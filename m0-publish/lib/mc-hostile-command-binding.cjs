'use strict';

const { isXcomControlledHostileUnit } = require('./unit-state-brief.cjs');

const MC_HOSTILE_BINDING_SCHEMA_VERSION = 1;

function isOnMapXcomControlledMcHostileForBinding(unit) {
  return isXcomControlledHostileUnit(unit)
    && unit.battlefieldPlacement !== 'carried_in_inventory'
    && Array.isArray(unit.position)
    && unit.position.length === 3;
}

function resolveMcHostileControlMode(unitId, soldierControlMirror) {
  if (!soldierControlMirror || soldierControlMirror.availability !== 'available') {
    return 'human';
  }
  const row = (soldierControlMirror.mcHostiles ?? []).find((h) => h.id === unitId);
  if (!row) {
    return 'human';
  }
  return row.controlMode === 'ai' ? 'ai' : 'human';
}

function mapPlayerMcHostileBindingRow(unit, soldierControlMirror) {
  const obs = unit.xcomControlledHostileObservationV1;
  const controlMode = resolveMcHostileControlMode(unit.id, soldierControlMirror);
  const executionReady = controlMode === 'ai' && obs != null;
  const row = {
    id: unit.id,
    position: unit.position,
    kneeled: unit.kneeled === true,
    originalFaction: unit.originalFaction,
    faction: unit.faction,
    controlMode,
    commandExecutionSupported: false,
    mcMoveExecutionSupported: executionReady,
    mcTurnFaceExecutionSupported: executionReady,
    mcKneelExecutionSupported: executionReady,
    observationPresent: obs != null,
  };
  if (obs) {
    row.xcomControlledHostileObservationV1 = obs;
    if (typeof obs.displayLabel === 'string') {
      row.displayLabel = obs.displayLabel;
    }
    if (typeof obs.unitType === 'string') {
      row.observedUnitType = obs.unitType;
    }
  }
  return row;
}

function buildPlayerMcHostileBindingRows(tactical, soldierControlMirror) {
  return tactical.units
    .filter(isOnMapXcomControlledMcHostileForBinding)
    .map((unit) => mapPlayerMcHostileBindingRow(unit, soldierControlMirror));
}

function listXcomControlledMcHostileIdsOnMap(tactical) {
  return tactical.units
    .filter(isOnMapXcomControlledMcHostileForBinding)
    .map((u) => u.id)
    .sort((a, b) => a - b);
}

module.exports = {
  MC_HOSTILE_BINDING_SCHEMA_VERSION,
  isOnMapXcomControlledMcHostileForBinding,
  mapPlayerMcHostileBindingRow,
  buildPlayerMcHostileBindingRows,
  listXcomControlledMcHostileIdsOnMap,
};