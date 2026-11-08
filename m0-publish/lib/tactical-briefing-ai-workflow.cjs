'use strict';

/**
 * Mandatory AI briefing workflow after a fresh F6 publish (m0/state.json).
 * Single source for operator docs, Cursor rules, and programmatic E2E review.
 */

const {
  HOSTILE_INTELLIGENCE_CONSUMER_RULES,
  getHostileIntelligenceContractMarkdown,
  assertSamePerceptionSession,
  mergePerceptionEventsSameSessionOnly,
  classifyCurrentHostileObservation,
  latestUnitLastSeenEvent,
  resolveHostileIntel,
  PerceptionSessionMismatchError,
} = require('./hostile-intelligence-consumer.cjs');
const {
  collectPsychologicalPerceptionEvents,
  buildPsychologicalHistoricalLines,
  getPsychologicalPerceptionContractMarkdown,
} = require('./psychological-perception-consumer.cjs');

const WORKFLOW_VERSION = 1;

const MANDATORY_F6_REVIEW_SEQUENCE = [
  {
    step: 1,
    title: 'Read unitStateBrief.exceptions before tactical planning',
    detail:
      'On every fresh retrieval of m0/state.json, inspect relay.unitStateBrief.exceptions first. Do not plan moves or issue orders until this pass completes.',
  },
  {
    step: 2,
    title: 'Review psychological perceptionLog history alongside exceptions',
    detail:
      'Inspect perceptionLog for *_observed psychological events (panic, berserk, mind control, psi morale). Treat as historical player notifications; never substitute for current readiness or faction fields.',
  },
  {
    step: 3,
    title: 'Identify panic, berserk, mind control, and low-morale warnings',
    detail:
      'Map exceptions: readiness.summary panicking/berserk; kind mind_controlled_roster_soldier; kind xcom_controlled_hostile_unit; kind low_morale_heuristic (and related readiness/engine_not_acting_unit when present).',
  },
  {
    step: 4,
    title: 'Distinguish confirmed conditions from heuristics',
    detail:
      'Confirmed: readiness panicking/berserk, mind_controlled_roster_soldier, xcom_controlled_hostile_unit, dead/unconscious. Heuristic only: low_morale_heuristic, low_energy_heuristic — never state these as active panic.',
  },
  {
    step: 5,
    title: 'Cross-check command authority before issuing orders',
    detail:
      'Actors must appear in commandBinding.player_soldiers (or equivalent binding). Exclude mind-controlled roster soldiers and any unit not listed. snapshot_sha256 and state_version must match the retrieved payload.',
  },
  {
    step: 6,
    title: 'Include significant status changes in the tactical assessment',
    detail:
      'State confirmed MC, confirmed panic/berserk, historical psych events, and heuristic morale/energy in plain language. Separate current export status from perceptionLog history (e.g. panicked during turn N; current standing unless readiness confirms panic).',
  },
];

const CONFIRMED_READINESS = new Set(['panicking', 'berserk']);

function getAiBriefingInstructionsMarkdown() {
  const lines = [
    '# Mandatory battlefield status review (M1)',
    '',
    'After **BRIEFING_PUBLISHED** or any fresh read of GitHub `m0/state.json`, follow this sequence before terrain or MOVE planning:',
    '',
  ];
  for (const item of MANDATORY_F6_REVIEW_SEQUENCE) {
    lines.push(`${item.step}. **${item.title}** — ${item.detail}`);
  }
  lines.push(
    '',
    'Use existing `unitStateBrief.exceptions` and `commandBinding` only. Do not invent a parallel summary field on the relay.',
    '',
    getHostileIntelligenceContractMarkdown(),
    '',
    getPsychologicalPerceptionContractMarkdown(),
    '',
    '## Stage D reference assessment (Battleship harness, turn 3)',
    '',
    '- **Virender Shah (#3):** Confirmed under alien mind control (`mind_controlled_roster_soldier`). Not available for X-COM orders.',
    '- **Eric Reyes (#1):** Low morale (`low_morale_heuristic`). No confirmed active panic at this snapshot.',
    '- **Historical panic:** Unknown. Current snapshots cannot establish whether an earlier panic episode occurred between exports.',
    '',
  );
  return lines.join('\n');
}

function unitLabel(unitId, name) {
  if (typeof name === 'string' && name.length > 0) {
    return `${name} (#${unitId})`;
  }
  return `Unit #${unitId}`;
}

/**
 * Programmatic consumer of the same rules the AI must follow (E2E / tooling).
 * @param {object} relay — published m0/state.json-shaped payload
 */
function runMandatoryBattlefieldStatusReview(relay) {
  const brief = relay?.unitStateBrief ?? {};
  const tactical = relay?.tactical ?? null;
  const perceptionLog = tactical?.perceptionLog ?? null;
  const exceptions = Array.isArray(brief.exceptions) ? brief.exceptions : [];
  const binding = relay?.commandBinding ?? null;
  const psychEvents = collectPsychologicalPerceptionEvents(perceptionLog);
  const psychHistoricalLines = buildPsychologicalHistoricalLines(perceptionLog, tactical);
  const commandedIds = new Set(
    (binding?.player_soldiers ?? []).map((s) => s.id).filter((id) => Number.isInteger(id)),
  );

  const byUnit = new Map();
  for (const ex of exceptions) {
    if (!Number.isInteger(ex.id)) {
      continue;
    }
    if (!byUnit.has(ex.id)) {
      byUnit.set(ex.id, []);
    }
    byUnit.get(ex.id).push(ex);
  }

  const unitAssessments = [];
  for (const [unitId, unitExceptions] of byUnit) {
    const name = unitExceptions.find((e) => typeof e.name === 'string')?.name;
    const label = unitLabel(unitId, name);
    const confirmed = [];
    const heuristics = [];

    for (const ex of unitExceptions) {
      if (ex.kind === 'mind_controlled_roster_soldier') {
        confirmed.push('mind_control');
      } else if (ex.kind === 'xcom_controlled_hostile_unit') {
        confirmed.push('xcom_controlled_hostile');
      } else if (ex.kind === 'readiness' && CONFIRMED_READINESS.has(ex.summary)) {
        confirmed.push(ex.summary);
      } else if (ex.kind === 'readiness' && ex.summary && ex.summary !== 'ready_to_act') {
        confirmed.push(`readiness:${ex.summary}`);
      } else if (ex.kind === 'low_morale_heuristic') {
        heuristics.push('low_morale');
      } else if (ex.kind === 'low_energy_heuristic') {
        heuristics.push('low_energy');
      } else if (ex.kind === 'unconscious' || ex.kind === 'dead') {
        confirmed.push(ex.kind);
      }
    }

    const commandable =
      commandedIds.size === 0 ? null : commandedIds.has(unitId) && !confirmed.includes('mind_control');

    unitAssessments.push({
      unitId,
      label,
      confirmed,
      heuristics,
      commandable,
      exceptions: unitExceptions,
    });
  }

  const tacticalStatusLines = [];
  for (const row of unitAssessments) {
    if (row.confirmed.includes('mind_control')) {
      tacticalStatusLines.push(
        `${row.label}: Confirmed under alien mind control. Not available for X-COM orders.`,
      );
    } else if (row.confirmed.includes('panicking')) {
      tacticalStatusLines.push(`${row.label}: Confirmed panicking at export.`);
    } else if (row.confirmed.includes('berserk')) {
      tacticalStatusLines.push(`${row.label}: Confirmed berserk at export.`);
    }
    if (row.heuristics.includes('low_morale') && !row.confirmed.includes('panicking')) {
      tacticalStatusLines.push(`${row.label}: Low morale (heuristic). No confirmed active panic at this snapshot.`);
    }
  }

  const anyConfirmedPanic = unitAssessments.some((r) => r.confirmed.includes('panicking'));
  const historicalPanicNote =
    psychEvents.length > 0
      ? 'Historical psychological observations recorded in perceptionLog; see psychHistoricalLines (not current status).'
      : 'Historical panic: Unknown. Current snapshots cannot establish whether an earlier panic episode occurred between exports.';

  if (psychHistoricalLines.length > 0) {
    tacticalStatusLines.push(...psychHistoricalLines);
  } else if (!anyConfirmedPanic) {
    tacticalStatusLines.push(historicalPanicNote);
  }

  return {
    workflowVersion: WORKFLOW_VERSION,
    sequenceCompleted: true,
    exceptionCount: exceptions.length,
    psychEventCount: psychEvents.length,
    psychHistoricalLines,
    unitAssessments,
    commandedIds: [...commandedIds].sort((a, b) => a - b),
    tacticalStatusLines,
    historicalPanicNote,
  };
}

module.exports = {
  WORKFLOW_VERSION,
  MANDATORY_F6_REVIEW_SEQUENCE,
  HOSTILE_INTELLIGENCE_CONSUMER_RULES,
  getAiBriefingInstructionsMarkdown,
  getHostileIntelligenceContractMarkdown,
  runMandatoryBattlefieldStatusReview,
  assertSamePerceptionSession,
  mergePerceptionEventsSameSessionOnly,
  classifyCurrentHostileObservation,
  latestUnitLastSeenEvent,
  resolveHostileIntel,
  PerceptionSessionMismatchError,
  collectPsychologicalPerceptionEvents,
  buildPsychologicalHistoricalLines,
  getPsychologicalPerceptionContractMarkdown,
};
