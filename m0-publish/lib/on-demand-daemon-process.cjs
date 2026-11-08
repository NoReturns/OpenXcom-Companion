'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { detectRunningSidecars } = require('./companion-relay-launcher.cjs');
const { execFileSyncHidden } = require('./exec-file-sync.cjs');

function loadDiagnostics() {
  return require('./on-demand-daemon-diagnostics.cjs');
}

function loadHealth() {
  return require('./on-demand-daemon-health.cjs');
}

function loadOwnership() {
  return require('./on-demand-daemon-ownership.cjs');
}

const DAEMON_SCRIPT_NAME = 'companion-on-demand-relay-daemon.cjs';
const PID_FILENAME = '.companion-on-demand-daemon.pid';
const READY_FILENAME = '.companion-on-demand-daemon-ready.json';
const START_LOCK_FILENAME = '.companion-on-demand-daemon-start.lock';
const DEFAULT_STARTUP_TIMEOUT_MS = 15000;
const CANONICAL_STARTUP_TIMEOUT_MS = 30000;
const STARTUP_POST_DEADLINE_VERIFY_MS = 5000;
const DEFAULT_STARTUP_POLL_MS = 50;
const START_LOCK_STALE_MS = 30000;

let inProcessEnsurePromise = null;

function resolveDaemonReadyPath(snapshotDir) {
  return path.join(snapshotDir, READY_FILENAME);
}

function readDaemonReady(snapshotDir, io = {}) {
  const readyPath = resolveDaemonReadyPath(snapshotDir);
  const existsSync = io.existsSync ?? fs.existsSync;
  const readFileSync = io.readFileSync ?? fs.readFileSync;
  if (!existsSync(readyPath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(readyPath, 'utf8'));
  } catch {
    return null;
  }
}

function writeDaemonReady(snapshotDir, payload, io = {}) {
  const readyPath = resolveDaemonReadyPath(snapshotDir);
  const writeFileSync = io.writeFileSync ?? fs.writeFileSync;
  const renameSync = io.renameSync ?? fs.renameSync;
  const { writeJsonAtomic } = require('./local-atomic.cjs');
  writeJsonAtomic(readyPath, payload, writeFileSync, renameSync);
}

function removeDaemonReady(snapshotDir, io = {}, meta = {}) {
  const { readOwnershipRecord, ownershipMatchesToken } = loadOwnership();
  const ownershipToken = meta.ownershipToken;
  if (ownershipToken) {
    const record = readOwnershipRecord(snapshotDir, io);
    if (!ownershipMatchesToken(record, ownershipToken)) {
      return false;
    }
  }
  const readyPath = resolveDaemonReadyPath(snapshotDir);
  const existsSync = io.existsSync ?? fs.existsSync;
  const unlinkSync = io.unlinkSync ?? fs.unlinkSync;
  if (existsSync(readyPath)) {
    unlinkSync(readyPath);
  }
  return true;
}

function sleepStartupPollMs(ms, deps = {}) {
  if (ms <= 0) {
    return;
  }
  if (deps.sleepSync) {
    deps.sleepSync(ms);
    return;
  }
  if (process.platform === 'win32') {
    execFileSyncHidden('powershell.exe', ['-NoProfile', '-Command', `Start-Sleep -Milliseconds ${ms}`], {
      stdio: 'ignore',
    });
    return;
  }
    const { execFileSync } = require('node:child_process');
    execFileSync('sleep', [String(Math.max(1, Math.ceil(ms / 1000)))], { stdio: 'ignore' });
}

/** Detach daemon child so the startup helper Node process can exit (M1-25E4). */
function releaseSpawnedDaemonChild(child) {
  if (!child) {
    return;
  }
  child.removeAllListeners('exit');
  child.removeAllListeners('error');
  if (typeof child.unref === 'function') {
    child.unref();
  }
}

function resolveStartLockPath(snapshotDir) {
  return path.join(snapshotDir, START_LOCK_FILENAME);
}

function readStartLock(snapshotDir, io = {}) {
  const existsSync = io.existsSync ?? fs.existsSync;
  const readFileSync = io.readFileSync ?? fs.readFileSync;
  const lockPath = resolveStartLockPath(snapshotDir);
  if (!existsSync(lockPath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

function writeStartLock(snapshotDir, payload, io = {}) {
  const writeFileSync = io.writeFileSync ?? fs.writeFileSync;
  writeFileSync(resolveStartLockPath(snapshotDir), `${JSON.stringify(payload)}\n`, 'utf8');
}

function removeStartLock(snapshotDir, io = {}) {
  const existsSync = io.existsSync ?? fs.existsSync;
  const unlinkSync = io.unlinkSync ?? fs.unlinkSync;
  const lockPath = resolveStartLockPath(snapshotDir);
  if (existsSync(lockPath)) {
    unlinkSync(lockPath);
  }
}

function acquireStartLock(snapshotDir, deps = {}) {
  const now = Date.now();
  const existing = readStartLock(snapshotDir, deps);
  if (existing && existing.started_at_ms && now - existing.started_at_ms < START_LOCK_STALE_MS) {
    return { acquired: false, lock: existing };
  }
  writeStartLock(snapshotDir, { pid: process.pid, started_at_ms: now }, deps);
  return { acquired: true };
}

function openDaemonStdioLog(snapshotDir, io = {}) {
  const openSync = io.openSync ?? fs.openSync;
  const { resolveDiagnosticsPath } = loadDiagnostics();
  try {
    return openSync(resolveDiagnosticsPath(snapshotDir), 'a');
  } catch {
    return 'ignore';
  }
}

function liveDaemonReuseAllowed(options = {}, deps = {}) {
  if (options.disableLiveDaemonReuse === true) {
    return false;
  }
  const env = deps.env ?? process.env;
  return env.COMPANION_ON_DEMAND_TEST_NO_LIVE_REUSE !== '1';
}

function tryReuseLiveDaemonForStart(snapshotPath, deps, options = {}) {
  if (!liveDaemonReuseAllowed(options, deps)) {
    return null;
  }
  const { tryReuseLiveDaemonBeforeSpawn } = loadOwnership();
  return tryReuseLiveDaemonBeforeSpawn(snapshotPath, deps);
}

function touchStartLock(snapshotDir, deps = {}) {
  writeStartLock(snapshotDir, { pid: process.pid, started_at_ms: Date.now() }, deps);
}

function reconcileOwnershipAfterFailedSpawn(snapshotDir, snapshotPath, spawnPid, deps, via) {
  const { appendDiagnosticEvent } = loadDiagnostics();
  const { clearStaleOwnershipIfSafe } = loadOwnership();
  const cleared = clearStaleOwnershipIfSafe(snapshotDir, snapshotPath, deps);
  if (cleared) {
    appendDiagnosticEvent(snapshotDir, {
      kind: 'ownership_reconciled',
      pid: spawnPid,
      via,
    }, deps);
  }
  return cleared;
}

function waitForEstablishedDaemonReady(snapshotPath, options = {}) {
  const { canonicalSnapshotPath } = loadOwnership();
  const deps = options.deps ?? {};
  const timeoutMs = options.timeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const excludePids = new Set((options.excludePids ?? []).map(Number));
  const snapshotDir = path.dirname(canonicalSnapshotPath(snapshotPath));
  const { verifyDaemonStartupLive } = loadHealth();
  const { discoverLiveDaemonForSnapshot } = loadOwnership();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const live = discoverLiveDaemonForSnapshot(snapshotPath, deps);
    if (live.found) {
      const candidates = live.livePids.filter((pid) => !excludePids.has(pid));
      for (const pid of candidates) {
        const verify = verifyDaemonStartupLive(snapshotPath, pid, deps);
        if (verify.ok) {
          return {
            ok: true,
            pid,
            reused: true,
            verify,
            splitBrain: live.splitBrain,
            livePids: live.livePids,
          };
        }
      }
    }
    if (options.holdStartLock) {
      touchStartLock(snapshotDir, deps);
    }
    sleepStartupPollMs(DEFAULT_STARTUP_POLL_MS, deps);
  }
  return { ok: false, reason: 'verified_ready_timeout' };
}

function finishSpawnReuseFromEstablishedOwner(snapshotPath, snapshotDir, owner, options, deps, finish, ownerLabel) {
  const { appendDiagnosticEvent } = loadDiagnostics();
  appendDiagnosticEvent(snapshotDir, {
    kind: 'startup_ready',
    pid: owner.pid,
    owner: ownerLabel,
    via: options.via ?? 'waited_for_established_owner',
    split_brain: owner.splitBrain,
    live_pids: owner.livePids,
  }, deps);
  return finish({
    ok: true,
    pid: owner.pid,
    startedByUs: false,
    reused: true,
    splitBrain: owner.splitBrain,
    owner: ownerLabel,
  });
}

function resolveDeferredSpawnOwner(snapshotPath, deps, spawnPid, timeoutMs, holdStartLock) {
  const waited = waitForEstablishedDaemonReady(snapshotPath, {
    deps,
    timeoutMs,
    excludePids: spawnPid ? [spawnPid] : [],
    holdStartLock,
  });
  if (waited.ok) {
    return waited;
  }
  return tryReuseLiveDaemonForStart(snapshotPath, deps, {}) || null;
}

function startOnDemandDaemonVerified(options = {}) {
  const { appendDiagnosticEvent } = loadDiagnostics();
  const {
    assessOnDemandDaemonHealth,
    verifyDaemonProcessIdentity,
    writeDaemonHealth,
    DAEMON_STATE,
  } = loadHealth();
  const {
    canonicalSnapshotPath,
    clearStaleOwnershipIfSafe,
  } = loadOwnership();
  const snapshotPath = canonicalSnapshotPath(options.snapshotPath);
  const snapshotDir = path.dirname(snapshotPath);
  const daemonScript = options.daemonScript;
  const timeoutMs = options.timeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_STARTUP_POLL_MS;
  const cwd = options.cwd ?? path.dirname(daemonScript);
  const extraArgs = options.extraArgs ?? [];
  const deps = options.deps ?? {};
  const owner = options.owner ?? 'launcher';
  const useStartLock = options.useStartLock !== false;

  if (!daemonScript || !fs.existsSync(daemonScript)) {
    appendDiagnosticEvent(snapshotDir, {
      kind: 'startup_failed',
      reason: 'missing_script',
      message: `Missing daemon script: ${daemonScript}`,
    }, deps);
    return { ok: false, error: `Missing daemon script: ${daemonScript}` };
  }

  const finish = (result) => result;
  let lockHeld = false;
  if (useStartLock) {
    const lock = acquireStartLock(snapshotDir, deps);
    if (!lock.acquired) {
      sleepStartupPollMs(150, deps);
      const afterWait = assessOnDemandDaemonHealth({ snapshotPath, deps });
      if (liveDaemonReuseAllowed(options, deps) && afterWait.healthy) {
        return finish({
          ok: true,
          pid: afterWait.pid,
          startedByUs: false,
          reused: true,
          health: afterWait,
        });
      }
      const liveReuse = tryReuseLiveDaemonForStart(snapshotPath, deps, options);
      if (liveReuse) {
        return finish({
          ok: true,
          pid: liveReuse.pid,
          startedByUs: false,
          reused: true,
          splitBrain: liveReuse.splitBrain,
        });
      }
      return finish({
        ok: false,
        error: 'On-demand relay daemon startup already in progress.',
        health: afterWait,
      });
    }
    lockHeld = true;
  }

  try {
    const health = assessOnDemandDaemonHealth({ snapshotPath, deps });
    if (liveDaemonReuseAllowed(options, deps) && health.healthy) {
      appendDiagnosticEvent(snapshotDir, {
        kind: 'reuse_healthy_daemon',
        pid: health.pid,
        state: health.state,
      }, deps);
      return finish({ ok: true, pid: health.pid, startedByUs: false, reused: true, health });
    }

    const liveReuse = tryReuseLiveDaemonForStart(snapshotPath, deps, options);
    if (liveReuse) {
      appendDiagnosticEvent(snapshotDir, {
        kind: 'reuse_live_daemon',
        pid: liveReuse.pid,
        split_brain: liveReuse.splitBrain,
        live_pids: liveReuse.livePids,
      }, deps);
      return finish({
        ok: true,
        pid: liveReuse.pid,
        startedByUs: false,
        reused: true,
        splitBrain: liveReuse.splitBrain,
      });
    }

    clearStaleOwnershipIfSafe(snapshotDir, snapshotPath, deps);
    const existingPid = readDaemonPid(snapshotDir, deps);
    if (existingPid && !pidIsRunningForDeps(existingPid, deps)) {
      removeDaemonPid(snapshotDir, deps);
      removeDaemonReady(snapshotDir, deps);
    } else if (
      liveDaemonReuseAllowed(options, deps)
      && existingPid
      && pidIsRunningForDeps(existingPid, deps)
    ) {
      const identity = verifyDaemonProcessIdentity(snapshotPath, existingPid, deps);
      if (identity.ok) {
        appendDiagnosticEvent(snapshotDir, {
          kind: 'reuse_live_daemon',
          pid: existingPid,
          via: 'pid_record',
        }, deps);
        return finish({
          ok: true,
          pid: existingPid,
          startedByUs: false,
          reused: true,
        });
      }
    }

    removeDaemonReady(snapshotDir, deps);
    writeDaemonHealth(snapshotDir, {
      pid: null,
      state: DAEMON_STATE.STARTING,
      owner,
    }, deps);
    appendDiagnosticEvent(snapshotDir, {
      kind: 'spawn_started',
      owner,
      snapshot_path: snapshotPath,
    }, deps);

    const relayStateArgs = options.commandRelayStateDir
      ? ['--command-relay-state-dir', path.resolve(options.commandRelayStateDir)]
      : [];
    const { spawn: spawnProcess } = deps.childProcess ?? require('node:child_process');
    const stdioLogFd = openDaemonStdioLog(snapshotDir, deps);
    let earlyExitCode = null;
    const spawnEnv = { ...(deps.env ?? process.env) };
    if (!liveDaemonReuseAllowed(options, deps)) {
      delete spawnEnv.NODE_TEST_CONTEXT;
    }
    const child = spawnProcess(process.execPath, [
      daemonScript,
      '--snapshot-path',
      snapshotPath,
      ...relayStateArgs,
      ...extraArgs,
    ], {
      cwd,
      env: spawnEnv,
      stdio: ['ignore', stdioLogFd, stdioLogFd],
      windowsHide: true,
      detached: true,
    });
    if (typeof stdioLogFd === 'number') {
      try {
        fs.closeSync(stdioLogFd);
      } catch {
        // parent may close duplicated fd
      }
    }
    child.once('exit', (code) => {
      if (code != null) {
        earlyExitCode = code;
      }
    });
    child.unref();

    const spawnPid = child.pid;
    if (lockHeld) {
      removeStartLock(snapshotDir, deps);
      lockHeld = false;
    }
    const deadline = Date.now() + timeoutMs;
    let lastStartupVerifyFailure = null;
    while (Date.now() < deadline) {
      if (earlyExitCode != null) {
        const remainingMs = Math.max(0, deadline - Date.now());
        const deferredOwner = resolveDeferredSpawnOwner(
          snapshotPath,
          deps,
          spawnPid,
          remainingMs,
          false,
        );
        if (deferredOwner) {
          appendDiagnosticEvent(snapshotDir, {
            kind: 'spawn_child_deferred',
            spawn_pid: spawnPid,
            owner_pid: deferredOwner.pid,
            spawn_exit_code: earlyExitCode,
          }, deps);
          return finishSpawnReuseFromEstablishedOwner(
            snapshotPath,
            snapshotDir,
            deferredOwner,
            { via: 'spawn_deferred_to_owner' },
            deps,
            finish,
            owner,
          );
        }
        writeDaemonHealth(snapshotDir, {
          pid: spawnPid,
          state: DAEMON_STATE.STARTUP_FAILED,
          exit_code: earlyExitCode,
          owner,
        }, deps);
        appendDiagnosticEvent(snapshotDir, {
          kind: 'startup_failed',
          pid: spawnPid,
          exit_code: earlyExitCode,
        }, deps);
        reconcileOwnershipAfterFailedSpawn(snapshotDir, snapshotPath, spawnPid, deps, 'spawn_early_exit');
        return finish({
          ok: false,
          error: earlyExitCode === 0
            ? 'On-demand relay daemon exited before ready marker was written.'
            : `On-demand relay daemon exited during startup (code ${earlyExitCode}).`,
        });
      }
      const pid = readDaemonPid(snapshotDir, deps);
      const ready = readDaemonReady(snapshotDir, deps);
      const livePid = pid ?? spawnPid;
      if (
        options.disableLiveDaemonReuse === true
        && ready
        && spawnPid
        && ready.pid === spawnPid
        && pidIsRunningForDeps(spawnPid, deps)
      ) {
        const { verifyDaemonStartupLive } = loadHealth();
        const verifyStarted = Date.now();
        const isolatedVerify = verifyDaemonStartupLive(snapshotPath, spawnPid, deps);
        appendDiagnosticEvent(snapshotDir, {
          kind: 'startup_poll_verify',
          pid: spawnPid,
          phase: 'isolated_spawn',
          ok: isolatedVerify.ok,
          reason: isolatedVerify.ok ? null : isolatedVerify.reason,
          duration_ms: Date.now() - verifyStarted,
          deadline_ms_remaining: deadline - Date.now(),
        }, deps);
        if (!isolatedVerify.ok) {
          lastStartupVerifyFailure = isolatedVerify;
        } else {
          appendDiagnosticEvent(snapshotDir, {
            kind: 'startup_ready',
            pid: spawnPid,
            owner,
            via: 'isolated_spawn_ready_marker',
          }, deps);
          return finish({ ok: true, pid: spawnPid, startedByUs: true, owner, health: isolatedVerify.health });
        }
      }
      if (ready && livePid && pidIsRunningForDeps(livePid, deps)) {
        const { verifyDaemonStartupLive } = loadHealth();
        const verifyStarted = Date.now();
        const liveVerify = verifyDaemonStartupLive(snapshotPath, livePid, deps);
        appendDiagnosticEvent(snapshotDir, {
          kind: 'startup_poll_verify',
          pid: livePid,
          ok: liveVerify.ok,
          reason: liveVerify.ok ? null : liveVerify.reason,
          duration_ms: Date.now() - verifyStarted,
          deadline_ms_remaining: deadline - Date.now(),
        }, deps);
        if (!liveVerify.ok) {
          lastStartupVerifyFailure = liveVerify;
        }
        if (liveVerify.ok) {
          appendDiagnosticEvent(snapshotDir, {
            kind: 'startup_ready',
            pid: livePid,
            owner,
            via: 'verify_daemon_startup_live',
          }, deps);
          return finish({
            ok: true,
            pid: livePid,
            startedByUs: spawnPid === livePid,
            reused: spawnPid !== livePid,
            owner,
            health: liveVerify.health,
          });
        }
      }
      if (spawnPid && !pidIsRunningForDeps(spawnPid, deps) && !ready) {
        const remainingMs = Math.max(0, deadline - Date.now());
        const deferredOwner = resolveDeferredSpawnOwner(
          snapshotPath,
          deps,
          spawnPid,
          remainingMs,
          false,
        );
        if (deferredOwner) {
          return finishSpawnReuseFromEstablishedOwner(
            snapshotPath,
            snapshotDir,
            deferredOwner,
            { via: 'spawn_exited_existing_owner' },
            deps,
            finish,
            owner,
          );
        }
        writeDaemonHealth(snapshotDir, {
          pid: spawnPid,
          state: DAEMON_STATE.STARTUP_FAILED,
          owner,
        }, deps);
        appendDiagnosticEvent(snapshotDir, {
          kind: 'startup_failed',
          pid: spawnPid,
          reason: 'exited_before_ready',
        }, deps);
        reconcileOwnershipAfterFailedSpawn(snapshotDir, snapshotPath, spawnPid, deps, 'exited_before_ready');
        return finish({
          ok: false,
          error: 'On-demand relay daemon exited during startup (see companion-on-demand-daemon-diagnostics.jsonl).',
        });
      }
      sleepStartupPollMs(pollMs, deps);
    }

    const failPid = readDaemonPid(snapshotDir, deps) ?? spawnPid;
    const readyAtDeadline = readDaemonReady(snapshotDir, deps);
    if (
      failPid
      && readyAtDeadline?.pid === failPid
      && pidIsRunningForDeps(failPid, deps)
    ) {
      const { verifyDaemonStartupLive } = loadHealth();
      const graceDeadline = Date.now() + STARTUP_POST_DEADLINE_VERIFY_MS;
      while (Date.now() < graceDeadline) {
        const verifyStarted = Date.now();
        const graceVerify = verifyDaemonStartupLive(snapshotPath, failPid, deps);
        appendDiagnosticEvent(snapshotDir, {
          kind: 'startup_poll_verify',
          pid: failPid,
          phase: 'post_deadline_grace',
          ok: graceVerify.ok,
          reason: graceVerify.ok ? null : graceVerify.reason,
          duration_ms: Date.now() - verifyStarted,
        }, deps);
        if (graceVerify.ok) {
          appendDiagnosticEvent(snapshotDir, {
            kind: 'startup_ready',
            pid: failPid,
            owner,
            via: 'verify_daemon_startup_live_grace',
          }, deps);
          return finish({
            ok: true,
            pid: failPid,
            startedByUs: spawnPid === failPid,
            reused: false,
            owner,
            health: graceVerify.health,
          });
        }
        lastStartupVerifyFailure = graceVerify;
        sleepStartupPollMs(pollMs, deps);
      }
    }
    if (failPid && options.stopOnTimeout !== false) {
      const owned = readDaemonPidRecord(snapshotDir, deps);
      if (owned && owned.owner === owner) {
        stopProcessTree(failPid, deps);
      }
    }
    removeDaemonReady(snapshotDir, deps);
    writeDaemonHealth(snapshotDir, {
      pid: failPid,
      state: DAEMON_STATE.STARTUP_FAILED,
      reason: 'readiness_timeout',
      owner,
    }, deps);
    appendDiagnosticEvent(snapshotDir, {
      kind: 'startup_timeout',
      pid: failPid,
      timeout_ms: timeoutMs,
    }, deps);
    reconcileOwnershipAfterFailedSpawn(snapshotDir, snapshotPath, failPid, deps, 'startup_timeout');
    if (lastStartupVerifyFailure && !lastStartupVerifyFailure.ok) {
      const { recordStartupVerificationFailure } = loadHealth();
      recordStartupVerificationFailure(snapshotPath, failPid, deps, {
        source: 'node_start_on_demand',
        verifyResult: lastStartupVerifyFailure,
      });
    }
    return finish({
      ok: false,
      error: `On-demand relay daemon did not become ready within ${timeoutMs}ms.`,
    });
  } finally {
    if (lockHeld) {
      removeStartLock(snapshotDir, deps);
    }
  }
}

function waitForHealthyOrLiveDaemon(snapshotPath, deps, waitMs = DEFAULT_STARTUP_TIMEOUT_MS) {
  const { assessOnDemandDaemonHealth } = loadHealth();
  const { tryReuseLiveDaemonBeforeSpawn } = loadOwnership();
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const health = assessOnDemandDaemonHealth({ snapshotPath, deps });
    if (health.healthy) {
      return { ok: true, pid: health.pid, startedByUs: false, reused: true, health };
    }
    const liveReuse = tryReuseLiveDaemonBeforeSpawn(snapshotPath, deps);
    if (liveReuse) {
      return {
        ok: true,
        pid: liveReuse.pid,
        startedByUs: false,
        reused: true,
        splitBrain: liveReuse.splitBrain,
      };
    }
    sleepStartupPollMs(150, deps);
  }
  return null;
}

function ensureOnDemandDaemonRunning(options = {}) {
  const { appendDiagnosticEvent, recordRecoveryAttempt, recoveryAllowed } = loadDiagnostics();
  const { assessOnDemandDaemonHealth } = loadHealth();
  const { canonicalSnapshotPath, tryReuseLiveDaemonBeforeSpawn } = loadOwnership();
  const snapshotPath = canonicalSnapshotPath(options.snapshotPath);
  const snapshotDir = path.dirname(snapshotPath);
  const deps = options.deps ?? {};
  const run = () => {
    const health = assessOnDemandDaemonHealth({ snapshotPath, deps });
    if (health.healthy) {
      return { ok: true, pid: health.pid, startedByUs: false, reused: true, health };
    }
    const liveReuse = tryReuseLiveDaemonBeforeSpawn(snapshotPath, deps);
    if (liveReuse) {
      return {
        ok: true,
        pid: liveReuse.pid,
        startedByUs: false,
        reused: true,
        splitBrain: liveReuse.splitBrain,
      };
    }
    const recovery = recoveryAllowed(snapshotDir, deps);
    if (!recovery.allowed) {
      appendDiagnosticEvent(snapshotDir, {
        kind: 'recovery_bounded',
        attempts: recovery.attempts,
        max: recovery.maxAttempts,
      }, deps);
      return {
        ok: false,
        error: 'On-demand relay daemon recovery limit reached; see companion-on-demand-daemon-diagnostics.jsonl.',
        bounded: true,
        health,
      };
    }
    const lock = acquireStartLock(snapshotDir, deps);
    if (!lock.acquired) {
      const waited = waitForHealthyOrLiveDaemon(
        snapshotPath,
        deps,
        options.waitForStartupMs ?? options.timeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
      );
      if (waited) {
        return waited;
      }
      return {
        ok: false,
        error: 'On-demand relay daemon startup already in progress.',
        health: assessOnDemandDaemonHealth({ snapshotPath, deps }),
      };
    }
    try {
      const racedReuse = tryReuseLiveDaemonBeforeSpawn(snapshotPath, deps);
      if (racedReuse) {
        return {
          ok: true,
          pid: racedReuse.pid,
          startedByUs: false,
          reused: true,
          splitBrain: racedReuse.splitBrain,
        };
      }
    } finally {
      removeStartLock(snapshotDir, deps);
    }
    const outcome = startOnDemandDaemonVerified({
      ...options,
      owner: options.owner ?? 'recovery',
      useStartLock: false,
    });
    recordRecoveryAttempt(snapshotDir, outcome, deps);
    return outcome;
  };

  if (options.singleFlight !== false) {
    if (inProcessEnsurePromise) {
      return inProcessEnsurePromise;
    }
    inProcessEnsurePromise = Promise.resolve().then(run).finally(() => {
      inProcessEnsurePromise = null;
    });
    return inProcessEnsurePromise;
  }
  return Promise.resolve(run());
}

function resolveDaemonPidPath(snapshotDir) {
  return path.join(snapshotDir, PID_FILENAME);
}

function readDaemonPid(snapshotDir, io = {}) {
  const record = readDaemonPidRecord(snapshotDir, io);
  return record && record.pid ? Number(record.pid) : null;
}

function readDaemonPidRecord(snapshotDir, io = {}) {
  const pidPath = resolveDaemonPidPath(snapshotDir);
  const existsSync = io.existsSync ?? fs.existsSync;
  const readFileSync = io.readFileSync ?? fs.readFileSync;
  if (!existsSync(pidPath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(pidPath, 'utf8'));
  } catch {
    return null;
  }
}

function writeDaemonPid(snapshotDir, pid, io = {}, meta = {}) {
  const pidPath = resolveDaemonPidPath(snapshotDir);
  const writeFileSync = io.writeFileSync ?? fs.writeFileSync;
  const renameSync = io.renameSync ?? fs.renameSync;
  const { writeJsonAtomic } = require('./local-atomic.cjs');
  const { readOwnershipRecord, ownershipMatchesToken } = loadOwnership();
  const ownershipToken = meta.ownershipToken;
  if (ownershipToken) {
    const record = readOwnershipRecord(snapshotDir, io);
    if (!ownershipMatchesToken(record, ownershipToken)) {
      return false;
    }
  }
  const creation = defaultGetProcessCreationIdentity(pid, io);
  writeJsonAtomic(pidPath, {
    pid,
    script: DAEMON_SCRIPT_NAME,
    started_at_ms: Date.now(),
    process_creation_ms: creation.ok ? creation.creationMs : null,
    owner: meta.owner ?? 'daemon',
    snapshot_path: meta.snapshotPath,
    ownership_token: ownershipToken,
  }, writeFileSync, renameSync);
  return true;
}

function removeDaemonPid(snapshotDir, io = {}, meta = {}) {
  const { readOwnershipRecord, ownershipMatchesToken } = loadOwnership();
  const ownershipToken = meta.ownershipToken;
  if (ownershipToken) {
    const record = readOwnershipRecord(snapshotDir, io);
    if (!ownershipMatchesToken(record, ownershipToken)) {
      return false;
    }
  }
  const pidPath = resolveDaemonPidPath(snapshotDir);
  const existsSync = io.existsSync ?? fs.existsSync;
  const unlinkSync = io.unlinkSync ?? fs.unlinkSync;
  if (existsSync(pidPath)) {
    unlinkSync(pidPath);
  }
  return true;
}

const PID_CREATION_SKEW_MS = 5000;
const PID_CREATION_BIND_TOLERANCE_MS = 2000;

function parseWmiCreationDateToMs(creationDate) {
  if (!creationDate) {
    return null;
  }
  if (typeof creationDate === 'number' && Number.isFinite(creationDate)) {
    return creationDate;
  }
  const text = String(creationDate);
  const dotnetMatch = text.match(/\/Date\((\d+)/);
  if (dotnetMatch) {
    return Number(dotnetMatch[1]);
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function defaultGetProcessCreationIdentity(pid, deps = {}) {
  if (deps.getProcessCreationIdentity) {
    return deps.getProcessCreationIdentity(pid, deps);
  }
  if (!Number.isFinite(pid) || pid <= 0) {
    return { ok: false, reason: 'invalid_pid' };
  }
  if (process.platform !== 'win32') {
    return {
      ok: true,
      creationMs: null,
      executablePath: null,
      commandLine: null,
    };
  }
  try {
    const script = [
      `$p = Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\" -ErrorAction SilentlyContinue`,
      'if (-not $p) { Write-Output \"{}\"; exit 0 }',
      '$ms = [DateTimeOffset]::new($p.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds()',
      '[pscustomobject]@{ creationMs = $ms; executablePath = $p.ExecutablePath; commandLine = $p.CommandLine } | ConvertTo-Json -Compress',
    ].join('; ');
    const out = execFileSyncHidden('powershell.exe', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!out || out === '{}') {
      return { ok: false, reason: 'process_not_found' };
    }
    const row = JSON.parse(out);
    return {
      ok: true,
      creationMs: parseWmiCreationDateToMs(row.creationMs),
      executablePath: row.executablePath ?? null,
      commandLine: row.commandLine ?? null,
    };
  } catch {
    return { ok: false, reason: 'process_creation_query_failed' };
  }
}

function pidIsRunningForDeps(pid, deps = {}) {
  if (typeof deps.isProcessRunning === 'function') {
    return deps.isProcessRunning(pid);
  }
  return isProcessRunning(pid, deps.platform);
}

function isProcessRunning(pid, platform = process.platform) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  if (platform !== 'win32') {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
  try {
    const out = execFileSyncHidden('powershell.exe', [
      '-NoProfile',
      '-Command',
      `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue) -ne $null`,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out.toLowerCase() === 'true';
  } catch {
    return false;
  }
}

function findRunningOnDemandDaemons(deps = {}) {
  const listFn = deps.listProcesses ?? defaultListOnDemandDaemonProcesses;
  const processes = listFn(deps);
  return processes.filter((proc) => (proc.commandLine || '').includes(DAEMON_SCRIPT_NAME));
}

function defaultListOnDemandDaemonProcesses(deps = {}) {
  if (deps.listProcesses) {
    return deps.listProcesses(deps);
  }
  if (process.platform !== 'win32') {
    return [];
  }
  try {
    const script = 'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*companion-on-demand-relay-daemon.cjs*" } | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress';
    const out = execFileSyncHidden('powershell.exe', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (!out) {
      return [];
    }
    const parsed = JSON.parse(out);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows
      .filter((row) => row && row.ProcessId)
      .filter((row) => !/powershell(\.exe)?/i.test(row.CommandLine || ''))
      .map((row) => ({ pid: row.ProcessId, commandLine: row.CommandLine || '' }));
  } catch {
    return [];
  }
}

function findLegacyContinuousWatchers(deps = {}) {
  return detectRunningSidecars(deps).filter((proc) => proc.kind === 'briefing' || proc.kind === 'command-relay');
}

function stopProcessTree(pid, deps = {}) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  if (deps.requireOwnedPidRecord) {
    const record = readDaemonPidRecord(deps.snapshotDir, deps);
    if (!record || record.pid !== pid) {
      return false;
    }
    if (record.owner && record.owner === 'external') {
      return false;
    }
  }
  if (process.platform === 'win32') {
    try {
      const { execFileSync } = require('node:child_process');
      execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
  try {
    (deps.kill ?? process.kill)(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  DAEMON_SCRIPT_NAME,
  PID_FILENAME,
  READY_FILENAME,
  PID_CREATION_SKEW_MS,
  PID_CREATION_BIND_TOLERANCE_MS,
  DEFAULT_STARTUP_TIMEOUT_MS,
  CANONICAL_STARTUP_TIMEOUT_MS,
  STARTUP_POST_DEADLINE_VERIFY_MS,
  getProcessCreationIdentity: defaultGetProcessCreationIdentity,
  parseWmiCreationDateToMs,
  resolveDaemonPidPath,
  resolveDaemonReadyPath,
  readDaemonPid,
  writeDaemonPid,
  removeDaemonPid,
  readDaemonReady,
  writeDaemonReady,
  removeDaemonReady,
  isProcessRunning,
  findRunningOnDemandDaemons,
  liveDaemonReuseAllowed,
  tryReuseLiveDaemonForStart,
  waitForEstablishedDaemonReady,
  defaultListOnDemandDaemonProcesses,
  findLegacyContinuousWatchers,
  stopProcessTree,
  startOnDemandDaemonVerified,
  ensureOnDemandDaemonRunning,
  releaseSpawnedDaemonChild,
  readDaemonPidRecord,
  acquireStartLock,
  removeStartLock,
};
