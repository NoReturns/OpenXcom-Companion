'use strict';

/** Mirrors CompanionCommandRuntimeSupport cross-session orphan policy (01B). */

function commandSessionBindingMatchesLiveBattle(liveSessionId, commandSessionId, resultSessionId) {
  if (!liveSessionId || !commandSessionId) {
    return false;
  }
  if (commandSessionId !== liveSessionId) {
    return false;
  }
  if (resultSessionId && resultSessionId !== liveSessionId) {
    return false;
  }
  return true;
}

function isOpenCompanionResultStatus(status) {
  return status === 'EXECUTING' || status === 'ACCEPTED';
}

function isCrossSessionPersistedOpenCommand(liveSessionId, inboxSessionId, resultSessionId, resultStatus) {
  if (!liveSessionId) {
    return false;
  }
  if (!isOpenCompanionResultStatus(resultStatus)) {
    return false;
  }
  if (inboxSessionId) {
    return inboxSessionId !== liveSessionId;
  }
  return Boolean(resultSessionId && resultSessionId !== liveSessionId);
}

function shouldPreserveSameSessionInFlightExecution(
  liveSessionId,
  activeCommandSessionId,
  resultSessionId,
  resultCommandId,
  activeInFlight,
  activeCommandId,
) {
  if (!activeInFlight || !activeCommandId || activeCommandId !== resultCommandId) {
    return false;
  }
  if (liveSessionId && activeCommandSessionId && activeCommandSessionId === liveSessionId) {
    return true;
  }
  return commandSessionBindingMatchesLiveBattle(liveSessionId, activeCommandSessionId, resultSessionId);
}

function shouldRecoverPersistedCrossSessionOrphan(
  liveSessionId,
  inboxSessionId,
  resultSessionId,
  resultStatus,
  inboxCommandId,
  resultCommandId,
  activeInFlight,
  activeCommandId,
  activeCommandSessionId,
) {
  if (!isCrossSessionPersistedOpenCommand(liveSessionId, inboxSessionId, resultSessionId, resultStatus)) {
    return false;
  }
  if (inboxCommandId && resultCommandId && inboxCommandId !== resultCommandId) {
    return false;
  }
  if (shouldPreserveSameSessionInFlightExecution(
    liveSessionId,
    activeCommandSessionId,
    resultSessionId,
    resultCommandId,
    activeInFlight,
    activeCommandId,
  )) {
    return false;
  }
  return true;
}

const SESSION_BOUNDARY_DIRECTED_FIRE_REASON =
  'Battle session changed; in-flight directed fire cannot resume after reload.';

function sessionBoundaryInterruptedPublicReasonForCommandType(commandType) {
  if (commandType === 'SNAP_SHOT' || commandType === 'AUTO_SHOT' || commandType === 'AIMED_SHOT') {
    return SESSION_BOUNDARY_DIRECTED_FIRE_REASON;
  }
  return 'Battle session changed; in-flight command cannot resume after reload.';
}

module.exports = {
  commandSessionBindingMatchesLiveBattle,
  isOpenCompanionResultStatus,
  isCrossSessionPersistedOpenCommand,
  shouldPreserveSameSessionInFlightExecution,
  shouldRecoverPersistedCrossSessionOrphan,
  sessionBoundaryInterruptedPublicReasonForCommandType,
  SESSION_BOUNDARY_DIRECTED_FIRE_REASON,
};
