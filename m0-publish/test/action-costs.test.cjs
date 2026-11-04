'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const {
  ValidationError,
  parseAndValidate,
  validateUnit,
  validateActionCosts,
  loadAndValidateSnapshotFromText,
  FACTION_PLAYER,
  FACTION_HOSTILE,
} = require('../lib/tactical-publish.cjs');

const FIXTURE_V2 = path.join(__dirname, 'fixtures', 'valid-v2.yaml');
const FIXTURE_V3 = path.join(__dirname, 'fixtures', 'valid-v3.yaml');
const FIXTURE_V3_ACTIONS = path.join(__dirname, 'fixtures', 'valid-v3-action-costs.yaml');

function friendlyV3WithEquipment(overrides = {}) {
  return {
    id: 1,
    faction: FACTION_PLAYER,
    originalFaction: FACTION_PLAYER,
    position: [1, 2, 0],
    name: 'Test Soldier',
    health: 40,
    timeUnits: 50,
    kneeled: false,
    activeHand: 'STR_RIGHT_HAND',
    hands: { right: null, left: null },
    inventory: [],
    ...overrides,
  };
}

function actionEntry(id, actionType, tuCost, canAffordTu, usable) {
  return { id, actionType, tuCost, canAffordTu, usable };
}

describe('schema v3 action costs', () => {
  it('accepts v3 snapshots without actionCosts (backward compatible)', () => {
    const text = fs.readFileSync(FIXTURE_V3, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(text, YAML);
    assert.equal(tactical.units[0].actionCosts, undefined);
  });

  it('accepts full action cost fixture', () => {
    const tactical = loadAndValidateSnapshotFromText(fs.readFileSync(FIXTURE_V3_ACTIONS, 'utf8'), YAML);
    const snap = tactical.units[0].actionCosts.hands.right.actions.find((a) => a.id === 'snap');
    assert.equal(snap.tuCost, 17);
    assert.equal(snap.canAffordTu, true);
  });

  it('validates Heavy Cannon snap cost at 17 TU (base TU 52 × 33%)', () => {
    const costs = validateActionCosts({
      posture: { kneelDownTu: 4, standUpTu: 8 },
      hands: {
        right: {
          itemType: 'STR_HEAVY_CANNON',
          actions: [actionEntry('snap', 6, 17, true, true)],
        },
        left: { actions: [] },
      },
    }, 'costs');
    assert.equal(costs.hands.right.actions[0].tuCost, 17);
  });

  it('accepts rifle firing modes', () => {
    validateUnit(friendlyV3WithEquipment({
      actionCosts: {
        posture: { kneelDownTu: 4, standUpTu: 8 },
        hands: {
          right: {
            itemType: 'STR_RIFLE',
            actions: [
              actionEntry('snap', 6, 15, true, true),
              actionEntry('aimed', 7, 35, true, true),
              actionEntry('auto', 5, 25, true, true),
            ],
          },
          left: { actions: [] },
        },
      },
    }), 0, 3);
  });

  it('accepts pistol firing modes on left hand', () => {
    validateUnit(friendlyV3WithEquipment({
      actionCosts: {
        posture: { kneelDownTu: 4, standUpTu: 8 },
        hands: {
          right: { actions: [] },
          left: {
            itemType: 'STR_PISTOL',
            actions: [
              actionEntry('snap', 6, 12, true, true),
              actionEntry('aimed', 7, 20, true, true),
            ],
          },
        },
      },
    }), 0, 3);
  });

  it('accepts grenade priming and throwing', () => {
    validateUnit(friendlyV3WithEquipment({
      actionCosts: {
        posture: { kneelDownTu: 4, standUpTu: 8 },
        hands: {
          right: {
            itemType: 'STR_GRENADE',
            actions: [
              actionEntry('throw', 4, 25, true, true),
              actionEntry('prime', 3, 50, true, true),
            ],
          },
          left: { actions: [] },
        },
      },
    }), 0, 3);
  });

  it('accepts different current TU values affecting canAffordTu only', () => {
    validateUnit(friendlyV3WithEquipment({
      timeUnits: 10,
      actionCosts: {
        posture: { kneelDownTu: 4, standUpTu: 8 },
        hands: {
          right: {
            itemType: 'STR_RIFLE',
            actions: [actionEntry('aimed', 7, 35, false, true)],
          },
          left: { actions: [] },
        },
      },
    }), 0, 3);
  });

  it('accepts empty firearm with unusable snap but affordable TU', () => {
    validateUnit(friendlyV3WithEquipment({
      timeUnits: 60,
      actionCosts: {
        posture: { kneelDownTu: 4, standUpTu: 8 },
        hands: {
          right: {
            itemType: 'STR_RIFLE',
            actions: [actionEntry('snap', 6, 15, true, false)],
          },
          left: { actions: [] },
        },
      },
    }), 0, 3);
  });

  it('accepts empty hand with no actions', () => {
    validateUnit(friendlyV3WithEquipment({
      actionCosts: {
        posture: { kneelDownTu: 4, standUpTu: 8 },
        hands: {
          right: { actions: [] },
          left: { actions: [] },
        },
      },
    }), 0, 3);
  });

  it('rejects actionCosts on visible hostile', () => {
    assert.throws(
      () => validateUnit({
        id: 1000000,
        faction: FACTION_HOSTILE,
        originalFaction: FACTION_HOSTILE,
        position: [5, 5, 0],
        actionCosts: {
          posture: { kneelDownTu: 4, standUpTu: 8 },
          hands: { right: { actions: [] }, left: { actions: [] } },
        },
      }, 0, 3),
      /must not include actionCosts/
    );
  });

  it('rejects actionCosts on mind-controlled XCOM soldier', () => {
    assert.throws(
      () => validateUnit({
        id: 9,
        faction: FACTION_HOSTILE,
        originalFaction: FACTION_PLAYER,
        position: [1, 2, 0],
        actionCosts: {
          posture: { kneelDownTu: 4, standUpTu: 8 },
          hands: { right: { actions: [] }, left: { actions: [] } },
        },
      }, 0, 3),
      /must not include actionCosts/
    );
  });

  it('rejects v2 snapshots with actionCosts', () => {
    const raw = YAML.parse(fs.readFileSync(FIXTURE_V2, 'utf8'));
    raw.units[0].actionCosts = {
      posture: { kneelDownTu: 4, standUpTu: 8 },
      hands: { right: { actions: [] }, left: { actions: [] } },
    };
    assert.throws(() => parseAndValidate(raw), /unknown field: actionCosts/);
  });

  it('preserves actionCosts on friendly soldiers for schema 4 and 5', () => {
    const sampleCosts = {
      posture: { kneelDownTu: 4, standUpTu: 8 },
      hands: {
        right: {
          itemType: 'STR_HEAVY_CANNON',
          actions: [{
            id: 'snap',
            actionType: 6,
            tuCost: 17,
            canAffordTu: true,
            usable: true,
          }],
        },
        left: { actions: [] },
      },
    };
    for (const schemaVersion of [4, 5]) {
      const unit = validateUnit(friendlyV3WithEquipment({ actionCosts: sampleCosts }), 0, schemaVersion);
      assert.equal(unit.actionCosts.hands.right.actions[0].tuCost, 17);
    }
  });

  it('rejects malformed action entry fields', () => {
    assert.throws(
      () => validateActionCosts({
        posture: { kneelDownTu: 4, badField: 8 },
        hands: { right: { actions: [] }, left: { actions: [] } },
      }, 'costs'),
      /posture/
    );
  });
});
