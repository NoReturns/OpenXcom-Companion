'use strict';

const fs = require('node:fs');
const path = require('node:path');

const GATE_SCHEMA = 1;
const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 3_600_000;
const SHARED_RELAY_RATE_LIMIT_GATE_FILENAME = '.relay-github-rate-limit-gate.json';

function resolveSharedRelayRateLimitGatePath(m0PublishRoot) {
  return path.join(m0PublishRoot, SHARED_RELAY_RATE_LIMIT_GATE_FILENAME);
}

function parseCooldownMsFromGhBlob(blob, now = Date.now()) {
  const text = String(blob || '');
  let cooldownMs = 0;

  const retryAfter = text.match(/retry-after:\s*(\d+)/i);
  if (retryAfter) {
    cooldownMs = Math.max(cooldownMs, Number(retryAfter[1]) * 1000);
  }

  const resetHeader = text.match(/x-ratelimit-reset:\s*(\d+)/i);
  if (resetHeader) {
    const resetMs = Number(resetHeader[1]) * 1000;
    if (Number.isFinite(resetMs)) {
      cooldownMs = Math.max(cooldownMs, resetMs - now);
    }
  }

  const resetIn = text.match(/rate limit reset[s]? in\s+(\d+)\s+minute/i);
  if (resetIn) {
    cooldownMs = Math.max(cooldownMs, Number(resetIn[1]) * 60_000);
  }

  if (/rate limit|429|secondary rate limit/i.test(text)) {
    cooldownMs = Math.max(cooldownMs, DEFAULT_COOLDOWN_MS);
  }

  if (!Number.isFinite(cooldownMs) || cooldownMs < 0) {
    return DEFAULT_COOLDOWN_MS;
  }
  return Math.min(Math.max(cooldownMs, DEFAULT_COOLDOWN_MS), MAX_COOLDOWN_MS);
}

function isRateLimitBlob(blob) {
  const text = String(blob || '');
  if (/rate limit|429|secondary rate limit/i.test(text)) {
    return true;
  }
  return /403/.test(text) && /api rate limit exceeded|rate limit exceeded/i.test(text);
}

function createRelayRateLimitGate(options = {}) {
  const gatePath = options.gatePath;
  const nowFn = options.now ?? (() => Date.now());
  const readFileSync = options.readFileSync ?? fs.readFileSync;
  const writeFileSync = options.writeFileSync ?? fs.writeFileSync;
  const existsSync = options.existsSync ?? fs.existsSync;
  const mkdirSync = options.mkdirSync ?? fs.mkdirSync;
  const renameSync = options.renameSync ?? fs.renameSync;
  const openSync = options.openSync ?? fs.openSync;
  const closeSync = options.closeSync ?? fs.closeSync;
  const unlinkSync = options.unlinkSync ?? fs.unlinkSync;
  const lockTimeoutMs = options.lockTimeoutMs ?? 10_000;

  function mergeLockPath() {
    return `${gatePath}.merge.lock`;
  }

  function withMergeLock(fn) {
    if (!gatePath) {
      return fn();
    }
    mkdirSync(path.dirname(gatePath), { recursive: true });
    const lockPath = mergeLockPath();
    const deadline = nowFn() + lockTimeoutMs;
    let lockFd = null;
    while (nowFn() < deadline) {
      try {
        lockFd = openSync(lockPath, 'wx');
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') {
          throw error;
        }
      }
    }
    if (lockFd === null) {
      const timeout = new Error('GitHub rate-limit gate merge lock timeout.');
      timeout.code = 'GATE_LOCK_TIMEOUT';
      throw timeout;
    }
    try {
      return fn();
    } finally {
      try {
        closeSync(lockFd);
      } catch {
        /* ignore */
      }
      try {
        unlinkSync(lockPath);
      } catch {
        /* ignore */
      }
    }
  }

  function readState() {
    if (!gatePath || !existsSync(gatePath)) {
      return null;
    }
    try {
      const parsed = JSON.parse(readFileSync(gatePath, 'utf8'));
      if (parsed && parsed.schema === GATE_SCHEMA && Number.isFinite(parsed.cooldown_until_ms)) {
        return parsed;
      }
    } catch {
      return null;
    }
    return null;
  }

  function writeState(cooldownUntilMs, reason) {
    if (!gatePath) {
      return;
    }
    mkdirSync(path.dirname(gatePath), { recursive: true });
    const payload = {
      schema: GATE_SCHEMA,
      cooldown_until_ms: cooldownUntilMs,
      reason: reason || 'RATE_LIMIT',
      updated_at: new Date(nowFn()).toISOString(),
    };
    const temp = `${gatePath}.tmp`;
    writeFileSync(temp, `${JSON.stringify(payload)}\n`, 'utf8');
    renameSync(temp, gatePath);
  }

  function cooldownUntilMs(now = nowFn()) {
    const state = readState();
    if (!state) {
      return 0;
    }
    if (state.cooldown_until_ms <= now) {
      return 0;
    }
    return state.cooldown_until_ms;
  }

  function msUntilOpen(now = nowFn()) {
    const until = cooldownUntilMs(now);
    return until > now ? until - now : 0;
  }

  function isOpen(now = nowFn()) {
    return msUntilOpen(now) === 0;
  }

  function mergeCooldownUntil(candidateUntilMs) {
    return withMergeLock(() => {
      const existing = readState();
      const mergedUntil = Math.max(existing?.cooldown_until_ms ?? 0, candidateUntilMs);
      writeState(mergedUntil, 'RATE_LIMIT');
      return mergedUntil;
    });
  }

  function recordError(error, now = nowFn()) {
    const blob = `${error && error.stderr ? error.stderr : ''}\n${error && error.message ? error.message : ''}`;
    if (error && error.code !== 'RATE_LIMIT' && !isRateLimitBlob(blob)) {
      return 0;
    }
    const waitMs = parseCooldownMsFromGhBlob(blob, now);
    const until = now + waitMs;
    const mergedUntil = mergeCooldownUntil(until);
    return Math.max(0, mergedUntil - now);
  }

  function assertOpenOrThrow(now = nowFn()) {
    const wait = msUntilOpen(now);
    if (wait > 0) {
      const rate = new Error(`GitHub API rate limit cooldown (${Math.ceil(wait / 1000)}s remaining).`);
      rate.code = 'RATE_LIMIT';
      rate.cooldown_ms = wait;
      throw rate;
    }
  }

  function wrapGhApiExec(ghApiExec) {
    return function gatedGhApi(method, apiPath, body) {
      assertOpenOrThrow();
      try {
        return ghApiExec(method, apiPath, body);
      } catch (error) {
        recordError(error);
        throw error;
      }
    };
  }

  return {
    gatePath,
    parseCooldownMsFromGhBlob,
    isRateLimitBlob,
    cooldownUntilMs,
    msUntilOpen,
    isOpen,
    recordError,
    assertOpenOrThrow,
    wrapGhApiExec,
    mergeCooldownUntil,
    readState,
  };
}

module.exports = {
  GATE_SCHEMA,
  DEFAULT_COOLDOWN_MS,
  SHARED_RELAY_RATE_LIMIT_GATE_FILENAME,
  resolveSharedRelayRateLimitGatePath,
  parseCooldownMsFromGhBlob,
  isRateLimitBlob,
  createRelayRateLimitGate,
};
