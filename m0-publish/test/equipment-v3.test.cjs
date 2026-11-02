'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const {
  MAX_INVENTORY_ENTRIES,
  ValidationError,
  parseAndValidate,
  validateUnit,
  validateEquipmentItem,
  computeSnapshotId,
  buildRelayPayload,
  loadAndValidateSnapshotFromText,
  FACTION_PLAYER,
  FACTION_HOSTILE,
  BT_FIREARM,
  BT_AMMO,
  BT_GRENADE,
} = require('../lib/tactical-publish.cjs');

const FIXTURE_V2 = path.join(__dirname, 'fixtures', 'valid-v2.yaml');
const FIXTURE_V3 = path.join(__dirname, 'fixtures', 'valid-v3.yaml');

function friendlyV3Base(overrides = {}) {
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

describe('schema v3 equipment validation', () => {
  it('accepts a valid schema v3 fixture', () => {
    const text = fs.readFileSync(FIXTURE_V3, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(text, YAML);
    assert.equal(tactical.schemaVersion, 3);
    assert.equal(tactical.units[0].hands.right.itemType, 'STR_RIFLE');
    assert.equal(tactical.units[0].hands.right.empty, undefined);
    assert.equal(tactical.units[1].inventory[0].primed, false);
    assert.equal(tactical.units[1].inventory[1].itemType, 'STR_RIFLE_CLIP');
    assert.equal(tactical.units[1].inventory[1].empty, undefined);
  });

  it('accepts loaded rifle without empty field', () => {
    const unit = validateUnit(friendlyV3Base({
      hands: {
        right: {
          itemType: 'STR_RIFLE',
          battleType: BT_FIREARM,
          loaded: { ammoType: 'STR_RIFLE_CLIP', rounds: 25 },
        },
        left: null,
      },
    }), 0, 3);
    assert.equal(unit.hands.right.loaded.rounds, 25);
    assert.equal(unit.hands.right.empty, undefined);
  });

  it('accepts Heavy Cannon with loaded AP ammunition', () => {
    validateUnit(friendlyV3Base({
      hands: {
        right: {
          itemType: 'STR_HEAVY_CANNON',
          battleType: BT_FIREARM,
          loaded: { ammoType: 'STR_HC_AP_AMMO', rounds: 6 },
        },
        left: null,
      },
    }), 0, 3);
  });

  it('accepts empty firearm with empty true only', () => {
    const unit = validateUnit(friendlyV3Base({
      hands: {
        right: {
          itemType: 'STR_RIFLE',
          battleType: BT_FIREARM,
          empty: true,
        },
        left: null,
      },
    }), 0, 3);
    assert.equal(unit.hands.right.empty, true);
    assert.equal(unit.hands.right.loaded, undefined);
  });

  it('accepts spare ammunition clip without empty or loaded', () => {
    validateUnit(friendlyV3Base({
      inventory: [{ slot: 'STR_BACK_PACK', itemType: 'STR_RIFLE_CLIP', battleType: BT_AMMO }],
    }), 0, 3);
  });

  it('rejects misleading empty on spare ammunition clip', () => {
    assert.throws(
      () => validateUnit(friendlyV3Base({
        inventory: [{
          slot: 'STR_BACK_PACK',
          itemType: 'STR_RIFLE_CLIP',
          battleType: BT_AMMO,
          empty: true,
        }],
      }), 0, 3),
      /must not include empty/
    );
  });

  it('accepts empty hand as null', () => {
    const unit = validateUnit(friendlyV3Base(), 0, 3);
    assert.equal(unit.hands.right, null);
    assert.equal(unit.hands.left, null);
  });

  it('accepts unprimed grenade in inventory', () => {
    validateUnit(friendlyV3Base({
      inventory: [{ slot: 'STR_BELT', itemType: 'STR_GRENADE', battleType: BT_GRENADE, primed: false }],
    }), 0, 3);
  });

  it('rejects misleading empty on grenade', () => {
    assert.throws(
      () => validateUnit(friendlyV3Base({
        inventory: [{
          slot: 'STR_BELT',
          itemType: 'STR_GRENADE',
          battleType: BT_GRENADE,
          empty: true,
          primed: false,
        }],
      }), 0, 3),
      /must not include empty/
    );
  });

  it('accepts primed grenade in hand', () => {
    validateUnit(friendlyV3Base({
      hands: {
        right: { itemType: 'STR_GRENADE', battleType: BT_GRENADE, primed: true },
        left: null,
      },
    }), 0, 3);
  });

  it('rejects mind-controlled alien equipment fields', () => {
    assert.throws(
      () => validateUnit({
        id: 1000000,
        faction: FACTION_PLAYER,
        originalFaction: FACTION_HOSTILE,
        position: [1, 2, 0],
        kneeled: false,
      }, 0, 3),
      /must not include kneeled/
    );
  });

  it('rejects mind-controlled XCOM soldier equipment fields', () => {
    assert.throws(
      () => validateUnit({
        id: 9,
        faction: FACTION_HOSTILE,
        originalFaction: FACTION_PLAYER,
        position: [1, 2, 0],
        inventory: [],
      }, 0, 3),
      /must not include inventory/
    );
  });

  it('keeps visible hostile position-only without equipment', () => {
    validateUnit({
      id: 1000000,
      faction: FACTION_HOSTILE,
      originalFaction: FACTION_HOSTILE,
      position: [5, 5, 0],
    }, 0, 3);
  });

  it('rejects enemy equipment fields', () => {
    assert.throws(
      () => validateUnit({
        id: 1000000,
        faction: FACTION_HOSTILE,
        originalFaction: FACTION_HOSTILE,
        position: [5, 5, 0],
        hands: { right: null, left: null },
      }, 0, 3),
      /must not include hands/
    );
  });

  it('rejects loaded on non-firearm items', () => {
    assert.throws(
      () => validateEquipmentItem({
        itemType: 'STR_RIFLE_CLIP',
        battleType: BT_AMMO,
        loaded: { ammoType: 'STR_RIFLE_CLIP', rounds: 25 },
      }, 'clip'),
      /must not include loaded/
    );
  });

  it('rejects oversized inventory', () => {
    const inventory = Array.from({ length: MAX_INVENTORY_ENTRIES + 1 }, (_, i) => ({
      slot: 'STR_BELT',
      itemType: `STR_ITEM_${i}`,
      battleType: BT_GRENADE,
    }));
    assert.throws(
      () => validateUnit(friendlyV3Base({ inventory }), 0, 3),
      /exceeds 24 entries/
    );
  });

  it('rejects invalid equipment item keys', () => {
    assert.throws(
      () => validateEquipmentItem({ itemType: 'STR_RIFLE', battleType: BT_FIREARM, secret: true }, 'item'),
      /unknown field: secret/
    );
  });

  it('rejects v2 snapshots that include v3-only fields', () => {
    const raw = YAML.parse(fs.readFileSync(FIXTURE_V2, 'utf8'));
    raw.units[0].kneeled = false;
    assert.throws(() => parseAndValidate(raw), /unknown field: kneeled/);
  });

  it('maintains v2 backward compatibility', () => {
    const text = fs.readFileSync(FIXTURE_V2, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(text, YAML);
    assert.equal(tactical.schemaVersion, 2);
    assert.equal(tactical.units[0].hands, undefined);
  });

  it('produces stable snapshot hashing for v3', () => {
    const text = fs.readFileSync(FIXTURE_V3, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(text, YAML);
    const a = computeSnapshotId(tactical);
    const b = computeSnapshotId(tactical);
    assert.equal(a, b);

    const relay = buildRelayPayload(tactical, '2026-01-01T00:00:00.000Z');
    assert.equal(relay.source.companion_schema, 3);
  });
});
