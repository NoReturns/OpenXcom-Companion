'use strict';

const path = require('node:path');
const { appendDiagnosticEvent } = require('./on-demand-daemon-diagnostics.cjs');
const {
  canonicalSnapshotPath,
  snapshotPathMatchesCommandLine,
  readOwnershipRecord,
  findAllDaemonsForSnapshot,
} = require('./on-demand-daemon-ownership.cjs');
const {
  DAEMON_SCRIPT_NAME,
  readDaemonPidRecord,
} = require('./on-demand-daemon-process.cjs');

const MAX_REJECTED_ROWS = 12;

function basenameOrNull(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    return null;
  }
  return path.basename(filePath.replace(/\\/g, '/'));
}

function summarizeCreationIdentityForDiagnostic(creation, snapshotPath) {
  if (!creation || creation.ok === false) {
    return {
      ok: false,
      reason: creation?.reason ?? 'unavailable',
      creation_ms: null,
      executable_basename: null,
      snapshot_arg_match: null,
      daemon_script_in_cmdline: null,
    };
  }
  const cmd = creation.commandLine || '';
  return {
    ok: true,
    reason: null,
    creation_ms: Number.isFinite(creation.creationMs) ? creation.creationMs : null,
    executable_basename: basenameOrNull(creation.executablePath),
    snapshot_arg_match: cmd ? snapshotPathMatchesCommandLine(cmd, snapshotPath) : null,
    daemon_script_in_cmdline: cmd.includes(DAEMON_SCRIPT_NAME),
  };
}

function describeDaemonEnumeration(snapshotPath, expectedPid, deps, processApi) {
  const usesInjected = typeof deps.listProcesses === 'function';
  const method = usesInjected
    ? 'injected_list'
    : (process.platform === 'win32' ? 'cim_win32_process_daemon_filter' : 'unsupported');
  let error = null;
  let unfilteredDaemonCount = null;
  let snapshotFilteredCount = null;
  let expectedPidInUnfiltered = false;
  let expectedPidInSnapshotFiltered = false;
  try {
    const { findRunningOnDemandDaemons } = processApi();
    const unfiltered = findRunningOnDemandDaemons(deps);
    unfilteredDaemonCount = unfiltered.length;
    expectedPidInUnfiltered = unfiltered.some((row) => row.pid === expectedPid);
  } catch (err) {
    error = err && err.message ? String(err.message).slice(0, 120) : 'unfiltered_enumeration_failed';
  }
  try {
    const filtered = findAllDaemonsForSnapshot(snapshotPath, deps);
    snapshotFilteredCount = filtered.length;
    expectedPidInSnapshotFiltered = filtered.some((row) => row.pid === expectedPid);
  } catch (err) {
    if (!error) {
      error = err && err.message ? String(err.message).slice(0, 120) : 'snapshot_filter_enumeration_failed';
    }
  }
  return {
    method,
    error,
    unfiltered_daemon_count: unfilteredDaemonCount,
    snapshot_filtered_count: snapshotFilteredCount,
    expected_pid_in_unfiltered: expectedPidInUnfiltered,
    expected_pid_in_snapshot_filtered: expectedPidInSnapshotFiltered,
  };
}

function buildStartupVerificationFailureDetail(snapshotPath, expectedPid, failedPredicate, deps = {}) {
  const processApi = () => require('./on-demand-daemon-process.cjs');
  const {
    listVerifiedDaemonsForSnapshot,
    verifyDaemonProcessIdentityForPid,
    readDaemonHealth,
  } = require('./on-demand-daemon-health.cjs');

  const snapshotCanonical = canonicalSnapshotPath(snapshotPath);
  const snapshotDir = path.dirname(snapshotCanonical);
  const { readDaemonReady, getProcessCreationIdentity, isProcessRunning } = processApi();

  const inventory = listVerifiedDaemonsForSnapshot(snapshotPath, deps);
  const processRunning = typeof deps.isProcessRunning === 'function'
    ? deps.isProcessRunning(expectedPid)
    : isProcessRunning(expectedPid, deps.platform ?? process.platform);

  const identity = verifyDaemonProcessIdentityForPid(snapshotPath, expectedPid, deps);
  const enumeration = describeDaemonEnumeration(snapshotPath, expectedPid, deps, processApi);

  const filteredMatches = findAllDaemonsForSnapshot(snapshotPath, deps);
  const listedMatch = filteredMatches.find((row) => row.pid === expectedPid);
  const listedCmd = listedMatch?.commandLine || '';
  const wmiCreation = processRunning
    ? getProcessCreationIdentity(expectedPid, deps)
    : { ok: false, reason: 'process_not_running' };

  const ownership = readOwnershipRecord(snapshotDir, deps);
  const pidRecord = readDaemonPidRecord(snapshotDir, deps);
  const ready = readDaemonReady(snapshotDir, deps);
  const health = readDaemonHealth(snapshotDir, deps);

  const creationSummary = summarizeCreationIdentityForDiagnostic(wmiCreation, snapshotCanonical);

  const { PID_CREATION_BIND_TOLERANCE_MS } = processApi();
  let boundCreationMs = null;
  let boundSource = null;
  if (ownership && ownership.pid === expectedPid && Number.isFinite(ownership.process_creation_ms)) {
    boundCreationMs = ownership.process_creation_ms;
    boundSource = 'ownership';
  } else if (pidRecord && pidRecord.pid === expectedPid && Number.isFinite(pidRecord.process_creation_ms)) {
    boundCreationMs = pidRecord.process_creation_ms;
    boundSource = 'pid_record';
  }
  let creationVsBound = null;
  if (creationSummary.ok && creationSummary.creation_ms != null) {
    creationVsBound = {
      bound_source: boundSource,
      bound_creation_ms: boundCreationMs,
      live_creation_ms: creationSummary.creation_ms,
      bind_tolerance_ms: PID_CREATION_BIND_TOLERANCE_MS,
      matches_bound: Number.isFinite(boundCreationMs)
        ? Math.abs(creationSummary.creation_ms - boundCreationMs) <= PID_CREATION_BIND_TOLERANCE_MS
        : null,
      ownership_started_at_ms: ownership?.started_at_ms ?? null,
    };
  }

  return {
    failed_predicate: failedPredicate,
    expected_pid: expectedPid,
    canonical_snapshot_path: snapshotCanonical,
    process_running: processRunning,
    verified_pids: inventory.verified.map((row) => row.pid),
    rejected: inventory.rejected.slice(0, MAX_REJECTED_ROWS).map((row) => ({
      pid: row.pid,
      reason: row.reason,
    })),
    split_brain: inventory.splitBrain,
    identity: {
      ok: identity.ok,
      reason: identity.ok ? null : (identity.reason || 'unknown'),
    },
    snapshot_arg_match_listed: listedCmd
      ? snapshotPathMatchesCommandLine(listedCmd, snapshotCanonical)
      : null,
    daemon_script_in_listed_cmdline: listedCmd ? listedCmd.includes(DAEMON_SCRIPT_NAME) : null,
    enumeration,
    creation_identity: creationSummary,
    creation_vs_bound: creationVsBound,
    ready_marker: {
      present: Boolean(ready),
      pid: ready?.pid ?? null,
      matches_expected: ready?.pid === expectedPid,
    },
    health_record: {
      present: Boolean(health),
      pid: health?.pid ?? null,
      state: health?.state ?? null,
      matches_expected: health?.pid === expectedPid,
    },
    ownership_record: ownership
      ? { pid: ownership.pid, matches_expected: ownership.pid === expectedPid }
      : null,
  };
}

function enrichStartupVerifyFailureResult(result, snapshotPath, expectedPid, deps = {}) {
  if (!result || result.ok) {
    return result;
  }
  const predicate = result.reason || 'unknown';
  return {
    ...result,
    diagnostics: buildStartupVerificationFailureDetail(snapshotPath, expectedPid, predicate, deps),
  };
}

function recordStartupVerificationFailure(snapshotPath, expectedPid, deps = {}, options = {}) {
  const snapshotDir = path.dirname(canonicalSnapshotPath(snapshotPath));
  const { verifyDaemonStartupLive } = require('./on-demand-daemon-health.cjs');
  const verify = options.verifyResult && options.verifyResult.ok === false
    ? options.verifyResult
    : verifyDaemonStartupLive(snapshotPath, expectedPid, deps);
  const diagnostics = verify.diagnostics
    ?? buildStartupVerificationFailureDetail(
      snapshotPath,
      expectedPid,
      verify.reason || options.failed_predicate || 'unknown',
      deps,
    );
  appendDiagnosticEvent(snapshotDir, {
    kind: 'startup_verify_failed',
    source: options.source || 'unspecified',
    pid: expectedPid,
    ...diagnostics,
  }, deps);
  return { verify, diagnostics };
}

module.exports = {
  MAX_REJECTED_ROWS,
  buildStartupVerificationFailureDetail,
  enrichStartupVerifyFailureResult,
  recordStartupVerificationFailure,
};
