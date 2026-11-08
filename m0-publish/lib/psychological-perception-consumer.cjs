'use strict';

const { PSYCHOLOGICAL_PERCEPTION_EVENT_TYPES } = require('./tactical-publish.cjs');
const { isMindControlledRosterSoldier, isXcomControlledHostileUnit } = require('./unit-state-brief.cjs');

const CONFIRMED_PANIC_READINESS = new Set(['panicking', 'berserk']);

function isPsychologicalPerceptionEvent(event) {
  return event && PSYCHOLOGICAL_PERCEPTION_EVENT_TYPES.has(event.type);
}

function collectPsychologicalPerceptionEvents(perceptionLog) {
  if (!perceptionLog?.events?.length) {
    return [];
  }
  return perceptionLog.events.filter(isPsychologicalPerceptionEvent);
}

function unitLabelFromEvent(event) {
  if (typeof event.subjectName === 'string' && event.subjectName.length > 0) {
    return `${event.subjectName} (#${event.subjectUnitId})`;
  }
  if (Number.isInteger(event.subjectUnitId)) {
    return `Unit #${event.subjectUnitId}`;
  }
  if (event.type === 'alien_panicked_observed' || event.type === 'alien_berserk_observed') {
    return 'A hostile unit (identity not in export)';
  }
  return 'Subject unit (identity not in export)';
}

function resolveCurrentControlStatus(tactical, unitId) {
  const unit = (tactical?.units ?? []).find((u) => u.id === unitId);
  if (!unit) {
    return 'unknown (unit not in snapshot)';
  }
  if (isMindControlledRosterSoldier(unit)) {
    return 'confirmed under hostile mind control at export';
  }
  if (isXcomControlledHostileUnit(unit)) {
    return 'confirmed under X-COM mind control at export';
  }
  if (unit.originalFaction === unit.faction) {
    return 'aligned with original faction at export';
  }
  return 'faction mismatch at export (review units[] fields)';
}

function describePsychEventHistoricalLine(event, tactical) {
  const label = unitLabelFromEvent(event);
  const turn = event.turn;
  switch (event.type) {
    case 'soldier_panicked_observed':
    case 'alien_panicked_observed': {
      const current = tactical?.units?.find((u) => u.id === event.subjectUnitId);
      const readiness = current?.readiness?.summary ?? current?.condition?.engineStatus ?? 'unknown';
      const currentNote = CONFIRMED_PANIC_READINESS.has(readiness)
        ? `Current status: ${readiness} (confirmed at export).`
        : `Current status: ${readiness} (historical panic event; not active panic unless readiness confirms).`;
      return `${label} panicked during turn ${turn} (player notification). ${currentNote}`;
    }
    case 'soldier_berserk_observed':
    case 'alien_berserk_observed': {
      const current = tactical?.units?.find((u) => u.id === event.subjectUnitId);
      const readiness = current?.readiness?.summary ?? current?.condition?.engineStatus ?? 'unknown';
      const currentNote = readiness === 'berserk'
        ? 'Current status: berserk (confirmed at export).'
        : `Current status: ${readiness} (historical berserk event).`;
      return `${label} went berserk during turn ${turn} (player notification). ${currentNote}`;
    }
    case 'soldier_mind_controlled_observed':
      return `${label} was reported mind-controlled during turn ${turn}. Current control status: ${resolveCurrentControlStatus(tactical, event.subjectUnitId)}.`;
    case 'alien_mind_controlled_observed':
      return `${label} was reported under X-COM mind control during turn ${turn}. Current control status: ${resolveCurrentControlStatus(tactical, event.subjectUnitId)}.`;
    case 'psi_morale_attack_observed':
      return `Psi morale attack succeeded against ${label} during turn ${turn}. Actual panic status not confirmed by this event alone.`;
    default:
      return `${label}: psychological event ${event.type} on turn ${turn}.`;
  }
}

function buildPsychologicalHistoricalLines(perceptionLog, tactical) {
  return collectPsychologicalPerceptionEvents(perceptionLog).map((event) =>
    describePsychEventHistoricalLine(event, tactical),
  );
}

function getPsychologicalPerceptionContractMarkdown() {
  return [
    '**Psychological perception history:** `perceptionLog` may contain `*_observed` psychological events from player UI notifications.',
    'Treat them as **historical confirmed observations**, not current unit status.',
    'Cross-check current status via `tactical.units` readiness/condition and `unitStateBrief.exceptions`.',
    'Do not infer active panic from `psi_morale_attack_observed` alone.',
  ].join('\n');
}

module.exports = {
  PSYCHOLOGICAL_PERCEPTION_EVENT_TYPES,
  isPsychologicalPerceptionEvent,
  collectPsychologicalPerceptionEvents,
  buildPsychologicalHistoricalLines,
  getPsychologicalPerceptionContractMarkdown,
  describePsychEventHistoricalLine,
};
