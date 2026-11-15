'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  ValidationError,
  validateUnit,
  FACTION_PLAYER,
  FACTION_HOSTILE,
  BT_MEDIKIT,
} = require('../lib/tactical-publish.cjs');

function rosterV5Base(overrides = {}) {
  return {
    id: 1,
    faction: FACTION_PLAYER,
    originalFaction: FACTION_PLAYER,
    position: { x: 1, y: 2, z: 0 },
    name: 'Test Soldier',
    health: 40,
    timeUnits: 50,
    kneeled: false,
    activeHand: 'STR_RIGHT_HAND',
    hands: {
      right: {
        itemType: 'STR_MEDI_KIT',
        battleType: BT_MEDIKIT,
        medikitCharges: { heal: 10, painKiller: 10, stimulant: 10 },
      },
      left: null,
    },
    inventory: [],
    actionCosts: {
      posture: { kneelDownTu: 4, standUpTu: 8 },
      hands: {
        right: {
          itemType: 'STR_MEDI_KIT',
          actions: [
            {
              id: 'use',
              actionType: 9,
              tuCost: 10,
              canAffordTu: true,
              usable: true,
            },
          ],
        },
        left: { actions: [] },
      },
    },
    facing: {
      direction: 0,
      vector: { dx: 0, dy: -1 },
    },
    condition: {
      energy: 50,
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
    ...overrides,
  };
}

describe('M1-WP9 medikit S0 observation schema', () => {
  it('accepts six-part fatalWounds and condition.maxHealth on roster soldiers', () => {
    const unit = validateUnit(rosterV5Base({
      fatalWounds: [0, 2, 0, 1, 0, 0],
      health: 35,
    }), 0, 5);
    assert.deepEqual(unit.fatalWounds, [0, 2, 0, 1, 0, 0]);
    assert.equal(unit.condition.maxHealth, 60);
    assert.equal(unit.actionCosts.hands.right.actions[0].id, 'use');
    assert.equal(unit.actionCosts.hands.right.actions[0].actionType, 9);
    assert.equal(unit.actionCosts.hands.right.actions[0].tuCost, 10);
  });

  it('rejects fatalWounds on visible hostiles', () => {
    assert.throws(
      () => validateUnit({
        id: 1_000_050,
        faction: FACTION_HOSTILE,
        originalFaction: FACTION_HOSTILE,
        position: { x: 3, y: 3, z: 0 },
        kneeled: false,
        facing: { direction: 4, vector: { dx: 0, dy: 1 } },
        fatalWounds: [1, 0, 0, 0, 0, 0],
      }, 0, 5),
      (err) => err instanceof ValidationError && /fatalWounds/.test(err.message),
    );
  });

  it('rejects malformed fatalWounds length', () => {
    assert.throws(
      () => validateUnit(rosterV5Base({ fatalWounds: [0, 1] }), 0, 5),
      (err) => err instanceof ValidationError && /exactly 6/.test(err.message),
    );
  });

  it('rejects unknown use action id', () => {
    assert.throws(
      () => validateUnit(rosterV5Base({
        actionCosts: {
          posture: { kneelDownTu: 4, standUpTu: 8 },
          hands: {
            right: {
              itemType: 'STR_MEDI_KIT',
              actions: [{
                id: 'heal',
                actionType: 9,
                tuCost: 10,
                canAffordTu: true,
                usable: true,
              }],
            },
            left: { actions: [] },
          },
        },
      }), 0, 5),
      (err) => err instanceof ValidationError && /id invalid/.test(err.message),
    );
  });

  it('accepts modded tuCost on use without assuming stock 10', () => {
    const unit = validateUnit(rosterV5Base({
      actionCosts: {
        posture: { kneelDownTu: 4, standUpTu: 8 },
        hands: {
          right: {
            itemType: 'STR_WP9_MEDIKIT_FLAT',
            actions: [{
              id: 'use',
              actionType: 9,
              tuCost: 17,
              canAffordTu: false,
              usable: true,
            }],
          },
          left: { actions: [] },
        },
      },
    }), 0, 5);
    assert.equal(unit.actionCosts.hands.right.actions[0].tuCost, 17);
    assert.equal(unit.actionCosts.hands.right.actions[0].canAffordTu, false);
  });
});