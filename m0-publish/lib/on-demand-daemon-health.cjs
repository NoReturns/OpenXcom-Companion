'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { writeJsonAtomic } = require('./local-atomic.cjs');
const {
  canonicalSnapshotPath,
  findAllDaemonsForSnapshot,
  readOwnershipRecord,
  ownershipMatchesToken,
} = require('./on-demand-daemon-ownership.cjs');

function processApi() {
  return require('./on-demand-daemon-process.cjs');
}

const HEALTH_FILENAME = '.companion-on-demand-daemon-health.json';
const DEFAULT_HEALTH_STALE_MS = 4000;
const DAEMON_SCRIPT_NAME = 'companion-on-demand-relay-daemon.cjs';

const DAEMON_STATE = {
  STARTING: 'starting',
  READY: 'ready',
  BUSY: 'busy',
  STOPPED: 'stopped',
  EXITED_UNEXPECTED: 'exited_unexpected',
  STARTUP_FAILED: 'startup_failed',
  UNRESPONSIVE: 'unresponsive',
};

function resolveHealthPath(snapshotDir) {
  return path.join(snapshotDir, HEALTH_FILENAME);
}

function readDaemonHealth(snapshotDir, io = {}) {
  const existsSync = io.existsSync ?? fs.existsSync;
  const readFileSync = io.readFileSync ?? fs.readFileSync;
  const healthPath = resolveHealthPath(snapshotDir);
  if (!existsSync(healthPath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(healthPath, 'utf8'));
  } catch {
    return null;
  }
}

function writeDaemonHealth(snapshotDir, payload, io = {}) {
  const token = io.ownershipToken;
  if (token) {
    const record = readOwnershipRecord(snapshotDir, io);
    if (!ownershipMatchesToken(record, token)) {
      const error = new Error('daemon_health_write_rejected: ownership_token_mismatch');
      if (io.throwOnOwnershipMismatch) {
        throw error;
      }
      return false;
    }
  }
  const writeFileSync = io.writeFileSync ?? fs.writeFileSync;
  const renameSync = io.renameSync ?? fs.renameSync;
  const healthPath = resolveHealthPath(snapshotDir);
  try {
    writeJsonAtomic(healthPath, {
      schema_version: 1,
      script: DAEMON_SCRIPT_NAME,
      updated_at_ms: Date.now(),
      ...payload,
    }, writeFileSync, renameSync, io.atomicWriteOptions);
  } catch (error) {
    if (io.recordMarkerWriteFailure !== false) {
      const { appendDiagnosticEvent } = require('./on-demand-daemon-diagnostics.cjs');
      appendDiagnosticEvent(snapshotDir, {
        kind: 'marker_write_failed',
        marker: 'daemon_health',
        pid: payload?.pid ?? process.pid,
        state: payload?.state ?? null,
        code: error?.code ?? null,
        message: error?.message ? String(error.message).slice(0, 240) : 'unknown',
      }, io);
    }
    throw error;
  }
  return true;
}

function normalizeSnapshotPathArg(commandLine, snapshotPath) {
  return findAllDaemonsForSnapshot(snapshotPath, {
    listProcesses: () => [{ pid: 0, commandLine: commandLine || '' }],
  }).length > 0;
}

function findDaemonProcessForSnapshot(snapshotPath, deps = {}) {
  const matches = findAllDaemonsForSnapshot(snapshotPath, deps);
  if (matches.length === 0) {
    return null;
  }
  const snapshotDir = path.dirname(canonicalSnapshotPath(snapshotPath));
  const record = readOwnershipRecord(snapshotDir, deps);
  if (record && record.pid) {
    const owned = matches.find((proc) => proc.pid === record.pid);
    if (owned) {
      return owned;
    }
  }
  return matches.slice().sort((a, b) => a.pid - b.pid)[0];
}

function verifyDaemonProcessIdentity(snapshotPath, pid, deps = {}) {
  return verifyDaemonProcessIdentityForPid(snapshotPath, pid, deps);
}

function pidIsRunningForDeps(pid, deps) {
  if (typeof deps.isProcessRunning === 'function') {
    return deps.isProcessRunning(pid);
  }
  const { isProcessRunning } = processApi();
  return isProcessRunning(pid, deps.platform);
}

function verifyDaemonProcessIdentityForPid(snapshotPath, pid, deps = {}) {
  const { getProcessCreationIdentity, readDaemonPidRecord } = processApi();
  const snapshotDir = path.dirname(canonicalSnapshotPath(snapshotPath));
  if (!Number.isFinite(pid) || pid <= 0 || !pidIsRunningForDeps(pid, deps)) {
    return { ok: false, reason: 'process_not_running' };
  }
  const matches = findAllDaemonsForSnapshot(snapshotPath, deps);
  const match = matches.find((proc) => proc.pid === pid);
  if (!match) {
    return { ok: false, reason: 'daemon_command_line_not_found' };
  }
  const creation = getProcessCreationIdentity(pid, deps);
  if (creation.ok === false) {
    return { ok: false, reason: creation.reason || 'process_creation_identity_unavailable' };
  }
  const { PID_CREATION_BIND_TOLERANCE_MS } = processApi();
  const pidRecord = readDaemonPidRecord(snapshotDir, deps);
  const ownership = readOwnershipRecord(snapshotDir, deps);
  let boundCreationMs = null;
  if (ownership && ownership.pid === pid && Number.isFinite(ownership.process_creation_ms)) {
    boundCreationMs = ownership.process_creation_ms;
  } else if (pidRecord && pidRecord.pid === pid && Number.isFinite(pidRecord.process_creation_ms)) {
    boundCreationMs = pidRecord.process_creation_ms;
  }
  const markerClaimsPid = (ownership && ownership.pid === pid) || (pidRecord && pidRecord.pid === pid);
  if (markerClaimsPid && !Number.isFinite(boundCreationMs)) {
    return { ok: false, reason: 'process_creation_binding_missing', pid };
  }
  if (Number.isFinite(boundCreationMs) && Number.isFinite(creation.creationMs)) {
    if (Math.abs(creation.creationMs - boundCreationMs) > PID_CREATION_BIND_TOLERANCE_MS) {
      return {
        ok: false,
        reason: 'pid_reuse_creation_mismatch',
        creationMs: creation.creationMs,
        boundCreationMs,
      };
    }
  }
  return {
    ok: true,
    process: match,
    creationMs: creation.creationMs,
    executablePath: creation.executablePath,
    commandLine: creation.commandLine ?? match.commandLine,
  };
}

function listVerifiedDaemonsForSnapshot(snapshotPath, deps = {}) {
  const matches = findAllDaemonsForSnapshot(snapshotPath, deps);
  const verified = [];
  const rejected = [];
  for (const proc of matches) {
    if (!pidIsRunningForDeps(proc.pid, deps)) {
      continue;
    }
    const identity = verifyDaemonProcessIdentityForPid(snapshotPath, proc.pid, deps);
    if (identity.ok) {
      verified.push({ pid: proc.pid, identity });
    } else {
      rejected.push({ pid: proc.pid, reason: identity.reason });
    }
  }
  verified.sort((a, b) => a.pid - b.pid);
  return {
    verified,
    rejected,
    splitBrain: verified.length > 1,
    livePids: verified.map((row) => row.pid),
  };
}

function clearStaleDaemonMarkers(snapshotDir, io = {}) {
  const { removeDaemonPid, removeDaemonReady } = processApi();
  removeDaemonPid(snapshotDir, io);
  removeDaemonReady(snapshotDir, io);
}

function assessOnDemandDaemonHealth(options = {}) {
  const {
    readDaemonPid,
    readDaemonReady,
    removeDaemonPid,
    removeDaemonReady,
    isProcessRunning,
  } = processApi();
  const snapshotPath = canonicalSnapshotPath(options.snapshotPath);
  const snapshotDir = path.dirname(snapshotPath);
  const deps = options.deps ?? {};
  const nowMs = options.nowMs ?? Date.now();
  const staleMs = options.healthStaleMs ?? DEFAULT_HEALTH_STALE_MS;
  const pid = readDaemonPid(snapshotDir, deps);
  const ready = readDaemonReady(snapshotDir, deps);
  const health = readDaemonHealth(snapshotDir, deps);
  const allMatches = findAllDaemonsForSnapshot(snapshotPath, deps);
  const processMatch = findDaemonProcessForSnapshot(snapshotPath, deps);

  if (allMatches.length > 1) {
    return {
      healthy: false,
      state: DAEMON_STATE.UNRESPONSIVE,
      reason: 'split_brain',
      pid,
      livePid: processMatch ? processMatch.pid : null,
      livePids: allMatches.map((proc) => proc.pid),
      ready,
      health,
    };
  }

  if (processMatch && pid && processMatch.pid !== pid) {
    return {
      healthy: false,
      state: DAEMON_STATE.UNRESPONSIVE,
      reason: 'pid_file_mismatch',
      pid,
      livePid: processMatch.pid,
      ready,
      health,
    };
  }

  const livePid = processMatch ? processMatch.pid : pid;
  const identity = livePid
    ? verifyDaemonProcessIdentityForPid(snapshotPath, livePid, deps)
    : { ok: false, reason: 'no_pid' };

  if (!identity.ok) {
    if (pid && !isProcessRunning(pid, deps.platform)) {
      clearStaleDaemonMarkers(snapshotDir, deps);
    }
    if (health && health.state === DAEMON_STATE.EXITED_UNEXPECTED) {
      return {
        healthy: false,
        state: DAEMON_STATE.EXITED_UNEXPECTED,
        reason: health.exit_reason || 'exited_unexpected',
        pid,
        ready,
        health,
      };
    }
    return {
      healthy: false,
      state: health && health.state === DAEMON_STATE.STARTUP_FAILED
        ? DAEMON_STATE.STARTUP_FAILED
        : DAEMON_STATE.UNRESPONSIVE,
      reason: identity.reason || 'not_running',
      pid,
      ready,
      health,
    };
  }

  if (!ready || !ready.pid || ready.pid !== livePid) {
    return {
      healthy: false,
      state: DAEMON_STATE.STARTING,
      reason: 'ready_marker_missing_or_mismatch',
      pid: livePid,
      ready,
      health,
    };
  }

  if (!health || !Number.isFinite(health.updated_at_ms)) {
    return {
      healthy: false,
      state: DAEMON_STATE.STARTING,
      reason: 'health_missing',
      pid: livePid,
      ready,
      health,
    };
  }

  if (health.pid && health.pid !== livePid) {
    return {
      healthy: false,
      state: DAEMON_STATE.UNRESPONSIVE,
      reason: 'health_pid_mismatch',
      pid: livePid,
      ready,
      health,
    };
  }

  if (health.state === DAEMON_STATE.STOPPED) {
    return {
      healthy: false,
      state: DAEMON_STATE.STOPPED,
      reason: 'health_stopped',
      pid: livePid,
      ready,
      health,
    };
  }

  const ageMs = nowMs - health.updated_at_ms;
  if (ageMs > staleMs) {
    return {
      healthy: false,
      state: DAEMON_STATE.UNRESPONSIVE,
      reason: 'health_stale',
      pid: livePid,
      ready,
      health,
      ageMs,
    };
  }

  if (health.state === DAEMON_STATE.BUSY || health.state === DAEMON_STATE.READY) {
    return {
      healthy: true,
      state: health.state,
      reason: 'ok',
      pid: livePid,
      ready,
      health,
    };
  }

  if (health.state === DAEMON_STATE.STARTING) {
    return {
      healthy: false,
      state: DAEMON_STATE.STARTING,
      reason: 'still_starting',
      pid: livePid,
      ready,
      health,
    };
  }

  return {
    healthy: false,
    state: health.state || DAEMON_STATE.UNRESPONSIVE,
    reason: health.state || 'unknown_state',
    pid: livePid,
    ready,
    health,
  };
}

function enrichStartupVerifyFailure(result, snapshotPath, expectedPid, deps = {}) {
  const { enrichStartupVerifyFailureResult } = require('./on-demand-daemon-startup-verify-diagnostics.cjs');
  return enrichStartupVerifyFailureResult(result, snapshotPath, expectedPid, deps);
}

function verifyDaemonStartupLive(snapshotPath, expectedPid, deps = {}) {
  const { readDaemonReady } = processApi();
  const snapshotDir = path.dirname(canonicalSnapshotPath(snapshotPath));
  const inventory = listVerifiedDaemonsForSnapshot(snapshotPath, deps);
  const verified = inventory.verified.find((row) => row.pid === expectedPid);
  if (!verified) {
    return enrichStartupVerifyFailure({
      ok: false,
      reason: 'pid_not_verified_live',
      expectedPid,
      verifiedPids: inventory.verified.map((row) => row.pid),
      rejected: inventory.rejected,
    }, snapshotPath, expectedPid, deps);
  }
  const ready = readDaemonReady(snapshotDir, deps);
  const health = readDaemonHealth(snapshotDir, deps);
  if (!ready || ready.pid !== expectedPid) {
    return enrichStartupVerifyFailure({
      ok: false,
      reason: 'ready_marker_mismatch',
      expectedPid,
      ready,
    }, snapshotPath, expectedPid, deps);
  }
  if (!health || health.pid !== expectedPid) {
    return enrichStartupVerifyFailure({
      ok: false,
      reason: 'health_pid_mismatch',
      expectedPid,
      health,
    }, snapshotPath, expectedPid, deps);
  }
  if (health.state === DAEMON_STATE.STOPPED) {
    return enrichStartupVerifyFailure({
      ok: false,
      reason: 'health_stopped',
      expectedPid,
      health,
    }, snapshotPath, expectedPid, deps);
  }
  if (health.state !== DAEMON_STATE.READY
    && health.state !== DAEMON_STATE.BUSY
    && health.state !== DAEMON_STATE.STARTING) {
    return enrichStartupVerifyFailure({
      ok: false,
      reason: 'health_state_invalid',
      expectedPid,
      health,
    }, snapshotPath, expectedPid, deps);
  }
  return {
    ok: true,
    pid: expectedPid,
    identity: verified.identity,
    health,
    ready,
    splitBrain: inventory.splitBrain,
  };
}

function reconcileDaemonMarkersForStoppedPid(snapshotDir, snapshotPath, pid, deps = {}) {
  const {
    readDaemonPid,
    readDaemonReady,
    removeDaemonPid,
    removeDaemonReady,
  } = processApi();
  const { releaseOwnershipIfTokenMatches, readOwnershipRecord } = require('./on-demand-daemon-ownership.cjs');
  if (pidIsRunningForDeps(pid, deps)) {
    return { ok: false, reason: 'process_still_running' };
  }
  const ownership = readOwnershipRecord(snapshotDir, deps);
  if (ownership && ownership.pid === pid && ownership.ownership_token) {
    releaseOwnershipIfTokenMatches(snapshotDir, ownership.ownership_token, deps);
  } else if (ownership && ownership.pid === pid) {
    const { removeOwnershipRecord } = require('./on-demand-daemon-ownership.cjs');
    removeOwnershipRecord(snapshotDir, deps);
  }
  const onDiskPid = readDaemonPid(snapshotDir, deps);
  const ready = readDaemonReady(snapshotDir, deps);
  if (onDiskPid === pid) {
    removeDaemonPid(snapshotDir, deps);
  }
  if (ready && ready.pid === pid) {
    removeDaemonReady(snapshotDir, deps);
  }
  const health = readDaemonHealth(snapshotDir, deps);
  const ownsHealthRecord = !health
    || health.pid === pid
    || (health.state === DAEMON_STATE.STOPPED && health.pid === pid);
  const ownsViaToken = ownership
    && ownership.pid === pid
    && ownershipMatchesToken(ownership, deps.ownershipToken);
  if (ownsHealthRecord || ownsViaToken) {
    writeDaemonHealth(snapshotDir, {
      pid,
      state: DAEMON_STATE.STOPPED,
      exit_reason: deps.exitReason ?? 'play_session_shutdown',
    }, deps);
  }
  return { ok: true, pid, skippedHealthWrite: !(ownsHealthRecord || ownsViaToken) };
}

const startupVerifyDiagnostics = require('./on-demand-daemon-startup-verify-diagnostics.cjs');

module.exports = {
  HEALTH_FILENAME,
  DEFAULT_HEALTH_STALE_MS,
  DAEMON_STATE,
  resolveHealthPath,
  readDaemonHealth,
  writeDaemonHealth,
  assessOnDemandDaemonHealth,
  verifyDaemonProcessIdentity,
  verifyDaemonProcessIdentityForPid,
  listVerifiedDaemonsForSnapshot,
  verifyDaemonStartupLive,
  recordStartupVerificationFailure: startupVerifyDiagnostics.recordStartupVerificationFailure,
  buildStartupVerificationFailureDetail: startupVerifyDiagnostics.buildStartupVerificationFailureDetail,
  reconcileDaemonMarkersForStoppedPid,
  findDaemonProcessForSnapshot,
  findAllDaemonsForSnapshot,
  clearStaleDaemonMarkers,
};
