'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LOCK_SCHEMA = 1;

function isProcessAlive(pid, killFn = process.kill.bind(process)) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    killFn(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

function readLockFile(lockPath, readFileSync = fs.readFileSync, existsSync = fs.existsSync) {
  if (!existsSync(lockPath)) {
    return null;
  }
  try {
    const raw = readFileSync(lockPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.schema === LOCK_SCHEMA && Number.isInteger(parsed.pid)) {
      return parsed;
    }
  } catch {
    return { parseError: true };
  }
  return null;
}

function formatDuplicateSidecarMessage(lock, lockPath) {
  const pid = lock && lock.pid ? lock.pid : 'unknown';
  const snap = lock && lock.snapshotPath ? lock.snapshotPath : '(unknown snapshot)';
  return `Another command-relay sidecar is already running (pid ${pid}, snapshot ${snap}). `
    + `Stop that process or remove stale lock ${lockPath} if the process has exited.`;
}

function acquireCommandRelaySidecarLock(options = {}) {
  const lockPath = options.lockPath;
  const pid = options.pid ?? process.pid;
  const snapshotPath = options.snapshotPath ?? '';
  const writeFileSync = options.writeFileSync ?? fs.writeFileSync;
  const readFileSync = options.readFileSync ?? fs.readFileSync;
  const existsSync = options.existsSync ?? fs.existsSync;
  const unlinkSync = options.unlinkSync ?? fs.unlinkSync;
  const mkdirSync = options.mkdirSync ?? fs.mkdirSync;
  const isAlive = options.isProcessAlive ?? isProcessAlive;

  if (!lockPath) {
    throw new Error('lockPath is required for command-relay sidecar lock.');
  }

  mkdirSync(path.dirname(lockPath), { recursive: true });

  const payload = {
    schema: LOCK_SCHEMA,
    pid,
    snapshotPath,
    started_at: new Date().toISOString(),
  };

  const tryAcquire = () => {
    writeFileSync(lockPath, `${JSON.stringify(payload)}\n`, { flag: 'wx' });
  };

  try {
    tryAcquire();
    return {
      lockPath,
      release() {
        try {
          if (!existsSync(lockPath)) {
            return;
          }
          const current = readLockFile(lockPath, readFileSync, existsSync);
          if (current && current.pid === pid) {
            unlinkSync(lockPath);
          }
        } catch {
          /* best-effort */
        }
      },
    };
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
  }

  const existing = readLockFile(lockPath, readFileSync, existsSync);
  if (existing && !existing.parseError && isAlive(existing.pid)) {
    const conflict = new Error(formatDuplicateSidecarMessage(existing, lockPath));
    conflict.code = 'DUPLICATE_SIDECAR';
    conflict.lock = existing;
    throw conflict;
  }

  try {
    unlinkSync(lockPath);
  } catch {
    const conflict = new Error(formatDuplicateSidecarMessage(existing, lockPath));
    conflict.code = 'DUPLICATE_SIDECAR';
    throw conflict;
  }

  tryAcquire();
  return {
    lockPath,
    release() {
      try {
        if (!existsSync(lockPath)) {
          return;
        }
        const current = readLockFile(lockPath, readFileSync, existsSync);
        if (current && current.pid === pid) {
          unlinkSync(lockPath);
        }
      } catch {
        /* best-effort */
      }
    },
  };
}

module.exports = {
  LOCK_SCHEMA,
  isProcessAlive,
  readLockFile,
  formatDuplicateSidecarMessage,
  acquireCommandRelaySidecarLock,
};
