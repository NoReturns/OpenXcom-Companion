'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const {
  startOnDemandDaemonVerified,
  stopProcessTree,
  isProcessRunning,
  getProcessCreationIdentity,
  findRunningOnDemandDaemons,
} = require('../lib/on-demand-daemon-process.cjs');
const {
  assessTestSupervisorTick,
  createTestSupervisorWatchdog,
  sha256CommandLineDigest,
  listTestOwnedOnDemandRelayLeaks,
  waitForTestOwnedRelayQuiescence,
  waitForProcessExit,
  SUPERVISOR_MISSING_GRACE_MS,
} = require('../lib/on-demand-test-supervisor.cjs');
const {
  isolatedCommandRelayStateDir,
  fingerprintProductionCommandRelayJournal,
  assertProductionCommandRelayJournalUnchanged,
} = require('../lib/relay-test-isolation.cjs');
const { canonicalSnapshotPath } = require('../lib/on-demand-daemon-ownership.cjs');

function makeRoot(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `m1-supervisor-${label}-`));
  const snapshotPath = path.join(root, 'tactical-live.yaml');
  fs.writeFileSync(snapshotPath, 'tactical: {}\n', 'utf8');
  return { root, snapshotPath, snapshotDir: path.dirname(snapshotPath) };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readManifestSafe(manifestPath) {
  if (!fs.existsSync(manifestPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return undefined;
  }
}

function assertUnexpectedWorkerDeath(manifestPath, workerLabel, workerPid, daemonPid) {
  const manifest = readManifestSafe(manifestPath);
  throw new Error(
    `${workerLabel} pid ${workerPid} exited unexpectedly before intentional shutdown; `
    + `daemon=${daemonPid} running=${isProcessRunning(daemonPid)} `
    + `manifest=${JSON.stringify(manifest ?? 'unreadable')}`,
  );
}

function killProcessForced(pid, context = '') {
  if (!isProcessRunning(pid)) {
    throw new Error(`refusing kill: process ${pid} already exited ${context}`.trim());
  }
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } catch (error) {
      if (!isProcessRunning(pid)) {
        return;
      }
      throw error;
    }
    return;
  }
  process.kill(pid, 'SIGKILL');
}

async function waitForWorkerReady(manifestPath, { label = 'worker', timeoutMs = 45000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(manifestPath)) {
      const manifest = readManifestSafe(manifestPath);
      if (manifest === undefined) {
        await sleep(25);
        continue;
      }
      if (!manifest) {
        await sleep(50);
        continue;
      }
      if (manifest.phase === 'failed' || manifest.phase === 'unexpected_daemon_exit') {
        throw new Error(`${label} failed early: ${manifest.start_error || manifest.phase}`);
      }
      if (manifest.phase === 'ready' && manifest.daemon_pid && manifest.worker_pid) {
        const heartbeatAge = Date.now() - (manifest.last_heartbeat_ms ?? 0);
        if (heartbeatAge > 2500) {
          throw new Error(`${label} stale heartbeat (${heartbeatAge}ms) — worker may have crashed`);
        }
        if (!isProcessRunning(manifest.worker_pid)) {
          throw new Error(`${label} worker ${manifest.worker_pid} not running at ready handshake`);
        }
        if (!isProcessRunning(manifest.daemon_pid)) {
          throw new Error(`${label} daemon ${manifest.daemon_pid} not running at ready handshake`);
        }
        return manifest;
      }
    }
    await sleep(200);
  }
  throw new Error(`${label} ready handshake timed out after ${timeoutMs}ms`);
}

async function waitForDaemonExit(daemonPid, timeoutMs = SUPERVISOR_MISSING_GRACE_MS + 8000) {
  const outcome = waitForProcessExit(daemonPid, { maxMs: timeoutMs, pollMs: 100 });
  return outcome.ok;
}

describe('on-demand test supervisor ownership', () => {
  let productionBefore;
  const spawnedDaemonPids = [];
  const spawnedWorkerPids = [];

  beforeEach(() => {
    productionBefore = fingerprintProductionCommandRelayJournal();
  });

  afterEach(async () => {
    const tracked = new Set([
      ...spawnedWorkerPids.splice(0),
      ...spawnedDaemonPids.splice(0),
    ]);
    for (const pid of tracked) {
      if (isProcessRunning(pid)) {
        stopProcessTree(pid);
      }
    }
    const trackedExit = [...tracked].map((pid) => waitForProcessExit(pid, { maxMs: SUPERVISOR_MISSING_GRACE_MS + 5000 }));
    const quiescence = waitForTestOwnedRelayQuiescence({ maxMs: SUPERVISOR_MISSING_GRACE_MS + 12_000 });
    if (!quiescence.ok) {
      throw new Error(
        `test-owned relay quiescence failed after tracked shutdown: ${JSON.stringify({ trackedExit, remaining: quiescence.remaining })}`,
      );
    }
    assertProductionCommandRelayJournalUnchanged(
      productionBefore,
      fingerprintProductionCommandRelayJournal(),
    );
  });

  it('rejects PID reuse when supervisor creation time changes', () => {
    const boundCreation = Date.now() - 60_000;
    const reusedCreation = boundCreation + 120_000;
    const state = {
      supervisorPid: 4242,
      supervisorCreationMs: boundCreation,
      supervisorCommandDigest: sha256CommandLineDigest('node --test file.test.cjs'),
    };
    const deps = {
      isProcessRunning: () => true,
      getProcessCreationIdentity: () => ({
        ok: true,
        creationMs: reusedCreation,
        executablePath: process.execPath,
        commandLine: 'node --test file.test.cjs',
      }),
    };
    const tick = assessTestSupervisorTick(state, deps);
    assert.equal(tick.action, 'shutdown');
    assert.equal(tick.reason, 'supervisor_pid_reuse');
  });

  it('starts daemon with supervisor binding under isolated relay state', async () => {
    const { snapshotPath, snapshotDir } = makeRoot('bind');
    const relayStateDir = isolatedCommandRelayStateDir(path.dirname(snapshotDir), 'relay-state');
    const daemonScript = path.join(__dirname, '..', 'companion-on-demand-relay-daemon.cjs');

    const start = startOnDemandDaemonVerified({
      snapshotPath,
      daemonScript,
      cwd: path.dirname(daemonScript),
      commandRelayStateDir: relayStateDir,
      extraArgs: ['--dry-run'],
      timeoutMs: 30000,
    });
    assert.equal(start.ok, true, start.error || 'startup failed');
    spawnedDaemonPids.push(start.pid);

  const procs = findRunningOnDemandDaemons();
    const row = procs.find((p) => p.pid === start.pid);
    assert.ok(row, 'daemon should appear in process inventory');
    assert.match(row.commandLine, /--test-supervisor-pid\s+\d+/);

    stopProcessTree(start.pid);
    await sleep(800);
    assert.equal(isProcessRunning(start.pid), false, 'daemon must exit after explicit stop');
  });

  it('terminates daemon when supervisor worker is killed abruptly', async () => {
    const { snapshotPath, snapshotDir } = makeRoot('forced');
    const manifestPath = path.join(snapshotDir, 'worker-manifest.json');
    const workerScript = path.join(__dirname, 'helpers', 'test-supervisor-daemon-worker.cjs');

    const worker = spawn(process.execPath, [
      workerScript,
      manifestPath,
      snapshotPath,
      'relay-state-forced',
      'dry-run',
    ], {
      cwd: path.dirname(workerScript),
      env: { ...process.env, NODE_TEST_CONTEXT: '' },
      stdio: 'ignore',
      windowsHide: true,
    });
    spawnedWorkerPids.push(worker.pid);

    const manifest = await waitForWorkerReady(manifestPath, { label: 'forced' });
    const daemonPid = manifest.daemon_pid;
    assert.ok(isProcessRunning(worker.pid), 'worker must remain alive before forced kill');
    killProcessForced(worker.pid);
    assert.equal(await waitForDaemonExit(daemonPid), true, 'daemon must exit after supervisor death');
  });

  it('keeps daemon alive while supervisor remains running', async () => {
    const { snapshotPath, snapshotDir } = makeRoot('long');
    const manifestPath = path.join(snapshotDir, 'worker-manifest-long.json');
    const workerScript = path.join(__dirname, 'helpers', 'test-supervisor-daemon-worker.cjs');

    const worker = spawn(process.execPath, [
      workerScript,
      manifestPath,
      snapshotPath,
      'relay-state-long',
      'dry-run',
    ], {
      cwd: path.dirname(workerScript),
      env: { ...process.env, NODE_TEST_CONTEXT: '' },
      stdio: 'ignore',
      windowsHide: true,
    });
    spawnedWorkerPids.push(worker.pid);

    const manifest = await waitForWorkerReady(manifestPath, { label: 'long' });
    await sleep(3500);
    assert.equal(isProcessRunning(manifest.worker_pid), true, 'worker should remain alive');
    assert.equal(isProcessRunning(manifest.daemon_pid), true, 'daemon should remain alive with supervisor');

    killProcessForced(worker.pid);
    assert.equal(await waitForDaemonExit(manifest.daemon_pid), true);
  });

  it('concurrent independent supervisors do not cross-terminate', async () => {
    const drainBefore = waitForTestOwnedRelayQuiescence({ maxMs: SUPERVISOR_MISSING_GRACE_MS + 15_000 });
    assert.equal(drainBefore.ok, true, `prior test relay drain failed: ${JSON.stringify(drainBefore)}`);

    const a = makeRoot('concurrent-a');
    const b = makeRoot('concurrent-b');
    const manifestA = path.join(a.snapshotDir, 'manifest-a.json');
    const manifestB = path.join(b.snapshotDir, 'manifest-b.json');
    const workerScript = path.join(__dirname, 'helpers', 'test-supervisor-daemon-worker.cjs');

    const workerA = spawn(process.execPath, [workerScript, manifestA, a.snapshotPath, 'relay-a', 'dry-run'], {
      env: { ...process.env, NODE_TEST_CONTEXT: '' },
      stdio: 'ignore',
      windowsHide: true,
    });
    const workerB = spawn(process.execPath, [workerScript, manifestB, b.snapshotPath, 'relay-b', 'dry-run'], {
      env: { ...process.env, NODE_TEST_CONTEXT: '' },
      stdio: 'ignore',
      windowsHide: true,
    });
    spawnedWorkerPids.push(workerA.pid, workerB.pid);

    const [ma, mb] = await Promise.all([
      waitForWorkerReady(manifestA, { label: 'workerA' }),
      waitForWorkerReady(manifestB, { label: 'workerB' }),
    ]);
    spawnedDaemonPids.push(ma.daemon_pid, mb.daemon_pid);
    assert.notEqual(ma.daemon_pid, mb.daemon_pid);
    assert.equal(workerA.pid, ma.worker_pid);
    assert.equal(workerB.pid, mb.worker_pid);
    assert.equal(isProcessRunning(workerA.pid), true);
    assert.equal(isProcessRunning(workerB.pid), true);
    assert.equal(isProcessRunning(ma.daemon_pid), true);
    assert.equal(isProcessRunning(mb.daemon_pid), true);

    killProcessForced(workerA.pid, 'workerA intentional kill');
    const daemonAExit = waitForProcessExit(ma.daemon_pid);
    assert.equal(daemonAExit.ok, true, `daemon A lingered ${JSON.stringify(daemonAExit)}`);
    if (isProcessRunning(workerB.pid)) {
      assert.equal(isProcessRunning(mb.daemon_pid), true, 'daemon B must remain alive after A killed');
    } else {
      assertUnexpectedWorkerDeath(manifestB, 'workerB', workerB.pid, mb.daemon_pid);
    }

    if (!isProcessRunning(workerB.pid)) {
      assertUnexpectedWorkerDeath(manifestB, 'workerB', workerB.pid, mb.daemon_pid);
    }
    killProcessForced(workerB.pid, 'workerB intentional kill');
    const daemonBExit = waitForProcessExit(mb.daemon_pid);
    assert.equal(daemonBExit.ok, true, `daemon B lingered ${JSON.stringify(daemonBExit)}`);
    const quiescence = waitForTestOwnedRelayQuiescence({ maxMs: SUPERVISOR_MISSING_GRACE_MS + 12_000 });
    assert.equal(quiescence.ok, true, JSON.stringify(quiescence));
  });

  it('production-style spawn args do not attach test supervisor', () => {
    const identity = getProcessCreationIdentity(process.pid);
    const watchdog = createTestSupervisorWatchdog({
      supervisorPid: process.pid,
      supervisorCreationMs: identity.creationMs,
      supervisorCommandDigest: sha256CommandLineDigest(identity.commandLine),
    });
    assert.equal(typeof watchdog.beforeTick, 'function');
    const leaks = listTestOwnedOnDemandRelayLeaks({
      listProcesses: () => ([{
        pid: 1,
        commandLine: `"${process.execPath}" companion-on-demand-relay-daemon.cjs --snapshot-path "E:\\\\Open X-Com Companion\\\\local\\\\m0\\\\tactical-live.yaml"`,
      }]),
    });
    assert.equal(leaks.length, 0);
  });
});
