'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { writeJsonAtomic } = require('./local-atomic.cjs');
const { appendDiagnosticEvent } = require('./on-demand-daemon-diagnostics.cjs');
const {
  canonicalSnapshotPath,
  readOwnershipRecord,
  discoverLiveDaemonForSnapshot,
  ownershipMatchesToken,
} = require('./on-demand-daemon-ownership.cjs');
const {
  DAEMON_STATE,
  listVerifiedDaemonsForSnapshot,
  reconcileDaemonMarkersForStoppedPid,
  verifyDaemonProcessIdentityForPid,
} = require('./on-demand-daemon-health.cjs');
const {
  isProcessRunning,
  stopProcessTree,
  DAEMON_SCRIPT_NAME,
  getProcessCreationIdentity,
} = require('./on-demand-daemon-process.cjs');

function pidIsRunning(pid, deps = {}) {
  if (typeof deps.isProcessRunning === 'function') {
    return deps.isProcessRunning(pid);
  }
  return isProcessRunning(pid, deps.platform);
}

const PLAY_SESSION_LEASE_FILENAME = '.companion-play-session-lease.json';
const PLAY_SESSION_SCHEMA_VERSION = 1;

function resolvePlaySessionLeasePath(snapshotDir) {
  return path.join(snapshotDir, PLAY_SESSION_LEASE_FILENAME);
}

function readPlaySessionLease(snapshotDir, io = {}) {
  const existsSync = io.existsSync ?? fs.existsSync;
  const readFileSync = io.readFileSync ?? fs.readFileSync;
  const leasePath = resolvePlaySessionLeasePath(snapshotDir);
  if (!existsSync(leasePath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(leasePath, 'utf8'));
  } catch {
    return null;
  }
}

function writePlaySessionLease(snapshotDir, payload, io = {}) {
  const writeFileSync = io.writeFileSync ?? fs.writeFileSync;
  const renameSync = io.renameSync ?? fs.renameSync;
  writeJsonAtomic(resolvePlaySessionLeasePath(snapshotDir), {
    schema_version: PLAY_SESSION_SCHEMA_VERSION,
    updated_at_ms: Date.now(),
    ...payload,
  }, writeFileSync, renameSync);
}

function removePlaySessionLease(snapshotDir, io = {}) {
  const existsSync = io.existsSync ?? fs.existsSync;
  const unlinkSync = io.unlinkSync ?? fs.unlinkSync;
  const leasePath = resolvePlaySessionLeasePath(snapshotDir);
  if (existsSync(leasePath)) {
    unlinkSync(leasePath);
  }
}

function isForeignPlaySessionActive(lease, sessionId, deps = {}) {
  if (!lease || !lease.session_id) {
    return false;
  }
  if (sessionId && lease.session_id === sessionId) {
    return false;
  }
  if (Number.isFinite(lease.game_pid) && pidIsRunning(lease.game_pid, deps)) {
    return true;
  }
  if (Number.isFinite(lease.launcher_pid) && pidIsRunning(lease.launcher_pid, deps)) {
    return true;
  }
  return false;
}

function normalizePidList(pids) {
  const out = new Set();
  for (const pid of pids ?? []) {
    const n = Number(pid);
    if (Number.isFinite(n) && n > 0) {
      out.add(n);
    }
  }
  return [...out].sort((a, b) => a - b);
}

function reconcilePlaySessionLeaseAfterFailedDaemonStart(options = {}) {
  const snapshotPath = canonicalSnapshotPath(options.snapshotPath);
  const snapshotDir = path.dirname(snapshotPath);
  const deps = options.deps ?? {};
  const sessionId = options.sessionId;
  const launcherPid = options.launcherPid != null ? Number(options.launcherPid) : null;
  if (!sessionId) {
    return { ok: false, reason: 'session_id_required' };
  }
  const lease = readPlaySessionLease(snapshotDir, deps);
  if (!lease || lease.session_id !== sessionId) {
    return { ok: true, action: 'lease_replaced_or_missing' };
  }
  if (launcherPid != null && Number(lease.launcher_pid) !== launcherPid) {
    return { ok: true, action: 'launcher_mismatch' };
  }
  if (Number.isFinite(lease.game_pid) && pidIsRunning(lease.game_pid, deps)) {
    return { ok: false, reason: 'game_still_running', deferred: true };
  }
  const inventory = listVerifiedDaemonsForSnapshot(snapshotPath, deps);
  if (inventory.verified.length > 0) {
    return { ok: false, reason: 'verified_daemon_still_live' };
  }
  const { readDaemonReady } = require('./on-demand-daemon-process.cjs');
  const ready = readDaemonReady(snapshotDir, deps);
  if (ready?.pid && pidIsRunning(ready.pid, deps)) {
    return { ok: false, reason: 'daemon_process_still_running_with_ready_marker' };
  }
  removePlaySessionLease(snapshotDir, deps);
  appendDiagnosticEvent(snapshotDir, {
    kind: 'play_session_lease_reconciled',
    session_id: sessionId,
    via: 'failed_daemon_start',
    launcher_pid: launcherPid,
  }, deps);
  return { ok: true, action: 'lease_removed', removed: true };
}

function beginCompanionPlaySession(options = {}) {
  const snapshotPath = canonicalSnapshotPath(options.snapshotPath);
  const snapshotDir = path.dirname(snapshotPath);
  const deps = options.deps ?? {};
  const launcherPid = Number(options.launcherPid ?? process.pid);
  const nowMs = options.nowMs ?? Date.now();

  const existing = readPlaySessionLease(snapshotDir, deps);
  if (existing && isForeignPlaySessionActive(existing, null, deps)) {
    appendDiagnosticEvent(snapshotDir, {
      kind: 'play_session_begin_blocked',
      reason: 'foreign_play_session_active',
      foreign_session_id: existing.session_id,
      foreign_game_pid: existing.game_pid ?? null,
    }, deps);
    return {
      ok: false,
      error: 'Another companion play session is still active for this snapshot.',
      blocker: 'foreign_play_session_active',
      lease: existing,
    };
  }

  const sessionId = options.sessionId ?? crypto.randomBytes(16).toString('hex');
  const lease = {
    session_id: sessionId,
    snapshot_path: snapshotPath,
    launcher_pid: launcherPid,
    game_pid: null,
    daemon_pids: normalizePidList(options.daemonPids),
    claimed_at_ms: nowMs,
  };
  writePlaySessionLease(snapshotDir, lease, deps);
  appendDiagnosticEvent(snapshotDir, {
    kind: 'play_session_began',
    session_id: sessionId,
    launcher_pid: launcherPid,
  }, deps);
  return { ok: true, sessionId, lease };
}

function updatePlaySessionLease(snapshotDir, sessionId, patch, io = {}) {
  const lease = readPlaySessionLease(snapshotDir, io);
  if (!lease || lease.session_id !== sessionId) {
    return { ok: false, reason: 'lease_mismatch' };
  }
  const next = {
    ...lease,
    ...patch,
    session_id: sessionId,
    daemon_pids: patch.daemon_pids
      ? normalizePidList(patch.daemon_pids)
      : normalizePidList(lease.daemon_pids),
    updated_at_ms: Date.now(),
  };
  writePlaySessionLease(snapshotDir, next, io);
  return { ok: true, lease: next };
}

function registerPlaySessionDaemonPid(snapshotPath, sessionId, daemonPid, deps = {}) {
  const snapshotDir = path.dirname(canonicalSnapshotPath(snapshotPath));
  const lease = readPlaySessionLease(snapshotDir, deps);
  if (!lease || lease.session_id !== sessionId) {
    return { ok: false, reason: 'lease_mismatch' };
  }
  const daemonPids = normalizePidList([...(lease.daemon_pids ?? []), daemonPid]);
  return updatePlaySessionLease(snapshotDir, sessionId, { daemon_pids: daemonPids }, deps);
}

function registerPlaySessionGamePid(snapshotPath, sessionId, gamePid, deps = {}) {
  const snapshotDir = path.dirname(canonicalSnapshotPath(snapshotPath));
  const lease = readPlaySessionLease(snapshotDir, deps);
  if (!lease || lease.session_id !== sessionId) {
    return { ok: false, reason: 'lease_mismatch' };
  }
  const nowMs = deps.nowMs ?? Date.now();
  const identity = getProcessCreationIdentity(Number(gamePid), deps);
  const patch = {
    game_pid: Number(gamePid),
    game_registered_at_ms: nowMs,
  };
  if (identity.ok !== false) {
    if (identity.executablePath) {
      patch.game_executable_path = identity.executablePath;
    }
    if (Number.isFinite(identity.creationMs)) {
      patch.game_creation_ms = identity.creationMs;
    }
  }
  return updatePlaySessionLease(snapshotDir, sessionId, patch, deps);
}

function adoptDaemonIntoPlaySessionLease(snapshotPath, daemonPid, sessionId, deps = {}) {
  const snapshotDir = path.dirname(canonicalSnapshotPath(snapshotPath));
  const lease = readPlaySessionLease(snapshotDir, deps);
  if (!lease || lease.session_id !== sessionId) {
    return { ok: false, reason: 'lease_mismatch' };
  }
  const verified = verifyDaemonProcessIdentityForPid(snapshotPath, Number(daemonPid), deps);
  if (!verified.ok) {
    return { ok: false, reason: 'daemon_not_verified_for_adopt', detail: verified.reason };
  }
  const prior = normalizePidList(lease.daemon_pids);
  const daemonPids = normalizePidList([...prior, daemonPid]);
  if (daemonPids.length === prior.length) {
    return { ok: true, adopted: false, lease };
  }
  const updated = updatePlaySessionLease(snapshotDir, sessionId, { daemon_pids: daemonPids }, deps);
  appendDiagnosticEvent(snapshotDir, {
    kind: 'play_session_daemon_adopted',
    session_id: sessionId,
    pid: daemonPid,
  }, deps);
  return { ...updated, adopted: true };
}

function classifyShutdownTargets(snapshotPath, sessionId, deps = {}) {
  const snapshotDir = path.dirname(canonicalSnapshotPath(snapshotPath));
  const lease = readPlaySessionLease(snapshotDir, deps);
  if (!lease || lease.session_id !== sessionId) {
    return {
      ok: false,
      reason: 'lease_mismatch',
      stopPids: [],
      refusedPids: [],
      ambiguous: false,
    };
  }

  const foreignActive = isForeignPlaySessionActive(
    readPlaySessionLease(snapshotDir, deps),
    sessionId,
    deps,
  );
  if (foreignActive) {
    return {
      ok: false,
      reason: 'foreign_play_session_active',
      stopPids: [],
      refusedPids: [],
      ambiguous: true,
    };
  }

  if (Number.isFinite(lease.game_pid) && pidIsRunning(lease.game_pid, deps)) {
    return {
      ok: false,
      reason: 'game_still_running',
      stopPids: [],
      refusedPids: [],
      ambiguous: false,
    };
  }

  const inventory = listVerifiedDaemonsForSnapshot(snapshotPath, deps);
  const sessionPids = new Set(normalizePidList(lease.daemon_pids));
  const verifiedLive = inventory.verified.map((row) => row.pid);
  const ownership = readOwnershipRecord(snapshotDir, deps);

  const stopPids = [];
  const refusedPids = [];
  let ambiguous = false;

  if (verifiedLive.length === 0) {
    return { ok: true, reason: 'no_live_daemons', stopPids, refusedPids, ambiguous: false, inventory, lease };
  }

  if (verifiedLive.length === 1) {
    stopPids.push(verifiedLive[0]);
    return { ok: true, reason: 'single_verified_daemon', stopPids, refusedPids, ambiguous: false, inventory, lease };
  }

  const ownershipMatchesLive = ownership
    && verifiedLive.includes(ownership.pid);
  const sessionCoversAll = verifiedLive.every((pid) => sessionPids.has(pid));

  if (sessionCoversAll) {
    stopPids.push(...verifiedLive);
    return {
      ok: true,
      reason: 'split_brain_session_covered',
      stopPids,
      refusedPids,
      ambiguous: false,
      inventory,
      lease,
    };
  }

  for (const pid of verifiedLive) {
    if (sessionPids.has(pid)) {
      stopPids.push(pid);
    } else {
      refusedPids.push(pid);
      ambiguous = true;
    }
  }

  if (!ambiguous && ownershipMatchesLive && stopPids.length === 0) {
    stopPids.push(ownership.pid);
  }

  return {
    ok: !ambiguous || stopPids.length > 0,
    reason: ambiguous ? 'split_brain_ambiguous' : 'split_brain_resolved',
    stopPids: normalizePidList(stopPids),
    refusedPids: normalizePidList(refusedPids),
    ambiguous,
    inventory,
    lease,
    ownershipPid: ownership?.pid ?? null,
  };
}

function stopVerifiedDaemonPid(snapshotPath, pid, deps = {}) {
  const snapshotDir = path.dirname(canonicalSnapshotPath(snapshotPath));
  const inventory = listVerifiedDaemonsForSnapshot(snapshotPath, deps);
  const isVerified = inventory.verified.some((row) => row.pid === pid);
  if (!isVerified) {
    return { ok: false, reason: 'not_verified_for_snapshot', pid };
  }
  const identityRow = inventory.verified.find((row) => row.pid === pid);
  const commandLine = identityRow?.identity?.commandLine ?? identityRow?.identity?.process?.commandLine ?? '';
  if (!commandLine.includes(DAEMON_SCRIPT_NAME)) {
    return { ok: false, reason: 'refuse_non_daemon_command_line', pid };
  }
  const stopFn = deps.stopProcessTree ?? stopProcessTree;
  const stopped = stopFn(pid, deps);
  if (!stopped && pidIsRunning(pid, deps)) {
    return { ok: false, reason: 'stop_failed', pid };
  }
  const reconciled = reconcileDaemonMarkersForStoppedPid(snapshotDir, snapshotPath, pid, deps);
  appendDiagnosticEvent(snapshotDir, {
    kind: 'play_session_daemon_stopped',
    pid,
    reconciled: reconciled.ok,
    state: DAEMON_STATE.STOPPED,
  }, deps);
  return { ok: true, pid, stopped, reconciled };
}

function reconcilePlaySessionLeaseForExitingDaemon(options = {}) {
  const snapshotPath = canonicalSnapshotPath(options.snapshotPath);
  const snapshotDir = path.dirname(snapshotPath);
  const deps = options.deps ?? {};
  const sessionId = options.sessionId;
  const daemonPid = Number(options.daemonPid ?? process.pid);
  const shutdownReason = options.shutdownReason ?? 'daemon_exit';
  const { verifyOpenXcomGameProcessIdentity } = require('./on-demand-game-session.cjs');

  if (!sessionId) {
    return { ok: false, reason: 'session_id_required' };
  }

  let lease = readPlaySessionLease(snapshotDir, deps);
  if (!lease) {
    return { ok: true, action: 'no_lease', removed: false };
  }

  if (lease.session_id !== sessionId) {
    appendDiagnosticEvent(snapshotDir, {
      kind: 'play_session_lease_reconcile_skipped',
      reason: 'lease_session_replaced',
      expected_session_id: sessionId,
      lease_session_id: lease.session_id,
      daemon_pid: daemonPid,
    }, deps);
    return { ok: true, action: 'skipped_newer_session', removed: false };
  }

  const leaseSnapshot = canonicalSnapshotPath(lease.snapshot_path || '');
  if (leaseSnapshot !== snapshotPath) {
    appendDiagnosticEvent(snapshotDir, {
      kind: 'play_session_lease_reconcile_refused',
      reason: 'snapshot_path_mismatch',
      session_id: sessionId,
      daemon_pid: daemonPid,
    }, deps);
    return { ok: false, reason: 'snapshot_path_mismatch' };
  }

  if (Number.isFinite(lease.game_pid)) {
    const gameIdentity = verifyOpenXcomGameProcessIdentity(lease.game_pid, lease, deps);
    if (gameIdentity.alive && gameIdentity.ok) {
      appendDiagnosticEvent(snapshotDir, {
        kind: 'play_session_lease_reconcile_deferred',
        reason: 'game_still_running',
        session_id: sessionId,
        game_pid: lease.game_pid,
        daemon_pid: daemonPid,
      }, deps);
      return { ok: false, reason: 'game_still_running', deferred: true };
    }
  }

  const inventory = listVerifiedDaemonsForSnapshot(snapshotPath, deps);
  const liveVerifiedPids = inventory.verified.map((row) => row.pid);
  const otherLiveVerified = liveVerifiedPids.filter((pid) => pid !== daemonPid);

  lease = readPlaySessionLease(snapshotDir, deps);
  if (!lease || lease.session_id !== sessionId) {
    return { ok: true, action: 'lease_replaced_during_reconcile', removed: false };
  }

  const liveSet = new Set(liveVerifiedPids);
  const staleDaemonPids = normalizePidList(lease.daemon_pids)
    .filter((pid) => !liveSet.has(pid));

  const selfVerified = verifyDaemonProcessIdentityForPid(snapshotPath, daemonPid, deps);
  const registeredOnLease = normalizePidList(lease.daemon_pids).includes(daemonPid);
  const ownership = readOwnershipRecord(snapshotDir, deps);
  const ownsSessionViaToken = ownershipMatchesToken(ownership, options.ownershipToken)
    && ownership.pid === daemonPid;
  if (!selfVerified.ok && !registeredOnLease && !ownsSessionViaToken) {
    appendDiagnosticEvent(snapshotDir, {
      kind: 'play_session_lease_reconcile_refused',
      reason: 'daemon_not_authorized',
      session_id: sessionId,
      daemon_pid: daemonPid,
      detail: selfVerified.reason,
    }, deps);
    return { ok: false, reason: 'daemon_not_authorized_for_lease' };
  }

  if (otherLiveVerified.length > 0) {
    const prunedDaemonPids = normalizePidList(otherLiveVerified);
    updatePlaySessionLease(snapshotDir, sessionId, { daemon_pids: prunedDaemonPids }, deps);
    appendDiagnosticEvent(snapshotDir, {
      kind: 'play_session_lease_pruned',
      session_id: sessionId,
      daemon_pid: daemonPid,
      stale_daemon_pids: staleDaemonPids,
      live_daemon_pids: prunedDaemonPids,
      via: 'daemon_watchdog',
    }, deps);
    return {
      ok: true,
      action: 'pruned_other_live_daemon',
      removed: false,
      stale_daemon_pids: staleDaemonPids,
      other_live: otherLiveVerified,
    };
  }

  removePlaySessionLease(snapshotDir, deps);
  appendDiagnosticEvent(snapshotDir, {
    kind: 'play_session_shutdown_complete',
    session_id: sessionId,
    via: 'daemon_watchdog',
    shutdown_reason: shutdownReason,
    daemon_pid: daemonPid,
    stale_daemon_pids: staleDaemonPids,
    stop_pids: [daemonPid],
    refused_pids: [],
    ambiguous: false,
    errors: [],
  }, deps);

  return {
    ok: true,
    action: 'lease_removed',
    removed: true,
    stale_daemon_pids: staleDaemonPids,
  };
}

function shutdownCompanionPlaySession(options = {}) {
  const snapshotPath = canonicalSnapshotPath(options.snapshotPath);
  const snapshotDir = path.dirname(snapshotPath);
  const deps = options.deps ?? {};
  const sessionId = options.sessionId;
  const launcherPid = options.launcherPid ?? null;

  if (!sessionId) {
    return { ok: false, error: 'sessionId required', code: 'invalid_args' };
  }

  const lease = readPlaySessionLease(snapshotDir, deps);
  if (!lease || lease.session_id !== sessionId) {
    appendDiagnosticEvent(snapshotDir, {
      kind: 'play_session_shutdown_refused',
      reason: 'lease_mismatch',
      session_id: sessionId,
    }, deps);
    return { ok: false, error: 'Play session lease mismatch; refusing shutdown.', code: 'lease_mismatch' };
  }

  if (launcherPid != null && Number(lease.launcher_pid) !== Number(launcherPid)) {
    appendDiagnosticEvent(snapshotDir, {
      kind: 'play_session_shutdown_refused',
      reason: 'launcher_pid_mismatch',
      session_id: sessionId,
      expected_launcher_pid: lease.launcher_pid,
      actual_launcher_pid: launcherPid,
    }, deps);
    return { ok: false, error: 'Launcher PID does not match play session lease.', code: 'launcher_mismatch' };
  }

  const discovered = discoverLiveDaemonForSnapshot(snapshotPath, deps);
  if (discovered.found) {
    const merged = normalizePidList([
      ...(lease.daemon_pids ?? []),
      ...(discovered.livePids ?? []),
    ]);
    updatePlaySessionLease(snapshotDir, sessionId, { daemon_pids: merged }, deps);
  }

  const plan = classifyShutdownTargets(snapshotPath, sessionId, deps);

  if (plan.reason === 'game_still_running') {
    appendDiagnosticEvent(snapshotDir, {
      kind: 'play_session_shutdown_deferred',
      reason: 'game_still_running',
      game_pid: lease.game_pid,
      session_id: sessionId,
    }, deps);
    return {
      ok: false,
      error: 'Game process still running; daemon shutdown deferred.',
      code: 'game_still_running',
      deferred: true,
    };
  }

  if (plan.reason === 'foreign_play_session_active') {
    return {
      ok: false,
      error: 'Another play session is active; refusing daemon shutdown.',
      code: 'foreign_play_session_active',
      ambiguous: true,
    };
  }

  const outcomes = [];
  const errors = [];

  if (plan.ambiguous && plan.refusedPids.length > 0) {
    appendDiagnosticEvent(snapshotDir, {
      kind: 'play_session_shutdown_ambiguous',
      session_id: sessionId,
      stop_pids: plan.stopPids,
      refused_pids: plan.refusedPids,
      split_brain: Boolean(plan.inventory?.splitBrain),
    }, deps);
  }

  for (const pid of plan.stopPids) {
    const outcome = stopVerifiedDaemonPid(snapshotPath, pid, deps);
    outcomes.push(outcome);
    if (!outcome.ok) {
      errors.push(outcome);
    }
  }

  if (plan.stopPids.length === 0 && !plan.ambiguous) {
    const inventory = listVerifiedDaemonsForSnapshot(snapshotPath, deps);
    for (const row of inventory.verified) {
      reconcileDaemonMarkersForStoppedPid(snapshotDir, snapshotPath, row.pid, deps);
    }
    if (inventory.verified.length === 0) {
      const onDisk = discoverLiveDaemonForSnapshot(snapshotPath, deps);
      if (!onDisk.found) {
        const ownership = readOwnershipRecord(snapshotDir, deps);
        if (ownership && !pidIsRunning(ownership.pid, deps)) {
          const { removeOwnershipRecord } = require('./on-demand-daemon-ownership.cjs');
          removeOwnershipRecord(snapshotDir, deps);
        }
        const { clearStaleDaemonMarkers } = require('./on-demand-daemon-health.cjs');
        clearStaleDaemonMarkers(snapshotDir, deps);
        const { writeDaemonHealth } = require('./on-demand-daemon-health.cjs');
        writeDaemonHealth(snapshotDir, {
          pid: null,
          state: DAEMON_STATE.STOPPED,
          exit_reason: 'play_session_no_live_daemon',
        }, deps);
      }
    }
  }

  removePlaySessionLease(snapshotDir, deps);
  appendDiagnosticEvent(snapshotDir, {
    kind: 'play_session_shutdown_complete',
    session_id: sessionId,
    stop_pids: plan.stopPids,
    refused_pids: plan.refusedPids,
    ambiguous: plan.ambiguous,
    errors: errors.map((row) => row.reason || row.error),
  }, deps);

  return {
    ok: errors.length === 0 && (!plan.ambiguous || plan.stopPids.length > 0 || plan.reason === 'no_live_daemons'),
    sessionId,
    stopped: outcomes.filter((row) => row.ok).map((row) => row.pid),
    refused: plan.refusedPids,
    ambiguous: plan.ambiguous,
    errors,
    planReason: plan.reason,
  };
}

module.exports = {
  PLAY_SESSION_LEASE_FILENAME,
  PLAY_SESSION_SCHEMA_VERSION,
  resolvePlaySessionLeasePath,
  readPlaySessionLease,
  writePlaySessionLease,
  removePlaySessionLease,
  beginCompanionPlaySession,
  registerPlaySessionDaemonPid,
  registerPlaySessionGamePid,
  adoptDaemonIntoPlaySessionLease,
  updatePlaySessionLease,
  pidIsRunning,
  classifyShutdownTargets,
  shutdownCompanionPlaySession,
  reconcilePlaySessionLeaseForExitingDaemon,
  reconcilePlaySessionLeaseAfterFailedDaemonStart,
  stopVerifiedDaemonPid,
  isForeignPlaySessionActive,
};
