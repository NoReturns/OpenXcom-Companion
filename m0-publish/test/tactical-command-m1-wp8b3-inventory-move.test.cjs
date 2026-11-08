'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const YAML = require('yaml');
const {
  loadAndValidateSnapshotFromText,
  FACTION_PLAYER,
  BT_AMMO,
  BT_GRENADE,
  BT_FIREARM,
} = require('../lib/tactical-publish.cjs');
const {
  parseInventoryMoveCommand,
  validateInventoryMoveAgainstSnapshot,
  validateTacticalCommandAgainstSnapshot,
  COMMAND_TYPE_INVENTORY_MOVE,
} = require('../lib/tactical-command.cjs');
const {
  buildCommandBinding,
  parseCommandBinding,
  composeInventoryMoveCommand: composeFromBinding,
} = require('../lib/command-binding.cjs');

const SESSION = 'a1b2c3d4e5f6789012345678abcdef01';
const SHA = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

function baseUnit(overrides = {}) {
  return {
    id: 1,
    faction: FACTION_PLAYER,
    originalFaction: FACTION_PLAYER,
    position: [1, 1, 0],
    name: 'WP8B3',
    health: 40,
    timeUnits: 50,
    kneeled: false,
    activeHand: 'STR_RIGHT_HAND',
    hands: {
      right: null,
      left: null,
    },
    inventory: [
      {
        battleItemId: 300,
        slot: 'STR_BELT',
        inventorySlotType: 'slot',
        inventoryX: 0,
        inventoryY: 0,
        itemType: 'STR_RIFLE_CLIP',
        battleType: BT_AMMO,
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
      memoryNote: 'wp8b3-test',
      droppedCount: 0,
      observations: [],
    },
  };
}

describe('M1-WP8B3 INVENTORY_MOVE tactical command', () => {
  it('parses inventory move command with optional source coordinates', () => {
    const cmd = {
      schema_version: 1,
      command_id: 'inv-1',
      command_type: COMMAND_TYPE_INVENTORY_MOVE,
      actor_unit_id: 1,
      item_battle_item_id: 300,
      source_slot: 'STR_BELT',
      destination_slot: 'STR_RIGHT_HAND',
      destination_x: 0,
      destination_y: 0,
      source_x: 0,
      source_y: 0,
      snapshot_sha256: SHA,
      session_id: SESSION,
      turn: 1,
      state_version: 0,
    };
    const p = parseInventoryMoveCommand(cmd);
    assert.equal(p.commandType, COMMAND_TYPE_INVENTORY_MOVE);
    assert.equal(p.itemBattleItemId, 300);
    assert.equal(p.sourceCoordsGuard, true);
    assert.equal(p.sourceX, 0);
  });

  it('parses without source_x/source_y', () => {
    const cmd = {
      schema_version: 1,
      command_id: 'inv-2',
      command_type: COMMAND_TYPE_INVENTORY_MOVE,
      actor_unit_id: 1,
      item_battle_item_id: 300,
      source_slot: 'STR_BELT',
      destination_slot: 'STR_RIGHT_HAND',
      destination_x: 0,
      destination_y: 0,
      snapshot_sha256: SHA,
      session_id: SESSION,
      turn: 1,
      state_version: 0,
    };
    const p = parseInventoryMoveCommand(cmd);
    assert.equal(p.sourceCoordsGuard, false);
  });

  it('rejects STR_GROUND as source or destination', () => {
    const yaml = YAML;
    const tactical = loadAndValidateSnapshotFromText(YAML.stringify(snapshotDoc(baseUnit())), yaml);
    const binding = parseCommandBinding(buildCommandBinding(tactical, SHA));
    const toGround = composeFromBinding(binding, {
      commandId: 'inv-bad-ground',
      actorUnitId: 1,
      itemBattleItemId: 300,
      sourceSlot: 'STR_BELT',
      destinationSlot: 'STR_GROUND',
      destinationX: 0,
      destinationY: 0,
      sourceX: 0,
      sourceY: 0,
    });
    assert.throws(() => validateInventoryMoveAgainstSnapshot(toGround, tactical, SHA), /destination_slot/);
    const fromGround = composeFromBinding(binding, {
      commandId: 'inv-bad-src',
      actorUnitId: 1,
      itemBattleItemId: 300,
      sourceSlot: 'STR_GROUND',
      destinationSlot: 'STR_BELT',
      destinationX: 0,
      destinationY: 0,
    });
    assert.throws(() => validateInventoryMoveAgainstSnapshot(fromGround, tactical, SHA), /source_slot/);
  });

  it('validates belt clip move against snapshot via compose', () => {
    const yaml = YAML;
    const tactical = loadAndValidateSnapshotFromText(YAML.stringify(snapshotDoc(baseUnit())), yaml);
    const binding = parseCommandBinding(buildCommandBinding(tactical, SHA));
    const cmd = composeFromBinding(binding, {
      commandId: 'inv-compose-1',
      actorUnitId: 1,
      itemBattleItemId: 300,
      sourceSlot: 'STR_BELT',
      destinationSlot: 'STR_RIGHT_HAND',
      destinationX: 0,
      destinationY: 0,
      sourceX: 0,
      sourceY: 0,
    });
    validateInventoryMoveAgainstSnapshot(cmd, tactical, SHA);
  });

  it('rejects source_slot mismatch', () => {
    const yaml = YAML;
    const tactical = loadAndValidateSnapshotFromText(YAML.stringify(snapshotDoc(baseUnit())), yaml);
    const binding = parseCommandBinding(buildCommandBinding(tactical, SHA));
    const cmd = composeFromBinding(binding, {
      commandId: 'inv-bad-slot',
      actorUnitId: 1,
      itemBattleItemId: 300,
      sourceSlot: 'STR_BACK_PACK',
      destinationSlot: 'STR_RIGHT_HAND',
      destinationX: 0,
      destinationY: 0,
    });
    assert.throws(() => validateInventoryMoveAgainstSnapshot(cmd, tactical, SHA), /source_slot/);
  });

  it('rejects nested magazine id (matches weapon nestedAmmo)', () => {
    const yaml = YAML;
    const unit = baseUnit({
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
    const cmd = composeFromBinding(binding, {
      commandId: 'inv-nested',
      actorUnitId: 1,
      itemBattleItemId: 301,
      sourceSlot: 'STR_RIGHT_HAND',
      destinationSlot: 'STR_BELT',
      destinationX: 0,
      destinationY: 0,
    });
    assert.throws(() => validateInventoryMoveAgainstSnapshot(cmd, tactical, SHA), /nested ammunition/);
  });

  it('rejects primed grenade in inventory', () => {
    const yaml = YAML;
    const unit = baseUnit({
      inventory: [
        {
          battleItemId: 302,
          slot: 'STR_BELT',
          inventorySlotType: 'slot',
          inventoryX: 0,
          inventoryY: 0,
          itemType: 'STR_GRENADE',
          battleType: BT_GRENADE,
          explosiveKind: 'timed',
          primed: true,
          fuseTimer: 0,
        },
      ],
    });
    const tactical = loadAndValidateSnapshotFromText(YAML.stringify(snapshotDoc(unit)), yaml);
    const binding = parseCommandBinding(buildCommandBinding(tactical, SHA));
    const cmd = composeFromBinding(binding, {
      commandId: 'inv-primed',
      actorUnitId: 1,
      itemBattleItemId: 302,
      sourceSlot: 'STR_BELT',
      destinationSlot: 'STR_RIGHT_HAND',
      destinationX: 0,
      destinationY: 0,
      sourceX: 0,
      sourceY: 0,
    });
    assert.throws(() => validateInventoryMoveAgainstSnapshot(cmd, tactical, SHA), /primed explosive/);
  });

  it('validateTacticalCommandAgainstSnapshot dispatches INVENTORY_MOVE', () => {
    const yaml = YAML;
    const tactical = loadAndValidateSnapshotFromText(YAML.stringify(snapshotDoc(baseUnit())), yaml);
    const binding = parseCommandBinding(buildCommandBinding(tactical, SHA));
    const cmd = composeFromBinding(binding, {
      commandId: 'inv-dispatch',
      actorUnitId: 1,
      itemBattleItemId: 300,
      sourceSlot: 'STR_BELT',
      destinationSlot: 'STR_RIGHT_HAND',
      destinationX: 0,
      destinationY: 0,
    });
    validateTacticalCommandAgainstSnapshot(cmd, tactical, SHA);
  });

  it('rejects ambiguous duplicate battleItemId on actor', () => {
    const yaml = YAML;
    const unit = baseUnit({
      inventory: [
        {
          battleItemId: 303,
          slot: 'STR_BELT',
          inventorySlotType: 'slot',
          inventoryX: 0,
          inventoryY: 0,
          itemType: 'STR_RIFLE_CLIP',
          battleType: BT_AMMO,
        },
        {
          battleItemId: 303,
          slot: 'STR_BELT',
          inventorySlotType: 'slot',
          inventoryX: 1,
          inventoryY: 0,
          itemType: 'STR_RIFLE_CLIP',
          battleType: BT_AMMO,
        },
      ],
    });
    const tactical = loadAndValidateSnapshotFromText(YAML.stringify(snapshotDoc(unit)), yaml);
    const binding = parseCommandBinding(buildCommandBinding(tactical, SHA));
    const cmd = composeFromBinding(binding, {
      commandId: 'inv-dup',
      actorUnitId: 1,
      itemBattleItemId: 303,
      sourceSlot: 'STR_BELT',
      destinationSlot: 'STR_RIGHT_HAND',
      destinationX: 0,
      destinationY: 0,
    });
    assert.throws(() => validateInventoryMoveAgainstSnapshot(cmd, tactical, SHA), /exactly one carried item/);
  });

  it('rejects stale binding via state_version', () => {
    const yaml = YAML;
    const tactical = loadAndValidateSnapshotFromText(YAML.stringify(snapshotDoc(baseUnit())), yaml);
    const binding = parseCommandBinding(buildCommandBinding(tactical, SHA));
    const cmd = composeFromBinding(binding, {
      commandId: 'inv-stale',
      actorUnitId: 1,
      itemBattleItemId: 300,
      sourceSlot: 'STR_BELT',
      destinationSlot: 'STR_RIGHT_HAND',
      destinationX: 0,
      destinationY: 0,
    });
    assert.throws(
      () => validateInventoryMoveAgainstSnapshot({ ...cmd, state_version: 99 }, tactical, SHA),
      /state_version/,
    );
  });
});
