'use strict';

const YAML = require('yaml');
const {
  FACTION_PLAYER,
  BT_MEDIKIT,
  loadAndValidateSnapshotFromText,
} = require('../../lib/tactical-publish.cjs');

const SESSION = 'abcdef0123456789abcdef0123456789';
const SNAPSHOT_SHA = 'd'.repeat(64);
const MEDIKIT_ID = 701;
const TARGET_ID = 2;

function medikitActionCosts(tuCost = 10, canAffordTu = true) {
  return {
    posture: { kneelDownTu: 4, standUpTu: 8 },
    hands: {
      right: {
        itemType: 'STR_MEDI_KIT',
        actions: [{
          id: 'use',
          actionType: 9,
          tuCost,
          canAffordTu,
          usable: true,
        }],
      },
      left: { actions: [] },
    },
  };
}

function medkitActorUnit(overrides = {}) {
  return {
    id: 1,
    faction: FACTION_PLAYER,
    originalFaction: FACTION_PLAYER,
    position: [1, 1, 0],
    name: 'Medic',
    health: 45,
    timeUnits: 50,
    kneeled: false,
    activeHand: 'STR_RIGHT_HAND',
    hands: {
      right: {
        battleItemId: MEDIKIT_ID,
        itemType: 'STR_MEDI_KIT',
        battleType: BT_MEDIKIT,
        slot: 'STR_RIGHT_HAND',
        medikitCharges: { heal: 2, painKiller: 2, stimulant: 1 },
      },
      left: null,
    },
    inventory: [],
    actionCosts: medikitActionCosts(),
    facing: { direction: 4, vector: { dx: 0, dy: 1 } },
    condition: {
      energy: 40,
      maxEnergy: 60,
      maxHealth: 60,
      morale: 80,
      stunLevel: 0,
      alive: true,
      conscious: true,
      engineStatus: 'standing',
      engineStatusId: 0,
      floating: false,
      movementTypeId: 0,
      movementType: 'walk',
    },
    readiness: {
      summary: 'ready_to_act',
      engineStatus: 'standing',
      liveRosterSoldier: true,
      engineActingUnitAvailable: true,
      observationNote: 'fixture',
    },
    fatalWounds: [0, 0, 0, 0, 0, 0],
    ...overrides,
  };
}

function woundedTargetUnit(overrides = {}) {
  return {
    id: TARGET_ID,
    faction: FACTION_PLAYER,
    originalFaction: FACTION_PLAYER,
    position: [1, 2, 0],
    name: 'Patient',
    health: 20,
    timeUnits: 0,
    kneeled: false,
    activeHand: 'STR_RIGHT_HAND',
    hands: { right: null, left: null },
    inventory: [],
    facing: { direction: 0, vector: { dx: 0, dy: -1 } },
    condition: {
      energy: 10,
      maxEnergy: 60,
      maxHealth: 60,
      morale: 40,
      stunLevel: 0,
      alive: true,
      conscious: true,
      engineStatus: 'standing',
      engineStatusId: 0,
      floating: false,
      movementTypeId: 0,
      movementType: 'walk',
    },
    readiness: {
      summary: 'ready_to_act',
      engineStatus: 'standing',
      liveRosterSoldier: true,
      engineActingUnitAvailable: false,
      observationNote: 'fixture',
    },
    fatalWounds: [1, 0, 0, 0, 0, 0],
    ...overrides,
  };
}

function loadMedikitTactical(units) {
  const text = YAML.stringify({
    schemaVersion: 5,
    turn: 1,
    side: 0,
    selectedUnitId: 1,
    map: { width: 10, height: 10, depth: 1 },
    terrain: {
      memoryNote: 'WP9 medikit relay fixture.',
      tiles: [
        { p: [1, 1, 0], disc: 4, inLos: true, body: { noFloor: false, elev: 0, walkF: 4 } },
        { p: [1, 2, 0], disc: 4, inLos: true, body: { noFloor: false, elev: 0, walkF: 4 } },
      ],
    },
    eventLog: {
      sessionId: SESSION,
      oldestSeq: 0,
      latestSeq: 0,
      droppedCount: 0,
      events: [],
    },
    units,
  });
  return loadAndValidateSnapshotFromText(text, YAML);
}

module.exports = {
  SESSION,
  SNAPSHOT_SHA,
  MEDIKIT_ID,
  TARGET_ID,
  medkitActorUnit,
  woundedTargetUnit,
  loadMedikitTactical,
};