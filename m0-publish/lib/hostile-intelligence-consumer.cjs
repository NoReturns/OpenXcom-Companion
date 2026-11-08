'use strict';

const {
  isFriendlyPlayerControlled,
  isMindControlledRosterSoldier,
  isGenuineHostileUnit,
  isNeutralCivilianUnit,
  isXcomControlledHostileUnit,
} = require('./unit-state-brief.cjs');

/** Engine-visible unit position at export (facing present); not synonymous with hostile target. */
function isConfirmedCurrentLosAvailability(availability) {
  return (
    availability === 'confirmed_current_los' ||
    (typeof availability === 'string' && availability.startsWith('confirmed_current_los_'))
  );
}

/**
 * Canonical fair-play rules for hostile / MC tactical intelligence (M1-WP5-P1).
 * Consumed by AI workflow markdown, Cursor rules, and regression tests.
 */
const HOSTILE_INTELLIGENCE_CONSUMER_RULES = [
  {
    id: 'current_visible_units',
    rule:
      'units[] rows with facing represent current engine-visible observations at snapshot export (confirmed current LOS at F6). Visible neutrals and mind-controlled roster soldiers are not generic hostile targets; use availability taxonomy from classifyCurrentHostileObservation.',
  },
  {
    id: 'perception_memory',
    rule:
      'perceptionLog is bounded historical observation memory, not a complete list of currently visible units.',
  },
  {
    id: 'missing_perception_not_hidden',
    rule:
      'Missing unit_last_seen (or an empty perceptionLog) does not mean a unit is hidden; use units[] presence and facing.',
  },
  {
    id: 'last_seen_historical',
    rule:
      'unit_last_seen with confidence last_seen (or sighted from a prior turn) is historical memory, not live tracking of hidden movement.',
  },
  {
    id: 'absent_unit_no_position',
    rule: 'Units absent from units[] provide no current position; never infer a hidden unit’s current location.',
  },
  {
    id: 'mc_threat_not_command',
    rule:
      'Mind-controlled roster soldiers are hostile for tactical threat assessment but not commandable via commandBinding.',
  },
  {
    id: 'no_hidden_controllers',
    rule:
      'Do not expose hidden mind controllers, private alien identity, or undiscovered battlefield information beyond export policy.',
  },
  {
    id: 'perception_session_scope',
    rule:
      'Do not merge perceptionLog events across different sessionId values; each session is its own observation history.',
  },
  {
    id: 'psych_perception_history',
    rule:
      'Psychological *_observed perceptionLog entries are historical UI notifications only; never treat them as current readiness, morale, or command authority.',
  },
];

class PerceptionSessionMismatchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PerceptionSessionMismatchError';
  }
}

/**
 * @param {string|null|undefined} sessionIdA
 * @param {string|null|undefined} sessionIdB
 */
function assertSamePerceptionSession(sessionIdA, sessionIdB) {
  if (typeof sessionIdA !== 'string' || typeof sessionIdB !== 'string') {
    throw new PerceptionSessionMismatchError('perceptionLog.sessionId required on both payloads to merge history');
  }
  if (sessionIdA !== sessionIdB) {
    throw new PerceptionSessionMismatchError(
      `Cannot merge perceptionLog histories: sessionId ${sessionIdA} vs ${sessionIdB}`,
    );
  }
}

/**
 * Append perception events only when both logs share the same sessionId.
 * @param {object[]} eventsA
 * @param {object[]} eventsB
 * @param {string} sessionIdA
 * @param {string} sessionIdB
 */
function mergePerceptionEventsSameSessionOnly(eventsA, eventsB, sessionIdA, sessionIdB) {
  assertSamePerceptionSession(sessionIdA, sessionIdB);
  return [...(eventsA ?? []), ...(eventsB ?? [])];
}

/**
 * Current hostile / MC position policy for one unit id (export semantics, not terrain.inLos).
 * @returns {{ availability: string, position: number[]|null, mindControlledRoster: boolean }}
 */
function classifyCurrentHostileObservation(tactical, unitId) {
  const unit = (tactical?.units ?? []).find((u) => u.id === unitId);
  if (!unit) {
    return {
      availability: 'no_current_position',
      position: null,
      mindControlledRoster: false,
    };
  }
  if (isFriendlyPlayerControlled(unit)) {
    return {
      availability: 'friendly_commandable_roster',
      position: unit.position ?? null,
      mindControlledRoster: false,
    };
  }
  const mc = isMindControlledRosterSoldier(unit);
  const position = unit.position ?? null;
  if (!unit.facing) {
    return {
      availability: 'in_units_without_facing_observation',
      position,
      mindControlledRoster: mc,
    };
  }
  if (isGenuineHostileUnit(unit)) {
    return {
      availability: 'confirmed_current_los',
      position,
      mindControlledRoster: false,
    };
  }
  if (mc) {
    return {
      availability: 'confirmed_current_los_mind_controlled_roster',
      position,
      mindControlledRoster: true,
    };
  }
  if (isNeutralCivilianUnit(unit)) {
    return {
      availability: 'confirmed_current_los_neutral_civilian',
      position,
      mindControlledRoster: false,
    };
  }
  if (isXcomControlledHostileUnit(unit)) {
    return {
      availability: 'confirmed_current_los_xcom_controlled_hostile',
      position,
      mindControlledRoster: false,
    };
  }
  return {
    availability: 'confirmed_current_los_non_hostile',
    position,
    mindControlledRoster: false,
  };
}

/**
 * Latest unit_last_seen for a subject within one perceptionLog (same session only).
 */
function latestUnitLastSeenEvent(perceptionLog, subjectUnitId) {
  if (!perceptionLog?.events?.length) {
    return null;
  }
  let latest = null;
  for (const ev of perceptionLog.events) {
    if (ev.type !== 'unit_last_seen' || ev.subjectUnitId !== subjectUnitId) {
      continue;
    }
    if (!ev.positionKnown || !ev.position) {
      continue;
    }
    latest = ev;
  }
  return latest;
}

/**
 * Resolve current vs memory for consumers; never promotes last_seen to confirmed current when unit is absent.
 */
function resolveHostileIntel(tactical, unitId) {
  const current = classifyCurrentHostileObservation(tactical, unitId);
  const historicalLastSeen = latestUnitLastSeenEvent(tactical?.perceptionLog, unitId);
  const memoryOnlyPosition =
    current.availability === 'no_current_position' && historicalLastSeen
      ? historicalLastSeen.position
      : null;
  const confirmedCurrentPosition = isConfirmedCurrentLosAvailability(current.availability)
    ? current.position
    : null;

  return {
    unitId,
    current,
    historicalLastSeen: historicalLastSeen
      ? {
          position: historicalLastSeen.position,
          confidence: historicalLastSeen.confidence,
          turn: historicalLastSeen.turn,
        }
      : null,
    confirmedCurrentPosition,
    memoryOnlyPosition,
  };
}

function getHostileIntelligenceContractMarkdown() {
  const lines = [
    '## Hostile intelligence fair-play (M1-WP5)',
    '',
    'Apply these rules when reading `tactical.units`, `perceptionLog`, and `unitStateBrief`:',
    '',
  ];
  for (const item of HOSTILE_INTELLIGENCE_CONSUMER_RULES) {
    lines.push(`- ${item.rule}`);
  }
  lines.push(
    '',
    '**Mind-controlled roster soldiers:** `unitStateBrief.exceptions` (`mind_controlled_roster_soldier`) confirms compromise and command exclusion. They are omitted from `visibleHostileObservations` (genuine hostiles only); use exceptions and `units[]` facing for MC threat geometry.',
    '',
    '**Perception sessions:** A shorter perceptionLog with `droppedCount: 0` may reflect a **new** `sessionId`, not proven event eviction. Do not assume one continuous history across exports unless `sessionId` matches.',
    '',
  );
  return lines.join('\n');
}

module.exports = {
  HOSTILE_INTELLIGENCE_CONSUMER_RULES,
  PerceptionSessionMismatchError,
  assertSamePerceptionSession,
  mergePerceptionEventsSameSessionOnly,
  isConfirmedCurrentLosAvailability,
  classifyCurrentHostileObservation,
  latestUnitLastSeenEvent,
  resolveHostileIntel,
  getHostileIntelligenceContractMarkdown,
};
