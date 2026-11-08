'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { DEFAULT_COMMAND_RELAY_STATE_DIR } = require('./companion-relay-launcher.cjs');
const { appendDiagnosticEvent } = require('./on-demand-daemon-diagnostics.cjs');

const PID_CREATION_SKEW_MS = 5000;

function daemonProcessHelpers() {
  return require('./on-demand-daemon-process.cjs');
}

function defaultGetProcessCreationIdentity(pid, deps = {}) {
  return daemonProcessHelpers().getProcessCreationIdentity(pid, deps);
}

function defaultIsProcessRunning(pid, deps = {}) {
  return daemonProcessHelpers().isProcessRunning(pid, deps);
}

const SUPERVISOR_MISSING_GRACE_MS = 1500;
const SUPERVISOR_MAX_WALK_DEPTH = 24;

function sha256CommandLineDigest(commandLine) {
  if (!commandLine || typeof commandLine !== 'string') {
    return null;
  }
  return crypto.createHash('sha256').update(commandLine, 'utf8').digest('hex');
}

function defaultGetParentProcessId(pid, deps = {}) {
  if (deps.getParentProcessId) {
    return deps.getParentProcessId(pid, deps);
  }
  if (process.platform !== 'win32' || !Number.isFinite(pid) || pid <= 0) {
    return null;
  }
  try {
    const { execFileSyncHidden } = require('./exec-file-sync.cjs');
    const script = [
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue`,
      'if (-not $p) { exit 0 }',
      'Write-Output $p.ParentProcessId',
    ].join('; ');
    const out = execFileSyncHidden('powershell.exe', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const parent = Number(out);
    return Number.isFinite(parent) && parent > 0 ? parent : null;
  } catch {
    return null;
  }
}

function isNodeExecutablePath(executablePath) {
  if (!executablePath) {
    return false;
  }
  const base = path.basename(String(executablePath)).toLowerCase();
  return base === 'node.exe' || base === 'node';
}

function isNodeTestSupervisorCommandLine(commandLine) {
  if (!commandLine || typeof commandLine !== 'string') {
    return false;
  }
  if (/\.test\.(cjs|js|mjs)/i.test(commandLine)) {
    return true;
  }
  if (/\s--test(\s|$)/.test(commandLine)) {
    return true;
  }
  if (/\bnode\.test\b/i.test(commandLine)) {
    return true;
  }
  if (/test-supervisor-daemon-worker\.cjs/i.test(commandLine)) {
    return true;
  }
  return false;
}

/**
 * Walk up from the immediate spawner (often node) to the node --test supervisor.
 * Skips short-lived cmd/powershell shells.
 */
function resolveNodeTestSupervisorPid(startPid, deps = {}) {
  const getIdentity = deps.getProcessCreationIdentity ?? defaultGetProcessCreationIdentity;
  const getParent = deps.getParentProcessId ?? defaultGetParentProcessId;
  let pid = startPid;
  let bestNodePid = null;
  const seen = new Set();

  for (let depth = 0; depth < SUPERVISOR_MAX_WALK_DEPTH; depth += 1) {
    if (!Number.isFinite(pid) || pid <= 0 || seen.has(pid)) {
      break;
    }
    seen.add(pid);
    const identity = getIdentity(pid, deps);
    if (!identity.ok) {
      break;
    }
    const exe = identity.executablePath || '';
    const cmd = identity.commandLine || '';
    const exeBase = path.basename(exe).toLowerCase();

    if (isNodeExecutablePath(exe)) {
      bestNodePid = pid;
      if (isNodeTestSupervisorCommandLine(cmd)) {
        return pid;
      }
    }

    if (exeBase === 'cmd.exe' || exeBase === 'powershell.exe' || exeBase === 'pwsh.exe') {
      const parent = getParent(pid, deps);
      if (!parent) {
        break;
      }
      pid = parent;
      continue;
    }

    const parent = getParent(pid, deps);
    if (!parent || parent === pid) {
      break;
    }
    pid = parent;
  }

  return bestNodePid ?? startPid;
}

function inferTestSupervisorBinding(options = {}, deps = {}) {
  if (options.bindTestSupervisor === false) {
    return null;
  }
  const env = deps.env ?? process.env;
  const relayDir = options.commandRelayStateDir
    ? path.resolve(options.commandRelayStateDir)
    : null;
  const productionRelayDir = path.resolve(DEFAULT_COMMAND_RELAY_STATE_DIR);
  const isolatedRelay = relayDir && relayDir !== productionRelayDir;
  const inNodeTest = Boolean(env.NODE_TEST_CONTEXT);
  if (options.bindTestSupervisor !== true && !isolatedRelay && !inNodeTest) {
    return null;
  }

  const startPid = options.supervisorPid ?? process.pid;
  const supervisorPid = process.platform === 'win32'
    ? resolveNodeTestSupervisorPid(startPid, deps)
    : startPid;
  const getIdentity = deps.getProcessCreationIdentity ?? defaultGetProcessCreationIdentity;
  const identity = getIdentity(supervisorPid, deps);
  if (!identity.ok) {
    return null;
  }
  return {
    supervisorPid,
    supervisorCreationMs: identity.creationMs ?? null,
    supervisorCommandDigest: sha256CommandLineDigest(identity.commandLine),
  };
}

function buildTestSupervisorCliArgs(binding) {
  if (!binding || !Number.isFinite(binding.supervisorPid)) {
    return [];
  }
  const args = [
    '--test-supervisor-pid',
    String(binding.supervisorPid),
  ];
  if (Number.isFinite(binding.supervisorCreationMs)) {
    args.push('--test-supervisor-creation-ms', String(binding.supervisorCreationMs));
  }
  if (binding.supervisorCommandDigest) {
    args.push('--test-supervisor-cmd-digest', binding.supervisorCommandDigest);
  }
  return args;
}

function parseTestSupervisorArgs(argv, parsed = {}) {
  const out = {
    testSupervisorPid: parsed.testSupervisorPid ?? null,
    testSupervisorCreationMs: parsed.testSupervisorCreationMs ?? null,
    testSupervisorCmdDigest: parsed.testSupervisorCmdDigest ?? null,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--test-supervisor-pid') {
      i += 1;
      out.testSupervisorPid = Number(argv[i]);
      continue;
    }
    if (arg === '--test-supervisor-creation-ms') {
      i += 1;
      out.testSupervisorCreationMs = Number(argv[i]);
      continue;
    }
    if (arg === '--test-supervisor-cmd-digest') {
      i += 1;
      out.testSupervisorCmdDigest = String(argv[i]);
      continue;
    }
  }
  return out;
}

function assessTestSupervisorTick(state, deps = {}) {
  const getIdentity = deps.getProcessCreationIdentity ?? defaultGetProcessCreationIdentity;
  const isRunning = deps.isProcessRunning ?? defaultIsProcessRunning;
  const now = deps.nowMs ?? Date.now();

  if (!Number.isFinite(state.supervisorPid) || state.supervisorPid <= 0) {
    return { action: 'shutdown', reason: 'invalid_supervisor_binding' };
  }

  const alive = isRunning(state.supervisorPid, deps);
  if (!alive) {
    if (!state.supervisorMissingSinceMs) {
      state.supervisorMissingSinceMs = now;
      return { action: 'grace', reason: 'supervisor_missing_grace' };
    }
    if (now - state.supervisorMissingSinceMs >= SUPERVISOR_MISSING_GRACE_MS) {
      return { action: 'shutdown', reason: 'supervisor_exited' };
    }
    return { action: 'grace', reason: 'supervisor_missing_grace' };
  }

  state.supervisorMissingSinceMs = null;
  const identity = getIdentity(state.supervisorPid, deps);
  if (!identity.ok) {
    return { action: 'shutdown', reason: 'supervisor_identity_lost' };
  }
  if (
    Number.isFinite(state.supervisorCreationMs)
    && Number.isFinite(identity.creationMs)
    && Math.abs(identity.creationMs - state.supervisorCreationMs) > PID_CREATION_SKEW_MS
  ) {
    return { action: 'shutdown', reason: 'supervisor_pid_reuse' };
  }
  if (state.supervisorCommandDigest) {
    const liveDigest = sha256CommandLineDigest(identity.commandLine);
    if (liveDigest !== state.supervisorCommandDigest) {
      return { action: 'shutdown', reason: 'supervisor_command_digest_mismatch' };
    }
  }
  return { action: 'continue', reason: 'supervisor_alive' };
}

function createTestSupervisorWatchdog(options = {}) {
  const snapshotDir = options.snapshotDir ?? null;
  const deps = options.deps ?? {};
  const state = {
    supervisorPid: options.supervisorPid,
    supervisorCreationMs: options.supervisorCreationMs ?? null,
    supervisorCommandDigest: options.supervisorCommandDigest ?? null,
    supervisorMissingSinceMs: null,
    shutdownRequested: false,
    shutdownReason: null,
    acceptingRequests: true,
  };

  const requestShutdown = (reason) => {
    if (state.shutdownRequested) {
      return;
    }
    state.shutdownRequested = true;
    state.shutdownReason = reason;
    state.acceptingRequests = false;
    if (snapshotDir) {
      appendDiagnosticEvent(snapshotDir, {
        kind: 'test_supervisor_shutdown_requested',
        pid: process.pid,
        supervisor_pid: state.supervisorPid,
        reason,
      }, deps);
    }
    if (typeof options.onShutdown === 'function') {
      options.onShutdown(reason);
    }
  };

  return {
    state,
    async beforeTick() {
      if (state.shutdownRequested) {
        return 'shutdown';
      }
      const assessment = assessTestSupervisorTick(state, deps);
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
      return state.acceptingRequests && !state.shutdownRequested;
    },
    assess: () => assessTestSupervisorTick(state, deps),
    requestShutdown,
  };
}

/** Narrow leak scan: test-bound daemons and abandoned temp dry-run harnesses only. */
function isDisposableTestSnapshotInCommandLine(commandLine) {
  if (!commandLine) {
    return false;
  }
  return /[\\/]Temp[\\/]m1-/i.test(commandLine)
    || /[\\/]Temp[\\/]m0-startup-poll-/i.test(commandLine)
    || /[\\/]Temp[\\/]m1-status-lifecycle-/i.test(commandLine)
    || /[\\/]AppData[\\/]Local[\\/]Temp[\\/]m1-/i.test(commandLine);
}

function listTestOwnedOnDemandRelayLeaks(deps = {}) {
  const { findRunningOnDemandDaemons } = daemonProcessHelpers();
  const procs = findRunningOnDemandDaemons(deps);
  const leaks = [];
  const isRunning = deps.isProcessRunning ?? defaultIsProcessRunning;
  const getIdentity = deps.getProcessCreationIdentity ?? defaultGetProcessCreationIdentity;

  for (const proc of procs) {
    const line = proc.commandLine || '';
    if (line.includes('--test-supervisor-pid')) {
      const match = line.match(/--test-supervisor-pid\s+(\d+)/);
      const supervisorPid = match ? Number(match[1]) : null;
      let reason = 'test_supervisor_binding_present';
      if (Number.isFinite(supervisorPid) && !isRunning(supervisorPid, deps)) {
        reason = 'supervisor_dead_test_daemon_surviving';
      }
      leaks.push({
        pid: proc.pid,
        commandLine: line,
        kind: 'test_supervisor_bound',
        reason,
        supervisorPid,
      });
      continue;
    }
    if (line.includes('--dry-run') && isDisposableTestSnapshotInCommandLine(line)) {
      leaks.push({
        pid: proc.pid,
        commandLine: line,
        kind: 'legacy_temp_dry_run_harness',
        reason: 'missing_test_supervisor_binding',
        supervisorPid: null,
      });
    }
  }

  return leaks;
}

function sleepSyncQuiescence(ms) {
  if (ms <= 0) {
    return;
  }
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // bounded sync wait for test harness quiescence polls
  }
}

/**
 * Wait until no live test-owned on-demand relay daemons remain (bounded).
 */
function waitForTestOwnedRelayQuiescence(options = {}) {
  const maxMs = options.maxMs ?? SUPERVISOR_MISSING_GRACE_MS + 12_000;
  const pollMs = options.pollMs ?? 150;
  const started = Date.now();
  const deadline = started + maxMs;
  const isRunning = options.isProcessRunning ?? defaultIsProcessRunning;
  const excludePids = new Set(options.excludePids ?? []);
  let lastAlive = [];

  while (Date.now() < deadline) {
    const leaks = listTestOwnedOnDemandRelayLeaks({
      isProcessRunning: isRunning,
      ...(options.deps ?? {}),
    });
    lastAlive = leaks.filter((row) => isRunning(row.pid) && !excludePids.has(row.pid));
    if (lastAlive.length === 0) {
      return { ok: true, elapsed_ms: Date.now() - started, remaining: [] };
    }
    sleepSyncQuiescence(pollMs);
  }

  return {
    ok: false,
    elapsed_ms: Date.now() - started,
    remaining: lastAlive,
  };
}

function waitForProcessExit(pid, options = {}) {
  const maxMs = options.maxMs ?? SUPERVISOR_MISSING_GRACE_MS + 8000;
  const pollMs = options.pollMs ?? 100;
  const isRunning = options.isProcessRunning ?? defaultIsProcessRunning;
  const started = Date.now();
  const deadline = started + maxMs;
  while (Date.now() < deadline) {
    if (!isRunning(pid, options.deps)) {
      return { ok: true, elapsed_ms: Date.now() - started };
    }
    sleepSyncQuiescence(pollMs);
  }
  return { ok: false, elapsed_ms: Date.now() - started, pid };
}

function formatRelayDaemonLeakReport(leaks) {
  if (!leaks.length) {
    return 'No test-owned on-demand relay daemon leaks detected.';
  }
  return [
    `Detected ${leaks.length} leaked Companion test relay daemon(s):`,
    ...leaks.map((row) => `  pid=${row.pid} kind=${row.kind} reason=${row.reason} supervisor=${row.supervisorPid ?? 'n/a'}`),
  ].join('\n');
}

module.exports = {
  SUPERVISOR_MISSING_GRACE_MS,
  inferTestSupervisorBinding,
  buildTestSupervisorCliArgs,
  parseTestSupervisorArgs,
  resolveNodeTestSupervisorPid,
  assessTestSupervisorTick,
  createTestSupervisorWatchdog,
  listTestOwnedOnDemandRelayLeaks,
  waitForTestOwnedRelayQuiescence,
  waitForProcessExit,
  formatRelayDaemonLeakReport,
  isDisposableTestSnapshotInCommandLine,
  sha256CommandLineDigest,
};
