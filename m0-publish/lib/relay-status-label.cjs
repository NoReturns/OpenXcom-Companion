'use strict';

/**
 * Engine overlay label mirror (CompanionOnDemandRelayCore::formatRelayStatusLabel).
 * Keep in sync with engine/OpenXcom/src/Engine/CompanionOnDemandRelayCore.cpp.
 */

function isValidationErrorCode(code) {
  return (
    code === 'SNAPSHOT_VALIDATION'
    || code === 'VALIDATION'
    || code === 'RELAY_SHRINK_EXHAUSTED'
    || code === 'COMMAND_BINDING_MISMATCH'
  );
}

function isAuthErrorCode(code) {
  return code === 'AUTH_FAILED' || code === 'AUTH' || code === 'gh_not_authenticated';
}

/**
 * @param {object} status parsed on-demand status fields used by the overlay
 * @returns {string}
 */
function formatRelayStatusLabel(status) {
  if (!status || typeof status !== 'object') {
    return '';
  }
  if (
    status.outcome === 'deferred'
    || (status.phase === 'sending' && status.error_code === 'RATE_LIMIT' && !status.terminal)
  ) {
    return 'Deferred: RATE LIMIT';
  }
  if (status.phase === 'manual_upload_required' || status.outcome === 'manual_upload_required') {
    return 'Manual upload required';
  }
  if (status.phase === 'not_ready') {
    return 'Not ready';
  }
  if (status.phase === 'sending') {
    return 'Sending';
  }
  if (status.phase === 'retrieving') {
    return 'Retrieving';
  }
  if (status.phase === 'no_new_orders') {
    return 'No new orders';
  }
  if (status.phase === 'sent') {
    if (status.outcome === 'skipped_unchanged') {
      return 'Unchanged';
    }
    return 'Published';
  }
  if (status.phase === 'completed') {
    if (status.action === 'retrieve') {
      if (status.last_command_status === 'COMPLETED') {
        return 'Order completed';
      }
      if (
        status.last_command_status === 'FAILED'
        || status.last_command_status === 'REJECTED'
        || status.last_command_status === 'INTERRUPTED'
      ) {
        return 'Order failed';
      }
      return 'Relay complete';
    }
    return 'Published';
  }
  if (status.phase === 'failed') {
    if (status.action === 'retrieve') {
      if (
        status.error_code === 'RETRIEVAL_ERROR'
        || status.error_code === 'NETWORK_FAILED'
        || status.error_code === 'RATE_LIMIT'
        || status.error_code === 'RELAY_OFFLINE'
      ) {
        return 'Retrieve error';
      }
      if (
        status.last_command_status === 'FAILED'
        || status.last_command_status === 'REJECTED'
        || status.last_command_status === 'INTERRUPTED'
      ) {
        return 'Order failed';
      }
      if (status.last_command_status === 'COMPLETED') {
        return 'Order done; relay incomplete';
      }
      if (status.error_code === 'RETRIEVE_INCOMPLETE') {
        return 'Retrieve incomplete';
      }
      return 'Retrieve failed';
    }
    if (isValidationErrorCode(status.error_code)) {
      return 'Failed: VALIDATION';
    }
    if (isAuthErrorCode(status.error_code)) {
      return 'Failed: AUTH';
    }
    return 'Failed';
  }
  return 'Status update';
}

module.exports = {
  formatRelayStatusLabel,
};
