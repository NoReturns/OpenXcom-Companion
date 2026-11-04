'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { writeJsonAtomic, removeFileIfExists } = require('./local-atomic.cjs');

const HUD_SCHEMA = 1;
const HUD_FILENAME = 'companion-github-quota.json';
/** Primary GitHub REST pool tracked for the in-game HUD. */
const HUD_RATE_LIMIT_RESOURCE = 'core';
/** Must exceed longest sidecar poll interval (terrain 15s) with margin. */
const HUD_RELAY_STALE_MS = 45_000;
/** Min interval between HUD file writes when quota fields are unchanged (idle relay heartbeat). */
const HUD_HEARTBEAT_WRITE_MS = 30_000;

function isValidQuotaInt(value) {
  return Number.isInteger(value) && value >= 0;
}

function resolveCompanionGithubQuotaHudPath(options = {}) {
  if (options.hudPath) {
    return path.resolve(options.hudPath);
  }
  const envPath = options.snapshotPathEnv ?? process.env.OPENXCOM_COMPANION_SNAPSHOT_PATH;
  if (envPath && String(envPath).trim()) {
    return path.join(path.dirname(path.resolve(String(envPath).trim())), HUD_FILENAME);
  }
  const publishRoot = options.m0PublishRoot ?? path.resolve(__dirname, '..');
  return path.join(publishRoot, HUD_FILENAME);
}

function readCompanionGithubQuotaHudFile(hudPath, io = {}) {
  const existsSync = io.existsSync ?? fs.existsSync;
  const readFileSync = io.readFileSync ?? fs.readFileSync;
  if (!existsSync(hudPath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(hudPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function snapshotFromHudFilePayload(raw) {
  if (!raw || raw.schema !== HUD_SCHEMA) {
    return null;
  }
  return {
    limit: isValidQuotaInt(raw.limit) ? raw.limit : null,
    remaining: isValidQuotaInt(raw.remaining) ? raw.remaining : null,
    used: null,
    resetEpochSec: isValidQuotaInt(raw.reset_epoch_sec) ? raw.reset_epoch_sec : null,
    resource: typeof raw.resource === 'string' && raw.resource.length > 0 ? raw.resource : HUD_RATE_LIMIT_RESOURCE,
    capturedAtMs: Number.isFinite(raw.observation_at_ms)
      ? raw.observation_at_ms
      : (Number.isFinite(raw.updated_at_ms) ? raw.updated_at_ms : null),
    lastErrorKind: null,
  };
}

function isLegitimateQuotaReset(existing, incoming) {
  if (!existing || !incoming) {
    return false;
  }
  if (!isValidQuotaInt(incoming.remaining)) {
    return false;
  }
  const existingReset = isValidQuotaInt(existing.reset_epoch_sec) ? existing.reset_epoch_sec : null;
  const incomingReset = isValidQuotaInt(incoming.reset_epoch_sec) ? incoming.reset_epoch_sec : null;
  if (incomingReset !== null && existingReset !== null && incomingReset > existingReset) {
    return true;
  }
  if (isValidQuotaInt(existing.remaining) && incoming.remaining > existing.remaining) {
    const existingLimit = isValidQuotaInt(existing.limit) ? existing.limit : null;
    if (existingLimit !== null && incoming.remaining >= Math.floor(existingLimit * 0.9)) {
      return true;
    }
  }
  return false;
}

function mergeHudQuotaFields(existing, incoming) {
  const merged = {
    remaining: isValidQuotaInt(existing?.remaining) ? existing.remaining : null,
    limit: isValidQuotaInt(existing?.limit) ? existing.limit : null,
    reset_epoch_sec: isValidQuotaInt(existing?.reset_epoch_sec) ? existing.reset_epoch_sec : null,
    resource: typeof existing?.resource === 'string' ? existing.resource : HUD_RATE_LIMIT_RESOURCE,
    observation_at_ms: Number.isFinite(existing?.observation_at_ms)
      ? existing.observation_at_ms
      : (Number.isFinite(existing?.updated_at_ms) ? existing.updated_at_ms : null),
  };

  const reset = isLegitimateQuotaReset(existing, incoming);
  for (const key of ['remaining', 'limit', 'reset_epoch_sec']) {
    const value = incoming[key];
    if (!isValidQuotaInt(value)) {
      continue;
    }
    if (key === 'remaining' && merged.remaining !== null && !reset && value > merged.remaining + 1) {
      continue;
    }
    merged[key] = value;
  }
  if (typeof incoming.resource === 'string' && incoming.resource.length > 0) {
    if (!merged.resource || merged.resource === incoming.resource || incoming.resource === HUD_RATE_LIMIT_RESOURCE) {
      merged.resource = incoming.resource;
    }
  }
  if (Number.isFinite(incoming.observation_at_ms)) {
    merged.observation_at_ms = incoming.observation_at_ms;
  }
  return merged;
}

function buildGithubQuotaHudPayload(options = {}) {
  const now = options.now ?? Date.now();
  const hudPath = options.hudPath ?? resolveCompanionGithubQuotaHudPath(options);
  const existing = readCompanionGithubQuotaHudFile(hudPath, options);
  const store = options.store;
  const snap = store && typeof store.getSnapshot === 'function'
    ? store.getSnapshot()
    : {
      limit: null,
      remaining: null,
      resetEpochSec: null,
      resource: null,
      capturedAtMs: null,
    };
  const rateLimitGate = options.rateLimitGate ?? null;
  let gateCooldownUntilMs = null;
  if (rateLimitGate && typeof rateLimitGate.cooldownUntilMs === 'function') {
    const until = rateLimitGate.cooldownUntilMs(now);
    if (Number.isFinite(until) && until > now) {
      gateCooldownUntilMs = until;
    }
  }

  const hasFreshObservation = snap.capturedAtMs !== null
    && (snap.remaining !== null || snap.limit !== null);
  const incoming = {
    remaining: isValidQuotaInt(snap.remaining) ? snap.remaining : null,
    limit: isValidQuotaInt(snap.limit) ? snap.limit : null,
    reset_epoch_sec: isValidQuotaInt(snap.resetEpochSec) ? snap.resetEpochSec : null,
    resource: snap.resource ?? HUD_RATE_LIMIT_RESOURCE,
    observation_at_ms: hasFreshObservation ? snap.capturedAtMs : null,
  };
  const merged = mergeHudQuotaFields(existing, incoming);
  const observationAtMs = Number.isFinite(merged.observation_at_ms) ? merged.observation_at_ms : null;
  const staleObservation = observationAtMs === null || (now - observationAtMs) > HUD_RELAY_STALE_MS;

  return {
    schema: HUD_SCHEMA,
    remaining: merged.remaining,
    limit: merged.limit,
    reset_epoch_sec: merged.reset_epoch_sec,
    resource: merged.resource ?? HUD_RATE_LIMIT_RESOURCE,
    observation_at_ms: observationAtMs,
    stale_observation: staleObservation,
    relay_heartbeat_at_ms: now,
    gate_cooldown_until_ms: gateCooldownUntilMs,
    updated_at_ms: now,
    updated_at: new Date(now).toISOString(),
  };
}

function removeCompanionGithubQuotaHudFile(options = {}) {
  const hudPath = options.hudPath ?? resolveCompanionGithubQuotaHudPath(options);
  removeFileIfExists(hudPath, options.existsSync, options.unlinkSync);
  return hudPath;
}

function hudQuotaContentSignature(payload) {
  return JSON.stringify({
    remaining: payload.remaining,
    limit: payload.limit,
    reset_epoch_sec: payload.reset_epoch_sec,
    resource: payload.resource,
    observation_at_ms: payload.observation_at_ms,
    gate_cooldown_until_ms: payload.gate_cooldown_until_ms,
  });
}

function shouldWriteCompanionGithubQuotaHudFile(existing, payload, now) {
  if (!existing || existing.schema !== HUD_SCHEMA) {
    return true;
  }
  if (hudQuotaContentSignature(existing) !== hudQuotaContentSignature(payload)) {
    return true;
  }
  const lastHeartbeat = Number.isFinite(existing.relay_heartbeat_at_ms)
    ? existing.relay_heartbeat_at_ms
    : (Number.isFinite(existing.updated_at_ms) ? existing.updated_at_ms : 0);
  return (now - lastHeartbeat) >= HUD_HEARTBEAT_WRITE_MS;
}

function writeCompanionGithubQuotaHudFile(options = {}) {
  const hudPath = options.hudPath ?? resolveCompanionGithubQuotaHudPath(options);
  const now = options.now ?? Date.now();
  const payload = options.payload ?? buildGithubQuotaHudPayload({ ...options, now });
  const existing = readCompanionGithubQuotaHudFile(hudPath, options);
  if (!shouldWriteCompanionGithubQuotaHudFile(existing, payload, now)) {
    return { hudPath, payload, written: false };
  }
  writeJsonAtomic(hudPath, payload, options.writeFileSync, options.renameSync);
  return { hudPath, payload, written: true };
}

module.exports = {
  HUD_SCHEMA,
  HUD_FILENAME,
  HUD_RATE_LIMIT_RESOURCE,
  HUD_RELAY_STALE_MS,
  HUD_HEARTBEAT_WRITE_MS,
  hudQuotaContentSignature,
  shouldWriteCompanionGithubQuotaHudFile,
  isValidQuotaInt,
  resolveCompanionGithubQuotaHudPath,
  readCompanionGithubQuotaHudFile,
  snapshotFromHudFilePayload,
  mergeHudQuotaFields,
  buildGithubQuotaHudPayload,
  writeCompanionGithubQuotaHudFile,
  removeCompanionGithubQuotaHudFile,
};
