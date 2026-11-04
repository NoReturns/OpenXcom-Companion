'use strict';

const { isRateLimitBlob } = require('./relay-rate-limit-gate.cjs');

const DEFAULT_WARN_FRACTION = 0.1;

function parseHttpHeaders(headerText) {
  const map = {};
  for (const line of String(headerText || '').split(/\r?\n/)) {
    if (!line || /^HTTP\//i.test(line)) {
      continue;
    }
    const colon = line.indexOf(':');
    if (colon < 0) {
      continue;
    }
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    map[key] = value;
  }
  return map;
}

function parseGhApiIncludeStdout(stdout) {
  const text = String(stdout ?? '');
  const separator = text.includes('\r\n\r\n') ? '\r\n\r\n' : '\n\n';
  const splitAt = text.indexOf(separator);
  if (splitAt < 0) {
    return {
      headerText: '',
      body: text,
      headers: parseHttpHeaders(''),
    };
  }
  const headerText = text.slice(0, splitAt);
  const body = text.slice(splitAt + separator.length);
  return {
    headerText,
    body,
    headers: parseHttpHeaders(headerText),
  };
}

function parseIntHeader(headers, name) {
  if (!headers) {
    return null;
  }
  const key = String(name).toLowerCase();
  const raw = headers[key];
  if (raw === undefined || raw === null || raw === '') {
    return null;
  }
  const value = Number.parseInt(String(raw), 10);
  return Number.isFinite(value) ? value : null;
}

function parseRateLimitHeadersFromText(text) {
  const blob = String(text || '');
  return {
    limit: (() => {
      const match = blob.match(/x-ratelimit-limit:\s*(\d+)/i);
      return match ? Number.parseInt(match[1], 10) : null;
    })(),
    remaining: (() => {
      const match = blob.match(/x-ratelimit-remaining:\s*(\d+)/i);
      return match ? Number.parseInt(match[1], 10) : null;
    })(),
    used: (() => {
      const match = blob.match(/x-ratelimit-used:\s*(\d+)/i);
      return match ? Number.parseInt(match[1], 10) : null;
    })(),
    resetEpochSec: (() => {
      const match = blob.match(/x-ratelimit-reset:\s*(\d+)/i);
      return match ? Number.parseInt(match[1], 10) : null;
    })(),
    resource: (() => {
      const match = blob.match(/x-ratelimit-resource:\s*(\S+)/i);
      return match ? match[1] : null;
    })(),
  };
}

function classifyGhErrorKind(error) {
  const blob = `${error && error.stderr ? error.stderr : ''}\n${error && error.message ? error.message : ''}`;
  if (error && error.code === 'AUTH_FAILED') {
    return 'AUTH_FAILED';
  }
  if (/secondary rate limit/i.test(blob)) {
    return 'SECONDARY_RATE_LIMIT';
  }
  if (error && error.code === 'RATE_LIMIT') {
    return 'PRIMARY_RATE_LIMIT';
  }
  if (isRateLimitBlob(blob)) {
    return 'PRIMARY_RATE_LIMIT';
  }
  return null;
}

function createGithubQuotaTelemetryStore(options = {}) {
  const nowFn = options.now ?? (() => Date.now());
  let state = emptySnapshot();

  function emptySnapshot() {
    return {
      limit: null,
      remaining: null,
      used: null,
      resetEpochSec: null,
      resource: null,
      capturedAtMs: null,
      lastErrorKind: null,
    };
  }

  function mergeParsed(parsed, now) {
    if (parsed.limit !== null) {
      state.limit = parsed.limit;
    }
    if (parsed.remaining !== null) {
      state.remaining = parsed.remaining;
    }
    if (parsed.used !== null) {
      state.used = parsed.used;
    }
    if (parsed.resetEpochSec !== null) {
      state.resetEpochSec = parsed.resetEpochSec;
    }
    if (parsed.resource) {
      state.resource = parsed.resource;
    }
    state.capturedAtMs = now;
  }

  function recordFromHeaders(headers, meta = {}) {
    const now = meta.now ?? nowFn();
    mergeParsed({
      limit: parseIntHeader(headers, 'x-ratelimit-limit'),
      remaining: parseIntHeader(headers, 'x-ratelimit-remaining'),
      used: parseIntHeader(headers, 'x-ratelimit-used'),
      resetEpochSec: parseIntHeader(headers, 'x-ratelimit-reset'),
      resource: headers['x-ratelimit-resource'] ?? null,
    }, now);
    if (state.remaining !== null && state.remaining > 0 && !meta.preserveErrorKind) {
      state.lastErrorKind = null;
    }
  }

  function recordFromGhError(error, now = nowFn()) {
    const blob = `${error && error.stderr ? error.stderr : ''}\n${error && error.message ? error.message : ''}`;
    mergeParsed(parseRateLimitHeadersFromText(blob), now);
    const kind = classifyGhErrorKind(error);
    if (kind) {
      state.lastErrorKind = kind;
    }
  }

  function getSnapshot() {
    return { ...state };
  }

  function resetForTests() {
    state = emptySnapshot();
  }

  return {
    recordFromHeaders,
    recordFromGhError,
    getSnapshot,
    resetForTests,
  };
}

function formatDurationHms(ms) {
  if (!Number.isFinite(ms)) {
    return 'UNKNOWN';
  }
  const clamped = Math.max(0, ms);
  const totalSec = Math.ceil(clamped / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function msUntilResetEpoch(resetEpochSec, now) {
  if (!Number.isFinite(resetEpochSec)) {
    return null;
  }
  return resetEpochSec * 1000 - now;
}

function deriveUsed(snapshot) {
  if (snapshot.used !== null) {
    return snapshot.used;
  }
  if (snapshot.limit !== null && snapshot.remaining !== null) {
    return snapshot.limit - snapshot.remaining;
  }
  return null;
}

function hasPrimaryTelemetry(snapshot) {
  return snapshot.limit !== null || snapshot.remaining !== null;
}

function buildQuotaConsoleView(options = {}) {
  const snapshot = options.snapshot ?? emptyViewSnapshot();
  const now = options.now ?? Date.now();
  const warnFraction = options.warnFraction ?? DEFAULT_WARN_FRACTION;
  const gate = options.rateLimitGate ?? null;
  const gateWaitMs = gate && typeof gate.msUntilOpen === 'function' ? gate.msUntilOpen(now) : 0;
  const gateUntilMs = gate && typeof gate.cooldownUntilMs === 'function' ? gate.cooldownUntilMs(now) : 0;

  if (snapshot.lastErrorKind === 'AUTH_FAILED') {
    return {
      kind: 'AUTH_FAILED',
      health: 'AUTH',
      message: '[GitHub quota] AUTH_FAILED — check `gh auth login`',
    };
  }

  if (snapshot.lastErrorKind === 'SECONDARY_RATE_LIMIT') {
    const countdownMs = gateWaitMs > 0 ? gateWaitMs : msUntilResetEpoch(snapshot.resetEpochSec, now);
    return {
      kind: 'SECONDARY_RATE_LIMIT',
      health: 'SECONDARY',
      resetIn: formatDurationHms(countdownMs),
      message: `[GitHub quota] SECONDARY_LIMIT health SECONDARY reset_in ${formatDurationHms(countdownMs)}`,
    };
  }

  const resetInMs = msUntilResetEpoch(snapshot.resetEpochSec, now);
  const used = deriveUsed(snapshot);
  const resource = snapshot.resource ?? 'core';

  if (hasPrimaryTelemetry(snapshot)) {
    const remaining = snapshot.remaining;
    const limit = snapshot.limit;
    let health = 'OK';
    if (remaining === 0) {
      health = 'EXHAUSTED';
    } else if (limit !== null && remaining !== null && limit > 0 && remaining / limit <= warnFraction) {
      health = 'LOW';
    }

    if (snapshot.lastErrorKind === 'PRIMARY_RATE_LIMIT' || remaining === 0) {
      health = 'EXHAUSTED';
    }

    const remainingLabel = remaining !== null ? String(remaining) : 'UNKNOWN';
    const limitLabel = limit !== null ? String(limit) : 'UNKNOWN';
    const usedLabel = used !== null ? String(used) : 'UNKNOWN';
    const resetLabel = resetInMs !== null ? formatDurationHms(resetInMs) : 'UNKNOWN';
    const warnPrefix = health === 'LOW' ? 'WARN ' : '';
    const line = `[GitHub quota] ${warnPrefix}${resource} ${remainingLabel}/${limitLabel} used ${usedLabel} health ${health} reset_in ${resetLabel}`;

    if (gateWaitMs > 0 && (health === 'EXHAUSTED' || snapshot.lastErrorKind === 'PRIMARY_RATE_LIMIT')) {
      return {
        kind: 'PRIMARY_WITH_GATE',
        health,
        resetIn: formatDurationHms(Math.max(gateWaitMs, resetInMs ?? 0)),
        message: `${line} gate_cooldown ${formatDurationHms(gateWaitMs)}`,
      };
    }

    return {
      kind: 'PRIMARY',
      health,
      resetIn: resetLabel,
      message: line,
    };
  }

  if (gateWaitMs > 0) {
    const gateResetIn = gateUntilMs > now ? formatDurationHms(gateUntilMs - now) : formatDurationHms(gateWaitMs);
    return {
      kind: 'GATE_COOLDOWN',
      health: 'COOLDOWN',
      resetIn: gateResetIn,
      message: `[GitHub quota] COOLDOWN health COOLDOWN reset_in ${gateResetIn} (relay gate; telemetry UNKNOWN)`,
    };
  }

  return {
    kind: 'UNKNOWN',
    health: 'UNKNOWN',
    resetIn: 'UNKNOWN',
    message: '[GitHub quota] telemetry UNKNOWN (no rate-limit headers captured yet)',
  };
}

function emptyViewSnapshot() {
  return {
    limit: null,
    remaining: null,
    used: null,
    resetEpochSec: null,
    resource: null,
    capturedAtMs: null,
    lastErrorKind: null,
  };
}

function formatQuotaConsoleLine(options = {}) {
  return buildQuotaConsoleView(options).message;
}

module.exports = {
  DEFAULT_WARN_FRACTION,
  parseGhApiIncludeStdout,
  parseHttpHeaders,
  parseRateLimitHeadersFromText,
  classifyGhErrorKind,
  createGithubQuotaTelemetryStore,
  formatDurationHms,
  msUntilResetEpoch,
  buildQuotaConsoleView,
  formatQuotaConsoleLine,
};
