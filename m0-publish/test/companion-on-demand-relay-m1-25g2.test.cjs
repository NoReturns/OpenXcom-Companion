'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createOnDemandRelayContext,
  runRetrieveOnce,
  RETRIEVE_PHASE,
  resolveOnDemandPaths,
  createGhApiCallLog,
} = require('../lib/companion-on-demand-relay.cjs');
const { writeJsonAtomic, writeTextAtomic } = require('../lib/local-atomic.cjs');
const { loadCommandJournal, persistCommandJournal, markCommandRecord } = require('../lib/command-journal.cjs');
const { createGhApiCallLog: createGhApiCallLogDirect } = require('../lib/github-api-instrumentation.cjs');
const { isolatedCommandRelayStateDir } = require('../lib/relay-test-isolation.cjs');
const { allowIsolatedRetrieveCommandDelivery } = require('./helpers/on-demand-retrieve-harness.cjs');
const { loadAndValidateSnapshotFromText } = require('../lib/tactical-publish.cjs');
const YAML = require('yaml');
const crypto = require('node:crypto');

function sha256HexLower(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'm1-25g2-'));
}

function seedStaleJournal(stateDir, commandIds) {
  fs.mkdirSync(stateDir, { recursive: true });
  const journal = loadCommandJournal(stateDir);
  for (const id of commandIds) {
    markCommandRecord(journal, id, {
      phase: 'published_terminal',
      status: 'COMPLETED',
      remote_sha256: `sha-${id.slice(0, 8)}`,
      published_at: new Date().toISOString(),
    });
  }
  persistCommandJournal(stateDir, journal);
}

describe('M1-25G2 retrieve quota and journal correction', () => {
  let root;
  let snapshotPath;

  let relayStateDir;

  beforeEach(() => {
    root = makeRoot();
    snapshotPath = path.join(root, 'tactical-live.yaml');
    fs.writeFileSync(
      snapshotPath,
      fs.readFileSync(path.join(__dirname, 'fixtures', 'valid-v5.yaml'), 'utf8'),
      'utf8',
    );
    relayStateDir = isolatedCommandRelayStateDir(root, 'relay-state');
  });

  it('empty remote inbox with 3 stale journal records uses one inbox GET and no second poll', async () => {
    const paths = resolveOnDemandPaths(snapshotPath);
    const stateDir = path.join(root, 'relay-state-empty');
    seedStaleJournal(stateDir, [
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'cccccccccccccccccccccccccccccccc',
    ]);
    writeTextAtomic(
      paths.localRelay.result,
      `${JSON.stringify({
        command_id: 'dddddddddddddddddddddddddddddddd',
        status: 'COMPLETED',
      }, null, 2)}\n`,
      fs.writeFileSync,
      fs.renameSync,
    );

    let commandReads = 0;
    let resultReads = 0;
    const ctx = createOnDemandRelayContext({
      snapshotPath,
      commandRelayStateDir: stateDir,
      dryRun: true,
      contentClient: {
        paths: {},
        readFile: () => null,
        publishFile: async () => {},
        deleteFile: async () => {},
      },
      relayPublisher: { publishRelayState: async () => ({ skipped: true }) },
    });
    ctx.commandWatcher.readRemoteCommand = async () => {
      commandReads += 1;
      return null;
    };
    ctx.commandWatcher.fetchRemoteResult = async () => {
      resultReads += 1;
      return null;
    };

    const outcome = await runRetrieveOnce(ctx, { transactionId: 'tx-empty-stale' });
    assert.equal(outcome.phase, RETRIEVE_PHASE.NO_NEW_ORDERS);
    assert.equal(commandReads, 1, 'settled empty retrieve should perform one inbox GET');
    assert.equal(resultReads, 0, 'unrelated local COMPLETED must not trigger result probes');

    const journal = loadCommandJournal(stateDir);
    for (const id of ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'cccccccccccccccccccccccccccccccc']) {
      assert.equal(journal.records[id].phase, 'retirement_closed');
      assert.match(journal.records[id].retirement_closed_reason, /unrelated_local_result_remote_inbox_empty/);
    }
  });

  it('does not treat unrelated local COMPLETED as retrieve completion', async () => {
    const paths = resolveOnDemandPaths(snapshotPath);
    writeTextAtomic(
      paths.localRelay.result,
      `${JSON.stringify({ command_id: 'old-old-old-old-old-old-old-old-old-old-old', status: 'COMPLETED' }, null, 2)}\n`,
      fs.writeFileSync,
      fs.renameSync,
    );
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
    const outcome = await runRetrieveOnce(ctx);
    assert.equal(outcome.phase, RETRIEVE_PHASE.NO_NEW_ORDERS);
  });

  it('fresh delivery publishes and reports completed with second poll', async () => {
    const paths = resolveOnDemandPaths(snapshotPath);
    const fixtureText = fs.readFileSync(snapshotPath, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(fixtureText, YAML);
    const digest = sha256HexLower(Buffer.from(fixtureText, 'utf8'));
    const commandId = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const command = {
      schema_version: 1,
      command_id: commandId,
      command_type: 'KNEEL',
      actor_unit_id: 1,
      snapshot_sha256: digest,
      session_id: tactical.eventLog.sessionId,
      turn: tactical.turn,
      state_version: tactical.eventLog.latestSeq,
    };
    let commandReads = 0;
    let remoteCommand = { text: `${JSON.stringify(command, null, 2)}\n`, sha: 'sha-live' };
    let published = false;
    const ctx = createOnDemandRelayContext({
      snapshotPath,
      commandRelayStateDir: path.join(root, 'relay-state-kneel'),
      dryRun: false,
      assertCommandDeliveryAllowed: allowIsolatedRetrieveCommandDelivery(),
      contentClient: {
        paths: {},
        readFile: () => null,
        publishFile: async () => {},
        deleteFile: async () => {},
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
    ctx.commandWatcher.readRemoteCommand = async () => {
      commandReads += 1;
      return remoteCommand;
    };
    ctx.commandWatcher.publishRemoteResult = async (result) => {
      published = true;
      remoteCommand = null;
    };
    ctx.commandWatcher.fetchRemoteResult = async () => null;
    ctx.commandWatcher.retireRemoteCommand = async () => {
      remoteCommand = null;
    };

    const outcome = await runRetrieveOnce(ctx, {
      transactionId: 'tx-kneel',
      localWaitMs: 200,
      localPollMs: 5,
    });
    assert.equal(outcome.phase, RETRIEVE_PHASE.COMPLETED);
    assert.ok(published);
    assert.ok(commandReads >= 2, 'delivery path requires follow-up poll');
  });

  it('records gh api calls with method endpoint and transaction id', () => {
    const log = createGhApiCallLogDirect({ transactionId: 'instrument-tx' });
    const exec = log.wrapExecFileSync(() => 'HTTP/1.1 200 OK\n\n{}');
    exec('gh', ['api', '--method', 'GET', 'repos/o/r/contents/m0/tactical-command.json']);
    assert.equal(log.countApiCalls(), 1);
    assert.equal(log.entries[0].method, 'GET');
    assert.equal(log.entries[0].endpoint, 'repos/o/r/contents/m0/tactical-command.json');
    assert.equal(log.entries[0].transaction_id, 'instrument-tx');
  });

  it('duplicate settled retrieves stay at one inbox GET each', async () => {
    const paths = resolveOnDemandPaths(snapshotPath);
    const stateDir = path.join(root, 'relay-state-dup');
    seedStaleJournal(stateDir, [
      'ffffffffffffffffffffffffffffffff',
    ]);
    writeTextAtomic(
      paths.localRelay.result,
      `${JSON.stringify({ command_id: '99999999999999999999999999999999', status: 'COMPLETED' }, null, 2)}\n`,
      fs.writeFileSync,
      fs.renameSync,
    );
    let commandReads = 0;
    const ctx = createOnDemandRelayContext({
      snapshotPath,
      commandRelayStateDir: stateDir,
      dryRun: true,
      contentClient: {
        paths: {},
        readFile: () => null,
        publishFile: async () => {},
        deleteFile: async () => {},
      },
    });
    ctx.commandWatcher.readRemoteCommand = async () => {
      commandReads += 1;
      return null;
    };
    ctx.commandWatcher.fetchRemoteResult = async () => null;

    await runRetrieveOnce(ctx, { transactionId: 'tx-dup-1' });
    const firstCount = commandReads;
    await runRetrieveOnce(ctx, { transactionId: 'tx-dup-2' });
    assert.equal(firstCount, 1);
    assert.equal(commandReads, 2);
  });

  it('exports createGhApiCallLog helper from on-demand relay module', () => {
    const log = createGhApiCallLog({ transactionId: 're-export' });
    assert.equal(typeof log.wrapExecFileSync, 'function');
  });
});
