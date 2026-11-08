'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createOnDemandRelayDaemon,
  createOnDemandRelayContext,
  runSendOnce,
  runRetrieveOnce,
  SEND_PHASE,
  RETRIEVE_PHASE,
  resolveOnDemandPaths,
} = require('../lib/companion-on-demand-relay.cjs');
const { writeJsonAtomic } = require('../lib/local-atomic.cjs');
const crypto = require('node:crypto');
const {
  isolatedCommandRelayStateDir,
} = require('../lib/relay-test-isolation.cjs');

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'm1-25e-'));
}

describe('companion on-demand relay (M1-25E)', () => {
  /** @type {string} */
  let root;
  /** @type {string} */
  let snapshotPath;

  /** @type {string} */
  let relayStateDir;

  beforeEach(() => {
    root = makeRoot();
    snapshotPath = path.join(root, 'tactical-live.yaml');
    fs.writeFileSync(snapshotPath, fs.readFileSync(path.join(__dirname, 'fixtures', 'valid-v5.yaml'), 'utf8'), 'utf8');
    relayStateDir = isolatedCommandRelayStateDir(root, 'relay-state');
  });

  it('daemon idle tick performs zero GitHub reads', async () => {
    let ghReads = 0;
    const contentClient = {
      paths: {},
      readFile: () => {
        ghReads += 1;
        return null;
      },
    };
    const daemon = createOnDemandRelayDaemon({
      snapshotPath,
      commandRelayStateDir: relayStateDir,
      dryRun: true,
      contentClient,
      relayPublisher: { publishRelayState: async () => ({ skipped: true }) },
    });
    await daemon.runTickOnce();
    assert.equal(ghReads, 0);
  });

  it('processes one send request per pending file', async () => {
    const paths = resolveOnDemandPaths(snapshotPath);
    writeJsonAtomic(paths.requestPath, {
      request_id: 'abcabcabcabcabcabcabcabcabcabc',
      action: 'send',
      status: 'pending',
      send_scope: 'tactical',
      briefing_request_id: 'ffffffffffffffffffffffffffffffff',
      created_at_ms: 1,
    });
    let publishCalls = 0;
    const ctx = createOnDemandRelayContext({
      snapshotPath,
      commandRelayStateDir: relayStateDir,
      dryRun: false,
      relayPublisher: {
        publishRelayState: async () => {
          publishCalls += 1;
          return { skipped: false };
        },
      },
    });
    const result = await require('../lib/companion-on-demand-relay.cjs').processPendingRequest(ctx, {
      preserveWatcherIo: true,
    });
    assert.equal(result.processed, true);
    assert.equal(publishCalls, 1);
    assert.equal(fs.existsSync(paths.requestPath), false);
    const status = JSON.parse(fs.readFileSync(paths.statusPath, 'utf8'));
    assert.equal(status.phase, SEND_PHASE.SENT);
  });

  it('retrieve reports no new orders when remote is empty', async () => {
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
      relayPublisher: { publishRelayState: async () => ({ skipped: true }) },
    });
    ctx.commandWatcher.readRemoteCommand = async () => null;
    const outcome = await runRetrieveOnce(ctx);
    assert.equal(outcome.phase, RETRIEVE_PHASE.NO_NEW_ORDERS);
  });

  it('processes retrieve once and writes terminal status', async () => {
    const paths = resolveOnDemandPaths(snapshotPath);
    writeJsonAtomic(paths.requestPath, {
      request_id: 'cccccccccccccccccccccccccccccccc',
      action: 'retrieve',
      status: 'pending',
      created_at_ms: 1,
    });
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
    const result = await require('../lib/companion-on-demand-relay.cjs').processPendingRequest(ctx, {
      preserveWatcherIo: true,
    });
    assert.equal(result.processed, true);
    const status = JSON.parse(fs.readFileSync(paths.statusPath, 'utf8'));
    assert.equal(status.phase, RETRIEVE_PHASE.NO_NEW_ORDERS);
    assert.equal(status.terminal, true);
  });

  it('runSendOnce uses briefing watcher when briefing-request exists', async () => {
    const paths = resolveOnDemandPaths(snapshotPath);
    const digest = crypto.createHash('sha256').update(fs.readFileSync(snapshotPath)).digest('hex');
    writeJsonAtomic(paths.briefingRequest, {
      schema_version: 1,
      type: 'tactical_briefing_request',
      request_id: 'ffffffffffffffffffffffffffffffff',
      session_id: '00000000000000000000000000000000',
      turn: 1,
      snapshot_sha256: digest,
      created_at: new Date().toISOString(),
    });
    let briefingPolls = 0;
    const ctx = createOnDemandRelayContext({ snapshotPath, commandRelayStateDir: relayStateDir, dryRun: true });
    ctx.briefingWatcher._pollOnce = async () => {
      briefingPolls += 1;
    };
    await runSendOnce(ctx);
    assert.equal(briefingPolls, 1);
  });

  it('surfaces rate-limit failures on send', async () => {
    const ctx = createOnDemandRelayContext({
      snapshotPath,
      commandRelayStateDir: relayStateDir,
      dryRun: false,
      relayPublisher: {
        publishRelayState: async () => {
          const err = new Error('rate limited');
          err.code = 'RATE_LIMIT';
          throw err;
        },
      },
    });
    const outcome = await runSendOnce(ctx);
    assert.equal(outcome.phase, SEND_PHASE.SENDING);
    assert.equal(outcome.outcome, 'deferred');
    assert.equal(outcome.terminal, false);
    assert.equal(outcome.error_code, 'RATE_LIMIT');
    assert.match(outcome.message, /rate/i);
  });
});
