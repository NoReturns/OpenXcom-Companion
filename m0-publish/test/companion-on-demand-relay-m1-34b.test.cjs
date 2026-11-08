'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const YAML = require('yaml');
const {
  createOnDemandRelayContext,
  processPendingRequest,
  runRetrieveOnce,
  RETRIEVE_PHASE,
  resolveOnDemandPaths,
} = require('../lib/companion-on-demand-relay.cjs');
const { writeJsonAtomic, writeTextAtomic } = require('../lib/local-atomic.cjs');
const { loadAndValidateSnapshotFromText } = require('../lib/tactical-publish.cjs');
const {
  fingerprintProductionCommandRelayJournal,
  assertProductionCommandRelayJournalUnchanged,
  isolatedCommandRelayStateDir,
} = require('../lib/relay-test-isolation.cjs');

function sha256HexLower(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'm1-34b-'));
}

function buildCommandFixture(snapshotPath, commandId, commandType = 'KNEEL') {
  const fixtureText = fs.readFileSync(snapshotPath, 'utf8');
  const tactical = loadAndValidateSnapshotFromText(fixtureText, YAML);
  const digest = sha256HexLower(Buffer.from(fixtureText, 'utf8'));
  const command = {
    schema_version: 1,
    command_id: commandId,
    command_type: commandType,
    actor_unit_id: 1,
    snapshot_sha256: digest,
    session_id: tactical.eventLog.sessionId,
    turn: tactical.turn,
    state_version: tactical.eventLog.latestSeq,
  };
  if (commandType === 'MOVE') {
    command.destination = { x: 9, y: 9, z: 0 };
  }
  if (commandType === 'SNAP_SHOT' || commandType === 'AUTO_SHOT' || commandType === 'AIMED_SHOT' ||
      commandType === 'THROW') {
    command.active_hand = 'STR_RIGHT_HAND';
    command.target = { x: 9, y: 9, z: 0 };
  }
  if (commandType === 'PRIME') {
    command.active_hand = 'STR_RIGHT_HAND';
    command.fuse_timer = 3;
  }
  return { command, digest, remoteSha: `sha-${commandId.slice(0, 8)}` };
}

function createRetrieveTestContext(root, snapshotPath, relayStateDir, hooks = {}) {
  const ctx = createOnDemandRelayContext({
    snapshotPath,
    commandRelayStateDir: relayStateDir,
    dryRun: hooks.dryRun ?? false,
    contentClient: {
      paths: {},
      readFile: () => null,
      publishFile: async () => {},
      deleteFile: async () => {},
    },
    ...hooks.contextOptions,
  });
  if (hooks.readRemoteCommand) {
    ctx.commandWatcher.readRemoteCommand = hooks.readRemoteCommand;
  }
  if (hooks.publishRemoteResult) {
    ctx.commandWatcher.publishRemoteResult = hooks.publishRemoteResult;
  }
  if (hooks.retireRemoteCommand) {
    ctx.commandWatcher.retireRemoteCommand = hooks.retireRemoteCommand;
  }
  if (hooks.fetchRemoteResult) {
    ctx.commandWatcher.fetchRemoteResult = hooks.fetchRemoteResult;
  }
  return ctx;
}

describe('M1-34B single-RETRIEVE lifecycle correction', () => {
  let root;
  let snapshotPath;
  let relayStateDir;
  let productionBefore;

  beforeEach(() => {
    productionBefore = fingerprintProductionCommandRelayJournal();
    root = makeRoot();
    snapshotPath = path.join(root, 'tactical-live.yaml');
    fs.writeFileSync(
      snapshotPath,
      fs.readFileSync(path.join(__dirname, 'fixtures', 'valid-v5.yaml'), 'utf8'),
      'utf8',
    );
    relayStateDir = isolatedCommandRelayStateDir(root, 'relay-state');
  });

  afterEach(() => {
    const productionAfter = fingerprintProductionCommandRelayJournal();
    assertProductionCommandRelayJournalUnchanged(productionBefore, productionAfter);
  });

  it('1. stale local inbox + new remote completes in one RETRIEVE', async () => {
    const paths = resolveOnDemandPaths(snapshotPath);
    const staleId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const newId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    writeTextAtomic(
      paths.localRelay.command,
      `${JSON.stringify({ schema_version: 1, command_id: staleId, command_type: 'KNEEL', actor_unit_id: 1 }, null, 2)}\n`,
      fs.writeFileSync,
      fs.renameSync,
    );
    writeTextAtomic(
      paths.localRelay.result,
      `${JSON.stringify({ command_id: staleId, status: 'COMPLETED' }, null, 2)}\n`,
      fs.writeFileSync,
      fs.renameSync,
    );

    const { command, remoteSha } = buildCommandFixture(snapshotPath, newId);
    let remoteCommand = { text: `${JSON.stringify(command, null, 2)}\n`, sha: remoteSha };
    let publishCount = 0;
    let retireCount = 0;
    let deliverCount = 0;

    const ctx = createRetrieveTestContext(root, snapshotPath, relayStateDir, {
      readRemoteCommand: async () => remoteCommand,
      fetchRemoteResult: async () => null,
      publishRemoteResult: async () => {
        publishCount += 1;
      },
      retireRemoteCommand: async () => {
        retireCount += 1;
        remoteCommand = null;
      },
    });
    const deliverLocalOrig = ctx.commandWatcher.deliverLocal.bind(ctx.commandWatcher);
    ctx.commandWatcher.deliverLocal = (cmd, sha, journal) => {
      deliverCount += 1;
      deliverLocalOrig(cmd, sha, journal);
      writeTextAtomic(
        paths.localRelay.result,
        `${JSON.stringify({ command_id: cmd.command_id, status: 'COMPLETED' }, null, 2)}\n`,
        fs.writeFileSync,
        fs.renameSync,
      );
    };

    const outcome = await runRetrieveOnce(ctx, {
      transactionId: 'tx-stale-inbox',
      localWaitMs: 500,
      localPollMs: 5,
      followUpPollMs: 10,
      maxFollowUpPolls: 8,
    });

    assert.equal(outcome.phase, RETRIEVE_PHASE.COMPLETED);
    assert.equal(deliverCount, 1);
    assert.equal(publishCount, 1);
    assert.equal(retireCount, 1);
    const tx = ctx.commandWatcher.getRetrieveTransactionState();
    assert.equal(tx.deliveredCommandId, newId);
    assert.equal(tx.publishedResult, true);
    assert.equal(tx.retiredRemote, true);
  });

  it('2. engine completion delayed several seconds still completes once', async () => {
    const paths = resolveOnDemandPaths(snapshotPath);
    const commandId = 'cccccccccccccccccccccccccccccccc';
    const { command, remoteSha } = buildCommandFixture(snapshotPath, commandId);
    let remoteCommand = { text: `${JSON.stringify(command, null, 2)}\n`, sha: remoteSha };

    const ctx = createRetrieveTestContext(root, snapshotPath, relayStateDir, {
      readRemoteCommand: async () => remoteCommand,
      fetchRemoteResult: async () => null,
      publishRemoteResult: async () => {},
      retireRemoteCommand: async () => {
        remoteCommand = null;
      },
    });
    const deliverLocalOrig = ctx.commandWatcher.deliverLocal.bind(ctx.commandWatcher);
    ctx.commandWatcher.deliverLocal = (cmd, sha, journal) => {
      deliverLocalOrig(cmd, sha, journal);
      setTimeout(() => {
        writeTextAtomic(
          paths.localRelay.result,
          `${JSON.stringify({ command_id: cmd.command_id, status: 'COMPLETED' }, null, 2)}\n`,
          fs.writeFileSync,
          fs.renameSync,
        );
      }, 250);
    };

    const started = Date.now();
    const outcome = await runRetrieveOnce(ctx, {
      transactionId: 'tx-delayed-engine',
      localWaitMs: 3000,
      localPollMs: 25,
      followUpPollMs: 25,
    });
    assert.ok(Date.now() - started >= 200);
    assert.equal(outcome.phase, RETRIEVE_PHASE.COMPLETED);
    const tx = ctx.commandWatcher.getRetrieveTransactionState();
    assert.equal(tx.publishedResult, true);
    assert.equal(tx.retiredRemote, true);
  });

  it('3. engine timeout does not report false COMPLETED', async () => {
    const paths = resolveOnDemandPaths(snapshotPath);
    const commandId = 'dddddddddddddddddddddddddddddddd';
    const { command, remoteSha } = buildCommandFixture(snapshotPath, commandId);
    let remoteCommand = { text: `${JSON.stringify(command, null, 2)}\n`, sha: remoteSha };
    let deliverCount = 0;

    const ctx = createRetrieveTestContext(root, snapshotPath, relayStateDir, {
      readRemoteCommand: async () => remoteCommand,
      fetchRemoteResult: async () => null,
      publishRemoteResult: async () => {},
      retireRemoteCommand: async () => {
        remoteCommand = null;
      },
    });
    const deliverLocalOrig = ctx.commandWatcher.deliverLocal.bind(ctx.commandWatcher);
    ctx.commandWatcher.deliverLocal = (cmd, sha, journal) => {
      deliverCount += 1;
      deliverLocalOrig(cmd, sha, journal);
    };

    const outcome = await runRetrieveOnce(ctx, {
      transactionId: 'tx-engine-timeout',
      localWaitMs: 40,
      localPollMs: 10,
      followUpPollMs: 10,
      maxFollowUpPolls: 2,
      totalBudgetMs: 200,
    });

    assert.equal(outcome.phase, RETRIEVE_PHASE.FAILED);
    assert.match(outcome.message, /incomplete/i);
    assert.equal(deliverCount, 1);
    const tx = ctx.commandWatcher.getRetrieveTransactionState();
    assert.equal(tx.publishedResult, false);
    assert.equal(tx.retiredRemote, false);
  });

  it('4. publication succeeds while retirement is delayed then completes in one RETRIEVE', async () => {
    const paths = resolveOnDemandPaths(snapshotPath);
    const commandId = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const { command, remoteSha } = buildCommandFixture(snapshotPath, commandId);
    let remoteCommand = { text: `${JSON.stringify(command, null, 2)}\n`, sha: remoteSha };
    let retireAttempts = 0;

    const ctx = createRetrieveTestContext(root, snapshotPath, relayStateDir, {
      readRemoteCommand: async () => remoteCommand,
      fetchRemoteResult: async () => null,
      publishRemoteResult: async () => {},
      retireRemoteCommand: async () => {
        retireAttempts += 1;
        if (retireAttempts < 3) {
          throw new Error('transient retire failure');
        }
        remoteCommand = null;
      },
    });
    ctx.commandWatcher._retirementBackoffMs = () => 0;
    const deliverLocalOrig = ctx.commandWatcher.deliverLocal.bind(ctx.commandWatcher);
    ctx.commandWatcher.deliverLocal = (cmd, sha, journal) => {
      deliverLocalOrig(cmd, sha, journal);
      writeTextAtomic(
        paths.localRelay.result,
        `${JSON.stringify({ command_id: cmd.command_id, status: 'COMPLETED' }, null, 2)}\n`,
        fs.writeFileSync,
        fs.renameSync,
      );
    };

    const outcome = await runRetrieveOnce(ctx, {
      transactionId: 'tx-delayed-retire',
      localWaitMs: 300,
      localPollMs: 5,
      followUpPollMs: 20,
      maxFollowUpPolls: 10,
    });

    assert.equal(outcome.phase, RETRIEVE_PHASE.COMPLETED);
    assert.ok(retireAttempts >= 3);
    const tx = ctx.commandWatcher.getRetrieveTransactionState();
    assert.equal(tx.publishedResult, true);
    assert.equal(tx.retiredRemote, true);
  });

  it('5. duplicate RETRIEVE does not duplicate local execution', async () => {
    const paths = resolveOnDemandPaths(snapshotPath);
    const commandId = 'ffffffffffffffffffffffffffffffff';
    const { command, remoteSha } = buildCommandFixture(snapshotPath, commandId);
    let remoteCommand = { text: `${JSON.stringify(command, null, 2)}\n`, sha: remoteSha };
    let deliverCount = 0;

    const ctx = createRetrieveTestContext(root, snapshotPath, relayStateDir, {
      readRemoteCommand: async () => remoteCommand,
      fetchRemoteResult: async () => null,
      publishRemoteResult: async () => {},
      retireRemoteCommand: async () => {
        remoteCommand = null;
      },
    });
    const deliverLocalOrig = ctx.commandWatcher.deliverLocal.bind(ctx.commandWatcher);
    ctx.commandWatcher.deliverLocal = (cmd, sha, journal) => {
      deliverCount += 1;
      deliverLocalOrig(cmd, sha, journal);
      writeTextAtomic(
        paths.localRelay.result,
        `${JSON.stringify({ command_id: cmd.command_id, status: 'COMPLETED' }, null, 2)}\n`,
        fs.writeFileSync,
        fs.renameSync,
      );
    };

    const first = await runRetrieveOnce(ctx, {
      transactionId: 'tx-dup-a',
      localWaitMs: 200,
      localPollMs: 5,
      followUpPollMs: 10,
    });
    assert.equal(first.phase, RETRIEVE_PHASE.COMPLETED);
    assert.equal(deliverCount, 1);

    remoteCommand = { text: `${JSON.stringify(command, null, 2)}\n`, sha: remoteSha };
    const second = await runRetrieveOnce(ctx, {
      transactionId: 'tx-dup-b',
      localWaitMs: 200,
      localPollMs: 5,
      followUpPollMs: 10,
    });
    assert.equal(second.phase, RETRIEVE_PHASE.NO_NEW_ORDERS);
    assert.equal(deliverCount, 1);
  });

  it('6. no duplicate terminal publication on idempotent remote result', async () => {
    const paths = resolveOnDemandPaths(snapshotPath);
    const commandId = '11111111111111111111111111111111';
    const { command, remoteSha } = buildCommandFixture(snapshotPath, commandId);
    let remoteCommand = { text: `${JSON.stringify(command, null, 2)}\n`, sha: remoteSha };
    let publishCount = 0;

    const ctx = createRetrieveTestContext(root, snapshotPath, relayStateDir, {
      readRemoteCommand: async () => remoteCommand,
      fetchRemoteResult: async () => ({
        value: { command_id: commandId, status: 'COMPLETED' },
      }),
      publishRemoteResult: async () => {
        publishCount += 1;
      },
      retireRemoteCommand: async () => {
        remoteCommand = null;
      },
    });
    const deliverLocalOrig = ctx.commandWatcher.deliverLocal.bind(ctx.commandWatcher);
    ctx.commandWatcher.deliverLocal = (cmd, sha, journal) => {
      deliverLocalOrig(cmd, sha, journal);
      writeTextAtomic(
        paths.localRelay.result,
        `${JSON.stringify({ command_id: cmd.command_id, status: 'COMPLETED' }, null, 2)}\n`,
        fs.writeFileSync,
        fs.renameSync,
      );
    };

    const outcome = await runRetrieveOnce(ctx, {
      transactionId: 'tx-no-dup-publish',
      localWaitMs: 200,
      localPollMs: 5,
      followUpPollMs: 10,
    });
    assert.equal(outcome.phase, RETRIEVE_PHASE.COMPLETED);
    assert.equal(publishCount, 0);
  });

  it('7. M1-33A transaction instrumentation still passes via processPendingRequest', async () => {
    const paths = resolveOnDemandPaths(snapshotPath);
    const commandId = '22222222222222222222222222222222';
    const { command, remoteSha } = buildCommandFixture(snapshotPath, commandId);
    let remoteCommand = { text: `${JSON.stringify(command, null, 2)}\n`, sha: remoteSha };

    const ctx = createRetrieveTestContext(root, snapshotPath, relayStateDir, {
      dryRun: true,
      readRemoteCommand: async () => remoteCommand,
      fetchRemoteResult: async () => null,
      publishRemoteResult: async () => {
        remoteCommand = null;
      },
      retireRemoteCommand: async () => {
        remoteCommand = null;
      },
    });
    const deliverLocalOrig = ctx.commandWatcher.deliverLocal.bind(ctx.commandWatcher);
    ctx.commandWatcher.deliverLocal = (cmd, sha, journal) => {
      deliverLocalOrig(cmd, sha, journal);
      writeTextAtomic(
        paths.localRelay.result,
        `${JSON.stringify({ command_id: cmd.command_id, status: 'COMPLETED' }, null, 2)}\n`,
        fs.writeFileSync,
        fs.renameSync,
      );
    };

    const requestId = 'req-m1-34b-33a-bridge';
    writeJsonAtomic(paths.requestPath, {
      request_id: requestId,
      action: 'retrieve',
      status: 'pending',
      created_at_ms: Date.now(),
    }, fs.writeFileSync, fs.renameSync);

    const result = await processPendingRequest(ctx, { preserveWatcherIo: true });
    assert.equal(result.processed, true);
    assert.equal(result.outcome.phase, RETRIEVE_PHASE.COMPLETED);

    const logPath = path.join(paths.snapshotDir, 'companion-on-demand-relay-transactions.jsonl');
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const complete = lines.find((line) => line.kind === 'relay_transaction_complete');
    assert.ok(complete);
    assert.equal(complete.request_id, requestId);
    assert.ok(complete.flags.internal_poll_count >= 2);
  });
});
