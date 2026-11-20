'use strict';

const { isFriendlyHwpUnit, isFriendlyRosterSoldier } = require('./unit-state-brief.cjs');

const HWP_BINDING_SCHEMA_VERSION = 1;
const MAX_ROSTER_UNIT_ID_EXCLUSIVE = 1_000_000;

function isOnMapFriendlyHwpForBinding(unit) {
  return isFriendlyHwpUnit(unit)
    && unit.battlefieldPlacement !== 'carried_in_inventory'
    && Array.isArray(unit.position)
    && unit.position.length === 3;
}

function resolveHwpControlMode(hwpId, soldierControlMirror) {
  if (!soldierControlMirror || soldierControlMirror.availability !== 'available') {
    return 'human';
  }
  const row = (soldierControlMirror.hwps ?? []).find((h) => h.id === hwpId);
  if (!row) {
    return 'human';
  }
  return row.controlMode === 'ai' ? 'ai' : 'human';
}

/**
 * Binding row for future HWP command authorization (execution still disabled in S2a).
 */
function mapPlayerHwpBindingRow(unit, soldierControlMirror) {
  const obs = unit.friendlyHwpObservationV1;
  const controlMode = resolveHwpControlMode(unit.id, soldierControlMirror);
  const row = {
    id: unit.id,
    position: unit.position,
    controlMode,
    commandExecutionSupported: false,
    hwpMoveExecutionSupported: true,
    hwpTurnExecutionSupported: true,
    hwpFireExecutionSupported: true,
    hwpGuidedLaunchExecutionSupported: true,
    observationPresent: obs != null,
  };
  if (obs) {
    row.friendlyHwpObservationV1 = {
      schemaVersion: obs.schemaVersion,
      unitId: obs.unitId,
      hwpUnitType: obs.hwpUnitType,
      ...(obs.displayLabel ? { displayLabel: obs.displayLabel } : {}),
      position: obs.position,
      ...(obs.bodyFacing ? { bodyFacing: obs.bodyFacing } : {}),
      ...(obs.turretFacing ? { turretFacing: obs.turretFacing } : {}),
      timeUnits: obs.timeUnits,
      ...(typeof obs.maxTimeUnits === 'number' ? { maxTimeUnits: obs.maxTimeUnits } : {}),
      ...(typeof obs.health === 'number' ? { health: obs.health } : {}),
      ...(typeof obs.maxHealth === 'number' ? { maxHealth: obs.maxHealth } : {}),
      ...(obs.fixedWeapons ? { fixedWeapons: obs.fixedWeapons } : {}),
      ...(obs.capabilities ? { capabilities: obs.capabilities } : {}),
    };
    row.hwpUnitType = obs.hwpUnitType;
  }
  return row;
}

function buildPlayerHwpBindingRows(tactical, soldierControlMirror) {
  return tactical.units
    .filter(isOnMapFriendlyHwpForBinding)
    .map((unit) => mapPlayerHwpBindingRow(unit, soldierControlMirror));
}

function assertControlAssignmentsDisjoint(doc) {
  const soldierIds = Object.keys(doc.assignments ?? {}).map((k) => Number.parseInt(k, 10));
  const hwpIds = Object.keys(doc.hwp_assignments ?? {}).map((k) => Number.parseInt(k, 10));
  const mcIds = Object.keys(doc.mc_hostile_assignments ?? {}).map((k) => Number.parseInt(k, 10));
  for (const id of soldierIds) {
    if (id >= MAX_ROSTER_UNIT_ID_EXCLUSIVE) {
      return 'roster_assignment_id_out_of_band';
    }
  }
  for (const id of hwpIds) {
    if (id < MAX_ROSTER_UNIT_ID_EXCLUSIVE) {
      return 'hwp_assignment_id_out_of_band';
    }
  }
  for (const id of mcIds) {
    if (id < MAX_ROSTER_UNIT_ID_EXCLUSIVE) {
      return 'mc_assignment_id_out_of_band';
    }
  }
  const bandHigh = [...hwpIds, ...mcIds];
  for (const id of bandHigh) {
    if (soldierIds.includes(id)) {
      return 'assignment_id_collision';
    }
  }
  for (const id of hwpIds) {
    if (mcIds.includes(id)) {
      return 'assignment_id_collision';
    }
  }
  return null;
}

module.exports = {
  HWP_BINDING_SCHEMA_VERSION,
  isOnMapFriendlyHwpForBinding,
  mapPlayerHwpBindingRow,
  buildPlayerHwpBindingRows,
  assertControlAssignmentsDisjoint,
};