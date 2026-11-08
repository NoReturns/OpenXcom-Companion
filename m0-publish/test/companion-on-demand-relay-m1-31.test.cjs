'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  startOnDemandDaemonVerified,
  ensureOnDemandDaemonRunning,
  stopProcessTree,
  removeDaemonReady,
  removeDaemonPid,
  readDaemonPid,
  isProcessRunning,
} = require('../lib/on-demand-daemon-process.cjs');
const {
  assessOnDemandDaemonHealth,
  writeDaemonHealth,
  DAEMON_STATE,
} = require('../lib/on-demand-daemon-health.cjs');
const {
  resolveDiagnosticsPath,
  appendDiagnosticEvent,
} = require('../lib/on-demand-daemon-diagnostics.cjs');
const {
  createOnDemandRelayContext,
  processPendingRequest,
  createGhApiCallLog,
} = require('../lib/companion-on-demand-relay.cjs');
const {
  isolatedCommandRelayStateDir,
  fingerprintProductionCommandRelayJournal,
  assertProductionCommandRelayJournalUnchanged,
  assertSubprocessRelayStateDirIsolated,
} = require('../lib/relay-test-isolation.cjs');
const { journalPath } = require('../lib/command-journal.cjs');

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'm1-31-'));
}

describe('M1-31 on-demand daemon lifecycle hardening', () => {
  let root;
  let snapshotPath;
  let snapshotDir;
  let daemonScript;
  let relayStateDir;
  let productionBefore;

  beforeEach(() => {
    productionBefore = fingerprintProductionCommandRelayJournal();
    root = makeRoot();
    snapshotPath = path.join(root, 'tactical-live.yaml');
    snapshotDir = path.dirname(snapshotPath);
    fs.writeFileSync(snapshotPath, 'tactical: {}\n', 'utf8');
    daemonScript = path.join(__dirname, '..', 'companion-on-demand-relay-daemon.cjs');
    relayStateDir = isolatedCommandRelayStateDir(root, 'relay-state');
    assertSubprocessRelayStateDirIsolated(relayStateDir);
  });

  afterEach(() => {
    const pid = readDaemonPid(snapshotDir);
    if (pid) {
      stopProcessTree(pid);
    }
    removeDaemonReady(snapshotDir);
    removeDaemonPid(snapshotDir);
    const productionAfter = fingerprintProductionCommandRelayJournal();
    assertProductionCommandRelayJournalUnchanged(productionBefore, productionAfter);
  });

  it('fresh startup reaches ready with health and diagnostics', () => {
    const start = startOnDemandDaemonVerified({
      snapshotPath,
      daemonScript,
      cwd: path.dirname(daemonScript),
      commandRelayStateDir: relayStateDir,
      extraArgs: ['--dry-run'],
    });
    assert.equal(start.ok, true, start.error || 'startup failed');
    assert.equal(start.startedByUs, true);
    const health = assessOnDemandDaemonHealth({ snapshotPath });
    assert.equal(health.healthy, true);
    assert.ok(fs.existsSync(resolveDiagnosticsPath(snapshotDir)));
    stopProcessTree(start.pid);
  });

  it('reuses existing healthy daemon without respawn', () => {
    const first = startOnDemandDaemonVerified({
      snapshotPath,
      daemonScript,
      cwd: path.dirname(daemonScript),
      commandRelayStateDir: relayStateDir,
      extraArgs: ['--dry-run'],
    });
    assert.equal(first.ok, true);
    const second = startOnDemandDaemonVerified({
      snapshotPath,
      daemonScript,
      cwd: path.dirname(daemonScript),
      commandRelayStateDir: relayStateDir,
      extraArgs: ['--dry-run'],
    });
    assert.equal(second.ok, true);
    assert.equal(second.startedByUs, false);
    assert.equal(second.pid, first.pid);
    stopProcessTree(first.pid);
  });

  it('startup failure leaves persistent diagnostics', () => {
    const start = startOnDemandDaemonVerified({
      snapshotPath,
      daemonScript: path.join(root, 'missing-daemon.cjs'),
    });
    assert.equal(start.ok, false);
    const log = fs.readFileSync(resolveDiagnosticsPath(snapshotDir), 'utf8');
    assert.match(log, /startup_failed|missing_script/);
  });

  it('stale pid and ready markers fail health validation', () => {
    fs.writeFileSync(path.join(snapshotDir, '.companion-on-demand-daemon.pid'), `${JSON.stringify({ pid: 999999, owner: 'test' })}\n`);
    fs.writeFileSync(path.join(snapshotDir, '.companion-on-demand-daemon-ready.json'), `${JSON.stringify({ pid: 999999, ready_at_ms: Date.now() })}\n`);
    writeDaemonHealth(snapshotDir, {
      pid: 999999,
      state: DAEMON_STATE.READY,
    });
    const health = assessOnDemandDaemonHealth({
      snapshotPath,
      deps: { listProcesses: () => [] },
    });
    assert.equal(health.healthy, false);
  });

  it('unknown process is never killed without owned pid record', () => {
    const ok = stopProcessTree(999999, {
      requireOwnedPidRecord: true,
      snapshotDir,
    });
    assert.equal(ok, false);
  });

  it('concurrent ensure calls share single-flight startup', async () => {
    const fakePid = 424242;
    let spawnCount = 0;
    const deps = {
      listProcesses: () => [],
      sleepSync: () => {},
      childProcess: {
        spawn: () => {
          spawnCount += 1;
          return {
            pid: fakePid,
            unref: () => {},
            once: () => {},
          };
        },
      },
    };
    writeDaemonHealth(snapshotDir, { pid: fakePid, state: DAEMON_STATE.STARTING });
    const p1 = ensureOnDemandDaemonRunning({
      snapshotPath,
      daemonScript,
      commandRelayStateDir: relayStateDir,
      extraArgs: ['--dry-run'],
      deps,
      timeoutMs: 100,
      stopOnTimeout: false,
      singleFlight: true,
    });
    const p2 = ensureOnDemandDaemonRunning({
      snapshotPath,
      daemonScript,
      commandRelayStateDir: relayStateDir,
      extraArgs: ['--dry-run'],
      deps,
      timeoutMs: 100,
      stopOnTimeout: false,
      singleFlight: true,
    });
    await Promise.all([p1, p2]);
    assert.ok(spawnCount <= 1, `expected one spawn, got ${spawnCount}`);
  });

  it('idle daemon tick performs zero GitHub API calls', async () => {
    const apiCallLog = createGhApiCallLog();
    const ctx = createOnDemandRelayContext({
      snapshotPath,
      commandRelayStateDir: relayStateDir,
      dryRun: true,
      apiCallLog,
    });
    await processPendingRequest(ctx, {
      existsSync: fs.existsSync,
      readFileSync: fs.readFileSync,
      writeFileSync: fs.writeFileSync,
      renameSync: fs.renameSync,
      unlinkSync: fs.unlinkSync,
    });
    assert.equal(apiCallLog.entries.length, 0);
  });

  it('terminal journal survives ensure recovery attempt with isolated state dir', async () => {
    const isolatedJournalPath = journalPath(relayStateDir);
    fs.mkdirSync(relayStateDir, { recursive: true });
    fs.writeFileSync(isolatedJournalPath, `${JSON.stringify({
      version: 1,
      active: null,
      records: {
        cmd1: { command_id: 'cmd1', phase: 'delivered_local', status: 'COMPLETED' },
      },
    })}\n`);
    const before = fs.readFileSync(isolatedJournalPath, 'utf8');
    appendDiagnosticEvent(snapshotDir, { kind: 'test_journal_preserved' });
    const outcome = await ensureOnDemandDaemonRunning({
      snapshotPath,
      daemonScript: path.join(root, 'missing-daemon.cjs'),
      commandRelayStateDir: relayStateDir,
      singleFlight: true,
    });
    assert.equal(outcome.ok, false);
    const after = fs.readFileSync(isolatedJournalPath, 'utf8');
    assert.equal(before, after);
    const journal = JSON.parse(after);
    assert.equal(journal.records.cmd1.status, 'COMPLETED');
  });

  it('daemon exit after ready is recorded in diagnostics', () => {
    const start = startOnDemandDaemonVerified({
      snapshotPath,
      daemonScript,
      cwd: path.dirname(daemonScript),
      commandRelayStateDir: relayStateDir,
      extraArgs: ['--dry-run'],
    });
    assert.equal(start.ok, true);
    stopProcessTree(start.pid);
    const health = assessOnDemandDaemonHealth({ snapshotPath, deps: { listProcesses: () => [] } });
    assert.equal(health.healthy, false);
    const log = fs.readFileSync(resolveDiagnosticsPath(snapshotDir), 'utf8');
    assert.match(log, /"kind":"(daemon_exited_unexpected|startup_ready|reuse_healthy_daemon)"/);
  });
});
