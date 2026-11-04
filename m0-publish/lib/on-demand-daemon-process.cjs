'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { detectRunningSidecars } = require('./companion-relay-launcher.cjs');
const { execFileSyncHidden } = require('./exec-file-sync.cjs');

const DAEMON_SCRIPT_NAME = 'companion-on-demand-relay-daemon.cjs';
const PID_FILENAME = '.companion-on-demand-daemon.pid';
const READY_FILENAME = '.companion-on-demand-daemon-ready.json';
const DEFAULT_STARTUP_TIMEOUT_MS = 15000;
const DEFAULT_STARTUP_POLL_MS = 50;

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

function removeDaemonReady(snapshotDir, io = {}) {
  const readyPath = resolveDaemonReadyPath(snapshotDir);
  const existsSync = io.existsSync ?? fs.existsSync;
  const unlinkSync = io.unlinkSync ?? fs.unlinkSync;
  if (existsSync(readyPath)) {
    unlinkSync(readyPath);
  }
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

function startOnDemandDaemonVerified(options = {}) {
  const snapshotPath = path.resolve(options.snapshotPath);
  const snapshotDir = path.dirname(snapshotPath);
  const daemonScript = options.daemonScript;
  const timeoutMs = options.timeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_STARTUP_POLL_MS;
  const cwd = options.cwd ?? path.dirname(daemonScript);
  const extraArgs = options.extraArgs ?? [];
  const deps = options.deps ?? {};

  if (!daemonScript || !fs.existsSync(daemonScript)) {
    return { ok: false, error: `Missing daemon script: ${daemonScript}` };
  }

  const existingPid = readDaemonPid(snapshotDir, deps);
  const existingReady = readDaemonReady(snapshotDir, deps);
  if (existingReady && existingPid && isProcessRunning(existingPid, deps.platform)) {
    return { ok: true, pid: existingPid, startedByUs: false };
  }

  const running = findRunningOnDemandDaemons(deps);
  if (running.length > 0) {
    const ready = readDaemonReady(snapshotDir, deps);
    const pid = readDaemonPid(snapshotDir, deps) ?? running[0].pid;
    if (ready && pid && isProcessRunning(pid, deps.platform)) {
      return { ok: true, pid, startedByUs: false };
    }
  }

  if (existingPid && !isProcessRunning(existingPid, deps.platform)) {
    removeDaemonPid(snapshotDir, deps);
    removeDaemonReady(snapshotDir, deps);
  }

  removeDaemonReady(snapshotDir, deps);
  const relayStateArgs = options.commandRelayStateDir
    ? ['--command-relay-state-dir', path.resolve(options.commandRelayStateDir)]
    : [];
  const { spawn: spawnProcess } = deps.childProcess ?? require('node:child_process');
  let earlyExitCode = null;
  const child = spawnProcess(process.execPath, [
    daemonScript,
    '--snapshot-path',
    snapshotPath,
    ...relayStateArgs,
    ...extraArgs,
  ], {
    cwd,
    stdio: 'ignore',
    windowsHide: true,
    detached: true,
  });
  child.once('exit', (code) => {
    if (code != null) {
      earlyExitCode = code;
    }
  });
  child.unref();

  const spawnPid = child.pid;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (earlyExitCode != null) {
      return {
        ok: false,
        error: earlyExitCode === 0
          ? 'On-demand relay daemon exited before ready marker was written.'
          : `On-demand relay daemon exited during startup (code ${earlyExitCode}).`,
      };
    }
    const pid = readDaemonPid(snapshotDir, deps);
    const ready = readDaemonReady(snapshotDir, deps);
    const livePid = pid ?? spawnPid;
    if (ready && livePid && isProcessRunning(livePid, deps.platform)) {
      return { ok: true, pid: livePid, startedByUs: true };
    }
    if (spawnPid && !isProcessRunning(spawnPid, deps.platform) && !ready) {
      return {
        ok: false,
        error: 'On-demand relay daemon exited during startup (check GitHub CLI auth or daemon logs).',
      };
    }
    sleepStartupPollMs(pollMs, deps);
  }

  const failPid = readDaemonPid(snapshotDir, deps) ?? spawnPid;
  if (failPid) {
    stopProcessTree(failPid, deps);
  }
  removeDaemonReady(snapshotDir, deps);
  return {
    ok: false,
    error: `On-demand relay daemon did not become ready within ${timeoutMs}ms.`,
  };
}

function resolveDaemonPidPath(snapshotDir) {
  return path.join(snapshotDir, PID_FILENAME);
}

function readDaemonPid(snapshotDir, io = {}) {
  const pidPath = resolveDaemonPidPath(snapshotDir);
  const existsSync = io.existsSync ?? fs.existsSync;
  const readFileSync = io.readFileSync ?? fs.readFileSync;
  if (!existsSync(pidPath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(pidPath, 'utf8'));
    return parsed && parsed.pid ? Number(parsed.pid) : null;
  } catch {
    return null;
  }
}

function writeDaemonPid(snapshotDir, pid, io = {}) {
  const pidPath = resolveDaemonPidPath(snapshotDir);
  const writeFileSync = io.writeFileSync ?? fs.writeFileSync;
  const renameSync = io.renameSync ?? fs.renameSync;
  const { writeJsonAtomic } = require('./local-atomic.cjs');
  writeJsonAtomic(pidPath, {
    pid,
    script: DAEMON_SCRIPT_NAME,
    started_at_ms: Date.now(),
  }, writeFileSync, renameSync);
}

function removeDaemonPid(snapshotDir, io = {}) {
  const pidPath = resolveDaemonPidPath(snapshotDir);
  const existsSync = io.existsSync ?? fs.existsSync;
  const unlinkSync = io.unlinkSync ?? fs.unlinkSync;
  if (existsSync(pidPath)) {
    unlinkSync(pidPath);
  }
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
  const listFn = deps.listProcesses ?? detectRunningSidecars;
  const processes = listFn(deps);
  return processes.filter((proc) => (proc.commandLine || '').includes(DAEMON_SCRIPT_NAME));
}

function findLegacyContinuousWatchers(deps = {}) {
  return detectRunningSidecars(deps).filter((proc) => proc.kind === 'briefing' || proc.kind === 'command-relay');
}

function stopProcessTree(pid, deps = {}) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
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
  DEFAULT_STARTUP_TIMEOUT_MS,
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
  findLegacyContinuousWatchers,
  stopProcessTree,
  startOnDemandDaemonVerified,
  releaseSpawnedDaemonChild,
};
