'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { writeJsonAtomic } = require('./local-atomic.cjs');
const { RELAY_SHRINK_EXHAUSTED } = require('./relay-payload-adaptive-shrink.cjs');

const MANUAL_UPLOAD_NOTICE_SCHEMA_VERSION = 1;
const MANUAL_UPLOAD_NOTICE_FILENAME = 'companion-manual-upload-notice.json';
const NOTICE_PRODUCER_NODE = 'node';
const NOTICE_PRODUCER_ENGINE = 'engine';

const MANUAL_UPLOAD_NOTICE_TITLE = 'COMPANION SNAPSHOT TOO LARGE';
const MANUAL_UPLOAD_NOTICE_MESSAGE = [
  'Complete battlefield intelligence has been saved locally.',
  'Please upload this file to your ChatGPT partner.',
].join('\n');

function noticePath(snapshotDir) {
  return path.join(snapshotDir, MANUAL_UPLOAD_NOTICE_FILENAME);
}

function readManualUploadNotice(snapshotDir, io = {}) {
  const existsSync = io.existsSync ?? fs.existsSync;
  const readFileSync = io.readFileSync ?? fs.readFileSync;
  const filePath = noticePath(snapshotDir);
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function isNodeProducerNotice(notice) {
  return Boolean(notice && notice.producer === NOTICE_PRODUCER_NODE);
}

function isActiveManualUploadNotice(notice) {
  return Boolean(notice && notice.active !== false && notice.artifact_path);
}

/**
 * Whether an incoming Node notice may replace the on-disk notice.
 * Never overwrites a non-node producer (e.g. future engine notices).
 */
function shouldReplaceManualUploadNotice(existing, incoming) {
  if (!incoming || incoming.producer !== NOTICE_PRODUCER_NODE) {
    return false;
  }
  if (!existing || !isActiveManualUploadNotice(existing)) {
    return true;
  }
  if (existing.producer !== NOTICE_PRODUCER_NODE) {
    return false;
  }
  if (typeof incoming.session_id === 'string'
    && typeof existing.session_id === 'string'
    && incoming.session_id !== existing.session_id) {
    return true;
  }
  const incomingMs = Number(incoming.created_at_ms);
  const existingMs = Number(existing.created_at_ms);
  if (Number.isFinite(incomingMs) && Number.isFinite(existingMs) && incomingMs < existingMs) {
    return false;
  }
  const incomingTurn = incoming.turn;
  const existingTurn = existing.turn;
  if (Number.isFinite(incomingTurn) && Number.isFinite(existingTurn) && incomingTurn < existingTurn) {
    return false;
  }
  if (incomingTurn === existingTurn
    && Number.isFinite(incomingMs)
    && Number.isFinite(existingMs)
    && incomingMs === existingMs
    && incoming.request_id
    && existing.request_id
    && incoming.request_id !== existing.request_id) {
    return false;
  }
  return true;
}

function buildManualUploadNotice(fields) {
  const createdAtMs = fields.createdAtMs ?? Date.now();
  return {
    schema_version: MANUAL_UPLOAD_NOTICE_SCHEMA_VERSION,
    active: true,
    notice_id: fields.noticeId ?? crypto.randomUUID(),
    producer: NOTICE_PRODUCER_NODE,
    reason_code: fields.reasonCode ?? RELAY_SHRINK_EXHAUSTED,
    artifact_path: fields.artifactPath,
    artifact_sha256: fields.artifactSha256,
    artifact_filename: fields.artifactFilename ?? null,
    session_id: fields.sessionId,
    snapshot_id: fields.snapshotId,
    turn: fields.turn,
    request_id: fields.requestId ?? null,
    created_at_ms: createdAtMs,
    created_at: new Date(createdAtMs).toISOString(),
    title: MANUAL_UPLOAD_NOTICE_TITLE,
    message: MANUAL_UPLOAD_NOTICE_MESSAGE,
  };
}

function writeManualUploadNoticeAtomic(snapshotDir, notice, io = {}) {
  if (!notice || notice.producer !== NOTICE_PRODUCER_NODE) {
    return { written: false, notice: readManualUploadNotice(snapshotDir, io), reason: 'not_node_producer' };
  }
  if (!shouldReplaceManualUploadNotice(readManualUploadNotice(snapshotDir, io), notice)) {
    return { written: false, notice: readManualUploadNotice(snapshotDir, io) };
  }
  writeJsonAtomic(
    noticePath(snapshotDir),
    notice,
    io.writeFileSync ?? fs.writeFileSync,
    io.renameSync ?? fs.renameSync,
  );
  return { written: true, notice };
}

function clearNodeManualUploadNotice(snapshotDir, options = {}, io = {}) {
  const existing = readManualUploadNotice(snapshotDir, io);
  if (!existing || !isNodeProducerNotice(existing)) {
    return { cleared: false, reason: 'not_node_notice' };
  }
  if (!isActiveManualUploadNotice(existing)) {
    return { cleared: false, reason: 'already_inactive' };
  }
  const sessionId = options.sessionId;
  if (sessionId && existing.session_id && sessionId !== existing.session_id) {
    return { cleared: false, reason: 'session_mismatch' };
  }
  const clearedAtMs = options.clearedAtMs ?? Date.now();
  const inactive = {
    ...existing,
    active: false,
    cleared_at_ms: clearedAtMs,
    cleared_at: new Date(clearedAtMs).toISOString(),
    cleared_reason: options.reason ?? 'relay_published',
  };
  writeJsonAtomic(
    noticePath(snapshotDir),
    inactive,
    io.writeFileSync ?? fs.writeFileSync,
    io.renameSync ?? fs.renameSync,
  );
  return { cleared: true, notice: inactive };
}

module.exports = {
  MANUAL_UPLOAD_NOTICE_SCHEMA_VERSION,
  MANUAL_UPLOAD_NOTICE_FILENAME,
  NOTICE_PRODUCER_NODE,
  NOTICE_PRODUCER_ENGINE,
  MANUAL_UPLOAD_NOTICE_TITLE,
  MANUAL_UPLOAD_NOTICE_MESSAGE,
  noticePath,
  readManualUploadNotice,
  isNodeProducerNotice,
  isActiveManualUploadNotice,
  shouldReplaceManualUploadNotice,
  buildManualUploadNotice,
  writeManualUploadNoticeAtomic,
  clearNodeManualUploadNotice,
};
