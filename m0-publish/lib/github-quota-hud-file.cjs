'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { writeJsonAtomic, removeFileIfExists } = require('./local-atomic.cjs');

const HUD_SCHEMA = 1;
const HUD_FILENAME = 'companion-github-quota.json';
/** Must exceed longest sidecar poll interval (terrain 15s) with margin. */
const HUD_RELAY_STALE_MS = 45_000;

function resolveCompanionGithubQuotaHudPath(options = {}) {
  const envPath = options.snapshotPathEnv ?? process.env.OPENXCOM_COMPANION_SNAPSHOT_PATH;
  if (envPath && String(envPath).trim()) {
    return path.join(path.dirname(path.resolve(String(envPath).trim())), HUD_FILENAME);
  }
  const publishRoot = options.m0PublishRoot ?? path.resolve(__dirname, '..');
  return path.join(publishRoot, HUD_FILENAME);
}

function buildGithubQuotaHudPayload(options = {}) {
  const now = options.now ?? Date.now();
  const store = options.store;
  const snap = store && typeof store.getSnapshot === 'function'
    ? store.getSnapshot()
    : {
      limit: null,
      remaining: null,
      resetEpochSec: null,
    };
  const rateLimitGate = options.rateLimitGate ?? null;
  let gateCooldownUntilMs = null;
  if (rateLimitGate && typeof rateLimitGate.cooldownUntilMs === 'function') {
    const until = rateLimitGate.cooldownUntilMs(now);
    if (Number.isFinite(until) && until > now) {
      gateCooldownUntilMs = until;
    }
  }
  return {
    schema: HUD_SCHEMA,
    remaining: snap.remaining ?? null,
    limit: snap.limit ?? null,
    reset_epoch_sec: snap.resetEpochSec ?? null,
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

function writeCompanionGithubQuotaHudFile(options = {}) {
  const hudPath = options.hudPath ?? resolveCompanionGithubQuotaHudPath(options);
  const payload = buildGithubQuotaHudPayload(options);
  writeJsonAtomic(hudPath, payload, options.writeFileSync, options.renameSync);
  return { hudPath, payload };
}

module.exports = {
  HUD_SCHEMA,
  HUD_FILENAME,
  HUD_RELAY_STALE_MS,
  resolveCompanionGithubQuotaHudPath,
  buildGithubQuotaHudPayload,
  writeCompanionGithubQuotaHudFile,
  removeCompanionGithubQuotaHudFile,
};
