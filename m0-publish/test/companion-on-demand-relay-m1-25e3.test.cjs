'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  runSendOnce,
  createOnDemandRelayContext,
  SEND_PHASE,
} = require('../lib/companion-on-demand-relay.cjs');
const {
  startOnDemandDaemonVerified,
  readDaemonReady,
  removeDaemonReady,
  stopProcessTree,
} = require('../lib/on-demand-daemon-process.cjs');
const {
  isolatedCommandRelayStateDir,
  fingerprintProductionCommandRelayJournal,
  assertProductionCommandRelayJournalUnchanged,
  assertSubprocessRelayStateDirIsolated,
} = require('../lib/relay-test-isolation.cjs');

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'm1-25e3-'));
}

describe('companion on-demand relay M1-25E3', () => {
  let root;
  let snapshotPath;
  let daemonScript;

  let relayStateDir;

  beforeEach(() => {
    root = makeRoot();
    snapshotPath = path.join(root, 'tactical-live.yaml');
    fs.writeFileSync(snapshotPath, 'tactical: {}\n', 'utf8');
    daemonScript = path.join(__dirname, '..', 'companion-on-demand-relay-daemon.cjs');
    relayStateDir = isolatedCommandRelayStateDir(root, 'relay-state');
  });

  it('tactical send fails when briefing request was superseded', async () => {
    const paths = require('../lib/companion-on-demand-relay.cjs').resolveOnDemandPaths(snapshotPath);
    const digest = require('node:crypto').createHash('sha256').update(fs.readFileSync(snapshotPath)).digest('hex');
    const { writeJsonAtomic } = require('../lib/local-atomic.cjs');
    writeJsonAtomic(paths.briefingRequest, {
      schema_version: 1,
      type: 'tactical_briefing_request',
      request_id: 'b'.repeat(32),
      session_id: '0'.repeat(32),
      turn: 1,
      snapshot_sha256: digest,
      created_at: new Date().toISOString(),
    });
    const ctx = createOnDemandRelayContext({ snapshotPath, commandRelayStateDir: relayStateDir, dryRun: true });
    const outcome = await runSendOnce(ctx, {
      request_id: 'a'.repeat(32),
      send_scope: 'tactical',
      briefing_request_id: 'c'.repeat(32),
    });
    assert.equal(outcome.phase, SEND_PHASE.FAILED);
    assert.match(outcome.message, /superseded/i);
  });

  it('verifies daemon startup via ready marker (--dry-run)', () => {
    assertSubprocessRelayStateDirIsolated(relayStateDir);
    const productionBefore = fingerprintProductionCommandRelayJournal();
    removeDaemonReady(root);
    const start = startOnDemandDaemonVerified({
      snapshotPath,
      daemonScript,
      cwd: path.dirname(daemonScript),
      commandRelayStateDir: relayStateDir,
      extraArgs: ['--dry-run'],
      timeoutMs: 15000,
    });
    assert.equal(start.ok, true, start.error || 'startup failed');
    assert.ok(readDaemonReady(root));
    stopProcessTree(start.pid);
    removeDaemonReady(root);
    const productionAfter = fingerprintProductionCommandRelayJournal();
    assertProductionCommandRelayJournalUnchanged(productionBefore, productionAfter);
  });

  it('surfaces startup error when daemon script is missing', () => {
    const start = startOnDemandDaemonVerified({
      snapshotPath,
      daemonScript: path.join(root, 'missing-daemon.cjs'),
      cwd: root,
    });
    assert.equal(start.ok, false);
    assert.match(start.error, /Missing daemon script/i);
  });
});
