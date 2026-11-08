'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const YAML = require('yaml');
const {
  loadAndValidateSnapshotFromText,
  FACTION_PLAYER,
  BT_FIREARM,
  BT_AMMO,
} = require('../lib/tactical-publish.cjs');
const {
  parseReloadCommand,
  validateReloadAgainstSnapshot,
  validateTacticalCommandAgainstSnapshot,
  COMMAND_TYPE_RELOAD,
} = require('../lib/tactical-command.cjs');
const { buildCommandBinding, parseCommandBinding, composeReloadCommand: composeReloadFromBinding } = require('../lib/command-binding.cjs');

const SESSION = 'a1b2c3d4e5f6789012345678abcdef01';
const SHA = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

function baseUnit(overrides = {}) {
  return {
    id: 1,
    faction: FACTION_PLAYER,
    originalFaction: FACTION_PLAYER,
    position: [1, 1, 0],
    name: 'WP8B1',
    health: 40,
    timeUnits: 50,
    kneeled: false,
    activeHand: 'STR_RIGHT_HAND',
    hands: {
      right: {
        battleItemId: 100,
        itemType: 'STR_RIFLE',
        battleType: BT_FIREARM,
        inventorySlotType: 'hand',
        slot: 'STR_RIGHT_HAND',
        hand: 'right',
        noMagazineInserted: true,
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
      memoryNote: 'wp8b1-test',
      droppedCount: 0,
      observations: [],
    },
  };
}

describe('M1-WP8B1 RELOAD tactical command', () => {
  it('parses reload command', () => {
    const cmd = {
      schema_version: 1,
      command_id: 'r1',
      command_type: COMMAND_TYPE_RELOAD,
      actor_unit_id: 1,
      weapon_battle_item_id: 100,
      ammo_battle_item_id: 102,
      snapshot_sha256: SHA,
      session_id: SESSION,
      turn: 1,
      state_version: 0,
    };
    const p = parseReloadCommand(cmd);
    assert.equal(p.commandType, COMMAND_TYPE_RELOAD);
    assert.equal(p.weaponBattleItemId, 100);
    assert.equal(p.ammoBattleItemId, 102);
  });

  it('rejects same weapon and ammo id', () => {
    assert.throws(() => parseReloadCommand({
      schema_version: 1,
      command_id: 'r1',
      command_type: COMMAND_TYPE_RELOAD,
      actor_unit_id: 1,
      weapon_battle_item_id: 5,
      ammo_battle_item_id: 5,
      snapshot_sha256: SHA,
      session_id: SESSION,
      turn: 1,
      state_version: 0,
    }));
  });

  it('validates reload against snapshot when chamber empty and ids match hands + inventory', () => {
    const yaml = YAML;
    const tactical = loadAndValidateSnapshotFromText(YAML.stringify(snapshotDoc(baseUnit())), yaml);
    const binding = parseCommandBinding(buildCommandBinding(tactical, SHA));
    const cmd = composeReloadFromBinding(binding, {
      commandId: 'reload-1',
      actorUnitId: 1,
      weaponBattleItemId: 100,
      ammoBattleItemId: 102,
    });
    validateReloadAgainstSnapshot(cmd, tactical, SHA);
  });

  it('validates reload when actor is kneeling (stance-agnostic preflight)', () => {
    const yaml = YAML;
    const tactical = loadAndValidateSnapshotFromText(YAML.stringify(snapshotDoc(baseUnit({ kneeled: true }))), yaml);
    const binding = parseCommandBinding(buildCommandBinding(tactical, SHA));
    const cmd = composeReloadFromBinding(binding, {
      commandId: 'reload-kneel',
      actorUnitId: 1,
      weaponBattleItemId: 100,
      ammoBattleItemId: 102,
    });
    validateReloadAgainstSnapshot(cmd, tactical, SHA);
  });

  it('validateTacticalCommandAgainstSnapshot dispatches RELOAD', () => {
    const yaml = YAML;
    const tactical = loadAndValidateSnapshotFromText(YAML.stringify(snapshotDoc(baseUnit())), yaml);
    const cmd = {
      schema_version: 1,
      command_id: 'reload-dispatch-1',
      command_type: COMMAND_TYPE_RELOAD,
      actor_unit_id: 1,
      weapon_battle_item_id: 100,
      ammo_battle_item_id: 102,
      snapshot_sha256: SHA,
      session_id: SESSION,
      turn: 1,
      state_version: 0,
    };
    validateTacticalCommandAgainstSnapshot(cmd, tactical, SHA);
  });

  it('rejects reload when magazine still present (no noMagazineInserted)', () => {
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
          nestedAmmo: { battleItemId: 101, ammoType: 'STR_RIFLE_CLIP', rounds: 20 },
          loaded: { ammoType: 'STR_RIFLE_CLIP', rounds: 20, battleItemId: 101 },
        },
        left: null,
      },
    });
    const tactical = loadAndValidateSnapshotFromText(YAML.stringify(snapshotDoc(unit)), yaml);
    const binding = parseCommandBinding(buildCommandBinding(tactical, SHA));
    const cmd = composeReloadFromBinding(binding, {
      commandId: 'reload-2',
      actorUnitId: 1,
      weaponBattleItemId: 100,
      ammoBattleItemId: 102,
    });
    assert.throws(() => validateReloadAgainstSnapshot(cmd, tactical, SHA));
  });
});
