'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const YAML = require('yaml');
const {
  loadAndValidateSnapshotFromText,
  buildRelayPayload,
  ValidationError,
  FACTION_PLAYER,
  BT_FIREARM,
  BT_AMMO,
  BT_GRENADE,
  BT_PROXIMITYGRENADE,
  BT_MEDIKIT,
} = require('../lib/tactical-publish.cjs');

function baseUnit(overrides = {}) {
  return {
    id: 1,
    faction: FACTION_PLAYER,
    originalFaction: FACTION_PLAYER,
    position: [1, 1, 0],
    name: 'WP8A',
    health: 40,
    timeUnits: 50,
    kneeled: false,
    activeHand: 'STR_RIGHT_HAND',
    carriedWeight: 10,
    strength: 40,
    encumbranceRatio: 4,
    ...overrides,
  };
}

function snapshotDoc(unit) {
  return {
    schemaVersion: 4,
    turn: 1,
    side: 0,
    selectedUnitId: 1,
    map: { width: 10, height: 10, depth: 1 },
    units: [unit],
    eventLog: {
      sessionId: 'a1b2c3d4e5f6789012345678abcdef01',
      oldestSeq: 0,
      latestSeq: 0,
      droppedCount: 0,
      events: [],
    },
    groundItems: {
      schemaVersion: 1,
      sessionId: 'a1b2c3d4e5f6789012345678abcdef01',
      memoryNote: 'wp8a-test',
      droppedCount: 0,
      observations: [],
    },
  };
}

describe('WP8A inventory observation (tactical-publish)', () => {
  it('accepts full equipment placement and nested ammo', () => {
    const doc = snapshotDoc(baseUnit({
      hands: {
        right: {
          battleItemId: 100,
          itemType: 'STR_RIFLE',
          battleType: BT_FIREARM,
          inventorySlotType: 'hand',
          slot: 'STR_RIGHT_HAND',
          hand: 'right',
          nestedAmmo: { battleItemId: 101, ammoType: 'STR_RIFLE_CLIP', rounds: 20 },
          loaded: { ammoType: 'STR_RIFLE_CLIP', rounds: 20, battleItemId: 101 },
        },
        left: null,
      },
      inventory: [
        {
          battleItemId: 102,
          slot: 'STR_BELT',
          inventorySlotType: 'slot',
          inventoryX: 1,
          inventoryY: 0,
          itemType: 'STR_RIFLE_CLIP',
          battleType: BT_AMMO,
        },
      ],
    }));
    const text = YAML.stringify(doc);
    loadAndValidateSnapshotFromText(text, YAML);
  });

  it('accepts dry magazine with empty and loaded rounds 0', () => {
    const doc = snapshotDoc(baseUnit({
      hands: {
        right: {
          battleItemId: 200,
          itemType: 'STR_RIFLE',
          battleType: BT_FIREARM,
          inventorySlotType: 'hand',
          slot: 'STR_RIGHT_HAND',
          hand: 'right',
          empty: true,
          nestedAmmo: { battleItemId: 201, ammoType: 'STR_RIFLE_CLIP', rounds: 0 },
          loaded: { ammoType: 'STR_RIFLE_CLIP', rounds: 0, battleItemId: 201 },
        },
        left: null,
      },
      inventory: [],
    }));
    loadAndValidateSnapshotFromText(YAML.stringify(doc), YAML);
  });

  it('rejects empty true without loaded when dry', () => {
    const doc = snapshotDoc(baseUnit({
      hands: {
        right: {
          battleItemId: 300,
          itemType: 'STR_RIFLE',
          battleType: BT_FIREARM,
          inventorySlotType: 'hand',
          slot: 'STR_RIGHT_HAND',
          hand: 'right',
          empty: true,
        },
        left: null,
      },
      inventory: [],
    }));
    assert.throws(
      () => loadAndValidateSnapshotFromText(YAML.stringify(doc), YAML),
      (e) => e instanceof ValidationError,
    );
  });

  it('accepts grenade states in backpack', () => {
    const doc = snapshotDoc(baseUnit({
      hands: { right: null, left: null },
      inventory: [
        {
          battleItemId: 400,
          slot: 'STR_BACK_PACK',
          inventorySlotType: 'slot',
          inventoryX: 0,
          inventoryY: 1,
          itemType: 'STR_GRENADE',
          battleType: BT_GRENADE,
          explosiveKind: 'timed',
          primed: true,
          fuseTimer: 0,
        },
        {
          battleItemId: 401,
          slot: 'STR_BELT',
          inventorySlotType: 'slot',
          inventoryX: 0,
          inventoryY: 0,
          itemType: 'STR_PROXIMITY_GRENADE',
          battleType: BT_PROXIMITYGRENADE,
          explosiveKind: 'proximity',
          primed: false,
        },
      ],
    }));
    loadAndValidateSnapshotFromText(YAML.stringify(doc), YAML);
  });

  it('accepts groundInventory researchUsable on actionable tile rows', () => {
    const doc = snapshotDoc(baseUnit({
      hands: { right: null, left: null },
      inventory: [],
      groundInventory: [
        {
          battleItemId: 501,
          slot: 'STR_GROUND',
          inventorySlotType: 'ground',
          inventoryX: 0,
          inventoryY: 0,
          itemType: 'STR_PLASMA_RIFLE',
          battleType: BT_FIREARM,
          researchUsable: false,
        },
      ],
    }));
    loadAndValidateSnapshotFromText(YAML.stringify(doc), YAML);
  });

  it('accepts groundItems researchUsable on identified primary rows', () => {
    const doc = snapshotDoc(baseUnit({ hands: { right: null, left: null }, inventory: [] }));
    doc.groundItems.observations = [
      {
        position: { x: 1, y: 1, z: 0 },
        observationStatus: 'CONFIRMED_IN_LOS',
        items: [
          {
            itemCategory: 'firearm',
            battleType: BT_FIREARM,
            itemType: 'STR_RIFLE',
            researchUsable: true,
          },
        ],
      },
    ];
    loadAndValidateSnapshotFromText(YAML.stringify(doc), YAML);
  });

  it('rejects researchUsable on concealed additional_ground_item rows', () => {
    const doc = snapshotDoc(baseUnit({ hands: { right: null, left: null }, inventory: [] }));
    doc.groundItems.observations = [
      {
        position: { x: 1, y: 1, z: 0 },
        observationStatus: 'CONFIRMED_IN_LOS',
        items: [
          {
            itemCategory: 'additional_ground_item',
            battleType: BT_AMMO,
            concealedOnTile: true,
            researchUsable: true,
          },
        ],
      },
    ];
    assert.throws(
      () => loadAndValidateSnapshotFromText(YAML.stringify(doc), YAML),
      ValidationError,
    );
  });

  it('accepts carried researchUsable on hands inventory and nested ammo', () => {
    const doc = snapshotDoc(baseUnit({
      hands: {
        right: {
          battleItemId: 600,
          itemType: 'STR_RIFLE',
          battleType: BT_FIREARM,
          inventorySlotType: 'hand',
          slot: 'STR_RIGHT_HAND',
          hand: 'right',
          researchUsable: true,
          nestedAmmo: {
            battleItemId: 601,
            ammoType: 'STR_RIFLE_CLIP',
            rounds: 12,
            researchUsable: false,
          },
          loaded: {
            ammoType: 'STR_RIFLE_CLIP',
            rounds: 12,
            battleItemId: 601,
            researchUsable: false,
          },
        },
        left: null,
      },
      inventory: [
        {
          battleItemId: 602,
          slot: 'STR_BELT',
          inventorySlotType: 'slot',
          inventoryX: 0,
          inventoryY: 0,
          itemType: 'STR_RIFLE_CLIP',
          battleType: BT_AMMO,
          researchUsable: true,
        },
      ],
    }));
    const tactical = loadAndValidateSnapshotFromText(YAML.stringify(doc), YAML);
    const relay = buildRelayPayload(tactical, '2026-11-09T12:00:00.000Z');
    const unit = relay.tactical.units[0];
    assert.equal(unit.hands.right.researchUsable, true);
    assert.equal(unit.hands.right.nestedAmmo.researchUsable, false);
    assert.equal(unit.hands.right.loaded.researchUsable, false);
    assert.equal(unit.inventory[0].researchUsable, true);
  });

  it('accepts medikit charges', () => {
    const doc = snapshotDoc(baseUnit({
      hands: { right: null, left: null },
      inventory: [
        {
          battleItemId: 500,
          slot: 'STR_BELT',
          inventorySlotType: 'slot',
          inventoryX: 2,
          inventoryY: 0,
          itemType: 'STR_MEDI_KIT',
          battleType: BT_MEDIKIT,
          medikitCharges: { heal: 2, painKiller: 1, stimulant: 0 },
        },
      ],
    }));
    loadAndValidateSnapshotFromText(YAML.stringify(doc), YAML);
  });
});
