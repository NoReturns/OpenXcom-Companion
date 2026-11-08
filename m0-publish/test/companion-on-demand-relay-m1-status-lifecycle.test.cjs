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
  resolveRetrieveCommandOutcome,
} = require('../lib/companion-on-demand-relay.cjs');
const {
  shouldWriteOnDemandStatus,
  writeOnDemandStatus,
  RELAY_OUTCOME,
} = require('../lib/companion-on-demand-status.cjs');
const { writeJsonAtomic, writeTextAtomic } = require('../lib/local-atomic.cjs');
const { loadAndValidateSnapshotFromText } = require('../lib/tactical-publish.cjs');
const {
  fingerprintProductionCommandRelayJournal,
  assertProductionCommandRelayJournalUnchanged,
  isolatedCommandRelayStateDir,
} = require('../lib/relay-test-isolation.cjs');
const { allowIsolatedRetrieveCommandDelivery } = require('./helpers/on-demand-retrieve-harness.cjs');

function sha256HexLower(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'm1-status-lifecycle-'));
}

function buildCommandFixture(snapshotPath, commandId) {
  const fixtureText = fs.readFileSync(snapshotPath, 'utf8');
  const tactical = loadAndValidateSnapshotFromText(fixtureText, YAML);
  const digest = sha256HexLower(Buffer.from(fixtureText, 'utf8'));
  return {
    command: {
      schema_version: 1,
      command_id: commandId,
      command_type: 'KNEEL',
      actor_unit_id: 1,
      snapshot_sha256: digest,
      session_id: tactical.eventLog.sessionId,
      turn: tactical.turn,
      state_version: tactical.eventLog.latestSeq,
    },
    remoteSha: `sha-${commandId.slice(0, 8)}`,
  };
}

describe('M1 retrieval status lifecycle', () => {
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
    assertProductionCommandRelayJournalUnchanged(
      productionBefore,
      fingerprintProductionCommandRelayJournal(),
    );
  });

  it('empty poll does not erase terminal completed retrieve with command outcome', () => {
    const statusPath = path.join(root, 'companion-on-demand-status.json');
    writeOnDemandStatus(statusPath, {
      request_id: 'req-complete',
      action: 'retrieve',
      phase: RETRIEVE_PHASE.COMPLETED,
      terminal: true,
      outcome: RELAY_OUTCOME.RETRIEVE_COMPLETE,
      last_command_id: 'cccccccccccccccccccccccccccccccc',
      last_command_status: 'COMPLETED',
      updated_at_ms: 5000,
    });
    const write = writeOnDemandStatus(statusPath, {
      request_id: 'req-empty',
      action: 'retrieve',
      phase: RETRIEVE_PHASE.NO_NEW_ORDERS,
      terminal: true,
      outcome: RELAY_OUTCOME.NO_NEW_ORDERS,
      updated_at_ms: 6000,
    });
    assert.equal(write.written, false);
    const kept = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    assert.equal(kept.phase, RETRIEVE_PHASE.COMPLETED);
    assert.equal(kept.last_command_status, 'COMPLETED');
    assert.equal(
      shouldWriteOnDemandStatus(kept, {
        action: 'retrieve',
        phase: RETRIEVE_PHASE.NO_NEW_ORDERS,
        terminal: true,
        updated_at_ms: 7000,
        request_id: 'req-empty-2',
      }),
      false,
    );
  });

  it('successful retrieve records authoritative command status COMPLETED', async () => {
    const paths = resolveOnDemandPaths(snapshotPath);
    const commandId = 'dddddddddddddddddddddddddddddddd';
    const { command, remoteSha } = buildCommandFixture(snapshotPath, commandId);
    const ctx = createOnDemandRelayContext({
      snapshotPath,
      commandRelayStateDir: relayStateDir,
      dryRun: true,
      assertCommandDeliveryAllowed: allowIsolatedRetrieveCommandDelivery(),
      contentClient: {
        paths: {},
        readFile: () => null,
        publishFile: async () => {},
        deleteFile: async () => {},
      },
    });
    ctx.commandWatcher.readRemoteCommand = async () => ({
      text: `${JSON.stringify(command, null, 2)}\n`,
      sha: remoteSha,
    });
    ctx.commandWatcher.fetchRemoteResult = async () => null;
    ctx.commandWatcher.retireRemoteCommand = async () => {};
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
      transactionId: 'tx-success',
      localWaitMs: 200,
      localPollMs: 5,
      followUpPollMs: 5,
      maxFollowUpPolls: 4,
    });
    assert.equal(outcome.phase, RETRIEVE_PHASE.COMPLETED);
    assert.equal(outcome.last_command_id, commandId);
    assert.equal(outcome.last_command_status, 'COMPLETED');
  });

  it('engine FAILED still completes relay but labels command status FAILED', async () => {
    const paths = resolveOnDemandPaths(snapshotPath);
    const commandId = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const { command, remoteSha } = buildCommandFixture(snapshotPath, commandId);
    const ctx = createOnDemandRelayContext({
      snapshotPath,
      commandRelayStateDir: relayStateDir,
      dryRun: true,
      assertCommandDeliveryAllowed: allowIsolatedRetrieveCommandDelivery(),
      contentClient: {
        paths: {},
        readFile: () => null,
        publishFile: async () => {},
        deleteFile: async () => {},
      },
    });
    ctx.commandWatcher.readRemoteCommand = async () => ({
      text: `${JSON.stringify(command, null, 2)}\n`,
      sha: remoteSha,
    });
    ctx.commandWatcher.fetchRemoteResult = async () => null;
    ctx.commandWatcher.retireRemoteCommand = async () => {};
    const deliverLocalOrig = ctx.commandWatcher.deliverLocal.bind(ctx.commandWatcher);
    ctx.commandWatcher.deliverLocal = (cmd, sha, journal) => {
      deliverLocalOrig(cmd, sha, journal);
      writeTextAtomic(
        paths.localRelay.result,
        `${JSON.stringify({ command_id: cmd.command_id, status: 'FAILED' }, null, 2)}\n`,
        fs.writeFileSync,
        fs.renameSync,
      );
    };

    const outcome = await runRetrieveOnce(ctx, {
      transactionId: 'tx-failed-cmd',
      localWaitMs: 200,
      localPollMs: 5,
      followUpPollMs: 5,
      maxFollowUpPolls: 4,
    });
    assert.equal(outcome.phase, RETRIEVE_PHASE.COMPLETED);
    assert.equal(outcome.last_command_status, 'FAILED');
  });

  it('remote inbox read failure is retrieval error not empty poll', async () => {
    const ctx = createOnDemandRelayContext({
      snapshotPath,
      commandRelayStateDir: relayStateDir,
      dryRun: true,
      contentClient: {
        paths: {},
        readFile: () => null,
        publishFile: async () => {},
        deleteFile: async () => {},
      },
    });
    const err = new Error('network down');
    err.code = 'NETWORK_FAILED';
    ctx.commandWatcher.readRemoteCommand = async () => {
      throw err;
    };

    const outcome = await runRetrieveOnce(ctx, { transactionId: 'tx-net-fail' });
    assert.equal(outcome.phase, RETRIEVE_PHASE.FAILED);
    assert.equal(outcome.error_code, 'NETWORK_FAILED');
    assert.notEqual(outcome.phase, RETRIEVE_PHASE.NO_NEW_ORDERS);
  });

  it('precedence B: Order FAILED terminal survives empty auto-poll', () => {
    const existing = {
      request_id: 'fail-1',
      action: 'retrieve',
      phase: RETRIEVE_PHASE.FAILED,
      terminal: true,
      last_command_id: 'a'.repeat(32),
      last_command_status: 'FAILED',
      updated_at_ms: 1000,
    };
    const emptyPoll = {
      request_id: 'poll-1',
      action: 'retrieve',
      phase: RETRIEVE_PHASE.NO_NEW_ORDERS,
      terminal: true,
      updated_at_ms: 2000,
    };
    assert.equal(shouldWriteOnDemandStatus(existing, emptyPoll), false);
  });

  it('precedence C: new completed command supersedes prior sticky outcome', () => {
    const existing = {
      request_id: 'old',
      action: 'retrieve',
      phase: RETRIEVE_PHASE.COMPLETED,
      terminal: true,
      last_command_id: 'a'.repeat(32),
      last_command_status: 'COMPLETED',
      updated_at_ms: 1000,
    };
    const newer = {
      request_id: 'new',
      action: 'retrieve',
      phase: RETRIEVE_PHASE.COMPLETED,
      terminal: true,
      last_command_id: 'b'.repeat(32),
      last_command_status: 'COMPLETED',
      updated_at_ms: 2000,
    };
    assert.equal(shouldWriteOnDemandStatus(existing, newer), true);
  });

  it('precedence E: RETRIEVE_INCOMPLETE may be superseded by later completed retrieve', () => {
    const incomplete = {
      request_id: 'inc',
      action: 'retrieve',
      phase: RETRIEVE_PHASE.FAILED,
      terminal: true,
      error_code: 'RETRIEVE_INCOMPLETE',
      updated_at_ms: 1000,
    };
    const done = {
      request_id: 'done',
      action: 'retrieve',
      phase: RETRIEVE_PHASE.COMPLETED,
      terminal: true,
      last_command_id: 'c'.repeat(32),
      last_command_status: 'COMPLETED',
      updated_at_ms: 3000,
    };
    assert.equal(shouldWriteOnDemandStatus(incomplete, done), true);
  });

  it('precedence F: resolveRetrieveCommandOutcome correlates by command id only', () => {
    const paths = resolveOnDemandPaths(snapshotPath);
    const ctx = createOnDemandRelayContext({
      snapshotPath,
      commandRelayStateDir: relayStateDir,
      dryRun: true,
      contentClient: {
        paths: {},
        readFile: () => null,
        publishFile: async () => {},
        deleteFile: async () => {},
      },
    });
    const idA = 'a'.repeat(32);
    const idB = 'b'.repeat(32);
    writeTextAtomic(
      paths.localRelay.result,
      `${JSON.stringify({ command_id: idB, status: 'COMPLETED' }, null, 2)}\n`,
      fs.writeFileSync,
      fs.renameSync,
    );
    const fields = resolveRetrieveCommandOutcome(ctx.commandWatcher, {
      deliveredCommandId: idA,
      publishedCommandId: idA,
      completionKind: 'engine_reported',
    });
    assert.equal(fields, null);
    writeTextAtomic(
      paths.localRelay.result,
      `${JSON.stringify({ command_id: idA, status: 'FAILED' }, null, 2)}\n`,
      fs.writeFileSync,
      fs.renameSync,
    );
    const matched = resolveRetrieveCommandOutcome(ctx.commandWatcher, {
      deliveredCommandId: idA,
      completionKind: 'engine_reported',
    });
    assert.equal(matched.last_command_id, idA);
    assert.equal(matched.last_command_status, 'FAILED');
  });

  it('precedence H: SEND pending status is not blocked by sticky retrieve outcome', () => {
    const existing = {
      request_id: 'r1',
      action: 'retrieve',
      phase: RETRIEVE_PHASE.COMPLETED,
      terminal: true,
      last_command_id: 'd'.repeat(32),
      last_command_status: 'COMPLETED',
      updated_at_ms: 1000,
    };
    const sendBusy = {
      request_id: 's1',
      action: 'send',
      phase: 'sending',
      terminal: false,
      updated_at_ms: 2000,
    };
    assert.equal(shouldWriteOnDemandStatus(existing, sendBusy), true);
  });

  it('processPendingRequest preserves status on auto no_new_orders after completed', async () => {
    const paths = resolveOnDemandPaths(snapshotPath);
    const commandId = 'ffffffffffffffffffffffffffffffff';
    writeOnDemandStatus(paths.statusPath, {
      request_id: 'prev',
      action: 'retrieve',
      phase: RETRIEVE_PHASE.COMPLETED,
      terminal: true,
      outcome: RELAY_OUTCOME.RETRIEVE_COMPLETE,
      last_command_id: commandId,
      last_command_status: 'COMPLETED',
      updated_at_ms: Date.now() - 1000,
    });

    writeJsonAtomic(paths.requestPath, {
      request_id: 'new-auto',
      action: 'retrieve',
      status: 'pending',
      created_at_ms: Date.now(),
    }, fs.writeFileSync, fs.renameSync);

    const ctx = createOnDemandRelayContext({
      snapshotPath,
      commandRelayStateDir: relayStateDir,
      dryRun: true,
      contentClient: {
        paths: {},
        readFile: () => null,
        publishFile: async () => {},
        deleteFile: async () => {},
      },
    });
    ctx.commandWatcher.readRemoteCommand = async () => null;

    const result = await processPendingRequest(ctx, { preserveWatcherIo: true });
    assert.equal(result.outcome.phase, RETRIEVE_PHASE.NO_NEW_ORDERS);
    const kept = JSON.parse(fs.readFileSync(paths.statusPath, 'utf8'));
    assert.equal(kept.phase, RETRIEVE_PHASE.COMPLETED);
    assert.equal(kept.last_command_id, commandId);
  });
});
