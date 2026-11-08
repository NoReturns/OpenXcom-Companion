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
  parseUnloadCommand,
  validateUnloadAgainstSnapshot,
  validateTacticalCommandAgainstSnapshot,
  COMMAND_TYPE_UNLOAD,
} = require('../lib/tactical-command.cjs');
const { buildCommandBinding, parseCommandBinding, composeUnloadCommand: composeUnloadFromBinding } = require('../lib/command-binding.cjs');

const SESSION = 'a1b2c3d4e5f6789012345678abcdef01';
const SHA = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

function baseWeaponHand(overrides = {}) {
  return {
    battleItemId: 100,
    itemType: 'STR_RIFLE',
    battleType: BT_FIREARM,
    inventorySlotType: 'hand',
    slot: 'STR_RIGHT_HAND',
    hand: 'right',
    nestedAmmo: { battleItemId: 101, ammoType: 'STR_RIFLE_CLIP', rounds: 18 },
    loaded: { ammoType: 'STR_RIFLE_CLIP', rounds: 18, battleItemId: 101 },
    ...overrides,
  };
}

function baseUnit(overrides = {}) {
  return {
    id: 1,
    faction: FACTION_PLAYER,
    originalFaction: FACTION_PLAYER,
    position: [1, 1, 0],
    name: 'WP8B2',
    health: 40,
    timeUnits: 50,
    kneeled: false,
    activeHand: 'STR_RIGHT_HAND',
    hands: {
      right: baseWeaponHand(),
      left: null,
    },
    inventory: [],
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
      memoryNote: 'wp8b2-test',
      droppedCount: 0,
      observations: [],
    },
  };
}

describe('M1-WP8B2 UNLOAD tactical command', () => {
  it('parses unload command', () => {
    const cmd = {
      schema_version: 1,
      command_id: 'u1',
      command_type: COMMAND_TYPE_UNLOAD,
      actor_unit_id: 1,
      weapon_battle_item_id: 100,
      loaded_ammo_battle_item_id: 101,
      snapshot_sha256: SHA,
      session_id: SESSION,
      turn: 1,
      state_version: 0,
    };
    const p = parseUnloadCommand(cmd);
    assert.equal(p.commandType, COMMAND_TYPE_UNLOAD);
    assert.equal(p.weaponBattleItemId, 100);
    assert.equal(p.loadedAmmoBattleItemId, 101);
  });

  it('rejects same weapon and magazine id', () => {
    assert.throws(() => parseUnloadCommand({
      schema_version: 1,
      command_id: 'u1',
      command_type: COMMAND_TYPE_UNLOAD,
      actor_unit_id: 1,
      weapon_battle_item_id: 5,
      loaded_ammo_battle_item_id: 5,
      snapshot_sha256: SHA,
      session_id: SESSION,
      turn: 1,
      state_version: 0,
    }));
  });

  it('validates unload against snapshot when nestedAmmo matches and other hand empty', () => {
    const yaml = YAML;
    const tactical = loadAndValidateSnapshotFromText(YAML.stringify(snapshotDoc(baseUnit())), yaml);
    const binding = parseCommandBinding(buildCommandBinding(tactical, SHA));
    const cmd = composeUnloadFromBinding(binding, {
      commandId: 'unload-1',
      actorUnitId: 1,
      weaponBattleItemId: 100,
      loadedAmmoBattleItemId: 101,
    });
    validateUnloadAgainstSnapshot(cmd, tactical, SHA);
  });

  it('validates unload when actor is kneeling (stance-agnostic)', () => {
    const yaml = YAML;
    const tactical = loadAndValidateSnapshotFromText(YAML.stringify(snapshotDoc(baseUnit({ kneeled: true }))), yaml);
    const binding = parseCommandBinding(buildCommandBinding(tactical, SHA));
    const cmd = composeUnloadFromBinding(binding, {
      commandId: 'unload-kneel',
      actorUnitId: 1,
      weaponBattleItemId: 100,
      loadedAmmoBattleItemId: 101,
    });
    validateUnloadAgainstSnapshot(cmd, tactical, SHA);
  });

  it('validateTacticalCommandAgainstSnapshot dispatches UNLOAD', () => {
    const yaml = YAML;
    const tactical = loadAndValidateSnapshotFromText(YAML.stringify(snapshotDoc(baseUnit())), yaml);
    const cmd = {
      schema_version: 1,
      command_id: 'unload-dispatch-1',
      command_type: COMMAND_TYPE_UNLOAD,
      actor_unit_id: 1,
      weapon_battle_item_id: 100,
      loaded_ammo_battle_item_id: 101,
      snapshot_sha256: SHA,
      session_id: SESSION,
      turn: 1,
      state_version: 0,
    };
    validateTacticalCommandAgainstSnapshot(cmd, tactical, SHA);
  });

  it('rejects when loaded_ammo id mismatches nestedAmmo', () => {
    const yaml = YAML;
    const tactical = loadAndValidateSnapshotFromText(YAML.stringify(snapshotDoc(baseUnit())), yaml);
    const binding = parseCommandBinding(buildCommandBinding(tactical, SHA));
    const cmd = composeUnloadFromBinding(binding, {
      commandId: 'unload-bad-mag',
      actorUnitId: 1,
      weaponBattleItemId: 100,
      loadedAmmoBattleItemId: 999,
    });
    assert.throws(() => validateUnloadAgainstSnapshot(cmd, tactical, SHA));
  });

  it('rejects when other hand occupied', () => {
    const yaml = YAML;
    const unit = baseUnit({
      hands: {
        right: baseWeaponHand(),
        left: {
          battleItemId: 200,
          itemType: 'STR_PISTOL',
          battleType: BT_FIREARM,
          inventorySlotType: 'hand',
          slot: 'STR_LEFT_HAND',
          hand: 'left',
          noMagazineInserted: true,
        },
      },
    });
    const tactical = loadAndValidateSnapshotFromText(YAML.stringify(snapshotDoc(unit)), yaml);
    const binding = parseCommandBinding(buildCommandBinding(tactical, SHA));
    const cmd = composeUnloadFromBinding(binding, {
      commandId: 'unload-busy-hand',
      actorUnitId: 1,
      weaponBattleItemId: 100,
      loadedAmmoBattleItemId: 101,
    });
    assert.throws(() => validateUnloadAgainstSnapshot(cmd, tactical, SHA));
  });

  it('rejects when chamber empty (no nestedAmmo)', () => {
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
          noMagazineInserted: true,
        },
        left: null,
      },
    });
    const tactical = loadAndValidateSnapshotFromText(YAML.stringify(snapshotDoc(unit)), yaml);
    const binding = parseCommandBinding(buildCommandBinding(tactical, SHA));
    const cmd = composeUnloadFromBinding(binding, {
      commandId: 'unload-empty',
      actorUnitId: 1,
      weaponBattleItemId: 100,
      loadedAmmoBattleItemId: 101,
    });
    assert.throws(() => validateUnloadAgainstSnapshot(cmd, tactical, SHA));
  });
});
