'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { writeJsonAtomic } = require('./local-atomic.cjs');

const DIAGNOSTICS_FILENAME = 'companion-on-demand-daemon-diagnostics.jsonl';
const STATE_FILENAME = '.companion-on-demand-daemon-lifecycle.json';
const MAX_JSONL_LINES = 200;
const MAX_RECOVERY_ATTEMPTS_PER_HOUR = 6;

function resolveDiagnosticsPath(snapshotDir) {
  return path.join(snapshotDir, DIAGNOSTICS_FILENAME);
}

function resolveLifecycleStatePath(snapshotDir) {
  return path.join(snapshotDir, STATE_FILENAME);
}

function redactSecrets(text) {
  if (typeof text !== 'string') {
    return String(text);
  }
  return text
    .replace(/gho_[A-Za-z0-9_]+/g, 'gho_[REDACTED]')
    .replace(/github_pat_[A-Za-z0-9_]+/g, 'github_pat_[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]');
}

function appendDiagnosticEvent(snapshotDir, event, io = {}) {
  if (!snapshotDir) {
    return;
  }
  const writeFileSync = io.writeFileSync ?? fs.writeFileSync;
  const readFileSync = io.readFileSync ?? fs.readFileSync;
  const existsSync = io.existsSync ?? fs.existsSync;
  const logPath = resolveDiagnosticsPath(snapshotDir);
  const line = `${JSON.stringify({
    at_ms: Date.now(),
    ...event,
    message: event.message ? redactSecrets(event.message) : undefined,
  })}\n`;
  let prior = '';
  if (existsSync(logPath)) {
    try {
      prior = readFileSync(logPath, 'utf8');
    } catch {
      prior = '';
    }
  }
  const lines = (prior + line).split('\n').filter(Boolean);
  const trimmed = lines.length > MAX_JSONL_LINES ? lines.slice(-MAX_JSONL_LINES) : lines;
  writeFileSync(logPath, `${trimmed.join('\n')}\n`, 'utf8');
}

function readLifecycleState(snapshotDir, io = {}) {
  const existsSync = io.existsSync ?? fs.existsSync;
  const readFileSync = io.readFileSync ?? fs.readFileSync;
  const statePath = resolveLifecycleStatePath(snapshotDir);
  if (!existsSync(statePath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeLifecycleState(snapshotDir, patch, io = {}) {
  const writeFileSync = io.writeFileSync ?? fs.writeFileSync;
  const renameSync = io.renameSync ?? fs.renameSync;
  const prior = readLifecycleState(snapshotDir, io) ?? {};
  writeJsonAtomic(resolveLifecycleStatePath(snapshotDir), {
    schema_version: 1,
    ...prior,
    ...patch,
    updated_at_ms: Date.now(),
  }, writeFileSync, renameSync);
}

function recordRecoveryAttempt(snapshotDir, outcome, io = {}) {
  const now = Date.now();
  const state = readLifecycleState(snapshotDir, io) ?? {};
  const windowStart = state.recovery_window_start_ms ?? now;
  const withinHour = now - windowStart < 60 * 60 * 1000;
  const attempts = withinHour ? (state.recovery_attempts ?? 0) + 1 : 1;
  writeLifecycleState(snapshotDir, {
    recovery_window_start_ms: withinHour ? windowStart : now,
    recovery_attempts: attempts,
    last_recovery_at_ms: now,
    last_recovery_ok: Boolean(outcome && outcome.ok),
    last_recovery_error: outcome && !outcome.ok ? redactSecrets(outcome.error || 'unknown') : null,
  }, io);
  appendDiagnosticEvent(snapshotDir, {
    kind: outcome && outcome.ok ? 'recovery_succeeded' : 'recovery_failed',
    attempts,
    error: outcome && !outcome.ok ? outcome.error : undefined,
  }, io);
  return {
    attempts,
    allowed: attempts <= MAX_RECOVERY_ATTEMPTS_PER_HOUR,
    maxAttempts: MAX_RECOVERY_ATTEMPTS_PER_HOUR,
  };
}

function recoveryAllowed(snapshotDir, io = {}) {
  const state = readLifecycleState(snapshotDir, io);
  if (!state || !state.recovery_window_start_ms) {
    return { allowed: true, attempts: 0, maxAttempts: MAX_RECOVERY_ATTEMPTS_PER_HOUR };
  }
  const now = Date.now();
  const withinHour = now - state.recovery_window_start_ms < 60 * 60 * 1000;
  const attempts = withinHour ? (state.recovery_attempts ?? 0) : 0;
  return {
    allowed: attempts < MAX_RECOVERY_ATTEMPTS_PER_HOUR,
    attempts,
    maxAttempts: MAX_RECOVERY_ATTEMPTS_PER_HOUR,
  };
}

module.exports = {
  DIAGNOSTICS_FILENAME,
  STATE_FILENAME,
  MAX_JSONL_LINES,
  MAX_RECOVERY_ATTEMPTS_PER_HOUR,
  resolveDiagnosticsPath,
  resolveLifecycleStatePath,
  appendDiagnosticEvent,
  readLifecycleState,
  writeLifecycleState,
  recordRecoveryAttempt,
  recoveryAllowed,
  redactSecrets,
};
