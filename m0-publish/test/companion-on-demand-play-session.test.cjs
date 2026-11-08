'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  startOnDemandDaemonVerified,
  stopProcessTree,
  removeDaemonReady,
  removeDaemonPid,
  readDaemonPid,
  isProcessRunning,
  writeDaemonPid,
  writeDaemonReady,
  DAEMON_SCRIPT_NAME,
} = require('../lib/on-demand-daemon-process.cjs');
const {
  assessOnDemandDaemonHealth,
  DAEMON_STATE,
  readDaemonHealth,
  verifyDaemonProcessIdentityForPid,
  listVerifiedDaemonsForSnapshot,
  verifyDaemonStartupLive,
  writeDaemonHealth,
} = require('../lib/on-demand-daemon-health.cjs');
const {
  writeOwnershipRecord,
  findAllDaemonsForSnapshot,
} = require('../lib/on-demand-daemon-ownership.cjs');
const {
  beginCompanionPlaySession,
  registerPlaySessionDaemonPid,
  registerPlaySessionGamePid,
  shutdownCompanionPlaySession,
  reconcilePlaySessionLeaseForExitingDaemon,
  reconcilePlaySessionLeaseAfterFailedDaemonStart,
  classifyShutdownTargets,
  stopVerifiedDaemonPid,
  readPlaySessionLease,
  adoptDaemonIntoPlaySessionLease,
  updatePlaySessionLease,
} = require('../lib/on-demand-play-session.cjs');
const {
  isolatedCommandRelayStateDir,
  fingerprintProductionCommandRelayJournal,
  assertProductionCommandRelayJournalUnchanged,
  assertSubprocessRelayStateDirIsolated,
} = require('../lib/relay-test-isolation.cjs');

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'play-session-'));
}

function daemonCommandLine(snapshotPath) {
  return `"${process.execPath}" "${path.join(__dirname, '..', 'companion-on-demand-relay-daemon.cjs')}" --snapshot-path "${snapshotPath}"`;
}

describe('companion play session shutdown (M1)', () => {
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
    for (const proc of findAllDaemonsForSnapshot(snapshotPath)) {
      if (isProcessRunning(proc.pid)) {
        stopProcessTree(proc.pid);
      }
    }
    removeDaemonReady(snapshotDir);
    removeDaemonPid(snapshotDir);
    const productionAfter = fingerprintProductionCommandRelayJournal();
    assertProductionCommandRelayJournalUnchanged(productionBefore, productionAfter);
  });

  it('launcher-started daemon: normal game exit shuts down and clears READY', () => {
    const session = beginCompanionPlaySession({
      snapshotPath,
      launcherPid: 424242,
    });
    assert.equal(session.ok, true);
    const start = startOnDemandDaemonVerified({
      snapshotPath,
      daemonScript,
      cwd: path.dirname(daemonScript),
      commandRelayStateDir: relayStateDir,
      extraArgs: ['--dry-run'],
      owner: 'launcher',
    });
    assert.equal(start.ok, true);
    assert.equal(start.startedByUs, true);
    registerPlaySessionDaemonPid(snapshotPath, session.sessionId, start.pid);
    registerPlaySessionGamePid(snapshotPath, session.sessionId, 919191);

    const shutdown = shutdownCompanionPlaySession({
      snapshotPath,
      sessionId: session.sessionId,
      launcherPid: 424242,
    });
    assert.equal(shutdown.ok, true, JSON.stringify(shutdown));
    assert.deepEqual(shutdown.stopped, [start.pid]);
    const health = readDaemonHealth(snapshotDir);
    assert.equal(health.state, DAEMON_STATE.STOPPED);
    assert.equal(readPlaySessionLease(snapshotDir), null);
    assert.equal(isProcessRunning(start.pid), false);
  });

  it('reused daemon is stopped after session shutdown (not gated on startedByUs)', () => {
    const first = startOnDemandDaemonVerified({
      snapshotPath,
      daemonScript,
      cwd: path.dirname(daemonScript),
      commandRelayStateDir: relayStateDir,
      extraArgs: ['--dry-run'],
    });
    const second = startOnDemandDaemonVerified({
      snapshotPath,
      daemonScript,
      cwd: path.dirname(daemonScript),
      commandRelayStateDir: relayStateDir,
      extraArgs: ['--dry-run'],
    });
    assert.equal(second.reused, true);
    assert.equal(second.pid, first.pid);

    const session = beginCompanionPlaySession({ snapshotPath, launcherPid: 111 });
    registerPlaySessionDaemonPid(snapshotPath, session.sessionId, first.pid);
    registerPlaySessionGamePid(snapshotPath, session.sessionId, 222);

    const shutdown = shutdownCompanionPlaySession({
      snapshotPath,
      sessionId: session.sessionId,
      launcherPid: 111,
    });
    assert.equal(shutdown.ok, true);
    assert.equal(isProcessRunning(first.pid), false);
  });

  it('engine-recovered daemon pid merged at shutdown and stopped', () => {
    const start = startOnDemandDaemonVerified({
      snapshotPath,
      daemonScript,
      cwd: path.dirname(daemonScript),
      commandRelayStateDir: relayStateDir,
      extraArgs: ['--dry-run'],
      owner: 'request_recovery',
    });
    const session = beginCompanionPlaySession({ snapshotPath, launcherPid: 333 });
    registerPlaySessionDaemonPid(snapshotPath, session.sessionId, start.pid);
    registerPlaySessionGamePid(snapshotPath, session.sessionId, 444);

    const shutdown = shutdownCompanionPlaySession({
      snapshotPath,
      sessionId: session.sessionId,
      launcherPid: 333,
    });
    assert.equal(shutdown.ok, true);
    assert.ok(shutdown.stopped.includes(start.pid));
  });

  it('split-brain: stops all live daemons when session registered every pid', () => {
    const now = Date.now();
    const deps = {
      listProcesses: () => ([
        { pid: 701001, commandLine: daemonCommandLine(snapshotPath) },
        { pid: 701002, commandLine: daemonCommandLine(snapshotPath) },
      ]),
      getProcessCreationIdentity: (pid) => ({
        ok: true,
        creationMs: now,
        executablePath: process.execPath,
        commandLine: daemonCommandLine(snapshotPath),
      }),
      isProcessRunning: (pid) => pid === 701001 || pid === 701002,
      stopProcessTree: (pid) => {
        assert.ok(pid === 701001 || pid === 701002);
        return true;
      },
      platform: 'win32',
    };

    const session = beginCompanionPlaySession({
      snapshotPath,
      launcherPid: 555,
      deps,
    });
    registerPlaySessionDaemonPid(snapshotPath, session.sessionId, 701001, deps);
    registerPlaySessionDaemonPid(snapshotPath, session.sessionId, 701002, deps);
    registerPlaySessionGamePid(snapshotPath, session.sessionId, 777, deps);

    const plan = classifyShutdownTargets(snapshotPath, session.sessionId, deps);
    assert.equal(plan.inventory.splitBrain, true);
    assert.deepEqual(plan.stopPids, [701001, 701002]);

    writeOwnershipRecord(snapshotDir, {
      snapshot_path: snapshotPath,
      pid: 701001,
      ownership_token: 'tok-a',
      started_at_ms: now,
      process_creation_ms: now,
      owner: 'daemon',
    }, deps);

    const shutdown = shutdownCompanionPlaySession({
      snapshotPath,
      sessionId: session.sessionId,
      launcherPid: 555,
      deps,
    });
    assert.equal(shutdown.ok, true);
    assert.deepEqual(shutdown.stopped.sort(), [701001, 701002]);
  });

  it('split-brain ambiguous: refuses unregistered live daemon', () => {
    const now = Date.now();
    const deps = {
      listProcesses: () => ([
        { pid: 801001, commandLine: daemonCommandLine(snapshotPath) },
        { pid: 801002, commandLine: daemonCommandLine(snapshotPath) },
      ]),
      getProcessCreationIdentity: () => ({
        ok: true,
        creationMs: now,
        executablePath: process.execPath,
        commandLine: daemonCommandLine(snapshotPath),
      }),
      isProcessRunning: (pid) => pid === 801001 || pid === 801002,
      stopProcessTree: () => true,
      platform: 'win32',
    };

    const session = beginCompanionPlaySession({ snapshotPath, launcherPid: 601, deps });
    registerPlaySessionDaemonPid(snapshotPath, session.sessionId, 801001, deps);
    registerPlaySessionGamePid(snapshotPath, session.sessionId, 602, deps);

    const plan = classifyShutdownTargets(snapshotPath, session.sessionId, deps);
    assert.equal(plan.ambiguous, true);
    assert.deepEqual(plan.stopPids, [801001]);
    assert.deepEqual(plan.refusedPids, [801002]);

    const shutdown = shutdownCompanionPlaySession({
      snapshotPath,
      sessionId: session.sessionId,
      launcherPid: 601,
      deps,
    });
    assert.equal(shutdown.stopped.includes(801001), true);
    assert.equal(shutdown.refused.includes(801002), true);
    assert.equal(shutdown.ambiguous, true);
  });

  it('stale PID / PID reuse: identity refused when live creation differs from bound identity', () => {
    const now = Date.now();
    const boundCreationMs = now;
    writeDaemonPid(snapshotDir, 900001, {}, { owner: 'test', snapshotPath });
    writeOwnershipRecord(snapshotDir, {
      snapshot_path: snapshotPath,
      pid: 900001,
      ownership_token: 'reuse-tok',
      started_at_ms: now,
      process_creation_ms: boundCreationMs,
      owner: 'daemon',
    });

    const deps = {
      listProcesses: () => [{
        pid: 900001,
        commandLine: daemonCommandLine(snapshotPath),
      }],
      getProcessCreationIdentity: () => ({
        ok: true,
        creationMs: boundCreationMs + 60_000,
        executablePath: process.execPath,
        commandLine: daemonCommandLine(snapshotPath),
      }),
      isProcessRunning: () => true,
      platform: 'win32',
    };

    const identity = verifyDaemonProcessIdentityForPid(snapshotPath, 900001, deps);
    assert.equal(identity.ok, false);
    assert.equal(identity.reason, 'pid_reuse_creation_mismatch');

    const inventory = listVerifiedDaemonsForSnapshot(snapshotPath, deps);
    assert.equal(inventory.verified.length, 0);
    assert.equal(inventory.rejected.length, 1);
  });

  it('another active play session blocks begin', () => {
    const deps = {
      isProcessRunning: (pid) => pid === 12001,
      platform: 'win32',
    };
    beginCompanionPlaySession({
      snapshotPath,
      launcherPid: 12000,
      sessionId: 'sess-a',
      deps,
    });
    registerPlaySessionGamePid(snapshotPath, 'sess-a', 12001, deps);

    const blocked = beginCompanionPlaySession({
      snapshotPath,
      launcherPid: 13000,
      deps,
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.blocker, 'foreign_play_session_active');
  });

  it('game still running defers daemon shutdown', () => {
    const deps = {
      isProcessRunning: (pid) => pid === 15001,
      platform: 'win32',
    };
    const session = beginCompanionPlaySession({ snapshotPath, launcherPid: 15000, deps });
    registerPlaySessionGamePid(snapshotPath, session.sessionId, 15001, deps);

    const shutdown = shutdownCompanionPlaySession({
      snapshotPath,
      sessionId: session.sessionId,
      launcherPid: 15000,
      deps,
    });
    assert.equal(shutdown.ok, false);
    assert.equal(shutdown.code, 'game_still_running');
    assert.equal(shutdown.deferred, true);
  });

  it('missing/malformed ownership still shuts down verified single daemon', () => {
    const start = startOnDemandDaemonVerified({
      snapshotPath,
      daemonScript,
      cwd: path.dirname(daemonScript),
      commandRelayStateDir: relayStateDir,
      extraArgs: ['--dry-run'],
    });
    const session = beginCompanionPlaySession({ snapshotPath, launcherPid: 16000 });
    registerPlaySessionDaemonPid(snapshotPath, session.sessionId, start.pid);
    registerPlaySessionGamePid(snapshotPath, session.sessionId, 16001);

    const shutdown = shutdownCompanionPlaySession({
      snapshotPath,
      sessionId: session.sessionId,
      launcherPid: 16000,
    });
    assert.equal(shutdown.ok, true);
    const health = assessOnDemandDaemonHealth({ snapshotPath });
    assert.equal(health.healthy, false);
    assert.notEqual(health.state, DAEMON_STATE.READY);
  });

  it('refuses to stop unrelated Cursor/Codex-shaped node process', () => {
    const cursorLine = `"C:\\cursor\\node.exe" cursor worker start --worker-dir "${root}"`;
    const deps = {
      listProcesses: () => [
        { pid: 17001, commandLine: cursorLine },
        { pid: 17002, commandLine: daemonCommandLine(snapshotPath) },
      ],
      getProcessCreationIdentity: (pid) => ({
        ok: true,
        creationMs: Date.now(),
        executablePath: process.execPath,
        commandLine: pid === 17002 ? daemonCommandLine(snapshotPath) : cursorLine,
      }),
      isProcessRunning: (pid) => pid === 17001 || pid === 17002,
      stopProcessTree: (pid) => pid === 17002,
      platform: 'win32',
    };

    const session = beginCompanionPlaySession({ snapshotPath, launcherPid: 17000, deps });
    registerPlaySessionDaemonPid(snapshotPath, session.sessionId, 17002, deps);
    registerPlaySessionGamePid(snapshotPath, session.sessionId, 17003, deps);

    const bad = stopVerifiedDaemonPid(snapshotPath, 17001, deps);
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, 'not_verified_for_snapshot');

    const inventory = listVerifiedDaemonsForSnapshot(snapshotPath, deps);
    assert.equal(inventory.verified.length, 1);
    assert.equal(inventory.verified[0].pid, 17002);
    assert.ok(inventory.verified[0].identity.commandLine.includes(DAEMON_SCRIPT_NAME));
  });

  it('startup verify rejects dead PID with stale ready marker', () => {
    const deadPid = 991001;
    writeDaemonPid(snapshotDir, deadPid, {}, { owner: 'test', snapshotPath });
    writeDaemonReady(snapshotDir, { pid: deadPid, ready_at_ms: Date.now(), script: 'companion-on-demand-relay-daemon.cjs' });
    writeDaemonHealth(snapshotDir, {
      pid: deadPid,
      state: DAEMON_STATE.READY,
      updated_at_ms: Date.now(),
    });
    const deps = {
      listProcesses: () => [],
      isProcessRunning: () => false,
      platform: 'win32',
    };
    const discover = require('../lib/on-demand-daemon-ownership.cjs').discoverLiveDaemonForSnapshot(snapshotPath, deps);
    assert.equal(discover.found, false);
    const verify = verifyDaemonStartupLive(snapshotPath, deadPid, deps);
    assert.equal(verify.ok, false);
    assert.equal(verify.reason, 'pid_not_verified_live');
    const start = startOnDemandDaemonVerified({
      snapshotPath,
      daemonScript,
      cwd: path.dirname(daemonScript),
      commandRelayStateDir: relayStateDir,
      extraArgs: ['--dry-run'],
    });
    assert.equal(start.ok, true, start.error || 'spawn failed');
    const post = verifyDaemonStartupLive(snapshotPath, start.pid);
    assert.equal(post.ok, true);
    stopProcessTree(start.pid);
  });

  it('cleanup records stop failure without throwing', () => {
    const now = Date.now();
    const deps = {
      listProcesses: () => [{
        pid: 18001,
        commandLine: daemonCommandLine(snapshotPath),
      }],
      getProcessCreationIdentity: () => ({
        ok: true,
        creationMs: now,
        executablePath: process.execPath,
        commandLine: daemonCommandLine(snapshotPath),
      }),
      isProcessRunning: (pid) => pid === 18001,
      stopProcessTree: () => false,
      platform: 'win32',
    };

    const session = beginCompanionPlaySession({ snapshotPath, launcherPid: 18000, deps });
    registerPlaySessionDaemonPid(snapshotPath, session.sessionId, 18001, deps);
    registerPlaySessionGamePid(snapshotPath, session.sessionId, 18002, deps);

    const shutdown = shutdownCompanionPlaySession({
      snapshotPath,
      sessionId: session.sessionId,
      launcherPid: 18000,
      deps,
    });
    assert.equal(shutdown.ok, false);
    assert.ok(Array.isArray(shutdown.errors) && shutdown.errors.length > 0);
  });

  it('reconcilePlaySessionLeaseForExitingDaemon removes lease after game exit (watchdog-only path)', () => {
    const daemonPid = 18100;
    const gamePid = 18101;
    const deps = {
      platform: 'win32',
      isProcessRunning: (pid) => pid === daemonPid,
      listProcesses: () => [{ pid: daemonPid, commandLine: daemonCommandLine(snapshotPath) }],
      getProcessCreationIdentity: (pid) => {
        if (pid === daemonPid) {
          return {
            ok: true,
            creationMs: Date.now(),
            executablePath: process.execPath,
            commandLine: daemonCommandLine(snapshotPath),
          };
        }
        return { ok: false, reason: 'not_found' };
      },
    };
    const session = beginCompanionPlaySession({ snapshotPath, launcherPid: 424242, deps });
    registerPlaySessionDaemonPid(snapshotPath, session.sessionId, daemonPid, deps);
    registerPlaySessionGamePid(snapshotPath, session.sessionId, gamePid, {
      ...deps,
      isProcessRunning: () => false,
    });
    updatePlaySessionLease(snapshotDir, session.sessionId, {
      daemon_pids: [daemonPid, 22276],
    }, deps);

    const outcome = reconcilePlaySessionLeaseForExitingDaemon({
      snapshotPath,
      sessionId: session.sessionId,
      daemonPid,
      shutdownReason: 'game_session:game_exited',
      deps,
    });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.removed, true);
    assert.deepEqual(outcome.stale_daemon_pids, [22276]);
    assert.equal(readPlaySessionLease(snapshotDir, deps), null);
  });

  it('reconcilePlaySessionLeaseForExitingDaemon defers while game is still running', () => {
    const daemonPid = 18102;
    const gamePid = 18103;
    const RUNTIME_OPENXCOM = 'E:\\Open X-Com Companion\\runtime\\m0\\bin\\openxcom.exe';
    const deps = {
      platform: 'win32',
      isProcessRunning: (pid) => pid === daemonPid || pid === gamePid,
      listProcesses: () => [{ pid: daemonPid, commandLine: daemonCommandLine(snapshotPath) }],
      getProcessCreationIdentity: (pid) => {
        if (pid === daemonPid) {
          return {
            ok: true,
            creationMs: Date.now(),
            executablePath: process.execPath,
            commandLine: daemonCommandLine(snapshotPath),
          };
        }
        if (pid === gamePid) {
          return {
            ok: true,
            creationMs: Date.now(),
            executablePath: RUNTIME_OPENXCOM,
            commandLine: `"${RUNTIME_OPENXCOM}"`,
          };
        }
        return { ok: false, reason: 'not_found' };
      },
    };
    const session = beginCompanionPlaySession({ snapshotPath, launcherPid: 424242, deps });
    registerPlaySessionDaemonPid(snapshotPath, session.sessionId, daemonPid, deps);
    registerPlaySessionGamePid(snapshotPath, session.sessionId, gamePid, deps);

    const outcome = reconcilePlaySessionLeaseForExitingDaemon({
      snapshotPath,
      sessionId: session.sessionId,
      daemonPid,
      deps,
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, 'game_still_running');
    assert.ok(readPlaySessionLease(snapshotDir, deps));
  });

  it('reconcilePlaySessionLeaseForExitingDaemon does not remove a newer active lease', () => {
    const deps = { platform: 'win32', isProcessRunning: () => false, listProcesses: () => [] };
    const sessionA = beginCompanionPlaySession({ snapshotPath, launcherPid: 1, sessionId: 'session-a', deps });
    const sessionB = beginCompanionPlaySession({ snapshotPath, launcherPid: 2, sessionId: 'session-b', deps });
    assert.equal(sessionB.ok, true);

    const outcome = reconcilePlaySessionLeaseForExitingDaemon({
      snapshotPath,
      sessionId: sessionA.sessionId,
      daemonPid: 19000,
      deps,
    });
    assert.equal(outcome.action, 'skipped_newer_session');
    assert.equal(readPlaySessionLease(snapshotDir, deps).session_id, 'session-b');
  });

  it('reconcilePlaySessionLeaseAfterFailedDaemonStart refuses when ready marker process still running', () => {
    const deps = {
      platform: 'win32',
      isProcessRunning: (pid) => pid === 8081,
      listProcesses: () => [],
    };
    const session = beginCompanionPlaySession({ snapshotPath, launcherPid: 8080, deps });
    const { writeDaemonReady } = require('../lib/on-demand-daemon-process.cjs');
    writeDaemonReady(snapshotDir, { pid: 8081, ready_at_ms: Date.now(), script: 'companion-on-demand-relay-daemon.cjs' });
    const outcome = reconcilePlaySessionLeaseAfterFailedDaemonStart({
      snapshotPath,
      sessionId: session.sessionId,
      launcherPid: 8080,
      deps,
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, 'daemon_process_still_running_with_ready_marker');
    assert.ok(readPlaySessionLease(snapshotDir, deps));
  });

  it('reconcilePlaySessionLeaseAfterFailedDaemonStart removes lease when game never registered', () => {
    const deps = { platform: 'win32', isProcessRunning: () => false, listProcesses: () => [] };
    const session = beginCompanionPlaySession({ snapshotPath, launcherPid: 8080, deps });
    const outcome = reconcilePlaySessionLeaseAfterFailedDaemonStart({
      snapshotPath,
      sessionId: session.sessionId,
      launcherPid: 8080,
      deps,
    });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.removed, true);
    assert.equal(readPlaySessionLease(snapshotDir, deps), null);
  });

  it('adoptDaemonIntoPlaySessionLease rejects unverified recovery spawn PIDs', () => {
    const deps = { platform: 'win32', isProcessRunning: () => false, listProcesses: () => [] };
    const session = beginCompanionPlaySession({ snapshotPath, launcherPid: 424242, deps });
    const adopted = adoptDaemonIntoPlaySessionLease(snapshotPath, 22276, session.sessionId, deps);
    assert.equal(adopted.ok, false);
    assert.equal(adopted.reason, 'daemon_not_verified_for_adopt');
    assert.deepEqual(readPlaySessionLease(snapshotDir, deps).daemon_pids, []);
  });
});
