'use strict';

/**
 * Engine overlay label mirror (CompanionOnDemandRelayCore::formatRelayStatusLabel).
 * Keep in sync with engine/OpenXcom/src/Engine/CompanionOnDemandRelayCore.cpp.
 */

const RETRIEVAL_TRANSPORT_ERROR_CODES = new Set([
  'RETRIEVAL_ERROR',
  'NETWORK_FAILED',
  'RATE_LIMIT',
  'RELAY_OFFLINE',
]);

function isValidationErrorCode(code) {
  return (
    code === 'SNAPSHOT_VALIDATION'
    || code === 'SNAPSHOT_ERROR'
    || code === 'SNAPSHOT_HASH_MISMATCH'
    || code === 'SNAPSHOT_SCHEMA'
    || code === 'SNAPSHOT_SESSION'
    || code === 'TURN_MISMATCH'
    || code === 'SESSION_MISMATCH'
    || code === 'VALIDATION'
    || code === 'RELAY_SHRINK_EXHAUSTED'
    || code === 'COMMAND_BINDING_MISMATCH'
  );
}

function isAuthErrorCode(code) {
  return code === 'AUTH_FAILED' || code === 'AUTH' || code === 'gh_not_authenticated';
}

/** Whitelisted engine reject codes → HUD text (never raw public_reason). */
const HUD_COMMAND_REJECT_LABELS = {
  INVALID_ACTIVE_HAND: 'Invalid active hand',
};

function hudLabelForCommandRejectCode(rejectCode) {
  if (!rejectCode || typeof rejectCode !== 'string') {
    return null;
  }
  const key = rejectCode.trim();
  return HUD_COMMAND_REJECT_LABELS[key] ?? null;
}

function allowedHudCommandRejectCode(rawRejectCode) {
  if (!rawRejectCode || typeof rawRejectCode !== 'string') {
    return null;
  }
  const key = rawRejectCode.trim();
  return HUD_COMMAND_REJECT_LABELS[key] ? key : null;
}

function tryFormatTerminalCommandOrderLabel(lastCommandStatus, lastCommandRejectCode) {
  if (!lastCommandStatus) {
    return null;
  }
  if (lastCommandStatus === 'COMPLETED') {
    return 'Order completed';
  }
  if (lastCommandStatus === 'INTERRUPTED') {
    return 'Order interrupted';
  }
  if (lastCommandStatus === 'FAILED') {
    return 'Order failed';
  }
  if (lastCommandStatus === 'REJECTED') {
    const specific = hudLabelForCommandRejectCode(lastCommandRejectCode);
    return specific || 'Order rejected';
  }
  return null;
}

function tryFormatRetrieveIncompleteCommandLabel(lastCommandStatus, lastCommandRejectCode) {
  if (!lastCommandStatus) {
    return null;
  }
  if (lastCommandStatus === 'COMPLETED') {
    return 'Order done; relay incomplete';
  }
  if (lastCommandStatus === 'INTERRUPTED') {
    return 'Interrupted; relay incomplete';
  }
  if (lastCommandStatus === 'FAILED') {
    return 'Order failed; relay incomplete';
  }
  if (lastCommandStatus === 'REJECTED') {
    const specific = hudLabelForCommandRejectCode(lastCommandRejectCode);
    return specific ? `${specific}; relay incomplete` : 'Rejected; relay incomplete';
  }
  return null;
}

function isRetrievalTransportError(errorCode) {
  return Boolean(errorCode && RETRIEVAL_TRANSPORT_ERROR_CODES.has(errorCode));
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
  const effective = {
    ...status,
    phase: attemptPhase,
    action: 'retrieve',
    request_id: status.last_retrieve_request_id || status.request_id,
  };
  if (status.last_retrieve_error_code) {
    effective.error_code = status.last_retrieve_error_code;
  } else if (attemptPhase !== status.phase) {
    delete effective.error_code;
  }
  if (
    isRetrievalTransportError(effective.error_code)
    && status.last_command_status
    && status.updated_at_ms > attemptMs
  ) {
    return status;
  }
  return effective;
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
      const commandLabel = tryFormatTerminalCommandOrderLabel(
        effective.last_command_status,
        effective.last_command_reject_code,
      );
      if (commandLabel) {
        return commandLabel;
      }
      return 'Relay complete';
    }
    return 'Published';
  }
  if (effective.phase === 'failed') {
    if (effective.action === 'retrieve') {
      if (isRetrievalTransportError(effective.error_code)) {
        return 'Retrieve error';
      }
      if (effective.error_code === 'RETRIEVE_INCOMPLETE') {
        const incompleteLabel = tryFormatRetrieveIncompleteCommandLabel(
          effective.last_command_status,
          effective.last_command_reject_code,
        );
        if (incompleteLabel) {
          return incompleteLabel;
        }
        return 'Retrieve incomplete';
      }
      if (effective.last_command_status === 'COMPLETED') {
        return 'Order done; relay incomplete';
      }
      const commandLabel = tryFormatTerminalCommandOrderLabel(
        effective.last_command_status,
        effective.last_command_reject_code,
      );
      if (commandLabel) {
        return commandLabel;
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
  tryFormatTerminalCommandOrderLabel,
  tryFormatRetrieveIncompleteCommandLabel,
  hudLabelForCommandRejectCode,
  allowedHudCommandRejectCode,
  HUD_COMMAND_REJECT_LABELS,
};