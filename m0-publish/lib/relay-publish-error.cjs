'use strict';

const { RELAY_SHRINK_EXHAUSTED } = require('./relay-payload-adaptive-shrink.cjs');

/** Error codes for relay publish / manual-upload decisioning (Step 1 taxonomy). */
const RELAY_PUBLISH_ERROR = Object.freeze({
  RELAY_SHRINK_EXHAUSTED,
  AUTH_FAILED: 'AUTH_FAILED',
  SHA_CONFLICT: 'SHA_CONFLICT',
  RATE_LIMIT: 'RATE_LIMIT',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  NETWORK_FAILED: 'NETWORK_FAILED',
  UNKNOWN: 'UNKNOWN',
});

const SIZE_FAILURE_CODES = new Set([RELAY_SHRINK_EXHAUSTED]);

function isRelayShrinkExhausted(error) {
  return Boolean(error && error.code === RELAY_SHRINK_EXHAUSTED);
}

function isRelaySizeFailure(error) {
  return isRelayShrinkExhausted(error);
}

/**
 * Classify a publish-time error for manual-upload vs retry vs operator handling.
 * Size failures are never inferred from auth, conflict, or rate-limit blobs.
 */
function classifyRelayPublishError(error) {
  if (!error) {
    return RELAY_PUBLISH_ERROR.UNKNOWN;
  }
  if (typeof error.code === 'string' && error.code.length > 0) {
    return error.code;
  }
  const blob = `${error.stderr ?? ''}\n${error.message ?? ''}`;
  if (/409|Conflict/i.test(blob)) {
    return RELAY_PUBLISH_ERROR.SHA_CONFLICT;
  }
  if (/401|authentication|Bad credentials/i.test(blob)) {
    return RELAY_PUBLISH_ERROR.AUTH_FAILED;
  }
  if (/rate limit|403.*rate/i.test(blob)) {
    return RELAY_PUBLISH_ERROR.RATE_LIMIT;
  }
  if (/validation|SNAPSHOT_|perceptionLog|malformed/i.test(blob)) {
    return RELAY_PUBLISH_ERROR.VALIDATION_FAILED;
  }
  if (/ENOTFOUND|ECONNRESET|ETIMEDOUT|network|fetch failed/i.test(blob)) {
    return RELAY_PUBLISH_ERROR.NETWORK_FAILED;
  }
  return RELAY_PUBLISH_ERROR.UNKNOWN;
}

function shouldOfferManualUploadForPublishError(error) {
  return isRelaySizeFailure(error);
}

module.exports = {
  RELAY_PUBLISH_ERROR,
  SIZE_FAILURE_CODES,
  isRelayShrinkExhausted,
  isRelaySizeFailure,
  classifyRelayPublishError,
  shouldOfferManualUploadForPublishError,
};
