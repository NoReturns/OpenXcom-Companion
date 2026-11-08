'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_ATOMIC_RENAME_ATTEMPTS = 5;
const DEFAULT_ATOMIC_RENAME_BACKOFF_MS = 8;

const TRANSIENT_RENAME_ERROR_CODES = new Set([
  'EPERM',
  'EACCES',
  'EBUSY',
  'ENOTEMPTY',
]);

function uniqueAtomicTempPath(filePath) {
  const suffix = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`;
  return `${filePath}.companion.${suffix}.tmp`;
}

function spinSleepMs(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // bounded synchronous backoff for rename retries
  }
}

function isTransientRenameError(error) {
  return Boolean(error && TRANSIENT_RENAME_ERROR_CODES.has(error.code));
}

function renameWithBoundedRetry(tmp, filePath, renameSync, options = {}) {
  const maxAttempts = options.maxAttempts ?? DEFAULT_ATOMIC_RENAME_ATTEMPTS;
  const backoffMs = options.backoffMs ?? DEFAULT_ATOMIC_RENAME_BACKOFF_MS;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      renameSync(tmp, filePath);
      return { ok: true, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isTransientRenameError(error)) {
        break;
      }
      spinSleepMs(backoffMs * attempt);
    }
  }
  if (tmp !== filePath) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore cleanup failure
    }
  }
  return { ok: false, error: lastError, attempts: maxAttempts };
}

function writeTextAtomic(filePath, text, writeFileSync = fs.writeFileSync, renameSync = fs.renameSync, options = {}) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = uniqueAtomicTempPath(filePath);
  writeFileSync(tmp, text, 'utf8');
  try {
    const outcome = renameWithBoundedRetry(tmp, filePath, renameSync, options);
    if (!outcome.ok) {
      throw outcome.error;
    }
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore cleanup failure
    }
    throw error;
  }
}

function writeJsonAtomic(filePath, value, writeFileSync = fs.writeFileSync, renameSync = fs.renameSync, options = {}) {
  writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, writeFileSync, renameSync, options);
}

function removeFileIfExists(filePath, existsSync = fs.existsSync, unlinkSync = fs.unlinkSync) {
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }
}

module.exports = {
  DEFAULT_ATOMIC_RENAME_ATTEMPTS,
  DEFAULT_ATOMIC_RENAME_BACKOFF_MS,
  TRANSIENT_RENAME_ERROR_CODES,
  uniqueAtomicTempPath,
  writeTextAtomic,
  writeJsonAtomic,
  removeFileIfExists,
  isTransientRenameError,
  renameWithBoundedRetry,
  spinSleepMs,
};
