'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const YAML = require('yaml');
const {
  MAX_GROUND_ITEM_OBSERVATIONS,
  MAX_GROUND_ITEMS_PER_TILE,
  ValidationError,
  parseAndValidate,
  loadAndValidateSnapshotFromText,
  BT_FIREARM,
  BT_AMMO,
  BT_GRENADE,
  computeSnapshotId,
} = require('../lib/tactical-publish.cjs');

const SESSION = '0123456789abcdef0123456789abcdef';

function friendlyUnit(overrides = {}) {
  return {
    id: 1,
    faction: 0,
    originalFaction: 0,
    position: [0, 0, 0],
    name: 'Test',
    health: 50,
    timeUnits: 50,
    kneeled: false,
    activeHand: 'STR_RIGHT_HAND',
    hands: { right: null, left: null },
    inventory: [],
    ...overrides,
  };
}

function baseV4(overrides = {}) {
  return {
    schemaVersion: 4,
    turn: 1,
    side: 0,
    selectedUnitId: 1,
    map: { width: 4, height: 4, depth: 1 },
    units: [friendlyUnit()],
    eventLog: {
      sessionId: SESSION,
      oldestSeq: 0,
      latestSeq: 0,
      droppedCount: 0,
      events: [],
    },
    ...overrides,
  };
}

function groundItemsBlock(observations) {
  return {
    schemaVersion: 1,
    sessionId: SESSION,
    memoryNote: 'test memory note',
    droppedCount: 0,
    observations,
  };
}

function obs(x, y, z, status, items) {
  return {
    position: { x, y, z },
    observationStatus: status,
    items,
  };
}

function item(entry) {
  return { battleType: BT_FIREARM, ...entry };
}

describe('M1-WP9 groundItems validation', () => {
  it('accepts visible ground weapon in LOS with verbose terrain', () => {
    const tactical = baseV4({
      groundItems: groundItemsBlock([
        obs(1, 1, 0, 'CONFIRMED_IN_LOS', [
          item({ itemCategory: 'firearm', itemType: 'STR_RIFLE' }),
        ]),
      ]),
      terrain: {
        memoryNote: 't',
        tiles: [{ p: [1, 1, 0], disc: 4, inLos: true, body: { noFloor: false, elev: 0, walkF: 4 } }],
      },
    });
    tactical.schemaVersion = 5;
    tactical.eventLog = baseV4().eventLog;
    const parsed = parseAndValidate(tactical);
    assert.equal(parsed.groundItems.observations.length, 1);
  });

  it('accepts multiple items on one tile', () => {
    const tactical = baseV4({
      groundItems: groundItemsBlock([
        obs(2, 0, 0, 'CONFIRMED_IN_LOS', [
          item({ itemCategory: 'firearm', itemType: 'STR_RIFLE' }),
          { itemCategory: 'additional_ground_item', battleType: BT_AMMO, concealedOnTile: true },
        ]),
      ]),
    });
    parseAndValidate(tactical);
  });

  it('accepts visible ammunition quantity', () => {
    parseAndValidate(baseV4({
      groundItems: groundItemsBlock([
        obs(0, 1, 0, 'CONFIRMED_IN_LOS', [
          { itemCategory: 'ammunition', battleType: BT_AMMO, itemType: 'STR_RIFLE_CLIP', quantity: 25 },
        ]),
      ]),
    }));
  });

  it('accepts visible primed grenade without fuseTimer', () => {
    parseAndValidate(baseV4({
      groundItems: groundItemsBlock([
        obs(0, 2, 0, 'CONFIRMED_IN_LOS', [
          { itemCategory: 'grenade', battleType: BT_GRENADE, itemType: 'STR_GRENADE', primed: true },
        ]),
      ]),
    }));
  });

  it('rejects hidden item claiming CONFIRMED_IN_LOS off terrain inLos', () => {
    const tactical = baseV4({
      schemaVersion: 5,
      eventLog: baseV4().eventLog,
      groundItems: groundItemsBlock([
        obs(1, 1, 0, 'CONFIRMED_IN_LOS', [item({ itemCategory: 'firearm', itemType: 'STR_RIFLE' })]),
      ]),
      terrain: {
        memoryNote: 't',
        tiles: [{ p: [1, 1, 0], disc: 4, inLos: false, body: { noFloor: false, elev: 0, walkF: 4 } }],
      },
    });
    assert.throws(() => parseAndValidate(tactical), /CONFIRMED_IN_LOS requires terrain inLos/);
  });

  it('rejects undiscovered tile reference when verbose terrain omits tile', () => {
    const tactical = baseV4({
      schemaVersion: 5,
      eventLog: baseV4().eventLog,
      groundItems: groundItemsBlock([
        obs(3, 3, 0, 'CONFIRMED_IN_LOS', [item({ itemCategory: 'firearm', itemType: 'STR_RIFLE' })]),
      ]),
      terrain: { memoryNote: 't', tiles: [] },
    });
    assert.throws(() => parseAndValidate(tactical), /absent from terrain/);
  });

  it('accepts remembered off-LOS observation with terrain', () => {
    const tactical = baseV4({
      schemaVersion: 5,
      eventLog: baseV4().eventLog,
      groundItems: groundItemsBlock([
        obs(1, 0, 0, 'REMEMBERED_OFF_LOS', [item({ itemCategory: 'firearm', itemType: 'STR_RIFLE' })]),
      ]),
      terrain: {
        memoryNote: 't',
        tiles: [{ p: [1, 0, 0], disc: 4, inLos: false, body: { noFloor: false, elev: 0, walkF: 4 } }],
      },
    });
    parseAndValidate(tactical);
  });

  it('rejects unresearched itemType leakage', () => {
    assert.throws(
      () => parseAndValidate(baseV4({
        groundItems: groundItemsBlock([
          obs(0, 0, 0, 'CONFIRMED_IN_LOS', [
            { itemCategory: 'unidentified_firearm', battleType: BT_FIREARM, itemType: 'STR_ALIEN_GUN' },
          ]),
        ]),
      })),
      /must not include itemType for unidentified/,
    );
  });

  it('accepts unresearched alien equipment category only', () => {
    parseAndValidate(baseV4({
      groundItems: groundItemsBlock([
        obs(0, 0, 0, 'CONFIRMED_IN_LOS', [
          { itemCategory: 'unidentified_firearm', battleType: BT_FIREARM },
        ]),
      ]),
    }));
  });

  it('accepts multi-level z coordinate within map.depth', () => {
    parseAndValidate(baseV4({
      map: { width: 2, height: 2, depth: 3 },
      groundItems: groundItemsBlock([
        obs(1, 1, 2, 'CONFIRMED_IN_LOS', [item({ itemCategory: 'firearm', itemType: 'STR_PISTOL' })]),
      ]),
    }));
  });

  it('rejects per-tile item overflow', () => {
    const items = [];
    for (let i = 0; i < MAX_GROUND_ITEMS_PER_TILE + 1; i += 1) {
      items.push({ itemCategory: 'additional_ground_item', battleType: BT_AMMO });
    }
    assert.throws(
      () => parseAndValidate(baseV4({ groundItems: groundItemsBlock([obs(0, 0, 0, 'CONFIRMED_IN_LOS', items)]) })),
      /per-tile limit/,
    );
  });

  it('rejects observation count overflow', () => {
    const observations = [];
    for (let i = 0; i < MAX_GROUND_ITEM_OBSERVATIONS + 1; i += 1) {
      observations.push(obs(i % 4, 0, 0, 'CONFIRMED_IN_LOS', [
        { itemCategory: 'ammunition', battleType: BT_AMMO, itemType: 'STR_RIFLE_CLIP', quantity: 1 },
      ]));
    }
    assert.throws(
      () => parseAndValidate(baseV4({ groundItems: groundItemsBlock(observations) })),
      /export cap/,
    );
  });

  it('preserves optional groundItems on v4 without terrain', () => {
    const tactical = baseV4({ groundItems: groundItemsBlock([]) });
    const id = computeSnapshotId(parseAndValidate(tactical));
    assert.match(id, /^[0-9a-f]{64}$/);
  });

  it('round-trips through YAML text loader', () => {
    const tactical = baseV4({
      groundItems: groundItemsBlock([
        obs(0, 0, 0, 'CONFIRMED_IN_LOS', [
          { itemCategory: 'firearm', battleType: BT_FIREARM, itemType: 'STR_RIFLE' },
        ]),
      ]),
    });
    loadAndValidateSnapshotFromText(YAML.stringify(tactical), YAML);
  });

  it('rejects groundItems before schemaVersion 4', () => {
    assert.throws(
      () => parseAndValidate({
        schemaVersion: 3,
        turn: 1,
        side: 0,
        selectedUnitId: -1,
        map: { width: 1, height: 1, depth: 1 },
        units: [],
        groundItems: groundItemsBlock([]),
      }),
      /groundItems must not appear before schemaVersion 4/,
    );
  });
});
