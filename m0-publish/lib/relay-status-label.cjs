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
 * Latest retrieve attempt vs sticky command completion are independent; empty polls keep command label.
 * @param {object} status
 * @returns {object}
 */
function resolveEffectiveLabelStatus(status) {
  if (!status || typeof status !== 'object') {
    return status;
  }
  const attemptPhase = status.last_retrieve_phase;
  const attemptMs = Number(status.last_retrieve_updated_at_ms) || 0;
  if (!attemptPhase || attemptMs <= 0) {
    return status;
  }
  if (
    attemptPhase === 'no_new_orders'
    && status.phase === 'completed'
    && status.action === 'retrieve'
    && status.last_command_status
  ) {
    return status;
  }
  const stickyMs = Number(status.updated_at_ms) || 0;
  if (attemptMs < stickyMs && status.phase === 'completed' && status.last_command_status) {
    return status;
  }
  return {
    ...status,
    phase: attemptPhase,
    action: 'retrieve',
    error_code: status.last_retrieve_error_code
      ?? (attemptPhase === status.phase ? status.error_code : undefined),
    request_id: status.last_retrieve_request_id || status.request_id,
  };
}

/**
 * @param {object} status parsed on-demand status fields used by the overlay
 * @returns {string}
 */
function formatRelayStatusLabel(status) {
  if (!status || typeof status !== 'object') {
    return '';
  }
  const effective = resolveEffectiveLabelStatus(status);
  if (
    effective.outcome === 'deferred'
    || (effective.phase === 'sending' && effective.error_code === 'RATE_LIMIT' && !effective.terminal)
  ) {
    return 'Deferred: RATE LIMIT';
  }
  if (effective.phase === 'manual_upload_required' || effective.outcome === 'manual_upload_required') {
    return 'Manual upload required';
  }
  if (effective.phase === 'not_ready') {
    return 'Not ready';
  }
  if (effective.phase === 'sending') {
    return 'Sending';
  }
  if (effective.phase === 'retrieving') {
    return 'Retrieving';
  }
  if (effective.phase === 'no_new_orders') {
    return 'No new orders';
  }
  if (effective.phase === 'sent') {
    if (effective.outcome === 'skipped_unchanged') {
      return 'Unchanged';
    }
    return 'Published';
  }
  if (effective.phase === 'completed') {
    if (effective.action === 'retrieve') {
      if (effective.last_command_status === 'COMPLETED') {
        return 'Order completed';
      }
      if (
        effective.last_command_status === 'FAILED'
        || effective.last_command_status === 'REJECTED'
        || effective.last_command_status === 'INTERRUPTED'
      ) {
        return 'Order failed';
      }
      return 'Relay complete';
    }
    return 'Published';
  }
  if (effective.phase === 'failed') {
    if (effective.action === 'retrieve') {
      if (
        effective.error_code === 'RETRIEVAL_ERROR'
        || effective.error_code === 'NETWORK_FAILED'
        || effective.error_code === 'RATE_LIMIT'
        || effective.error_code === 'RELAY_OFFLINE'
      ) {
        return 'Retrieve error';
      }
      if (
        effective.last_command_status === 'FAILED'
        || effective.last_command_status === 'REJECTED'
        || effective.last_command_status === 'INTERRUPTED'
      ) {
        return 'Order failed';
      }
      if (effective.last_command_status === 'COMPLETED') {
        return 'Order done; relay incomplete';
      }
      if (effective.error_code === 'RETRIEVE_INCOMPLETE') {
        return 'Retrieve incomplete';
      }
      return 'Retrieve failed';
    }
    if (isValidationErrorCode(effective.error_code)) {
      return 'Failed: VALIDATION';
    }
    if (isAuthErrorCode(effective.error_code)) {
      return 'Failed: AUTH';
    }
    return 'Failed';
  }
  return 'Status update';
}

module.exports = {
  formatRelayStatusLabel,
  resolveEffectiveLabelStatus,
};
