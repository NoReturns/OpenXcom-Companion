'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createOnDemandRelayContext,
  processPendingRequest,
  RETRIEVE_PHASE,
  createGhApiCallLog,
} = require('../lib/companion-on-demand-relay.cjs');
const {
  resolveRelayTransactionsPath,
  recordButtonEnqueue,
  createRelayTransactionTrace,
} = require('../lib/relay-transaction-trace.cjs');
const { writeJsonAtomic, writeTextAtomic } = require('../lib/local-atomic.cjs');
const { loadAndValidateSnapshotFromText } = require('../lib/tactical-publish.cjs');
const YAML = require('yaml');
const crypto = require('node:crypto');
const {
  fingerprintProductionCommandRelayJournal,
  assertProductionCommandRelayJournalUnchanged,
  isolatedCommandRelayStateDir,
} = require('../lib/relay-test-isolation.cjs');

function sha256HexLower(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'm1-33a-'));
}

function readTransactionLines(snapshotDir) {
  const filePath = resolveRelayTransactionsPath(snapshotDir);
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

describe('M1-33A relay transaction observability', () => {
  let root;
  let snapshotPath;
  let snapshotDir;
  let relayStateDir;
  let productionBefore;

  beforeEach(() => {
    productionBefore = fingerprintProductionCommandRelayJournal();
    root = makeRoot();
    snapshotPath = path.join(root, 'tactical-live.yaml');
    snapshotDir = path.dirname(snapshotPath);
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

  it('one physical retrieve maps to one request_id across internal polls', async () => {
    const paths = require('../lib/companion-on-demand-relay.cjs').resolveOnDemandPaths(snapshotPath);
    const fixtureText = fs.readFileSync(snapshotPath, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(fixtureText, YAML);
    const digest = sha256HexLower(Buffer.from(fixtureText, 'utf8'));
    const commandId = '33333333333333333333333333333333';
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
    let remoteCommand = { text: `${JSON.stringify(command, null, 2)}\n`, sha: 'sha-m1-33a' };
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
    ctx.commandWatcher.readRemoteCommand = async () => remoteCommand;
    ctx.commandWatcher.fetchRemoteResult = async () => null;
    ctx.commandWatcher.publishRemoteResult = async () => {
      remoteCommand = null;
    };
    ctx.commandWatcher.retireRemoteCommand = async () => {
      remoteCommand = null;
    };

    const requestId = 'req-m1-33a-retrieve-001';
    writeJsonAtomic(paths.requestPath, {
      request_id: requestId,
      action: 'retrieve',
      status: 'pending',
      created_at_ms: Date.now(),
    }, fs.writeFileSync, fs.renameSync);

    const result = await processPendingRequest(ctx, { preserveWatcherIo: true });
    assert.equal(result.processed, true);
    assert.equal(result.outcome.phase, RETRIEVE_PHASE.COMPLETED);

    const lines = readTransactionLines(snapshotDir);
    const complete = lines.find((line) => line.kind === 'relay_transaction_complete');
    assert.ok(complete, 'expected relay_transaction_complete line');
    assert.equal(complete.request_id, requestId);
    assert.equal(complete.action, 'retrieve');
    assert.ok(complete.github_api.invocation_count >= 0);
    assert.ok(Array.isArray(complete.events));
    const pollStarts = complete.events.filter((event) => event.phase === 'internal_poll_start');
    assert.ok(pollStarts.length >= 1, 'expected at least one internal poll');
    for (const poll of pollStarts) {
      assert.equal(complete.request_id, requestId);
    }
    assert.equal(complete.flags.internal_poll_count, pollStarts.length);
    assert.equal(complete.flags.saw_second_poll, pollStarts.length >= 2);
  });

  it('records rejected busy enqueue without a daemon transaction', () => {
    recordButtonEnqueue(snapshotDir, {
      action: 'retrieve',
      accepted: false,
      reject_code: 'relay_busy',
    });
    const lines = readTransactionLines(snapshotDir);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].kind, 'relay_button_enqueue');
    assert.equal(lines[0].accepted, false);
    assert.equal(lines[0].reject_code, 'relay_busy');
  });

  it('attributes gh api invocations to the request transaction id', async () => {
    const paths = require('../lib/companion-on-demand-relay.cjs').resolveOnDemandPaths(snapshotPath);
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

    const requestId = 'req-m1-33a-empty';
    writeJsonAtomic(paths.requestPath, {
      request_id: requestId,
      action: 'retrieve',
      status: 'pending',
      created_at_ms: Date.now(),
    }, fs.writeFileSync, fs.renameSync);

    await processPendingRequest(ctx, { preserveWatcherIo: true });
    const complete = readTransactionLines(snapshotDir).find((line) => line.kind === 'relay_transaction_complete');
    assert.ok(complete);
    assert.equal(complete.request_id, requestId);
    assert.equal(complete.outcome_phase, 'no_new_orders');
    assert.equal(complete.github_api.invocation_count, 0);
  });

  it('trace finish records sidecar rejection diagnostics on retrieve transactions', () => {
    const trace = createRelayTransactionTrace({
      requestId: 'trace-sidecar-reject',
      action: 'retrieve',
      snapshotDir,
      getQuotaStore: () => ({
        getSnapshot: () => ({
          limit: 5000,
          remaining: 100,
          used: 4900,
          resource: 'core',
          capturedAtMs: Date.now(),
        }),
      }),
    });
    const payload = trace.finish({
      outcomePhase: 'failed',
      outcomeMessage: 'Sidecar rejected command before execution; cooperative retrieve incomplete.',
      uiStatusTerminal: true,
      retrieveTx: {
        publishedCommandId: 'aaaabbbbccccddddaaaabbbbccccdddd',
        sidecarRejectCode: 'SIDECAR_VALIDATION',
        completionKind: 'sidecar_rejected',
        publishedResult: true,
      },
    });
    assert.equal(payload.command_id, 'aaaabbbbccccddddaaaabbbbccccdddd');
    assert.equal(payload.sidecar_reject_code, 'SIDECAR_VALIDATION');
  });

  it('trace finish records quota snapshots without extra gh calls', () => {
    const store = {
      getSnapshot: () => ({
        limit: 5000,
        remaining: 100,
        used: 4900,
        resource: 'core',
        capturedAtMs: Date.now(),
      }),
    };
    const trace = createRelayTransactionTrace({
      requestId: 'trace-quota-only',
      action: 'retrieve',
      snapshotDir,
      getQuotaStore: () => store,
    });
    trace.record('daemon_processing_started');
    const payload = trace.finish({
      outcomePhase: 'no_new_orders',
      uiStatusTerminal: true,
      apiCallLog: createGhApiCallLog({ transactionId: 'trace-quota-only' }),
    });
    assert.equal(payload.github_quota.at_start.core_used, 4900);
    assert.equal(payload.github_quota.at_end.core_used, 4900);
    assert.equal(payload.github_quota.core_used_delta, 0);
  });
});
