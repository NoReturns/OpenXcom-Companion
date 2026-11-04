'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  isProcessRunning,
  stopProcessTree,
  removeDaemonReady,
  removeDaemonPid,
} = require('../lib/on-demand-daemon-process.cjs');
const {
  isolatedCommandRelayStateDir,
  fingerprintProductionCommandRelayJournal,
  assertProductionCommandRelayJournalUnchanged,
  assertSubprocessRelayStateDirIsolated,
  getProductionCommandRelayJournalPath,
} = require('../lib/relay-test-isolation.cjs');
const { journalPath } = require('../lib/command-journal.cjs');

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'm1-25e4-'));
}

describe('companion on-demand relay M1-25E4', () => {
  let root;
  let snapshotPath;
  let snapshotDir;
  let daemonScript;
  let helperScript;
  let relayStateDir;

  beforeEach(() => {
    root = makeRoot();
    snapshotPath = path.join(root, 'tactical-live.yaml');
    snapshotDir = path.dirname(snapshotPath);
    fs.writeFileSync(snapshotPath, 'tactical: {}\n', 'utf8');
    daemonScript = path.join(__dirname, '..', 'companion-on-demand-relay-daemon.cjs');
    helperScript = path.join(__dirname, '..', 'scripts', 'run-startup-helper-once.cjs');
    relayStateDir = isolatedCommandRelayStateDir(root, 'relay-state');
    assertSubprocessRelayStateDirIsolated(relayStateDir);
  });

  afterEach(() => {
    const pidPath = path.join(snapshotDir, '.companion-on-demand-daemon.pid');
    if (fs.existsSync(pidPath)) {
      try {
        const pid = JSON.parse(fs.readFileSync(pidPath, 'utf8')).pid;
        if (pid) {
          stopProcessTree(pid);
        }
      } catch {
        // ignore
      }
    }
    removeDaemonReady(snapshotDir);
    removeDaemonPid(snapshotDir);
  });

  it('startup helper Node process exits after daemon readiness while daemon stays alive', () => {
    const productionBefore = fingerprintProductionCommandRelayJournal();
    const startedAt = Date.now();
    const result = spawnSync(process.execPath, [
      helperScript,
      snapshotPath,
      daemonScript,
      relayStateDir,
    ], {
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
    });
    const helperElapsedMs = Date.now() - startedAt;

    assert.equal(result.error, undefined, result.error ? String(result.error) : 'spawn error');
    assert.equal(result.status, 0, `helper stderr: ${result.stderr}\nstdout: ${result.stdout}`);
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.ok, true);
    assert.equal(payload.startedByUs, true);
    assert.ok(Number.isFinite(payload.pid));
    assert.ok(helperElapsedMs < 25000, `helper took too long: ${helperElapsedMs}ms`);
    assert.ok(isProcessRunning(payload.pid), 'daemon should remain running after helper exits');
    assert.notEqual(
      journalPath(relayStateDir),
      getProductionCommandRelayJournalPath(),
    );

    const productionAfter = fingerprintProductionCommandRelayJournal();
    assertProductionCommandRelayJournalUnchanged(productionBefore, productionAfter);

    stopProcessTree(payload.pid);
    removeDaemonReady(snapshotDir);
    removeDaemonPid(snapshotDir);
  });
});
