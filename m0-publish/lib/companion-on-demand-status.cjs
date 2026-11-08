'use strict';

const fs = require('node:fs');
const { writeJsonAtomic } = require('./local-atomic.cjs');

const BRIEFING_ACK_STATUS_MANUAL_UPLOAD_REQUIRED = 'manual_upload_required';
const BRIEFING_ACK_STATUS_DEFERRED = 'deferred';

const RELAY_OUTCOME = Object.freeze({
  SENDING: 'sending',
  PUBLISHED: 'published',
  SKIPPED_UNCHANGED: 'skipped_unchanged',
  FAILED: 'failed',
  MANUAL_UPLOAD_REQUIRED: 'manual_upload_required',
  DEFERRED: 'deferred',
  RETRIEVE_COMPLETE: 'retrieve_complete',
  NO_NEW_ORDERS: 'no_new_orders',
});

function readOnDemandStatus(statusPath, io = {}) {
  const existsSync = io.existsSync ?? fs.existsSync;
  const readFileSync = io.readFileSync ?? fs.readFileSync;
  if (!existsSync(statusPath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(statusPath, 'utf8'));
  } catch {
    return null;
  }
}

function isTerminalRetrievePhase(phase) {
  return phase === 'completed' || phase === 'failed';
}

/**
 * Empty inbox polls must not erase a confirmed retrieve / command outcome on the overlay.
 */
function isStickyTerminalRetrieveOutcome(existing) {
  if (!existing || existing.action !== 'retrieve' || !existing.terminal) {
    return false;
  }
  if (existing.last_command_id && existing.last_command_status) {
    return true;
  }
  return isTerminalRetrievePhase(existing.phase);
}

function incomingRetrievePollWouldEraseTerminalOutcome(existing, incoming) {
  if (!existing || !incoming || incoming.action !== 'retrieve') {
    return false;
  }
  if (!isStickyTerminalRetrieveOutcome(existing)) {
    return false;
  }
  if (incoming.phase === 'no_new_orders') {
    return true;
  }
  if (incoming.phase === 'retrieving' && incoming.terminal === false) {
    return true;
  }
  return false;
}

/**
 * Prevent an older on-demand request or stale poll from overwriting a newer terminal status.
 */
function shouldWriteOnDemandStatus(existing, incoming) {
  if (!incoming || typeof incoming !== 'object') {
    return false;
  }
  if (!existing || typeof existing !== 'object') {
    return true;
  }
  if (incomingRetrievePollWouldEraseTerminalOutcome(existing, incoming)) {
    return false;
  }
  if (incoming.request_id && existing.request_id && incoming.request_id === existing.request_id) {
    return true;
  }
  const existingMs = Number(existing.updated_at_ms) || 0;
  const incomingMs = Number(incoming.updated_at_ms) || 0;
  if (incoming.request_id && existing.request_id && incoming.request_id !== existing.request_id) {
    if (incomingMs >= existingMs) {
      return true;
    }
    if (existing.terminal) {
      return false;
    }
    return incomingMs >= existingMs;
  }
  if (existing.terminal && incomingMs < existingMs) {
    return false;
  }
  if (existing.terminal && incoming.terminal === false && incoming.request_id === existing.request_id) {
    return true;
  }
  return true;
}

function buildOnDemandStatusPayload(fields) {
  const payload = {
    request_id: fields.request_id,
    action: fields.action,
    phase: fields.phase,
    message: fields.message ?? '',
    updated_at_ms: fields.updated_at_ms,
    terminal: Boolean(fields.terminal),
  };
  if (fields.outcome) {
    payload.outcome = fields.outcome;
  }
  if (fields.error_code) {
    payload.error_code = fields.error_code;
  }
  if (fields.briefing_request_id) {
    payload.briefing_request_id = fields.briefing_request_id;
  }
  if (fields.last_command_id) {
    payload.last_command_id = fields.last_command_id;
  }
  if (fields.last_command_status) {
    payload.last_command_status = fields.last_command_status;
  }
  if (fields.retrieve_outcome) {
    payload.retrieve_outcome = fields.retrieve_outcome;
  }
  return payload;
}

function writeOnDemandStatus(statusPath, payload, io = {}) {
  const existing = readOnDemandStatus(statusPath, io);
  if (!shouldWriteOnDemandStatus(existing, payload)) {
    return { written: false, payload: existing };
  }
  writeJsonAtomic(
    statusPath,
    payload,
    io.writeFileSync ?? fs.writeFileSync,
    io.renameSync ?? fs.renameSync,
  );
  return { written: true, payload };
}

function mapBriefingAckToSendFields(ack, expectedBriefingRequestId, options = {}) {
  if (!ack?.value?.status) {
    return null;
  }
  const v = ack.value;
  if (expectedBriefingRequestId && v.request_id !== expectedBriefingRequestId) {
    return null;
  }
  const sanitize = options.sanitizeReason ?? ((text) => text);
  if (v.status === BRIEFING_ACK_STATUS_DEFERRED) {
    return {
      error_code: v.error_code || 'RATE_LIMIT',
      outcome: RELAY_OUTCOME.DEFERRED,
      terminal: false,
      message: sanitize(v.message || 'Publish deferred (rate limit).'),
    };
  }
  if (v.status === 'published') {
    return {
      outcome: RELAY_OUTCOME.PUBLISHED,
      terminal: true,
      message: sanitize(v.message || 'Briefing published.'),
    };
  }
  if (v.status === 'skipped_unchanged') {
    return {
      outcome: RELAY_OUTCOME.SKIPPED_UNCHANGED,
      terminal: true,
      message: sanitize(v.message || 'Remote state already current.'),
    };
  }
  if (v.status === 'dry_run') {
    return {
      outcome: RELAY_OUTCOME.PUBLISHED,
      terminal: true,
      message: sanitize(v.message || 'Dry-run briefing validated.'),
    };
  }
  if (v.status === BRIEFING_ACK_STATUS_MANUAL_UPLOAD_REQUIRED) {
    return {
      error_code: v.error_code || 'RELAY_SHRINK_EXHAUSTED',
      outcome: RELAY_OUTCOME.MANUAL_UPLOAD_REQUIRED,
      terminal: true,
      message: sanitize('Manual upload required (artifact saved locally).'),
      artifact_filename: v.artifact_path ? String(v.artifact_path).split(/[/\\]/).pop() : undefined,
    };
  }
  if (v.status === 'error') {
    return {
      error_code: v.error_code || 'BRIEFING_FAILED',
      outcome: RELAY_OUTCOME.FAILED,
      terminal: true,
      message: sanitize(v.message || 'Briefing publish failed.'),
    };
  }
  return null;
}

function mapDirectPublishToSendFields(direct, options = {}) {
  const sanitize = options.sanitizeReason ?? ((text) => text);
  if (!direct) {
    return null;
  }
  if (direct.ok) {
    return {
      outcome: direct.skipped ? RELAY_OUTCOME.SKIPPED_UNCHANGED : RELAY_OUTCOME.PUBLISHED,
      terminal: true,
      message: direct.skipped
        ? sanitize('Published (remote matched request).')
        : sanitize('Snapshot published.'),
    };
  }
  if (direct.code === 'RATE_LIMIT') {
    return {
      error_code: 'RATE_LIMIT',
      outcome: RELAY_OUTCOME.DEFERRED,
      terminal: false,
      message: sanitize(direct.reason || 'Rate limited.'),
    };
  }
  if (direct.code === BRIEFING_ACK_STATUS_MANUAL_UPLOAD_REQUIRED) {
    return {
      error_code: direct.code === BRIEFING_ACK_STATUS_MANUAL_UPLOAD_REQUIRED
        ? (direct.error_code || 'RELAY_SHRINK_EXHAUSTED')
        : direct.code,
      outcome: RELAY_OUTCOME.MANUAL_UPLOAD_REQUIRED,
      terminal: true,
      message: sanitize('Manual upload required (artifact saved locally).'),
      artifact_filename: direct.artifact_path ? String(direct.artifact_path).split(/[/\\]/).pop() : undefined,
    };
  }
  return {
    error_code: direct.code || 'PUBLISH_FAILED',
    outcome: RELAY_OUTCOME.FAILED,
    terminal: true,
    message: sanitize(direct.reason || 'Publish failed.'),
  };
}

module.exports = {
  BRIEFING_ACK_STATUS_MANUAL_UPLOAD_REQUIRED,
  BRIEFING_ACK_STATUS_DEFERRED,
  RELAY_OUTCOME,
  isTerminalRetrievePhase,
  isStickyTerminalRetrieveOutcome,
  incomingRetrievePollWouldEraseTerminalOutcome,
  readOnDemandStatus,
  shouldWriteOnDemandStatus,
  buildOnDemandStatusPayload,
  writeOnDemandStatus,
  mapBriefingAckToSendFields,
  mapDirectPublishToSendFields,
};
