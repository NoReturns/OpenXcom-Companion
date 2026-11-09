'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { DEFAULT_BASE_STATE_PATH } = require('./relay-config.cjs');
const { createRelayPublisher, checkGhAuthReadiness } = require('./github-relay.cjs');
const { sha256HexLower } = require('./briefing-snapshot.cjs');

const BASE_INTELLIGENCE_FILENAME = 'companion-base-intelligence.json';
/** Relay-only snapshot staged at strategic SEND (isolated from F8/manual canonical export). */
const BASE_INTELLIGENCE_SEND_FILENAME = 'companion-base-intelligence-send.json';
const STRATEGIC_SEND_MARKER_FILENAME = 'companion-strategic-send-marker.json';
const STRATEGIC_BI_SCHEMA_VERSION = 2;
const STRATEGIC_EXPORT_MAX_BYTES = 524288;

function resolveStrategicBaseStatePath(ctx) {
  const contract = ctx.relayIsolationContract;
  if (contract?.baseStatePath) {
    return contract.baseStatePath;
  }
  const fromOpts = ctx.relayOptions?.baseStatePath ?? ctx.relayOptions?.base_state_path;
  if (fromOpts && String(fromOpts).trim()) {
    return String(fromOpts).trim();
  }
  return DEFAULT_BASE_STATE_PATH;
}

function loadStrategicSendMarker(markerPath, io = {}) {
  const existsSync = io.existsSync ?? fs.existsSync;
  const readFileSync = io.readFileSync ?? fs.readFileSync;
  if (!existsSync(markerPath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(markerPath, 'utf8'));
  } catch {
    return { parseError: true };
  }
}

function assessStrategicSendReadiness(paths, pendingRequestId, io = {}) {
  const existsSync = io.existsSync ?? fs.existsSync;
  const readFileSync = io.readFileSync ?? fs.readFileSync;
  const biPath = paths.baseIntelligenceSendPath;
  if (!biPath) {
    return { ok: false, message: 'Strategic send snapshot path not configured.', error_code: 'NOT_READY' };
  }
  if (!existsSync(biPath)) {
    return { ok: false, message: 'No strategic send snapshot on disk.', error_code: 'NOT_READY' };
  }
  let raw;
  try {
    raw = readFileSync(biPath);
  } catch {
    return { ok: false, message: 'Strategic send snapshot unreadable.', error_code: 'NOT_READY' };
  }
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8');
  if (bytes.byteLength > STRATEGIC_EXPORT_MAX_BYTES) {
    return { ok: false, message: 'Base intelligence export exceeds size cap.', error_code: 'STRATEGIC_PAYLOAD_TOO_LARGE' };
  }
  let bi;
  try {
    bi = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { ok: false, message: 'Base intelligence export is not valid JSON.', error_code: 'STRATEGIC_INVALID_JSON' };
  }
  if (!bi || typeof bi !== 'object' || bi.schema_version !== STRATEGIC_BI_SCHEMA_VERSION) {
    return { ok: false, message: 'Base intelligence export schema mismatch.', error_code: 'STRATEGIC_SCHEMA_MISMATCH' };
  }
  const digest = sha256HexLower(bytes);
  const marker = loadStrategicSendMarker(paths.strategicSendMarkerPath, io);
  if (!marker || marker.parseError) {
    return { ok: false, message: 'No fresh strategic send marker.', error_code: 'NOT_READY' };
  }
  if (!pendingRequestId || String(marker.on_demand_request_id) !== String(pendingRequestId)) {
    return { ok: false, message: 'Strategic send marker does not match this request.', error_code: 'STRATEGIC_MARKER_STALE' };
  }
  if (!marker.content_sha256 || String(marker.content_sha256) !== digest) {
    return { ok: false, message: 'Strategic send snapshot stale vs marker.', error_code: 'STRATEGIC_DIGEST_MISMATCH' };
  }
  return { ok: true, bi, digest, marker };
}

function buildStrategicRelayEnvelope(bi, { requestId, publishedAt, snapshotSha256 }) {
  return {
    ...bi,
    kind: 'strategic_base_snapshot',
    request_id: requestId,
    published_at: publishedAt,
    snapshot_sha256: snapshotSha256,
    snapshot_id: snapshotSha256.slice(0, 12),
  };
}

async function publishStrategicBaseState(ctx, pending = null) {
  const requestId = pending?.request_id ?? null;
  const readiness = assessStrategicSendReadiness(ctx.paths, requestId);
  if (!readiness.ok) {
    return {
      ok: false,
      reason: readiness.message,
      code: readiness.error_code ?? 'NOT_READY',
    };
  }
  if (ctx.dryRun) {
    ctx.log?.(`Dry-run strategic base-state publish ${readiness.digest.slice(0, 12)}.`);
    return { ok: true, dryRun: true, digest: readiness.digest };
  }
  if (!checkGhAuthReadiness()) {
    return { ok: false, reason: 'GitHub CLI not authenticated.', code: 'AUTH_FAILED' };
  }
  const publishedAt = new Date(ctx.now()).toISOString();
  const relay = buildStrategicRelayEnvelope(readiness.bi, {
    requestId,
    publishedAt,
    snapshotSha256: readiness.digest,
  });
  const baseStatePath = resolveStrategicBaseStatePath(ctx);
  const publisher = ctx.publisher
    ?? createRelayPublisher({
      ...ctx.relayOptions,
    });
  try {
    const outcome = await publisher.publishRelayDocument(relay, {
    statePath: baseStatePath,
    maxBytes: STRATEGIC_EXPORT_MAX_BYTES + 4096,
    commitMessagePrefix: 'M1 strategic base snapshot',
  });
    if (outcome.skipped) {
      return { ok: true, skipped: true, digest: readiness.digest };
    }
    return { ok: true, digest: readiness.digest };
  } catch (error) {
    return {
      ok: false,
      reason: error.message || 'Strategic publish failed.',
      code: error.code || 'PUBLISH_FAILED',
    };
  }
}

module.exports = {
  BASE_INTELLIGENCE_FILENAME,
  BASE_INTELLIGENCE_SEND_FILENAME,
  STRATEGIC_SEND_MARKER_FILENAME,
  STRATEGIC_BI_SCHEMA_VERSION,
  STRATEGIC_EXPORT_MAX_BYTES,
  resolveStrategicBaseStatePath,
  assessStrategicSendReadiness,
  buildStrategicRelayEnvelope,
  publishStrategicBaseState,
};
