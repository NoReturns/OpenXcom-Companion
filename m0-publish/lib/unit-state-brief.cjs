'use strict';

const FACTION_PLAYER = 0;
const FACTION_HOSTILE = 1;
const FACTION_NEUTRAL = 2;

/** OpenXcom BattleUnit::MAX_SOLDIER_ID — geoscape roster unit ids stay below this. */
const MAX_ROSTER_UNIT_ID_EXCLUSIVE = 1_000_000;

function isFriendlyPlayerControlled(unit) {
  return unit.originalFaction === FACTION_PLAYER && unit.faction === FACTION_PLAYER;
}

/** X-COM roster soldier under player control (excludes friendly HWP / id >= MAX_SOLDIER_ID). */
function unitStateBriefPlacementFields(unit) {
  if (unit.battlefieldPlacement === 'carried_in_inventory') {
    return {
      positionKnown: false,
      battlefieldPlacement: unit.battlefieldPlacement,
      carriedByUnitId: unit.carriedByUnitId,
      carriedBodyBattleItemId: unit.carriedBodyBattleItemId,
    };
  }
  return { position: unit.position };
}

function isFriendlyRosterSoldier(unit) {
  return isFriendlyPlayerControlled(unit) && isRosterSoldierUnitId(unit.id);
}

function isRosterSoldierUnitId(unitId) {
  return Number.isInteger(unitId) && unitId > 0 && unitId < MAX_ROSTER_UNIT_ID_EXCLUSIVE;
}

/** X-COM roster soldier currently fighting for another faction (e.g. alien mind control). */
function isMindControlledRosterSoldier(unit) {
  if (!unit || !isRosterSoldierUnitId(unit.id)) {
    return false;
  }
  return unit.originalFaction === FACTION_PLAYER && unit.faction !== FACTION_PLAYER;
}

/** Hostile-origin unit currently fighting under X-COM mind control (not Companion-commandable). */
function isXcomControlledHostileUnit(unit) {
  if (!unit) {
    return false;
  }
  return unit.originalFaction === FACTION_HOSTILE && unit.faction === FACTION_PLAYER;
}

/** Engine-exported alien threat (not neutral civilian, MC roster, or friendly-controlled hostile). */
function isGenuineHostileUnit(unit) {
  if (!unit) {
    return false;
  }
  return unit.originalFaction === FACTION_HOSTILE && unit.faction === FACTION_HOSTILE;
}

/** Neutral civilian (terror mission / non-combatant faction). */
function isNeutralCivilianUnit(unit) {
  if (!unit) {
    return false;
  }
  return unit.originalFaction === FACTION_NEUTRAL && unit.faction === FACTION_NEUTRAL;
}

/**
 * Compact relay summary of entitled unit-state exceptions (M1-WP2).
 * Full validated tactical.units retains authoritative numeric fields.
 */
function buildUnitStateBrief(tactical, options = {}) {
  const maxBytes = options.maxBytes ?? 4096;
  const friendly = (tactical.units ?? []).filter((unit) => isFriendlyPlayerControlled(unit));

  const exceptions = [];
  const facingNotes = [];

  for (const unit of friendly) {
    const base = { id: unit.id, name: unit.name, ...unitStateBriefPlacementFields(unit) };
    const readiness = unit.readiness?.summary;
    if (readiness && readiness !== 'ready_to_act') {
      exceptions.push({
        ...base,
        kind: 'readiness',
        summary: readiness,
        engineStatus: unit.readiness?.engineStatus ?? unit.condition?.engineStatus,
      });
    } else if (unit.readiness && unit.readiness.engineActingUnitAvailable === false) {
      exceptions.push({
        ...base,
        kind: 'engine_not_acting_unit',
        summary: readiness ?? 'unknown',
      });
    }

    if (unit.condition) {
      if (unit.condition.conscious === false && unit.condition.alive === true) {
        exceptions.push({ ...base, kind: 'unconscious', stunLevel: unit.condition.stunLevel });
      }
      if (unit.condition.alive === false) {
        exceptions.push({ ...base, kind: 'dead' });
      }
      if (
        typeof unit.condition.maxEnergy === 'number' &&
        unit.condition.maxEnergy > 0 &&
        unit.condition.energy <= Math.floor(unit.condition.maxEnergy * 0.15)
      ) {
        exceptions.push({
          ...base,
          kind: 'low_energy_heuristic',
          energy: unit.condition.energy,
          maxEnergy: unit.condition.maxEnergy,
          note: 'Heuristic: energy at or below 15% of maxEnergy.',
        });
      }
      if (unit.condition.morale < 50) {
        exceptions.push({
          ...base,
          kind: 'low_morale_heuristic',
          morale: unit.condition.morale,
          note: 'Heuristic: morale below 50 (panic checks use engine RNG).',
        });
      }
    }

    if (unit.facing?.label) {
      facingNotes.push({
        id: unit.id,
        name: unit.name,
        direction: unit.facing.direction,
        label: unit.facing.label,
        vector: unit.facing.vector,
      });
    }
  }

  for (const unit of tactical.units ?? []) {
    if (!isMindControlledRosterSoldier(unit)) {
      continue;
    }
    exceptions.push({
      id: unit.id,
      ...(typeof unit.name === 'string' && unit.name.length > 0 ? { name: unit.name } : {}),
      position: unit.position,
      kind: 'mind_controlled_roster_soldier',
      currentFaction: unit.faction,
      note: 'Roster soldier (originalFaction X-COM) is under hostile control; not commandable as friendly.',
    });
  }

  for (const unit of tactical.units ?? []) {
    if (!isXcomControlledHostileUnit(unit)) {
      continue;
    }
    exceptions.push({
      id: unit.id,
      position: unit.position,
      kind: 'xcom_controlled_hostile_unit',
      currentFaction: unit.faction,
      note: 'Hostile-origin unit under X-COM mind control; friendly-controlled asset, not a hostile threat or Companion command actor.',
    });
  }

  const visibleHostiles = (tactical.units ?? []).filter(
    (unit) => isGenuineHostileUnit(unit) && unit.facing
  );
  const hostileObservations = visibleHostiles.map((unit) => ({
    id: unit.id,
    position: unit.position,
    ...(unit.kneeled !== undefined ? { kneeled: unit.kneeled } : {}),
    ...(typeof unit.observedUnitType === 'string' && unit.observedUnitType.length > 0
      ? { observedUnitType: unit.observedUnitType }
      : {}),
    ...(typeof unit.displayLabel === 'string' && unit.displayLabel.length > 0
      ? { displayLabel: unit.displayLabel }
      : {}),
    facing: unit.facing,
  }));

  const brief = {
    schemaVersion: 1,
    friendlyRosterCount: friendly.length,
    exceptionCount: exceptions.length,
    exceptions: exceptions.slice(0, 32),
    facingBySoldier: facingNotes.slice(0, 16),
    visibleHostileObservations: hostileObservations.slice(0, 16),
    notes: [
      'Derived summary only; tactical.units.condition and facing are authoritative.',
      'Low energy/morale entries are labeled heuristics, not engine verdicts.',
      'mind_controlled_roster_soldier uses originalFaction vs faction on roster-band unit ids.',
      'mind_controlled_roster_soldier and neutral civilians (faction 2) are omitted from visibleHostileObservations; exceptions carry MC compromise status.',
      'xcom_controlled_hostile_unit marks MC aliens as friendly-controlled assets; they are omitted from visibleHostileObservations.',
      'visibleHostileObservations lists only genuine hostiles (originalFaction and faction both hostile) with current facing.',
      'Per-action TU affordability remains in actionCosts.',
    ],
  };

  let serialized = JSON.stringify(brief);
  while (Buffer.byteLength(serialized, 'utf8') > maxBytes && brief.exceptions.length > 1) {
    brief.exceptions.pop();
    brief.truncated = true;
    serialized = JSON.stringify(brief);
  }
  return brief;
}

module.exports = {
  buildUnitStateBrief,
  isFriendlyPlayerControlled,
  isFriendlyRosterSoldier,
  isMindControlledRosterSoldier,
  isXcomControlledHostileUnit,
  isGenuineHostileUnit,
  isNeutralCivilianUnit,
  isRosterSoldierUnitId,
  FACTION_NEUTRAL,
  MAX_ROSTER_UNIT_ID_EXCLUSIVE,
};
