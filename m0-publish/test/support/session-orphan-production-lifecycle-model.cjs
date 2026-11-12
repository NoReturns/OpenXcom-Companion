'use strict';

/**
 * Test mirror of production companion command session lifecycle policy (01B).
 * Sources:
 *   engine/OpenXcom/src/Engine/CompanionCommandRuntime.cpp
 *   engine/OpenXcom/src/Engine/CompanionCommandRuntimeSupport.*
 *   companion/m0-publish/lib/companion-canonical-runtime.cjs — evaluateInboxQuarantine
 *   companion/m0-publish/lib/session-orphan-policy.cjs
 */

const {
  shouldRecoverPersistedCrossSessionOrphan,
  sessionBoundaryInterruptedPublicReasonForCommandType,
  commandSessionBindingMatchesLiveBattle,
  SESSION_BOUNDARY_DIRECTED_FIRE_REASON,
} = require('../../lib/session-orphan-policy.cjs');

const { evaluateInboxQuarantine } = require('../../lib/companion-canonical-runtime.cjs');

const SESSION_BOUNDARY_PUBLIC_REASON = SESSION_BOUNDARY_DIRECTED_FIRE_REASON;

function shouldRehydrateOrphanedDirectedFireForSession(liveSessionId, commandSessionId, resultSessionId) {
  return commandSessionBindingMatchesLiveBattle(liveSessionId, commandSessionId, resultSessionId);
}

function productionTryRecoverCrossSessionOrphanOnBinding(memory, liveSessionId) {
  const disk = memory.disk;
  const activeSessionId = memory.activeCommandSessionId || '';
  if (
    !shouldRecoverPersistedCrossSessionOrphan(
      liveSessionId,
      disk.inboxSessionId,
      disk.resultSessionId,
      disk.resultStatus,
      disk.inboxCommandId,
      disk.resultCommandId,
      memory.g_activeInFlight,
      memory.g_activeCommandId,
      activeSessionId,
    )
  ) {
    return false;
  }
  if (!disk.journalHasCommand) {
    return false;
  }
  if (disk.inboxPresent) {
    if (!disk.inboxDigestMatches || disk.inboxCommandId !== disk.resultCommandId) {
      return false;
    }
  } else if (!disk.resultInboxSha256) {
    return false;
  }

  disk.resultStatus = 'INTERRUPTED';
  disk.publicReason = sessionBoundaryInterruptedPublicReasonForCommandType(disk.inboxCommandType);
  disk.commandFired = false;
  disk.inboxPresent = false;
  return true;
}

/**
 * productionOnBattleCompanionBindingContext — 01B engine policy.
 */
function productionOnBattleCompanionBindingContext(memory, liveSessionId, liveTacticalBattleId) {
  const hadPriorContext = Boolean(memory.boundSessionId || memory.boundTacticalBattleId);
  const contextChanged = hadPriorContext
    && (liveSessionId !== memory.boundSessionId
      || liveTacticalBattleId !== memory.boundTacticalBattleId);
  const effects = {
    contextChanged,
    interruptedInFlight: false,
    inboxArchived: false,
    recoveredOnBind: false,
  };

  effects.recoveredOnBind = productionTryRecoverCrossSessionOrphanOnBinding(memory, liveSessionId);

  if (contextChanged) {
    if (memory.g_activeInFlight) {
      effects.interruptedInFlight = true;
      if (memory.disk.resultStatus === 'EXECUTING' || memory.disk.resultStatus === 'ACCEPTED') {
        memory.disk.resultStatus = 'INTERRUPTED';
        memory.disk.publicReason = 'Battle binding reset.';
      }
    }
    memory.g_activeInFlight = false;
    memory.g_activeCommandId = null;

    if (
      memory.disk.inboxPresent
      && memory.disk.inboxSessionId
      && memory.disk.inboxSessionId !== liveSessionId
      && !(memory.g_activeInFlight && memory.g_activeCommandId === memory.disk.inboxCommandId)
    ) {
      effects.inboxArchived = true;
      memory.disk.inboxPresent = false;
    }
  }

  memory.boundSessionId = liveSessionId;
  memory.boundTacticalBattleId = liveTacticalBattleId;
  return effects;
}

/**
 * tryResolveOrphanedDirectedFireSessionBoundary — delegates to cross-session recovery (01B).
 */
function productionTryResolveSessionBoundaryOrphan(memory, liveSessionId) {
  if (memory.disk.resultStatus !== 'EXECUTING' && memory.disk.resultStatus !== 'ACCEPTED') {
    return false;
  }
  return productionTryRecoverCrossSessionOrphanOnBinding(memory, liveSessionId);
}

function productionTryResolveWhileSameSessionInFlight(memory, liveSessionId) {
  if (!memory.g_activeInFlight) {
    return false;
  }
  const disk = memory.disk;
  if (!shouldRehydrateOrphanedDirectedFireForSession(
    liveSessionId,
    disk.inboxSessionId,
    disk.resultSessionId,
  )) {
    return false;
  }
  return disk.resultStatus === 'EXECUTING';
}

function createIncident029DiskFixture(overrides = {}) {
  return {
    inboxPresent: true,
    inboxCommandId: 'aster-20261110-seppe-sectoid-auto-29',
    inboxCommandType: 'AUTO_SHOT',
    inboxSessionId: '112482ac508d5bc16dcde1470d197d09',
    resultCommandId: 'aster-20261110-seppe-sectoid-auto-29',
    resultSessionId: '112482ac508d5bc16dcde1470d197d09',
    resultStatus: 'EXECUTING',
    inboxDigestMatches: true,
    journalHasCommand: true,
    resultInboxSha256: 'a5154a3afed19545d1e4feb326524187a7bcfa61f63fe815aec7ea56dc6a2ee5',
    commandFired: false,
    publicReason: null,
    inboxQuarantined: false,
    ...overrides,
  };
}

function applyLauncherQuarantineForIncident(memory, sessionB) {
  const decision = evaluateLaunchInboxQuarantineForIncident(sessionB, memory.disk);
  if (decision.action === 'quarantine') {
    memory.disk.inboxPresent = false;
    memory.disk.inboxQuarantined = true;
  }
  return decision;
}

/** Launcher quarantine first, then engine session bind (029 incident). */
function runRecoveryOrderingLauncherQuarantineFirst(options = {}) {
  const sessionB = options.sessionB ?? 'c2c699950ddc838bfe4b37babc03967f';
  const tacticalB = options.tacticalB ?? '0e43e2f99518d148f83c8c59a974c1f8';
  const memory = createEmptyMemory();
  if (options.diskOverrides) {
    memory.disk = createIncident029DiskFixture(options.diskOverrides);
  }
  const launchDecision = applyLauncherQuarantineForIncident(memory, sessionB);
  const bindingEffects = productionOnBattleCompanionBindingContext(memory, sessionB, tacticalB);
  return { memory, disk: memory.disk, launchDecision, bindingEffects };
}

/** Engine bind recovery first, then launcher assessment. */
function runRecoveryOrderingEngineBindFirst(options = {}) {
  const sessionB = options.sessionB ?? 'c2c699950ddc838bfe4b37babc03967f';
  const tacticalB = options.tacticalB ?? '0e43e2f99518d148f83c8c59a974c1f8';
  const memory = createEmptyMemory();
  if (options.diskOverrides) {
    memory.disk = createIncident029DiskFixture(options.diskOverrides);
  }
  const bindingEffects = productionOnBattleCompanionBindingContext(memory, sessionB, tacticalB);
  const launchDecision = evaluateLaunchInboxQuarantineForIncident(sessionB, memory.disk);
  return { memory, disk: memory.disk, launchDecision, bindingEffects };
}

function createEmptyMemory() {
  return {
    boundSessionId: '',
    boundTacticalBattleId: '',
    g_activeInFlight: false,
    g_activeCommandId: null,
    activeCommandSessionId: '',
    disk: createIncident029DiskFixture(),
  };
}

function evaluateLaunchInboxQuarantineForIncident(sessionB, disk) {
  const inbox = {
    command_id: disk.inboxCommandId,
    session_id: disk.inboxSessionId,
    snapshot_sha256: '15f9c26f5435a30438d68fb69fe5269f08bb209860416b1d261693f0ea592c12',
    turn: 4,
    state_version: 4,
  };
  return evaluateInboxQuarantine({
    inboxExists: disk.inboxPresent,
    resultExists: true,
    resultStatus: disk.resultStatus,
    resultParseError: false,
    inboxValue: inbox,
    resultCommandId: disk.resultCommandId,
    snapshotBinding: {
      sessionId: sessionB,
      snapshotSha256: '223b701f353ebcaa309ece7a0be8a23fac33148b5a095dcc2f23fa11fe1ee6cf',
      turn: 1,
      stateVersion: 0,
    },
  });
}

/**
 * Sequence: cold process, Session B battlescape entry, optional companion tick(s).
 */
function runProductionColdStartSessionBSequence(options = {}) {
  const sessionB = options.sessionB ?? 'c2c699950ddc838bfe4b37babc03967f';
  const tacticalB = options.tacticalB ?? '0e43e2f99518d148f83c8c59a974c1f8';
  const tickCount = options.tickCount ?? 3;

  const memory = createEmptyMemory();
  memory.g_activeInFlight = options.g_activeInFlight === true;
  memory.g_activeCommandId = options.g_activeCommandId ?? null;
  memory.activeCommandSessionId = options.activeCommandSessionId ?? '';
  if (options.diskOverrides) {
    memory.disk = createIncident029DiskFixture(options.diskOverrides);
  }

  const trace = [];

  const launchDecision = evaluateLaunchInboxQuarantineForIncident(sessionB, memory.disk);
  trace.push({ phase: 'launcher', launchDecision });

  const bindingEffects = productionOnBattleCompanionBindingContext(memory, sessionB, tacticalB);
  trace.push({ phase: 'binding_context', ...bindingEffects, resultStatus: memory.disk.resultStatus });

  for (let i = 0; i < tickCount; i += 1) {
    const resolved = productionTryResolveSessionBoundaryOrphan(memory, sessionB);
    trace.push({ phase: 'companion_tick', tick: i + 1, boundaryResolved: resolved, resultStatus: memory.disk.resultStatus });
  }

  return { memory, trace, disk: memory.disk, launchDecision };
}

function runCorrectedColdStartSessionBSequence(options = {}) {
  return runProductionColdStartSessionBSequence(options);
}

module.exports = {
  SESSION_BOUNDARY_PUBLIC_REASON,
  commandSessionBindingMatchesLiveBattle,
  shouldRehydrateOrphanedDirectedFireForSession,
  evaluateLaunchInboxQuarantineForIncident,
  productionOnBattleCompanionBindingContext,
  productionTryRecoverCrossSessionOrphanOnBinding,
  productionTryResolveSessionBoundaryOrphan,
  productionTryResolveWhileSameSessionInFlight,
  createIncident029DiskFixture,
  createEmptyMemory,
  runProductionColdStartSessionBSequence,
  runCorrectedColdStartSessionBSequence,
  applyLauncherQuarantineForIncident,
  runRecoveryOrderingLauncherQuarantineFirst,
  runRecoveryOrderingEngineBindFirst,
};
