'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { writeJsonAtomic } = require('./local-atomic.cjs');

const OWNERSHIP_FILENAME = '.companion-on-demand-daemon-ownership.json';
const OWNERSHIP_STALE_MS = 7 * 24 * 60 * 60 * 1000;

function processApi() {
  return require('./on-demand-daemon-process.cjs');
}

function resolveOwnershipPath(snapshotDir) {
  return path.join(snapshotDir, OWNERSHIP_FILENAME);
}

function canonicalSnapshotPath(snapshotPath) {
  return path.resolve(path.normalize(snapshotPath));
}

function snapshotPathCommandLineVariants(snapshotPath) {
  const canonical = canonicalSnapshotPath(snapshotPath);
  const variants = new Set([
    canonical,
    canonical.toLowerCase(),
    canonical.replace(/\//g, '\\'),
    canonical.replace(/\\/g, '/'),
    canonical.replace(/\//g, '\\').toLowerCase(),
    canonical.replace(/\\/g, '/').toLowerCase(),
  ]);
  for (const v of [...variants]) {
    variants.add(v.replace(/\\/g, '\\\\'));
  }
  return variants;
}

function snapshotPathMatchesCommandLine(commandLine, snapshotPath) {
  if (!commandLine || !snapshotPath) {
    return false;
  }
  for (const variant of snapshotPathCommandLineVariants(snapshotPath)) {
    let fromIndex = 0;
    while (fromIndex < commandLine.length) {
      const idx = commandLine.indexOf(variant, fromIndex);
      if (idx === -1) {
        break;
      }
      const next = commandLine[idx + variant.length];
      if (next === undefined || next === '"' || next === "'" || next === ' ' || next === '\t') {
        return true;
      }
      fromIndex = idx + variant.length;
    }
  }
  return false;
}

function findAllDaemonsForSnapshot(snapshotPath, deps = {}) {
  const { findRunningOnDemandDaemons } = processApi();
  return findRunningOnDemandDaemons(deps).filter((proc) => (
    snapshotPathMatchesCommandLine(proc.commandLine, snapshotPath)
  ));
}

function readOwnershipRecord(snapshotDir, io = {}) {
  const existsSync = io.existsSync ?? fs.existsSync;
  const readFileSync = io.readFileSync ?? fs.readFileSync;
  const ownershipPath = resolveOwnershipPath(snapshotDir);
  if (!existsSync(ownershipPath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(ownershipPath, 'utf8'));
  } catch {
    return null;
  }
}

function writeOwnershipRecord(snapshotDir, payload, io = {}) {
  const writeFileSync = io.writeFileSync ?? fs.writeFileSync;
  const renameSync = io.renameSync ?? fs.renameSync;
  writeJsonAtomic(resolveOwnershipPath(snapshotDir), {
    schema_version: 1,
    updated_at_ms: Date.now(),
    ...payload,
  }, writeFileSync, renameSync);
}

function removeOwnershipRecord(snapshotDir, io = {}) {
  const existsSync = io.existsSync ?? fs.existsSync;
  const unlinkSync = io.unlinkSync ?? fs.unlinkSync;
  const ownershipPath = resolveOwnershipPath(snapshotDir);
  if (existsSync(ownershipPath)) {
    unlinkSync(ownershipPath);
  }
}

function ownershipMatchesToken(record, token) {
  return Boolean(record && token && record.ownership_token === token);
}

function pickPreferredLiveDaemon(liveMatches, snapshotDir, deps = {}) {
  if (liveMatches.length === 1) {
    return liveMatches[0];
  }
  const record = readOwnershipRecord(snapshotDir, deps);
  if (record && record.pid) {
    const owned = liveMatches.find((proc) => proc.pid === record.pid);
    if (owned) {
      return owned;
    }
  }
  return liveMatches.slice().sort((a, b) => a.pid - b.pid)[0];
}

function isEstablishedDaemonContender(snapshotPath, procPid, snapshotDir, deps = {}) {
  const { verifyDaemonStartupLive, readDaemonHealth, DAEMON_STATE } = require('./on-demand-daemon-health.cjs');
  const { readDaemonReady, readDaemonPid } = processApi();
  const ownership = readOwnershipRecord(snapshotDir, deps);
  if (ownership?.pid === procPid) {
    return true;
  }
  const ready = readDaemonReady(snapshotDir, deps);
  if (ready?.pid === procPid) {
    return true;
  }
  const onDiskPid = readDaemonPid(snapshotDir, deps);
  if (onDiskPid === procPid) {
    return true;
  }
  const startup = verifyDaemonStartupLive(snapshotPath, procPid, deps);
  if (startup.ok) {
    return true;
  }
  const health = readDaemonHealth(snapshotDir, deps);
  if (health?.pid === procPid && health.state === DAEMON_STATE.STARTING) {
    return true;
  }
  return false;
}

function discoverLiveDaemonForSnapshot(snapshotPath, deps = {}) {
  const { verifyDaemonProcessIdentityForPid } = require('./on-demand-daemon-health.cjs');
  const { isProcessRunning } = processApi();
  const snapshotDir = path.dirname(canonicalSnapshotPath(snapshotPath));
  const matches = findAllDaemonsForSnapshot(snapshotPath, deps);
  const live = [];
  for (const proc of matches) {
    if (!isProcessRunning(proc.pid, deps.platform)) {
      continue;
    }
    const identity = verifyDaemonProcessIdentityForPid(snapshotPath, proc.pid, deps);
    if (!identity.ok) {
      continue;
    }
    if (!isEstablishedDaemonContender(snapshotPath, proc.pid, snapshotDir, deps)) {
      continue;
    }
    live.push({ ...proc, identity });
  }
  if (live.length === 0) {
    return { found: false, splitBrain: false, liveCount: 0 };
  }
  const preferred = pickPreferredLiveDaemon(live, snapshotDir, deps);
  return {
    found: true,
    splitBrain: live.length > 1,
    liveCount: live.length,
    pid: preferred.pid,
    process: preferred,
    livePids: live.map((proc) => proc.pid),
    verified: true,
  };
}

function isOwnershipRecordStale(record, nowMs = Date.now()) {
  if (!record) {
    return true;
  }
  if (record.started_at_ms && nowMs - record.started_at_ms > OWNERSHIP_STALE_MS) {
    return true;
  }
  return false;
}

function pidIsRunningForOwnership(pid, deps = {}) {
  if (typeof deps.isProcessRunning === 'function') {
    return deps.isProcessRunning(pid);
  }
  const { isProcessRunning } = processApi();
  return isProcessRunning(pid, deps.platform);
}

function clearStaleOwnershipIfSafe(snapshotDir, snapshotPath, deps = {}) {
  const record = readOwnershipRecord(snapshotDir, deps);
  if (!record || !record.pid) {
    return false;
  }
  if (pidIsRunningForOwnership(record.pid, deps)) {
    return false;
  }
  const { verifyDaemonProcessIdentityForPid } = require('./on-demand-daemon-health.cjs');
  const identity = verifyDaemonProcessIdentityForPid(snapshotPath, record.pid, deps);
  if (identity.ok) {
    return false;
  }
  removeOwnershipRecord(snapshotDir, deps);
  return true;
}

function tryReuseLiveDaemonBeforeSpawn(snapshotPath, deps = {}) {
  const { verifyDaemonProcessIdentity, verifyDaemonStartupLive } = require('./on-demand-daemon-health.cjs');
  const snapshotDir = path.dirname(canonicalSnapshotPath(snapshotPath));
  const live = discoverLiveDaemonForSnapshot(snapshotPath, deps);
  if (!live.found) {
    return null;
  }
  const identity = verifyDaemonProcessIdentity(snapshotPath, live.pid, deps);
  if (!identity.ok) {
    return null;
  }
  const startup = verifyDaemonStartupLive(snapshotPath, live.pid, deps);
  if (!startup.ok) {
    return null;
  }
  return {
    ok: true,
    pid: live.pid,
    reused: true,
    splitBrain: live.splitBrain,
    livePids: live.livePids,
    snapshotDir,
  };
}

function disableLiveDaemonReuseInEnv(deps = {}) {
  return (deps.env ?? process.env).COMPANION_ON_DEMAND_TEST_NO_LIVE_REUSE === '1';
}

function claimDaemonOwnership(options = {}) {
  const { appendDiagnosticEvent } = require('./on-demand-daemon-diagnostics.cjs');
  const { acquireStartLock, removeStartLock } = processApi();
  const snapshotPath = canonicalSnapshotPath(options.snapshotPath);
  const snapshotDir = path.dirname(snapshotPath);
  const deps = options.deps ?? {};
  const pid = options.pid ?? process.pid;
  const owner = options.owner ?? 'daemon';
  const lock = acquireStartLock(snapshotDir, deps);
  if (!lock.acquired) {
    const reuse = tryReuseLiveDaemonBeforeSpawn(snapshotPath, deps);
    if (reuse && reuse.pid !== pid) {
      appendDiagnosticEvent(snapshotDir, {
        kind: 'daemon_deferred_to_owner',
        pid,
        owner_pid: reuse.pid,
        reason: 'startup_lock_held',
      }, deps);
      return { ok: false, reason: 'existing_live_owner', ownerPid: reuse.pid };
    }
    return { ok: false, reason: 'startup_in_progress' };
  }

  try {
    clearStaleOwnershipIfSafe(snapshotDir, snapshotPath, deps);
    if (!disableLiveDaemonReuseInEnv(deps)) {
      const live = discoverLiveDaemonForSnapshot(snapshotPath, deps);
      if (live.found && live.pid !== pid) {
        appendDiagnosticEvent(snapshotDir, {
          kind: 'daemon_deferred_to_owner',
          pid,
          owner_pid: live.pid,
          split_brain: live.splitBrain,
          live_pids: live.livePids,
        }, deps);
        return { ok: false, reason: 'existing_live_owner', ownerPid: live.pid, splitBrain: live.splitBrain };
      }
    }

    const { getProcessCreationIdentity } = processApi();
    const processCreation = getProcessCreationIdentity(pid, deps);
    const token = options.ownershipToken ?? crypto.randomBytes(16).toString('hex');
    writeOwnershipRecord(snapshotDir, {
      snapshot_path: snapshotPath,
      pid,
      ownership_token: token,
      started_at_ms: Date.now(),
      process_creation_ms: processCreation.ok ? processCreation.creationMs : null,
      owner,
    }, deps);
    appendDiagnosticEvent(snapshotDir, {
      kind: 'ownership_acquired',
      pid,
      owner,
      split_brain: false,
    }, deps);
    return { ok: true, ownershipToken: token, snapshotDir, snapshotPath };
  } finally {
    removeStartLock(snapshotDir, deps);
  }
}

function releaseOwnershipIfTokenMatches(snapshotDir, token, io = {}) {
  const record = readOwnershipRecord(snapshotDir, io);
  if (!ownershipMatchesToken(record, token)) {
    return false;
  }
  removeOwnershipRecord(snapshotDir, io);
  return true;
}

module.exports = {
  OWNERSHIP_FILENAME,
  canonicalSnapshotPath,
  snapshotPathMatchesCommandLine,
  findAllDaemonsForSnapshot,
  readOwnershipRecord,
  writeOwnershipRecord,
  removeOwnershipRecord,
  ownershipMatchesToken,
  discoverLiveDaemonForSnapshot,
  tryReuseLiveDaemonBeforeSpawn,
  claimDaemonOwnership,
  releaseOwnershipIfTokenMatches,
  clearStaleOwnershipIfSafe,
  isEstablishedDaemonContender,
};
