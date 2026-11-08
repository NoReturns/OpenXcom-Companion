'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const {
  ValidationError,
  computeSnapshotId,
  loadAndValidateSnapshotFromText,
  BT_GRENADE,
  BT_PROXIMITYGRENADE,
  BT_FIREARM,
  BT_AMMO,
} = require('./tactical-publish.cjs');
const { readSnapshotByteBuffer, sha256HexLower } = require('./briefing-snapshot.cjs');

const COMMAND_SCHEMA_VERSION = 1;
const RESULT_SCHEMA_VERSION = 1;
const COMMAND_TYPE_MOVE = 'MOVE';
const COMMAND_TYPE_KNEEL = 'KNEEL';
const COMMAND_TYPE_STAND = 'STAND';
const COMMAND_TYPE_SNAP_SHOT = 'SNAP_SHOT';
const COMMAND_TYPE_AUTO_SHOT = 'AUTO_SHOT';
const COMMAND_TYPE_AIMED_SHOT = 'AIMED_SHOT';
const COMMAND_TYPE_PRIME = 'PRIME';
const COMMAND_TYPE_THROW = 'THROW';
const COMMAND_TYPE_RELOAD = 'RELOAD';
const COMMAND_TYPE_UNLOAD = 'UNLOAD';
const COMMAND_TYPE_INVENTORY_MOVE = 'INVENTORY_MOVE';
const COMMAND_TYPE_PICKUP = 'PICKUP';
const COMMAND_TYPE_DROP = 'DROP';

const DIRECTED_FIRE_COMMAND_TYPES = new Set([
  COMMAND_TYPE_SNAP_SHOT,
  COMMAND_TYPE_AUTO_SHOT,
  COMMAND_TYPE_AIMED_SHOT,
]);

const GRENADE_COMMAND_TYPES = new Set([
  COMMAND_TYPE_PRIME,
  COMMAND_TYPE_THROW,
]);

const VALID_ACTIVE_HANDS = new Set(['STR_LEFT_HAND', 'STR_RIGHT_HAND']);

const TERMINAL_STATUSES = new Set(['REJECTED', 'COMPLETED', 'INTERRUPTED', 'FAILED']);
const NON_TERMINAL_STATUSES = new Set(['ACCEPTED', 'EXECUTING']);

const COMMAND_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SESSION_ID_PATTERN = /^[a-f0-9]{32}$/;
const SNAPSHOT_SHA_PATTERN = /^[a-f0-9]{64}$/;

const COMMAND_KEYS_COMMON = new Set([
  'schema_version',
  'command_id',
  'command_type',
  'actor_unit_id',
  'snapshot_sha256',
  'session_id',
  'turn',
  'state_version',
]);

const COMMAND_KEYS_MOVE = new Set([...COMMAND_KEYS_COMMON, 'destination']);
const COMMAND_KEYS_KNEEL = new Set([...COMMAND_KEYS_COMMON]);
const COMMAND_KEYS_STAND = new Set([...COMMAND_KEYS_COMMON]);
const COMMAND_KEYS_DIRECTED_FIRE = new Set([...COMMAND_KEYS_COMMON, 'target', 'active_hand']);
const COMMAND_KEYS_PRIME = new Set([...COMMAND_KEYS_COMMON, 'active_hand', 'fuse_timer']);
const COMMAND_KEYS_THROW = new Set([...COMMAND_KEYS_COMMON, 'target', 'active_hand']);
const COMMAND_KEYS_RELOAD = new Set([...COMMAND_KEYS_COMMON, 'weapon_battle_item_id', 'ammo_battle_item_id']);
const COMMAND_KEYS_UNLOAD = new Set([...COMMAND_KEYS_COMMON, 'weapon_battle_item_id', 'loaded_ammo_battle_item_id']);
const COMMAND_KEYS_INVENTORY_MOVE = new Set([
  ...COMMAND_KEYS_COMMON,
  'item_battle_item_id',
  'source_slot',
  'destination_slot',
  'destination_x',
  'destination_y',
  'source_x',
  'source_y',
]);

const COMMAND_KEYS_PICKUP = new Set([
  ...COMMAND_KEYS_COMMON,
  'item_battle_item_id',
  'ground_position',
  'destination_slot',
  'destination_x',
  'destination_y',
]);

const COMMAND_KEYS_DROP = new Set([
  ...COMMAND_KEYS_COMMON,
  'item_battle_item_id',
  'source_slot',
  'source_x',
  'source_y',
]);

const CARRIED_INVENTORY_SLOT_IDS = new Set([
  'STR_RIGHT_HAND',
  'STR_LEFT_HAND',
  'STR_BELT',
  'STR_BACK_PACK',
  'STR_RIGHT_SHOULDER',
  'STR_LEFT_SHOULDER',
  'STR_RIGHT_LEG',
  'STR_LEFT_LEG',
]);

const DESTINATION_KEYS = new Set(['x', 'y', 'z']);

const FIRE_ACTION_IDS = {
  [COMMAND_TYPE_SNAP_SHOT]: 'snap',
  [COMMAND_TYPE_AUTO_SHOT]: 'auto',
  [COMMAND_TYPE_AIMED_SHOT]: 'aimed',
};

const GRENADE_ACTION_IDS = {
  [COMMAND_TYPE_PRIME]: 'prime',
  [COMMAND_TYPE_THROW]: 'throw',
};

const RESULT_KEYS_BASE = new Set([
  'schema_version',
  'command_id',
  'command_type',
  'status',
  'session_id',
  'turn',
]);

function assert(condition, message) {
  if (!condition) throw new ValidationError(message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertAllowedCommandKeys(raw, allowedKeys) {
  for (const key of Object.keys(raw)) {
    assert(allowedKeys.has(key), `unknown command field: ${key}`);
  }
}

function parseBindingFields(raw) {
  assert(Number.isInteger(raw.actor_unit_id) && raw.actor_unit_id > 0, 'actor_unit_id must be positive integer');
  assert(typeof raw.snapshot_sha256 === 'string' && SNAPSHOT_SHA_PATTERN.test(raw.snapshot_sha256),
    'invalid snapshot_sha256');
  assert(typeof raw.session_id === 'string' && SESSION_ID_PATTERN.test(raw.session_id), 'invalid session_id');
  assert(Number.isInteger(raw.turn) && raw.turn >= 1, 'turn must be >= 1');
  assert(Number.isInteger(raw.state_version) && raw.state_version >= 0, 'state_version must be >= 0');
  return {
    schemaVersion: raw.schema_version,
    commandId: raw.command_id,
    commandType: raw.command_type,
    actorUnitId: raw.actor_unit_id,
    snapshotSha256: raw.snapshot_sha256,
    sessionId: raw.session_id,
    turn: raw.turn,
    stateVersion: raw.state_version,
  };
}

function parseMoveCommand(raw) {
  assert(isPlainObject(raw), 'command must be an object');
  assert(raw.schema_version === COMMAND_SCHEMA_VERSION, 'unsupported command schema_version');
  assert(typeof raw.command_id === 'string' && COMMAND_ID_PATTERN.test(raw.command_id), 'invalid command_id');
  assert(raw.command_type === COMMAND_TYPE_MOVE, 'unsupported command_type');
  assertAllowedCommandKeys(raw, COMMAND_KEYS_MOVE);
  if (raw.destination === undefined || raw.destination === null) {
    throw new ValidationError('destination required');
  }
  if (Array.isArray(raw.destination)) {
    throw new ValidationError('destination must be object with integer x, y, z (not a JSON array)');
  }
  assert(isPlainObject(raw.destination), 'destination must be object with x, y, z');
  for (const key of Object.keys(raw.destination)) {
    assert(DESTINATION_KEYS.has(key), `unknown destination field: ${key}`);
  }
  assert(Number.isInteger(raw.destination.x) && raw.destination.x >= 0 && raw.destination.x <= 255, 'destination.x');
  assert(Number.isInteger(raw.destination.y) && raw.destination.y >= 0 && raw.destination.y <= 255, 'destination.y');
  assert(Number.isInteger(raw.destination.z) && raw.destination.z >= 0 && raw.destination.z <= 255, 'destination.z');
  const binding = parseBindingFields(raw);
  return {
    ...binding,
    destination: { x: raw.destination.x, y: raw.destination.y, z: raw.destination.z },
  };
}

function parseKneelCommand(raw) {
  assert(isPlainObject(raw), 'command must be an object');
  assert(raw.schema_version === COMMAND_SCHEMA_VERSION, 'unsupported command schema_version');
  assert(typeof raw.command_id === 'string' && COMMAND_ID_PATTERN.test(raw.command_id), 'invalid command_id');
  assert(raw.command_type === COMMAND_TYPE_KNEEL, 'unsupported command_type');
  assertAllowedCommandKeys(raw, COMMAND_KEYS_KNEEL);
  return parseBindingFields(raw);
}

function parseStandCommand(raw) {
  assert(isPlainObject(raw), 'command must be an object');
  assert(raw.schema_version === COMMAND_SCHEMA_VERSION, 'unsupported command schema_version');
  assert(typeof raw.command_id === 'string' && COMMAND_ID_PATTERN.test(raw.command_id), 'invalid command_id');
  assert(raw.command_type === COMMAND_TYPE_STAND, 'unsupported command_type');
  assertAllowedCommandKeys(raw, COMMAND_KEYS_STAND);
  return parseBindingFields(raw);
}

function parseCoordinateObject(raw, fieldName) {
  if (raw === undefined || raw === null) {
    throw new ValidationError(`${fieldName} required`);
  }
  if (Array.isArray(raw)) {
    throw new ValidationError(`${fieldName} must be object with integer x, y, z (not a JSON array)`);
  }
  assert(isPlainObject(raw), `${fieldName} must be object with x, y, z`);
  for (const key of Object.keys(raw)) {
    assert(DESTINATION_KEYS.has(key), `unknown ${fieldName} field: ${key}`);
  }
  assert(Number.isInteger(raw.x) && raw.x >= 0 && raw.x <= 255, `${fieldName}.x`);
  assert(Number.isInteger(raw.y) && raw.y >= 0 && raw.y <= 255, `${fieldName}.y`);
  assert(Number.isInteger(raw.z) && raw.z >= 0 && raw.z <= 255, `${fieldName}.z`);
  return { x: raw.x, y: raw.y, z: raw.z };
}

function parseDirectedFireCommand(raw, commandType) {
  assert(isPlainObject(raw), 'command must be an object');
  assert(raw.schema_version === COMMAND_SCHEMA_VERSION, 'unsupported command schema_version');
  assert(typeof raw.command_id === 'string' && COMMAND_ID_PATTERN.test(raw.command_id), 'invalid command_id');
  assert(raw.command_type === commandType, 'unsupported command_type');
  assertAllowedCommandKeys(raw, COMMAND_KEYS_DIRECTED_FIRE);
  assert(typeof raw.active_hand === 'string' && VALID_ACTIVE_HANDS.has(raw.active_hand), 'invalid active_hand');
  const target = parseCoordinateObject(raw.target, 'target');
  const binding = parseBindingFields(raw);
  return {
    ...binding,
    activeHand: raw.active_hand,
    target,
  };
}

function parseSnapShotCommand(raw) {
  return parseDirectedFireCommand(raw, COMMAND_TYPE_SNAP_SHOT);
}

function parseAutoShotCommand(raw) {
  return parseDirectedFireCommand(raw, COMMAND_TYPE_AUTO_SHOT);
}

function parseAimedShotCommand(raw) {
  return parseDirectedFireCommand(raw, COMMAND_TYPE_AIMED_SHOT);
}

function parsePrimeCommand(raw) {
  assert(isPlainObject(raw), 'command must be an object');
  assert(raw.schema_version === COMMAND_SCHEMA_VERSION, 'unsupported command schema_version');
  assert(typeof raw.command_id === 'string' && COMMAND_ID_PATTERN.test(raw.command_id), 'invalid command_id');
  assert(raw.command_type === COMMAND_TYPE_PRIME, 'unsupported command_type');
  assertAllowedCommandKeys(raw, COMMAND_KEYS_PRIME);
  assert(typeof raw.active_hand === 'string' && VALID_ACTIVE_HANDS.has(raw.active_hand), 'invalid active_hand');
  assert(Number.isInteger(raw.fuse_timer) && raw.fuse_timer >= 0 && raw.fuse_timer <= 23, 'invalid fuse_timer');
  const binding = parseBindingFields(raw);
  return {
    ...binding,
    activeHand: raw.active_hand,
    fuseTimer: raw.fuse_timer,
  };
}

function parseThrowCommand(raw) {
  assert(isPlainObject(raw), 'command must be an object');
  assert(raw.schema_version === COMMAND_SCHEMA_VERSION, 'unsupported command schema_version');
  assert(typeof raw.command_id === 'string' && COMMAND_ID_PATTERN.test(raw.command_id), 'invalid command_id');
  assert(raw.command_type === COMMAND_TYPE_THROW, 'unsupported command_type');
  assertAllowedCommandKeys(raw, COMMAND_KEYS_THROW);
  assert(typeof raw.active_hand === 'string' && VALID_ACTIVE_HANDS.has(raw.active_hand), 'invalid active_hand');
  const target = parseCoordinateObject(raw.target, 'target');
  const binding = parseBindingFields(raw);
  return {
    ...binding,
    activeHand: raw.active_hand,
    target,
  };
}

function parseReloadCommand(raw) {
  assert(isPlainObject(raw), 'command must be an object');
  assert(raw.schema_version === COMMAND_SCHEMA_VERSION, 'unsupported command schema_version');
  assert(typeof raw.command_id === 'string' && COMMAND_ID_PATTERN.test(raw.command_id), 'invalid command_id');
  assert(raw.command_type === COMMAND_TYPE_RELOAD, 'unsupported command_type');
  assertAllowedCommandKeys(raw, COMMAND_KEYS_RELOAD);
  assert(Number.isInteger(raw.weapon_battle_item_id) && raw.weapon_battle_item_id > 0, 'weapon_battle_item_id must be positive');
  assert(Number.isInteger(raw.ammo_battle_item_id) && raw.ammo_battle_item_id > 0, 'ammo_battle_item_id must be positive');
  assert(raw.weapon_battle_item_id !== raw.ammo_battle_item_id, 'weapon and ammo battle item ids must differ');
  const binding = parseBindingFields(raw);
  return {
    ...binding,
    weaponBattleItemId: raw.weapon_battle_item_id,
    ammoBattleItemId: raw.ammo_battle_item_id,
  };
}

function parseUnloadCommand(raw) {
  assert(isPlainObject(raw), 'command must be an object');
  assert(raw.schema_version === COMMAND_SCHEMA_VERSION, 'unsupported command schema_version');
  assert(typeof raw.command_id === 'string' && COMMAND_ID_PATTERN.test(raw.command_id), 'invalid command_id');
  assert(raw.command_type === COMMAND_TYPE_UNLOAD, 'unsupported command_type');
  assertAllowedCommandKeys(raw, COMMAND_KEYS_UNLOAD);
  assert(Number.isInteger(raw.weapon_battle_item_id) && raw.weapon_battle_item_id > 0, 'weapon_battle_item_id must be positive');
  assert(Number.isInteger(raw.loaded_ammo_battle_item_id) && raw.loaded_ammo_battle_item_id > 0,
    'loaded_ammo_battle_item_id must be positive');
  assert(raw.weapon_battle_item_id !== raw.loaded_ammo_battle_item_id, 'weapon and loaded ammo battle item ids must differ');
  const binding = parseBindingFields(raw);
  return {
    ...binding,
    weaponBattleItemId: raw.weapon_battle_item_id,
    loadedAmmoBattleItemId: raw.loaded_ammo_battle_item_id,
  };
}

const MAX_INVENTORY_GRID_CELL = 255;

function parseInventoryMoveCommand(raw) {
  assert(isPlainObject(raw), 'command must be an object');
  assert(raw.schema_version === COMMAND_SCHEMA_VERSION, 'unsupported command schema_version');
  assert(typeof raw.command_id === 'string' && COMMAND_ID_PATTERN.test(raw.command_id), 'invalid command_id');
  assert(raw.command_type === COMMAND_TYPE_INVENTORY_MOVE, 'unsupported command_type');
  assertAllowedCommandKeys(raw, COMMAND_KEYS_INVENTORY_MOVE);
  assert(Number.isInteger(raw.item_battle_item_id) && raw.item_battle_item_id > 0, 'item_battle_item_id must be positive');
  assert(typeof raw.source_slot === 'string' && raw.source_slot.length > 0, 'source_slot required');
  assert(typeof raw.destination_slot === 'string' && raw.destination_slot.length > 0, 'destination_slot required');
  assert(Number.isInteger(raw.destination_x) && raw.destination_x >= 0 && raw.destination_x <= MAX_INVENTORY_GRID_CELL,
    'destination_x must be integer 0..255');
  assert(Number.isInteger(raw.destination_y) && raw.destination_y >= 0 && raw.destination_y <= MAX_INVENTORY_GRID_CELL,
    'destination_y must be integer 0..255');

  const hasSourceX = Object.prototype.hasOwnProperty.call(raw, 'source_x');
  const hasSourceY = Object.prototype.hasOwnProperty.call(raw, 'source_y');
  assert(hasSourceX === hasSourceY, 'source_x and source_y must both be present or both omitted');
  let sourceCoordsGuard = false;
  let sourceX = 0;
  let sourceY = 0;
  if (hasSourceX) {
    assert(Number.isInteger(raw.source_x) && raw.source_x >= 0 && raw.source_x <= MAX_INVENTORY_GRID_CELL,
      'source_x must be integer 0..255');
    assert(Number.isInteger(raw.source_y) && raw.source_y >= 0 && raw.source_y <= MAX_INVENTORY_GRID_CELL,
      'source_y must be integer 0..255');
    sourceCoordsGuard = true;
    sourceX = raw.source_x;
    sourceY = raw.source_y;
  }

  const binding = parseBindingFields(raw);
  return {
    ...binding,
    itemBattleItemId: raw.item_battle_item_id,
    sourceSlot: raw.source_slot,
    destinationSlot: raw.destination_slot,
    destinationX: raw.destination_x,
    destinationY: raw.destination_y,
    sourceCoordsGuard,
    sourceX,
    sourceY,
  };
}

function parsePickupCommand(raw) {
  assert(isPlainObject(raw), 'command must be an object');
  assert(raw.schema_version === COMMAND_SCHEMA_VERSION, 'unsupported command schema_version');
  assert(typeof raw.command_id === 'string' && COMMAND_ID_PATTERN.test(raw.command_id), 'invalid command_id');
  assert(raw.command_type === COMMAND_TYPE_PICKUP, 'unsupported command_type');
  assertAllowedCommandKeys(raw, COMMAND_KEYS_PICKUP);
  assert(Number.isInteger(raw.item_battle_item_id) && raw.item_battle_item_id > 0, 'item_battle_item_id must be positive');
  const groundPosition = parseCoordinateObject(raw.ground_position, 'ground_position');
  assert(typeof raw.destination_slot === 'string' && raw.destination_slot.length > 0, 'destination_slot required');
  assert(CARRIED_INVENTORY_SLOT_IDS.has(raw.destination_slot), 'destination_slot must be a supported carried section');
  assert(Number.isInteger(raw.destination_x) && raw.destination_x >= 0 && raw.destination_x <= MAX_INVENTORY_GRID_CELL,
    'destination_x must be integer 0..255');
  assert(Number.isInteger(raw.destination_y) && raw.destination_y >= 0 && raw.destination_y <= MAX_INVENTORY_GRID_CELL,
    'destination_y must be integer 0..255');
  const binding = parseBindingFields(raw);
  return {
    ...binding,
    itemBattleItemId: raw.item_battle_item_id,
    groundPosition,
    destinationSlot: raw.destination_slot,
    destinationX: raw.destination_x,
    destinationY: raw.destination_y,
  };
}

function parseDropCommand(raw) {
  assert(isPlainObject(raw), 'command must be an object');
  assert(raw.schema_version === COMMAND_SCHEMA_VERSION, 'unsupported command schema_version');
  assert(typeof raw.command_id === 'string' && COMMAND_ID_PATTERN.test(raw.command_id), 'invalid command_id');
  assert(raw.command_type === COMMAND_TYPE_DROP, 'unsupported command_type');
  assertAllowedCommandKeys(raw, COMMAND_KEYS_DROP);
  assert(Number.isInteger(raw.item_battle_item_id) && raw.item_battle_item_id > 0, 'item_battle_item_id must be positive');
  assert(typeof raw.source_slot === 'string' && raw.source_slot.length > 0, 'source_slot required');
  assert(CARRIED_INVENTORY_SLOT_IDS.has(raw.source_slot), 'source_slot must be a supported carried section');

  const hasSourceX = Object.prototype.hasOwnProperty.call(raw, 'source_x');
  const hasSourceY = Object.prototype.hasOwnProperty.call(raw, 'source_y');
  assert(hasSourceX === hasSourceY, 'source_x and source_y must both be present or both omitted');
  let sourceCoordsGuard = false;
  let sourceX = 0;
  let sourceY = 0;
  if (hasSourceX) {
    assert(Number.isInteger(raw.source_x) && raw.source_x >= 0 && raw.source_x <= MAX_INVENTORY_GRID_CELL,
      'source_x must be integer 0..255');
    assert(Number.isInteger(raw.source_y) && raw.source_y >= 0 && raw.source_y <= MAX_INVENTORY_GRID_CELL,
      'source_y must be integer 0..255');
    sourceCoordsGuard = true;
    sourceX = raw.source_x;
    sourceY = raw.source_y;
  }

  const binding = parseBindingFields(raw);
  return {
    ...binding,
    itemBattleItemId: raw.item_battle_item_id,
    sourceSlot: raw.source_slot,
    sourceCoordsGuard,
    sourceX,
    sourceY,
  };
}

function findInventoryRowByBattleItemId(actor, battleItemId) {
  if (!actor || !Array.isArray(actor.inventory)) {
    return null;
  }
  return actor.inventory.find((row) => row && row.battleItemId === battleItemId) || null;
}

function findGroundRowByBattleItemId(actor, battleItemId) {
  if (!actor || !Array.isArray(actor.groundInventory)) {
    return null;
  }
  return actor.groundInventory.find((row) => row && row.battleItemId === battleItemId) || null;
}

/** Snapshot units use position as [x, y, z] (see tactical-publish normalizePosition). */
function actorPositionTriple(actor) {
  assert(actor && Array.isArray(actor.position) && actor.position.length === 3,
    'actor position must be [x, y, z] array');
  return { x: actor.position[0], y: actor.position[1], z: actor.position[2] };
}

function handHeldWeaponBattleItemId(actor, handKey) {
  const h = actor.hands && actor.hands[handKey];
  return h && Number.isInteger(h.battleItemId) ? h.battleItemId : null;
}

function validateReloadAgainstSnapshot(command, tactical, snapshotSha256Lower) {
  parseReloadCommand(command);
  validateBindingAgainstSnapshot(command, tactical, snapshotSha256Lower);
  const actor = validateActorAgainstSnapshot(command, tactical);
  const wId = command.weapon_battle_item_id ?? command.weaponBattleItemId;
  const aId = command.ammo_battle_item_id ?? command.ammoBattleItemId;
  const rightId = handHeldWeaponBattleItemId(actor, 'right');
  const leftId = handHeldWeaponBattleItemId(actor, 'left');
  assert(rightId === wId || leftId === wId, 'weapon_battle_item_id must match firearm in STR_LEFT_HAND or STR_RIGHT_HAND');
  const weaponHand = rightId === wId ? actor.hands.right : actor.hands.left;
  assert(weaponHand && weaponHand.battleType === BT_FIREARM, 'weapon must be BT_FIREARM');
  assert(weaponHand.noMagazineInserted === true, 'reload only supported when no magazine is inserted (empty chamber)');
  const ammoRow = findInventoryRowByBattleItemId(actor, aId);
  assert(ammoRow, 'ammo_battle_item_id must match a carried inventory row for the actor');
  assert(ammoRow.battleType === BT_AMMO, 'ammo must be BT_AMMO');
  return { snapshotId: computeSnapshotId(tactical), actor };
}

function validateUnloadAgainstSnapshot(command, tactical, snapshotSha256Lower) {
  parseUnloadCommand(command);
  validateBindingAgainstSnapshot(command, tactical, snapshotSha256Lower);
  const actor = validateActorAgainstSnapshot(command, tactical);
  const wId = command.weapon_battle_item_id ?? command.weaponBattleItemId;
  const magId = command.loaded_ammo_battle_item_id ?? command.loadedAmmoBattleItemId;
  const rightId = handHeldWeaponBattleItemId(actor, 'right');
  const leftId = handHeldWeaponBattleItemId(actor, 'left');
  assert(rightId === wId || leftId === wId, 'weapon_battle_item_id must match firearm in STR_LEFT_HAND or STR_RIGHT_HAND');
  const weaponHand = rightId === wId ? actor.hands.right : actor.hands.left;
  assert(weaponHand && weaponHand.battleType === BT_FIREARM, 'weapon must be BT_FIREARM');
  assert(weaponHand.noMagazineInserted !== true, 'unload requires a magazine inserted (no noMagazineInserted flag)');
  const nested = weaponHand.nestedAmmo;
  assert(nested && Number.isInteger(nested.battleItemId), 'nestedAmmo.battleItemId required for unload preflight (WP8A)');
  assert(nested.battleItemId === magId, 'loaded_ammo_battle_item_id must match weapon nestedAmmo.battleItemId');
  const otherHandKey = rightId === wId ? 'left' : 'right';
  const other = actor.hands && actor.hands[otherHandKey];
  assert(other == null, 'other hand must be empty for unload (matches engine inventory unload)');
  return { snapshotId: computeSnapshotId(tactical), actor };
}

function collectCarriedItemPlacements(actor, battleItemId) {
  const out = [];
  for (const handKey of ['right', 'left']) {
    const h = actor.hands && actor.hands[handKey];
    if (h && h.battleItemId === battleItemId) {
      out.push({ kind: 'hand', handKey, item: h });
    }
  }
  for (const row of actor.inventory || []) {
    if (row && row.battleItemId === battleItemId) {
      out.push({ kind: 'row', row });
    }
  }
  return out;
}

function nestedAmmoBattleItemIdOnActor(actor) {
  const ids = [];
  for (const handKey of ['right', 'left']) {
    const h = actor.hands && actor.hands[handKey];
    if (h && h.nestedAmmo && Number.isInteger(h.nestedAmmo.battleItemId)) {
      ids.push(h.nestedAmmo.battleItemId);
    }
  }
  return ids;
}

function inventoryMoveItemIsPrimedExplosiveBlocked(item) {
  if (!item || typeof item.battleType !== 'number') {
    return false;
  }
  if (item.battleType !== BT_GRENADE && item.battleType !== BT_PROXIMITYGRENADE) {
    return false;
  }
  return item.primed === true;
}

function validateInventoryMoveAgainstSnapshot(command, tactical, snapshotSha256Lower) {
  const parsed = parseInventoryMoveCommand(command);
  validateBindingAgainstSnapshot(command, tactical, snapshotSha256Lower);
  const actor = validateActorAgainstSnapshot(command, tactical);

  assert(parsed.sourceSlot !== 'STR_GROUND', 'source_slot must not be STR_GROUND');
  assert(parsed.destinationSlot !== 'STR_GROUND', 'destination_slot must not be STR_GROUND');
  assert(CARRIED_INVENTORY_SLOT_IDS.has(parsed.sourceSlot), 'source_slot must be a supported carried section');
  assert(CARRIED_INVENTORY_SLOT_IDS.has(parsed.destinationSlot), 'destination_slot must be a supported carried section');

  const itemId = parsed.itemBattleItemId;
  if (nestedAmmoBattleItemIdOnActor(actor).includes(itemId)) {
    throw new ValidationError('nested ammunition cannot be moved (unload first)');
  }

  const placements = collectCarriedItemPlacements(actor, itemId);
  assert(placements.length === 1, 'item_battle_item_id must match exactly one carried item on the actor');
  const placement = placements[0];
  const item = placement.kind === 'hand' ? placement.item : placement.row;
  assert(item.slot === parsed.sourceSlot, 'source_slot does not match snapshot item placement');

  if (parsed.sourceCoordsGuard) {
    if (item.inventorySlotType === 'slot') {
      assert(
        item.inventoryX === parsed.sourceX && item.inventoryY === parsed.sourceY,
        'source_x/source_y do not match snapshot grid coordinates',
      );
    }
  }

  if (inventoryMoveItemIsPrimedExplosiveBlocked(item)) {
    throw new ValidationError('primed explosive cannot be moved via INVENTORY_MOVE');
  }

  return {
    snapshotId: computeSnapshotId(tactical),
    actor,
    planningHint: {
      advisory: true,
      note: 'Placement geometry, overlap, transfer TU, and final legality are enforced by the engine; rules-reference may supplement planning.',
    },
  };
}

function validatePickupAgainstSnapshot(command, tactical, snapshotSha256Lower) {
  const parsed = parsePickupCommand(command);
  validateBindingAgainstSnapshot(command, tactical, snapshotSha256Lower);
  const actor = validateActorAgainstSnapshot(command, tactical);

  const gp = parsed.groundPosition;
  const ap = actorPositionTriple(actor);
  assert(
    gp.x === ap.x && gp.y === ap.y && gp.z === ap.z,
    'ground_position must match actor tile (inventory ground is per standing tile only)',
  );

  const groundRows = Array.isArray(actor.groundInventory) ? actor.groundInventory : [];
  const matches = groundRows.filter((row) => row && row.battleItemId === parsed.itemBattleItemId);
  assert(matches.length === 1, 'item must appear exactly once in exported actor groundInventory');
  const groundRow = matches[0];
  assert(groundRow.slot === 'STR_GROUND', 'ground item slot must be STR_GROUND');
  assert(groundRow.inventorySlotType === 'ground', 'ground inventory rows must use inventorySlotType ground');

  if (nestedAmmoBattleItemIdOnActor(actor).includes(parsed.itemBattleItemId)) {
    throw new ValidationError('nested ammunition cannot be picked up directly');
  }

  if (parsed.destinationSlot === 'STR_RIGHT_HAND' || parsed.destinationSlot === 'STR_LEFT_HAND') {
    assert(
      parsed.destinationX === 0 && parsed.destinationY === 0,
      'hand destinations use destination_x/y 0,0 per engine semantics',
    );
  }

  return {
    snapshotId: computeSnapshotId(tactical),
    actor,
    planningHint: {
      advisory: true,
      note: 'Ground TU and placement are enforced by the engine; Node resolves items via exported actor groundInventory only.',
    },
  };
}

function validateDropAgainstSnapshot(command, tactical, snapshotSha256Lower) {
  const parsed = parseDropCommand(command);
  validateBindingAgainstSnapshot(command, tactical, snapshotSha256Lower);
  const actor = validateActorAgainstSnapshot(command, tactical);

  const itemId = parsed.itemBattleItemId;
  if (nestedAmmoBattleItemIdOnActor(actor).includes(itemId)) {
    throw new ValidationError('nested ammunition cannot be dropped (unload first)');
  }

  const placements = collectCarriedItemPlacements(actor, itemId);
  assert(placements.length === 1, 'item_battle_item_id must match exactly one carried item on the actor');
  const placement = placements[0];
  const item = placement.kind === 'hand' ? placement.item : placement.row;
  assert(item.slot === parsed.sourceSlot, 'source_slot does not match snapshot item placement');

  if (parsed.sourceCoordsGuard) {
    if (item.inventorySlotType === 'slot') {
      assert(
        item.inventoryX === parsed.sourceX && item.inventoryY === parsed.sourceY,
        'source_x/source_y do not match snapshot grid coordinates',
      );
    }
  }

  return {
    snapshotId: computeSnapshotId(tactical),
    actor,
    planningHint: {
      advisory: true,
      note: 'Ground placement coordinates are engine-chosen on success; Node only validates carried source identity.',
    },
  };
}

function parseTacticalCommand(raw) {
  assert(isPlainObject(raw), 'command must be an object');
  if (raw.command_type === COMMAND_TYPE_MOVE) {
    return parseMoveCommand(raw);
  }
  if (raw.command_type === COMMAND_TYPE_KNEEL) {
    return parseKneelCommand(raw);
  }
  if (raw.command_type === COMMAND_TYPE_STAND) {
    return parseStandCommand(raw);
  }
  if (raw.command_type === COMMAND_TYPE_SNAP_SHOT) {
    return parseSnapShotCommand(raw);
  }
  if (raw.command_type === COMMAND_TYPE_AUTO_SHOT) {
    return parseAutoShotCommand(raw);
  }
  if (raw.command_type === COMMAND_TYPE_AIMED_SHOT) {
    return parseAimedShotCommand(raw);
  }
  if (raw.command_type === COMMAND_TYPE_PRIME) {
    return parsePrimeCommand(raw);
  }
  if (raw.command_type === COMMAND_TYPE_THROW) {
    return parseThrowCommand(raw);
  }
  if (raw.command_type === COMMAND_TYPE_RELOAD) {
    return parseReloadCommand(raw);
  }
  if (raw.command_type === COMMAND_TYPE_UNLOAD) {
    return parseUnloadCommand(raw);
  }
  if (raw.command_type === COMMAND_TYPE_INVENTORY_MOVE) {
    return parseInventoryMoveCommand(raw);
  }
  if (raw.command_type === COMMAND_TYPE_PICKUP) {
    return parsePickupCommand(raw);
  }
  if (raw.command_type === COMMAND_TYPE_DROP) {
    return parseDropCommand(raw);
  }
  throw new ValidationError('unsupported command_type');
}

function commandDigest(command) {
  return crypto.createHash('sha256').update(JSON.stringify(command)).digest('hex');
}

function validateActorAgainstSnapshot(command, tactical) {
  const actor = tactical.units.find((u) => u.id === command.actor_unit_id);
  assert(actor, 'actor_unit_id not in snapshot');
  assert(actor.faction === 0 && actor.originalFaction === 0, 'actor must be player-controlled soldier');
  return actor;
}

function validateBindingAgainstSnapshot(command, tactical, snapshotSha256Lower) {
  assert(typeof snapshotSha256Lower === 'string' && SNAPSHOT_SHA_PATTERN.test(snapshotSha256Lower),
    'snapshot digest invalid');
  assert(command.snapshot_sha256 === snapshotSha256Lower, 'snapshot_sha256 mismatch');
  assert(command.session_id === tactical.eventLog.sessionId, 'session_id mismatch');
  assert(command.turn === tactical.turn, 'turn mismatch');
  assert(command.state_version === tactical.eventLog.latestSeq,
    'state_version must match eventLog.latestSeq at export (engine freshness binding)');
}

function validateMoveAgainstSnapshot(command, tactical, snapshotSha256Lower) {
  parseMoveCommand(command);
  validateBindingAgainstSnapshot(command, tactical, snapshotSha256Lower);
  assert(command.destination.x < tactical.map.width
    && command.destination.y < tactical.map.height
    && command.destination.z < tactical.map.depth, 'destination out of map bounds');
  const actor = validateActorAgainstSnapshot(command, tactical);
  return { snapshotId: computeSnapshotId(tactical), actor };
}

function validateKneelAgainstSnapshot(command, tactical, snapshotSha256Lower) {
  parseKneelCommand(command);
  validateBindingAgainstSnapshot(command, tactical, snapshotSha256Lower);
  const actor = validateActorAgainstSnapshot(command, tactical);
  return { snapshotId: computeSnapshotId(tactical), actor };
}

function validateStandAgainstSnapshot(command, tactical, snapshotSha256Lower) {
  parseStandCommand(command);
  validateBindingAgainstSnapshot(command, tactical, snapshotSha256Lower);
  const actor = validateActorAgainstSnapshot(command, tactical);
  return { snapshotId: computeSnapshotId(tactical), actor };
}

function handCostsKey(activeHand) {
  if (activeHand === 'STR_RIGHT_HAND') return 'right';
  if (activeHand === 'STR_LEFT_HAND') return 'left';
  return null;
}

function findFireActionOnActor(actor, activeHand, actionId) {
  const key = handCostsKey(activeHand);
  if (!key || !actor.actionCosts || !actor.actionCosts.hands || !actor.actionCosts.hands[key]) {
    return null;
  }
  const actions = actor.actionCosts.hands[key].actions;
  if (!Array.isArray(actions)) {
    return null;
  }
  return actions.find((entry) => entry && entry.id === actionId) || null;
}

function findHandEquipment(actor, activeHand) {
  const key = handCostsKey(activeHand);
  if (!key || !actor.hands) {
    return null;
  }
  return actor.hands[key] || null;
}

function validatePrimeFuseAgainstHand(activeHand, fuseTimer, handEquip) {
  if (!handEquip || typeof handEquip.battleType !== 'number') {
    return true;
  }
  if (handEquip.battleType === BT_GRENADE) {
    return fuseTimer >= 0 && fuseTimer <= 23;
  }
  if (handEquip.battleType === BT_PROXIMITYGRENADE) {
    return fuseTimer === 0;
  }
  return false;
}

function validateDirectedFireAgainstSnapshot(command, tactical, snapshotSha256Lower, commandType) {
  if (commandType === COMMAND_TYPE_SNAP_SHOT) {
    parseSnapShotCommand(command);
  } else if (commandType === COMMAND_TYPE_AUTO_SHOT) {
    parseAutoShotCommand(command);
  } else {
    parseAimedShotCommand(command);
  }
  validateBindingAgainstSnapshot(command, tactical, snapshotSha256Lower);
  assert(command.target.x < tactical.map.width
    && command.target.y < tactical.map.height
    && command.target.z < tactical.map.depth, 'target out of map bounds');
  const actor = validateActorAgainstSnapshot(command, tactical);
  const activeHand = command.active_hand || command.activeHand;
  const actionId = FIRE_ACTION_IDS[commandType];
  const fireAction = findFireActionOnActor(actor, activeHand, actionId);
  assert(fireAction, `weapon in active_hand does not support ${actionId} fire mode`);
  assert(fireAction.usable !== false, 'fire mode not usable for weapon or ammunition');
  assert(fireAction.canAffordTu !== false, 'insufficient TU for fire mode');
  const planningHint = buildFirePlanningHint(actor, activeHand, commandType);
  return { snapshotId: computeSnapshotId(tactical), actor, planningHint };
}

function validateSnapShotAgainstSnapshot(command, tactical, snapshotSha256Lower) {
  return validateDirectedFireAgainstSnapshot(command, tactical, snapshotSha256Lower, COMMAND_TYPE_SNAP_SHOT);
}

function validateAutoShotAgainstSnapshot(command, tactical, snapshotSha256Lower) {
  return validateDirectedFireAgainstSnapshot(command, tactical, snapshotSha256Lower, COMMAND_TYPE_AUTO_SHOT);
}

function validateAimedShotAgainstSnapshot(command, tactical, snapshotSha256Lower) {
  return validateDirectedFireAgainstSnapshot(command, tactical, snapshotSha256Lower, COMMAND_TYPE_AIMED_SHOT);
}

function validatePrimeAgainstSnapshot(command, tactical, snapshotSha256Lower) {
  parsePrimeCommand(command);
  validateBindingAgainstSnapshot(command, tactical, snapshotSha256Lower);
  const actor = validateActorAgainstSnapshot(command, tactical);
  const activeHand = command.active_hand || command.activeHand;
  const handEquip = findHandEquipment(actor, activeHand);
  assert(handEquip, 'no equipment in active_hand');
  assert(handEquip.primed !== true, 'grenade already primed');
  assert(validatePrimeFuseAgainstHand(activeHand, command.fuse_timer, handEquip),
    'fuse_timer invalid for grenade type in active_hand');
  const primeAction = findFireActionOnActor(actor, activeHand, GRENADE_ACTION_IDS[COMMAND_TYPE_PRIME]);
  assert(primeAction, 'hand item does not support prime');
  assert(primeAction.usable !== false, 'prime not usable');
  assert(primeAction.canAffordTu !== false, 'insufficient TU for prime');
  const planningHint = buildGrenadePlanningHint(actor, activeHand);
  return { snapshotId: computeSnapshotId(tactical), actor, planningHint };
}

function validateThrowAgainstSnapshot(command, tactical, snapshotSha256Lower) {
  parseThrowCommand(command);
  validateBindingAgainstSnapshot(command, tactical, snapshotSha256Lower);
  assert(command.target.x < tactical.map.width
    && command.target.y < tactical.map.height
    && command.target.z < tactical.map.depth, 'target out of map bounds');
  const actor = validateActorAgainstSnapshot(command, tactical);
  const activeHand = command.active_hand || command.activeHand;
  const throwAction = findFireActionOnActor(actor, activeHand, GRENADE_ACTION_IDS[COMMAND_TYPE_THROW]);
  assert(throwAction, 'hand item does not support throw');
  assert(throwAction.usable !== false, 'throw not usable');
  assert(throwAction.canAffordTu !== false, 'insufficient TU for throw');
  const planningHint = buildGrenadePlanningHint(actor, activeHand);
  return { snapshotId: computeSnapshotId(tactical), actor, planningHint };
}

function buildFirePlanningHint(actor, activeHand, commandType) {
  const fireAction = findFireActionOnActor(actor, activeHand, FIRE_ACTION_IDS[commandType]);
  const snapAfter = findFireActionOnActor(actor, activeHand, 'snap');
  if (!fireAction || typeof actor.timeUnits !== 'number') {
    return {
      advisory: true,
      note: 'Planning hint unavailable; engine validation is authoritative.',
    };
  }
  const fireTu = typeof fireAction.tuCost === 'number' ? fireAction.tuCost : null;
  const remainingEstimate = fireTu != null ? actor.timeUnits - fireTu : null;
  const snapTu = snapAfter && typeof snapAfter.tuCost === 'number' ? snapAfter.tuCost : null;
  const snapAffordableAfter = remainingEstimate != null && snapTu != null
    ? remainingEstimate >= snapTu && snapAfter.canAffordTu !== false && snapAfter.usable !== false
    : null;
  return {
    advisory: true,
    note: 'Non-authoritative estimate from export actionCosts; engine validation is authoritative. Movement, reactions, or state changes may invalidate it.',
    fireTuCost: fireTu,
    remainingTuEstimate: remainingEstimate,
    snapTuCost: snapTu,
    snapAffordableAfter,
  };
}

/**
 * Non-authoritative TU estimate for PRIME / THROW / combined (engine validates at execution).
 */
function buildGrenadePlanningHint(actor, activeHand) {
  const primeAction = findFireActionOnActor(actor, activeHand, 'prime');
  const throwAction = findFireActionOnActor(actor, activeHand, 'throw');
  const snapAfter = findFireActionOnActor(actor, activeHand, 'snap');
  if (typeof actor.timeUnits !== 'number') {
    return {
      advisory: true,
      note: 'Planning hint unavailable; engine validation is authoritative.',
    };
  }
  const primeTu = primeAction && typeof primeAction.tuCost === 'number' ? primeAction.tuCost : null;
  const throwTu = throwAction && typeof throwAction.tuCost === 'number' ? throwAction.tuCost : null;
  const handEquip = findHandEquipment(actor, activeHand);
  const alreadyPrimed = handEquip && handEquip.primed === true;
  const combinedTu = alreadyPrimed
    ? throwTu
    : (primeTu != null && throwTu != null ? primeTu + throwTu : null);
  const remainingAfterPrime = primeTu != null ? actor.timeUnits - primeTu : null;
  const remainingAfterThrow = throwTu != null ? actor.timeUnits - throwTu : null;
  const remainingAfterCombined = combinedTu != null ? actor.timeUnits - combinedTu : null;
  const snapTu = snapAfter && typeof snapAfter.tuCost === 'number' ? snapAfter.tuCost : null;
  const snapAffordableAfterCombined = remainingAfterCombined != null && snapTu != null
    ? remainingAfterCombined >= snapTu && snapAfter.canAffordTu !== false && snapAfter.usable !== false
    : null;
  return {
    advisory: true,
    note: 'Non-authoritative estimate from export actionCosts; engine validation is authoritative.',
    alreadyPrimed,
    primeTuCost: primeTu,
    throwTuCost: throwTu,
    combinedTuCostEstimate: combinedTu,
    remainingTuAfterPrimeEstimate: remainingAfterPrime,
    remainingTuAfterThrowEstimate: remainingAfterThrow,
    remainingTuAfterPrimeAndThrowEstimate: remainingAfterCombined,
    snapTuCost: snapTu,
    snapAffordableAfterCombined,
  };
}

function validateTacticalCommandAgainstSnapshot(command, tactical, snapshotSha256Lower) {
  if (command && command.command_type === COMMAND_TYPE_MOVE) {
    return validateMoveAgainstSnapshot(command, tactical, snapshotSha256Lower);
  }
  if (command && command.command_type === COMMAND_TYPE_KNEEL) {
    return validateKneelAgainstSnapshot(command, tactical, snapshotSha256Lower);
  }
  if (command && command.command_type === COMMAND_TYPE_STAND) {
    return validateStandAgainstSnapshot(command, tactical, snapshotSha256Lower);
  }
  if (command && command.command_type === COMMAND_TYPE_SNAP_SHOT) {
    return validateSnapShotAgainstSnapshot(command, tactical, snapshotSha256Lower);
  }
  if (command && command.command_type === COMMAND_TYPE_AUTO_SHOT) {
    return validateAutoShotAgainstSnapshot(command, tactical, snapshotSha256Lower);
  }
  if (command && command.command_type === COMMAND_TYPE_AIMED_SHOT) {
    return validateAimedShotAgainstSnapshot(command, tactical, snapshotSha256Lower);
  }
  if (command && command.command_type === COMMAND_TYPE_PRIME) {
    return validatePrimeAgainstSnapshot(command, tactical, snapshotSha256Lower);
  }
  if (command && command.command_type === COMMAND_TYPE_THROW) {
    return validateThrowAgainstSnapshot(command, tactical, snapshotSha256Lower);
  }
  if (command && command.command_type === COMMAND_TYPE_RELOAD) {
    return validateReloadAgainstSnapshot(command, tactical, snapshotSha256Lower);
  }
  if (command && command.command_type === COMMAND_TYPE_UNLOAD) {
    return validateUnloadAgainstSnapshot(command, tactical, snapshotSha256Lower);
  }
  if (command && command.command_type === COMMAND_TYPE_INVENTORY_MOVE) {
    return validateInventoryMoveAgainstSnapshot(command, tactical, snapshotSha256Lower);
  }
  if (command && command.command_type === COMMAND_TYPE_PICKUP) {
    return validatePickupAgainstSnapshot(command, tactical, snapshotSha256Lower);
  }
  if (command && command.command_type === COMMAND_TYPE_DROP) {
    return validateDropAgainstSnapshot(command, tactical, snapshotSha256Lower);
  }
  throw new ValidationError('unsupported command_type');
}

function buildResultEnvelope(command, status, fields = {}) {
  assert(typeof status === 'string', 'status required');
  const base = {
    schema_version: RESULT_SCHEMA_VERSION,
    command_id: command.command_id,
    command_type: command.command_type,
    status,
    session_id: command.session_id,
    turn: command.turn,
    ...fields,
  };
  return base;
}

function parseResultStatus(result) {
  assert(isPlainObject(result), 'result must be object');
  assert(result.schema_version === RESULT_SCHEMA_VERSION, 'unsupported result schema_version');
  assert(typeof result.command_id === 'string', 'result command_id required');
  assert(typeof result.status === 'string', 'result status required');
  return result.status;
}

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

function canAcceptNewCommand(lastOpenStatus) {
  if (!lastOpenStatus) return true;
  return isTerminalStatus(lastOpenStatus);
}

function validateMoveAgainstSnapshotFile(command, snapshotPath, yaml, readFileSync = fs.readFileSync) {
  const snapshotBytes = readSnapshotByteBuffer(readFileSync, snapshotPath);
  const digest = sha256HexLower(snapshotBytes);
  const tactical = loadAndValidateSnapshotFromText(snapshotBytes.toString('utf8'), yaml);
  validateMoveAgainstSnapshot(command, tactical, digest);
  return { tactical, digest, snapshotId: computeSnapshotId(tactical) };
}

function validateTacticalCommandAgainstSnapshotFile(command, snapshotPath, yaml, readFileSync = fs.readFileSync) {
  const snapshotBytes = readSnapshotByteBuffer(readFileSync, snapshotPath);
  const digest = sha256HexLower(snapshotBytes);
  const tactical = loadAndValidateSnapshotFromText(snapshotBytes.toString('utf8'), yaml);
  validateTacticalCommandAgainstSnapshot(command, tactical, digest);
  return { tactical, digest, snapshotId: computeSnapshotId(tactical) };
}

module.exports = {
  COMMAND_SCHEMA_VERSION,
  RESULT_SCHEMA_VERSION,
  COMMAND_TYPE_MOVE,
  COMMAND_TYPE_KNEEL,
  COMMAND_TYPE_STAND,
  COMMAND_TYPE_SNAP_SHOT,
  COMMAND_TYPE_AUTO_SHOT,
  COMMAND_TYPE_AIMED_SHOT,
  COMMAND_TYPE_PRIME,
  COMMAND_TYPE_THROW,
  COMMAND_TYPE_RELOAD,
  COMMAND_TYPE_UNLOAD,
  COMMAND_TYPE_INVENTORY_MOVE,
  COMMAND_TYPE_PICKUP,
  COMMAND_TYPE_DROP,
  CARRIED_INVENTORY_SLOT_IDS,
  DIRECTED_FIRE_COMMAND_TYPES,
  GRENADE_COMMAND_TYPES,
  TERMINAL_STATUSES,
  NON_TERMINAL_STATUSES,
  parseMoveCommand,
  parseKneelCommand,
  parseStandCommand,
  parseSnapShotCommand,
  parseAutoShotCommand,
  parseAimedShotCommand,
  parsePrimeCommand,
  parseThrowCommand,
  parseReloadCommand,
  parseUnloadCommand,
  parseInventoryMoveCommand,
  parsePickupCommand,
  parseDropCommand,
  parseTacticalCommand,
  commandDigest,
  validateMoveAgainstSnapshot,
  validateKneelAgainstSnapshot,
  validateStandAgainstSnapshot,
  validateSnapShotAgainstSnapshot,
  validateAutoShotAgainstSnapshot,
  validateAimedShotAgainstSnapshot,
  validatePrimeAgainstSnapshot,
  validateThrowAgainstSnapshot,
  validateReloadAgainstSnapshot,
  validateUnloadAgainstSnapshot,
  validateInventoryMoveAgainstSnapshot,
  validatePickupAgainstSnapshot,
  validateDropAgainstSnapshot,
  validateTacticalCommandAgainstSnapshot,
  validateMoveAgainstSnapshotFile,
  validateTacticalCommandAgainstSnapshotFile,
  buildFirePlanningHint,
  buildGrenadePlanningHint,
  buildResultEnvelope,
  parseResultStatus,
  isTerminalStatus,
  canAcceptNewCommand,
};
