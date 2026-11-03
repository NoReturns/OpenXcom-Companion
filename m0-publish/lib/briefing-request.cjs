'use strict';

const REQUEST_ID_RE = /^[0-9a-f]{32}$/;
const SESSION_ID_RE = /^[0-9a-f]{32}$/;
const SNAPSHOT_SHA256_RE = /^[0-9a-f]{64}$/;

class BriefingRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BriefingRequestError';
  }
}

function parseBriefingRequestJson(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new BriefingRequestError('briefing-request.json is not valid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BriefingRequestError('briefing-request.json must be an object');
  }
  if (value.schema_version !== 1) {
    throw new BriefingRequestError('schema_version must be 1');
  }
  if (value.type !== 'tactical_briefing_request') {
    throw new BriefingRequestError('type must be tactical_briefing_request');
  }
  if (typeof value.request_id !== 'string' || !REQUEST_ID_RE.test(value.request_id)) {
    throw new BriefingRequestError('request_id must be 32 lowercase hex characters');
  }
  if (typeof value.session_id !== 'string' || !SESSION_ID_RE.test(value.session_id)) {
    throw new BriefingRequestError('session_id must be 32 lowercase hex characters');
  }
  if (typeof value.turn !== 'number' || !Number.isInteger(value.turn) || value.turn < 0) {
    throw new BriefingRequestError('turn must be a valid nonnegative integer');
  }
  if (typeof value.snapshot_sha256 !== 'string' || !SNAPSHOT_SHA256_RE.test(value.snapshot_sha256)) {
    throw new BriefingRequestError('snapshot_sha256 must be 64 lowercase hex characters');
  }
  return {
    schema_version: 1,
    type: value.type,
    request_id: value.request_id,
    session_id: value.session_id,
    turn: value.turn,
    snapshot_sha256: value.snapshot_sha256,
  };
}

module.exports = {
  BriefingRequestError,
  parseBriefingRequestJson,
  REQUEST_ID_RE,
  SESSION_ID_RE,
  SNAPSHOT_SHA256_RE,
};
