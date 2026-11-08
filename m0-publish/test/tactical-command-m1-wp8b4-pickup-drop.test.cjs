'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const YAML = require('yaml');
const {
  loadAndValidateSnapshotFromText,
  FACTION_PLAYER,
  BT_AMMO,
  BT_FIREARM,
} = require('../lib/tactical-publish.cjs');
const {
  parsePickupCommand,
  parseDropCommand,
  validatePickupAgainstSnapshot,
  validateDropAgainstSnapshot,
  validateTacticalCommandAgainstSnapshot,
  COMMAND_TYPE_PICKUP,
  COMMAND_TYPE_DROP,
} = require('../lib/tactical-command.cjs');
const {
  buildCommandBinding,
  parseCommandBinding,
  composePickupCommand,
  composeDropCommand,
} = require('../lib/command-binding.cjs');

const SESSION = 'a1b2c3d4e5f6789012345678abcdef01';
const SHA = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

function baseUnit(overrides = {}) {
  return {
    id: 1,
    faction: FACTION_PLAYER,
    originalFaction: FACTION_PLAYER,
    position: [1, 1, 0],
    name: 'WP8B4',
    health: 40,
    timeUnits: 50,
    kneeled: false,
    activeHand: 'STR_RIGHT_HAND',
    hands: {
      right: null,
      left: null,
    },
    inventory: [],
    groundInventory: [
      {
        slot: 'STR_GROUND',
        inventorySlotType: 'ground',
        battleItemId: 900,
        itemType: 'STR_RIFLE_CLIP',
        battleType: BT_AMMO,
        inventoryX: 0,
        inventoryY: 1,
      },
    ],
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
      sessionId: SESSION,
      oldestSeq: 0,
      latestSeq: 0,
      droppedCount: 0,
      events: [],
    },
    groundItems: {
      schemaVersion: 1,
      sessionId: SESSION,
      memoryNote: 'wp8b4-test',
      droppedCount: 0,
      observations: [],
    },
  };
}

describe('M1-WP8B4 PICKUP / DROP tactical command', () => {
  it('parses PICKUP', () => {
    const cmd = {
      schema_version: 1,
      command_id: 'pickup-1',
      command_type: COMMAND_TYPE_PICKUP,
      actor_unit_id: 1,
      item_battle_item_id: 900,
      ground_position: { x: 1, y: 1, z: 0 },
      destination_slot: 'STR_RIGHT_HAND',
      destination_x: 0,
      destination_y: 0,
      snapshot_sha256: SHA,
      session_id: SESSION,
      turn: 1,
      state_version: 0,
    };
    const p = parsePickupCommand(cmd);
    assert.equal(p.commandType, COMMAND_TYPE_PICKUP);
    assert.equal(p.itemBattleItemId, 900);
    assert.deepEqual(p.groundPosition, { x: 1, y: 1, z: 0 });
  });

  it('parses DROP with optional source coords', () => {
    const cmd = {
      schema_version: 1,
      command_id: 'drop-1',
      command_type: COMMAND_TYPE_DROP,
      actor_unit_id: 1,
      item_battle_item_id: 300,
      source_slot: 'STR_BELT',
      source_x: 0,
      source_y: 0,
      snapshot_sha256: SHA,
      session_id: SESSION,
      turn: 1,
      state_version: 0,
    };
    const p = parseDropCommand(cmd);
    assert.equal(p.commandType, COMMAND_TYPE_DROP);
    assert.equal(p.sourceCoordsGuard, true);
  });

  it('composePickupCommand matches actor tile and validates', () => {
    const yaml = YAML;
    const tactical = loadAndValidateSnapshotFromText(YAML.stringify(snapshotDoc(baseUnit())), yaml);
    const binding = parseCommandBinding(buildCommandBinding(tactical, SHA));
    const cmd = composePickupCommand(binding, {
      commandId: 'pickup-compose',
      actorUnitId: 1,
      itemBattleItemId: 900,
      groundPosition: { x: 1, y: 1, z: 0 },
      destinationSlot: 'STR_RIGHT_HAND',
      destinationX: 0,
      destinationY: 0,
    });
    validatePickupAgainstSnapshot(cmd, tactical, SHA);
  });

  it('PICKUP rejects ground_position not on actor tile', () => {
    const yaml = YAML;
    const tactical = loadAndValidateSnapshotFromText(YAML.stringify(snapshotDoc(baseUnit())), yaml);
    const binding = parseCommandBinding(buildCommandBinding(tactical, SHA));
    const good = composePickupCommand(binding, {
      commandId: 'pickup-bad-pos',
      actorUnitId: 1,
      itemBattleItemId: 900,
      groundPosition: { x: 1, y: 1, z: 0 },
      destinationSlot: 'STR_RIGHT_HAND',
      destinationX: 0,
      destinationY: 0,
    });
    const cmd = { ...good, ground_position: { x: 2, y: 1, z: 0 } };
    assert.throws(() => validatePickupAgainstSnapshot(cmd, tactical, SHA), /ground_position/);
  });

  it('PICKUP rejects missing groundInventory item id', () => {
    const yaml = YAML;
    const tactical = loadAndValidateSnapshotFromText(YAML.stringify(snapshotDoc(baseUnit())), yaml);
    const binding = parseCommandBinding(buildCommandBinding(tactical, SHA));
    const cmd = composePickupCommand(binding, {
      commandId: 'pickup-bad-item',
      actorUnitId: 1,
      itemBattleItemId: 999,
      groundPosition: { x: 1, y: 1, z: 0 },
      destinationSlot: 'STR_RIGHT_HAND',
      destinationX: 0,
      destinationY: 0,
    });
    assert.throws(() => validatePickupAgainstSnapshot(cmd, tactical, SHA), /exactly once/);
  });

  it('PICKUP rejects nested magazine id', () => {
    const yaml = YAML;
    const unit = baseUnit({
      groundInventory: [
        {
          slot: 'STR_GROUND',
          inventorySlotType: 'ground',
          battleItemId: 301,
          itemType: 'STR_RIFLE_CLIP',
          battleType: BT_AMMO,
          inventoryX: 0,
          inventoryY: 0,
        },
      ],
      hands: {
        right: {
          battleItemId: 100,
          itemType: 'STR_RIFLE',
          battleType: BT_FIREARM,
          inventorySlotType: 'hand',
          slot: 'STR_RIGHT_HAND',
          hand: 'right',
          nestedAmmo: { battleItemId: 301, ammoType: 'STR_RIFLE_CLIP', rounds: 18 },
        },
        left: null,
      },
    });
    const tactical = loadAndValidateSnapshotFromText(YAML.stringify(snapshotDoc(unit)), yaml);
    const binding = parseCommandBinding(buildCommandBinding(tactical, SHA));
    const cmd = composePickupCommand(binding, {
      commandId: 'pickup-nested',
      actorUnitId: 1,
      itemBattleItemId: 301,
      groundPosition: { x: 1, y: 1, z: 0 },
      destinationSlot: 'STR_BELT',
      destinationX: 0,
      destinationY: 0,
    });
    assert.throws(() => validatePickupAgainstSnapshot(cmd, tactical, SHA), /nested ammunition/);
  });

  it('composeDropCommand validates carried item', () => {
    const yaml = YAML;
    const unit = baseUnit({
      groundInventory: [],
      inventory: [
        {
          battleItemId: 400,
          slot: 'STR_BELT',
          inventorySlotType: 'slot',
          inventoryX: 0,
          inventoryY: 0,
          itemType: 'STR_RIFLE_CLIP',
          battleType: BT_AMMO,
        },
      ],
    });
    const tactical = loadAndValidateSnapshotFromText(YAML.stringify(snapshotDoc(unit)), yaml);
    const binding = parseCommandBinding(buildCommandBinding(tactical, SHA));
    const cmd = composeDropCommand(binding, {
      commandId: 'drop-compose',
      actorUnitId: 1,
      itemBattleItemId: 400,
      sourceSlot: 'STR_BELT',
      sourceX: 0,
      sourceY: 0,
    });
    validateDropAgainstSnapshot(cmd, tactical, SHA);
  });

  it('DROP rejects nested magazine', () => {
    const yaml = YAML;
    const unit = baseUnit({
      groundInventory: [],
      hands: {
        right: {
          battleItemId: 100,
          itemType: 'STR_RIFLE',
          battleType: BT_FIREARM,
          inventorySlotType: 'hand',
          slot: 'STR_RIGHT_HAND',
          hand: 'right',
          nestedAmmo: { battleItemId: 301, ammoType: 'STR_RIFLE_CLIP', rounds: 18 },
        },
        left: null,
      },
      inventory: [],
    });
    const tactical = loadAndValidateSnapshotFromText(YAML.stringify(snapshotDoc(unit)), yaml);
    const binding = parseCommandBinding(buildCommandBinding(tactical, SHA));
    const cmd = composeDropCommand(binding, {
      commandId: 'drop-nested',
      actorUnitId: 1,
      itemBattleItemId: 301,
      sourceSlot: 'STR_RIGHT_HAND',
    });
    assert.throws(() => validateDropAgainstSnapshot(cmd, tactical, SHA), /nested ammunition/);
  });

  it('validateTacticalCommandAgainstSnapshot dispatches PICKUP and DROP', () => {
    const yaml = YAML;
    const tactical = loadAndValidateSnapshotFromText(YAML.stringify(snapshotDoc(baseUnit())), yaml);
    const binding = parseCommandBinding(buildCommandBinding(tactical, SHA));
    const pickup = composePickupCommand(binding, {
      commandId: 'dispatch-pickup',
      actorUnitId: 1,
      itemBattleItemId: 900,
      groundPosition: { x: 1, y: 1, z: 0 },
      destinationSlot: 'STR_RIGHT_HAND',
      destinationX: 0,
      destinationY: 0,
    });
    validateTacticalCommandAgainstSnapshot(pickup, tactical, SHA);
    const dropTactical = loadAndValidateSnapshotFromText(YAML.stringify(snapshotDoc(baseUnit({
      groundInventory: [],
      inventory: [{
        battleItemId: 400,
        slot: 'STR_BELT',
        inventorySlotType: 'slot',
        inventoryX: 0,
        inventoryY: 0,
        itemType: 'STR_RIFLE_CLIP',
        battleType: BT_AMMO,
      }],
    }))), yaml);
    const dropBinding = parseCommandBinding(buildCommandBinding(dropTactical, SHA));
    const drop = composeDropCommand(dropBinding, {
      commandId: 'dispatch-drop',
      actorUnitId: 1,
      itemBattleItemId: 400,
      sourceSlot: 'STR_BELT',
    });
    validateTacticalCommandAgainstSnapshot(drop, dropTactical, SHA);
  });
});
