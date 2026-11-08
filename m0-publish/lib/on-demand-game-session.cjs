'use strict';

const path = require('node:path');
const { appendDiagnosticEvent } = require('./on-demand-daemon-diagnostics.cjs');
const {
  getProcessCreationIdentity,
  PID_CREATION_SKEW_MS,
} = require('./on-demand-daemon-process.cjs');
const { canonicalSnapshotPath } = require('./on-demand-daemon-ownership.cjs');
const {
  readPlaySessionLease,
  adoptDaemonIntoPlaySessionLease,
  pidIsRunning,
} = require('./on-demand-play-session.cjs');
const {
  discoverLiveDaemonForSnapshot,
  readOwnershipRecord,
} = require('./on-demand-daemon-ownership.cjs');
const {
  listVerifiedDaemonsForSnapshot,
} = require('./on-demand-daemon-health.cjs');

const GAME_INIT_GRACE_MS = 120_000;
const GAME_PID_SPAWN_GRACE_MS = 15_000;
const UNBOUND_DAEMON_MAX_MS = 180_000;
const OPENXCOM_EXE_NAME = 'openxcom.exe';

function gameSessionGateDisabled(deps = {}) {
  const env = deps.env ?? process.env;
  if (env.COMPANION_PLAY_SESSION_GAME_GATE === '0') {
    return true;
  }
  if (deps.disableGameSessionGate === true) {
    return true;
  }
  return false;
}

function isOpenXcomExecutablePath(executablePath) {
  if (!executablePath || typeof executablePath !== 'string') {
    return false;
  }
  return path.basename(executablePath).toLowerCase() === OPENXCOM_EXE_NAME;
}

function verifyOpenXcomGameProcessIdentity(gamePid, lease, deps = {}) {
  if (!Number.isFinite(gamePid) || gamePid <= 0) {
    return { ok: false, alive: false, reason: 'invalid_game_pid' };
  }
  if (!pidIsRunning(gamePid, deps)) {
    return { ok: false, alive: false, reason: 'game_not_running' };
  }
  const creation = getProcessCreationIdentity(gamePid, deps);
  if (creation.ok === false) {
    return { ok: false, alive: false, reason: creation.reason || 'game_process_not_found' };
  }
  if (!isOpenXcomExecutablePath(creation.executablePath)) {
    return { ok: false, alive: true, reason: 'not_openxcom_executable' };
  }
  if (Number.isFinite(lease?.game_creation_ms) && Number.isFinite(creation.creationMs)) {
    if (creation.creationMs < lease.game_creation_ms - PID_CREATION_SKEW_MS) {
      return { ok: false, alive: true, reason: 'game_pid_reuse' };
    }
    if (Math.abs(creation.creationMs - lease.game_creation_ms) > PID_CREATION_SKEW_MS * 3) {
      return { ok: false, alive: true, reason: 'game_creation_mismatch' };
    }
  }
  if (lease?.game_executable_path && creation.executablePath) {
    const expected = String(lease.game_executable_path).toLowerCase();
    const actual = String(creation.executablePath).toLowerCase();
    if (expected !== actual) {
      return { ok: false, alive: true, reason: 'game_executable_mismatch' };
    }
  }
  return {
    ok: true,
    alive: true,
    creationMs: creation.creationMs,
    executablePath: creation.executablePath,
    commandLine: creation.commandLine,
  };
}

function isDaemonSupersededByForeignSession(snapshotPath, daemonPid, boundSessionId, deps = {}) {
  const snapshotDir = path.dirname(canonicalSnapshotPath(snapshotPath));
  const lease = readPlaySessionLease(snapshotDir, deps);
  if (!lease) {
    return false;
  }
  if (boundSessionId && lease.session_id !== boundSessionId) {
    if (Number.isFinite(lease.game_pid) && pidIsRunning(lease.game_pid, deps)) {
      return true;
    }
    if (Number.isFinite(lease.launcher_pid) && pidIsRunning(lease.launcher_pid, deps)) {
      return true;
    }
  }
  const live = discoverLiveDaemonForSnapshot(snapshotPath, deps);
  if (live.splitBrain && Array.isArray(lease.daemon_pids)) {
    const registered = new Set(lease.daemon_pids);
    if (!registered.has(daemonPid) && live.livePids.some((pid) => registered.has(pid))) {
      return true;
    }
  }
  return false;
}

function assessDaemonGameSessionTick(state, deps = {}) {
  if (gameSessionGateDisabled(deps)) {
    return { action: 'continue', reason: 'gate_disabled' };
  }
  const now = deps.nowMs ?? Date.now();
  const snapshotDir = path.dirname(canonicalSnapshotPath(state.snapshotPath));
  const lease = readPlaySessionLease(snapshotDir, deps);

  if (state.shutdownRequested) {
    return { action: 'shutdown', reason: state.shutdownReason || 'shutdown_requested' };
  }

  if (isDaemonSupersededByForeignSession(
    state.snapshotPath,
    state.daemonPid,
    state.boundSessionId,
    deps,
  )) {
    return { action: 'shutdown', reason: 'foreign_play_session_active' };
  }

  if (!lease) {
    if (now - state.daemonStartedAtMs > UNBOUND_DAEMON_MAX_MS) {
      return { action: 'shutdown', reason: 'no_lease_fail_closed' };
    }
    return { action: 'grace', reason: 'awaiting_lease' };
  }

  if (!state.boundSessionId) {
    state.boundSessionId = lease.session_id;
  } else if (state.boundSessionId !== lease.session_id) {
    return { action: 'shutdown', reason: 'lease_session_replaced' };
  }

  adoptDaemonIntoPlaySessionLease(state.snapshotPath, state.daemonPid, lease.session_id, deps);

  if (!Number.isFinite(lease.game_pid)) {
    const launcherAlive = Number.isFinite(lease.launcher_pid)
      && pidIsRunning(lease.launcher_pid, deps);
    const withinInitGrace = (now - (lease.claimed_at_ms ?? state.daemonStartedAtMs)) < GAME_INIT_GRACE_MS;
    if (launcherAlive || withinInitGrace) {
      return { action: 'grace', reason: 'awaiting_game_pid' };
    }
    return { action: 'shutdown', reason: 'game_never_registered' };
  }

  const gameIdentity = verifyOpenXcomGameProcessIdentity(lease.game_pid, lease, deps);
  if (!gameIdentity.alive) {
    if (state.gameEverVerified) {
      return { action: 'shutdown', reason: 'game_exited' };
    }
    const registeredAt = lease.game_registered_at_ms ?? lease.updated_at_ms ?? now;
    if (now - registeredAt < GAME_PID_SPAWN_GRACE_MS) {
      return { action: 'grace', reason: 'awaiting_game_process' };
    }
    return { action: 'shutdown', reason: 'game_exited_before_bind' };
  }

  if (!gameIdentity.ok) {
    return { action: 'shutdown', reason: gameIdentity.reason || 'game_identity_failed' };
  }

  state.gameEverVerified = true;
  state.lastVerifiedGamePid = lease.game_pid;

  const ownership = readOwnershipRecord(snapshotDir, deps);
  const inventory = listVerifiedDaemonsForSnapshot(state.snapshotPath, deps);
  if (inventory.splitBrain && ownership && ownership.pid !== state.daemonPid) {
    const registered = new Set(lease.daemon_pids ?? []);
    if (!registered.has(state.daemonPid) && registered.has(ownership.pid)) {
      return { action: 'shutdown', reason: 'unregistered_split_brain_daemon' };
    }
  }

  return { action: 'continue', reason: 'game_active', gamePid: lease.game_pid };
}

function assertCommandDeliveryAllowed(snapshotPath, options = {}) {
  const deps = options.deps ?? {};
  if (gameSessionGateDisabled(deps)) {
    return { ok: true, reason: 'gate_disabled' };
  }
  const watchdog = options.gameSessionWatchdog;
  if (watchdog && typeof watchdog.acceptingRequests === 'function' && !watchdog.acceptingRequests()) {
    return { ok: false, reason: 'game_session_closed' };
  }
  const snapshotDir = path.dirname(canonicalSnapshotPath(snapshotPath));
  const lease = readPlaySessionLease(snapshotDir, deps);
  if (!lease) {
    return { ok: false, reason: 'play_session_lease_missing' };
  }
  if (watchdog?.state?.boundSessionId && lease.session_id !== watchdog.state.boundSessionId) {
    return { ok: false, reason: 'lease_session_replaced' };
  }
  if (!Number.isFinite(lease.game_pid)) {
    return { ok: false, reason: 'game_not_bound' };
  }
  const gameIdentity = verifyOpenXcomGameProcessIdentity(lease.game_pid, lease, deps);
  if (!gameIdentity.alive) {
    return { ok: false, reason: gameIdentity.reason || 'game_not_running' };
  }
  if (!gameIdentity.ok) {
    return { ok: false, reason: gameIdentity.reason || 'game_identity_failed' };
  }
  const state = watchdog?.state ?? {
    snapshotPath: canonicalSnapshotPath(snapshotPath),
    daemonPid: options.daemonPid ?? process.pid,
    daemonStartedAtMs: Date.now(),
    boundSessionId: lease.session_id,
    gameEverVerified: true,
  };
  const tick = assessDaemonGameSessionTick(state, deps);
  if (tick.action === 'shutdown') {
    return { ok: false, reason: tick.reason || 'game_session_shutdown' };
  }
  return { ok: true, reason: 'ok', gamePid: lease.game_pid, sessionId: lease.session_id };
}

function createGameSessionWatchdog(options = {}) {
  const snapshotPath = canonicalSnapshotPath(options.snapshotPath);
  const snapshotDir = path.dirname(snapshotPath);
  const deps = options.deps ?? {};
  const state = {
    snapshotPath,
    daemonPid: options.daemonPid ?? process.pid,
    daemonStartedAtMs: options.startedAtMs ?? Date.now(),
    boundSessionId: options.boundSessionId ?? null,
    gameEverVerified: false,
    lastVerifiedGamePid: null,
    acceptingRequests: true,
    shutdownRequested: false,
    shutdownReason: null,
  };

  const requestShutdown = (reason) => {
    if (state.shutdownRequested) {
      return;
    }
    state.shutdownRequested = true;
    state.shutdownReason = reason;
    state.acceptingRequests = false;
    appendDiagnosticEvent(snapshotDir, {
      kind: 'game_session_shutdown_requested',
      pid: state.daemonPid,
      reason,
    }, deps);
    if (typeof options.onShutdown === 'function') {
      options.onShutdown(reason);
    }
  };

  return {
    state,
    async beforeTick() {
      const assessment = assessDaemonGameSessionTick(state, deps);
      if (assessment.action === 'shutdown') {
        requestShutdown(assessment.reason);
        return 'shutdown';
      }
      if (assessment.action === 'grace') {
        return 'grace';
      }
      return 'continue';
    },
    acceptingRequests() {
      if (gameSessionGateDisabled(deps)) {
        return true;
      }
      return state.acceptingRequests && !state.shutdownRequested;
    },
    requestShutdown,
    assess: () => assessDaemonGameSessionTick(state, deps),
  };
}

module.exports = {
  GAME_INIT_GRACE_MS,
  GAME_PID_SPAWN_GRACE_MS,
  UNBOUND_DAEMON_MAX_MS,
  OPENXCOM_EXE_NAME,
  gameSessionGateDisabled,
  verifyOpenXcomGameProcessIdentity,
  assertCommandDeliveryAllowed,
  assessDaemonGameSessionTick,
  createGameSessionWatchdog,
  isOpenXcomExecutablePath,
};
