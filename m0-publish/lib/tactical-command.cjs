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
  BT_MEDIKIT,
  BT_MELEE,
  BT_PSIAMP,
} = require('./tactical-publish.cjs');
const { classifyCurrentHostileObservation } = require('./hostile-intelligence-consumer.cjs');
const {
  isFriendlyRosterSoldier,
  isFriendlyHwpUnit,
  isGenuineHostileUnit,
  isMindControlledRosterSoldier,
  isXcomControlledHostileUnit,
  MAX_ROSTER_UNIT_ID_EXCLUSIVE,
} = require('./unit-state-brief.cjs');
const { isCommandApplicableForBinding } = require('./command-binding.cjs');
const { readSnapshotByteBuffer, sha256HexLower } = require('./briefing-snapshot.cjs');
const {
  buildMovePlanningHint,
  buildHwpMovePlanningHint,
  buildDirectedFireCompositeHint,
  buildTurnFacePlanningHint,
  buildHwpTurnPlanningHint,
  buildHwpFirePlanningHint,
  HWP_TURN_PARTS,
} = require('./tu-composite-advisory.cjs');

const COMMAND_SCHEMA_VERSION = 1;
const RESULT_SCHEMA_VERSION = 1;
const COMMAND_TYPE_MOVE = 'MOVE';
const COMMAND_TYPE_HWP_MOVE = 'HWP_MOVE';
const COMMAND_TYPE_HWP_TURN = 'HWP_TURN';
const COMMAND_TYPE_HWP_FIRE = 'HWP_FIRE';
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
const COMMAND_TYPE_GUIDED_LAUNCH = 'GUIDED_LAUNCH';
const COMMAND_TYPE_HEAL = 'HEAL';
const COMMAND_TYPE_STIMULANT = 'STIMULANT';
const COMMAND_TYPE_PAINKILLER = 'PAINKILLER';
const COMMAND_TYPE_PSI_PANIC = 'PSI_PANIC';
const COMMAND_TYPE_PSI_MIND_CONTROL = 'PSI_MIND_CONTROL';
const COMMAND_TYPE_MELEE_ATTACK = 'MELEE_ATTACK';
const COMMAND_TYPE_TURN_FACE = 'TURN_FACE';

const TURN_FACE_COMMAND_TYPES = new Set([COMMAND_TYPE_TURN_FACE]);

const MEDIKIT_COMMAND_TYPES = new Set([
  COMMAND_TYPE_HEAL,
  COMMAND_TYPE_STIMULANT,
  COMMAND_TYPE_PAINKILLER,
]);

const MEDIKIT_CHARGE_FIELD = {
  [COMMAND_TYPE_HEAL]: 'heal',
  [COMMAND_TYPE_STIMULANT]: 'stimulant',
  [COMMAND_TYPE_PAINKILLER]: 'painKiller',
};

const MEDIKIT_USE_ACTION_ID = 'use';

const PSI_PANIC_COMMAND_TYPES = new Set([COMMAND_TYPE_PSI_PANIC]);
const PSI_MIND_CONTROL_COMMAND_TYPES = new Set([COMMAND_TYPE_PSI_MIND_CONTROL]);
const PSI_TACTICAL_COMMAND_TYPES = new Set([
  COMMAND_TYPE_PSI_PANIC,
  COMMAND_TYPE_PSI_MIND_CONTROL,
]);

const PSI_PANIC_ACTION_ID = 'panic';
const PSI_MIND_CONTROL_ACTION_ID = 'mindcontrol';

const MELEE_TACTICAL_COMMAND_TYPES = new Set([COMMAND_TYPE_MELEE_ATTACK]);
const MELEE_ACTION_ID = 'melee';

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
const COMMAND_KEYS_HWP_MOVE = new Set([...COMMAND_KEYS_COMMON, 'destination']);
const COMMAND_KEYS_HWP_TURN = new Set([...COMMAND_KEYS_COMMON, 'target', 'turn_part']);
const COMMAND_KEYS_HWP_FIRE = new Set([
  ...COMMAND_KEYS_COMMON,
  'target',
  'fire_mode',
  'weapon_battle_item_id',
]);
const HWP_FIRE_MODES = new Set(['snap', 'aimed']);
const HWP_FIRE_MODE_ACTION_IDS = {
  snap: 'snap',
  aimed: 'aimed',
};
const COMMAND_KEYS_KNEEL = new Set([...COMMAND_KEYS_COMMON]);
const COMMAND_KEYS_STAND = new Set([...COMMAND_KEYS_COMMON]);
const COMMAND_KEYS_TURN_FACE = new Set([...COMMAND_KEYS_COMMON, 'target']);
const COMMAND_KEYS_DIRECTED_FIRE = new Set([...COMMAND_KEYS_COMMON, 'target', 'active_hand']);
const COMMAND_KEYS_PRIME = new Set([...COMMAND_KEYS_COMMON, 'active_hand', 'fuse_timer']);
const COMMAND_KEYS_THROW = new Set([...COMMAND_KEYS_COMMON, 'target', 'active_hand']);
const COMMAND_KEYS_GUIDED_LAUNCH = new Set([...COMMAND_KEYS_COMMON, 'active_hand', 'waypoints']);
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

const COMMAND_KEYS_MEDIKIT_APPLICATION = new Set([
  ...COMMAND_KEYS_COMMON,
  'target_unit_id',
  'medikit_battle_item_id',
  'active_hand',
]);

const COMMAND_KEYS_HEAL = new Set([...COMMAND_KEYS_MEDIKIT_APPLICATION, 'body_part']);

const COMMAND_KEYS_PSI_PANIC = new Set([
  ...COMMAND_KEYS_COMMON,
  'target_unit_id',
  'psi_amp_battle_item_id',
  'active_hand',
]);

const COMMAND_KEYS_PSI_MIND_CONTROL = COMMAND_KEYS_PSI_PANIC;

const COMMAND_KEYS_MELEE_ATTACK = new Set([
  ...COMMAND_KEYS_COMMON,
  'target_unit_id',
  'melee_weapon_battle_item_id',
  'active_hand',
]);

const MEDIKIT_BODY_PART_MIN = 0;
const MEDIKIT_BODY_PART_MAX = 5;

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

const GUIDED_LAUNCH_ACTION_ID = 'launch';

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

function parseHwpTurnCommand(raw) {
  assert(isPlainObject(raw), 'command must be an object');
  assert(raw.schema_version === COMMAND_SCHEMA_VERSION, 'unsupported command schema_version');
  assert(typeof raw.command_id === 'string' && COMMAND_ID_PATTERN.test(raw.command_id), 'invalid command_id');
  assert(raw.command_type === COMMAND_TYPE_HWP_TURN, 'unsupported command_type');
  assertAllowedCommandKeys(raw, COMMAND_KEYS_HWP_TURN);
  assert(typeof raw.turn_part === 'string' && HWP_TURN_PARTS.has(raw.turn_part),
    'turn_part must be "body" or "turret"');
  const target = parseCoordinateObject(raw.target, 'target');
  const binding = parseBindingFields(raw);
  return {
    ...binding,
    turnPart: raw.turn_part,
    target,
  };
}

function parseHwpFireCommand(raw) {
  assert(isPlainObject(raw), 'command must be an object');
  assert(raw.schema_version === COMMAND_SCHEMA_VERSION, 'unsupported command schema_version');
  assert(typeof raw.command_id === 'string' && COMMAND_ID_PATTERN.test(raw.command_id), 'invalid command_id');
  assert(raw.command_type === COMMAND_TYPE_HWP_FIRE, 'unsupported command_type');
  assertAllowedCommandKeys(raw, COMMAND_KEYS_HWP_FIRE);
  assert(typeof raw.fire_mode === 'string', 'fire_mode required');
  assert(HWP_FIRE_MODES.has(raw.fire_mode), 'fire_mode must be "snap" or "aimed"');
  assert(
    Number.isInteger(raw.weapon_battle_item_id) && raw.weapon_battle_item_id >= 0,
    'weapon_battle_item_id must be a non-negative integer',
  );
  const target = parseCoordinateObject(raw.target, 'target');
  const binding = parseBindingFields(raw);
  return {
    ...binding,
    fireMode: raw.fire_mode,
    weaponBattleItemId: raw.weapon_battle_item_id,
    target,
  };
}

function parseHwpMoveCommand(raw) {
  assert(isPlainObject(raw), 'command must be an object');
  assert(raw.schema_version === COMMAND_SCHEMA_VERSION, 'unsupported command schema_version');
  assert(typeof raw.command_id === 'string' && COMMAND_ID_PATTERN.test(raw.command_id), 'invalid command_id');
  assert(raw.command_type === COMMAND_TYPE_HWP_MOVE, 'unsupported command_type');
  assertAllowedCommandKeys(raw, COMMAND_KEYS_HWP_MOVE);
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

function parseTurnFaceCommand(raw) {
  assert(isPlainObject(raw), 'command must be an object');
  assert(raw.schema_version === COMMAND_SCHEMA_VERSION, 'unsupported command schema_version');
  assert(typeof raw.command_id === 'string' && COMMAND_ID_PATTERN.test(raw.command_id), 'invalid command_id');
  assert(raw.command_type === COMMAND_TYPE_TURN_FACE, 'unsupported command_type');
  assertAllowedCommandKeys(raw, COMMAND_KEYS_TURN_FACE);
  const target = parseCoordinateObject(raw.target, 'target');
  const binding = parseBindingFields(raw);
  return {
    ...binding,
    target,
  };
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

function parseWaypointSequence(rawWaypoints) {
  if (!Array.isArray(rawWaypoints)) {
    throw new ValidationError('waypoints must be a non-empty array');
  }
  if (rawWaypoints.length === 0) {
    throw new ValidationError('waypoints must contain at least one position');
  }
  const waypoints = [];
  for (let i = 0; i < rawWaypoints.length; i += 1) {
    waypoints.push(parseCoordinateObject(rawWaypoints[i], `waypoints[${i}]`));
  }
  return waypoints;
}

function parseGuidedLaunchCommand(raw) {
  assert(isPlainObject(raw), 'command must be an object');
  assert(raw.schema_version === COMMAND_SCHEMA_VERSION, 'unsupported command schema_version');
  assert(typeof raw.command_id === 'string' && COMMAND_ID_PATTERN.test(raw.command_id), 'invalid command_id');
  assert(raw.command_type === COMMAND_TYPE_GUIDED_LAUNCH, 'unsupported command_type');
  assertAllowedCommandKeys(raw, COMMAND_KEYS_GUIDED_LAUNCH);
  assert(typeof raw.active_hand === 'string' && VALID_ACTIVE_HANDS.has(raw.active_hand), 'invalid active_hand');
  const waypoints = parseWaypointSequence(raw.waypoints);
  const binding = parseBindingFields(raw);
  return {
    ...binding,
    activeHand: raw.active_hand,
    waypoints,
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

function parseMedikitApplicationCommand(raw, commandType, allowedKeys) {
  assert(isPlainObject(raw), 'command must be an object');
  assert(raw.schema_version === COMMAND_SCHEMA_VERSION, 'unsupported command schema_version');
  assert(typeof raw.command_id === 'string' && COMMAND_ID_PATTERN.test(raw.command_id), 'invalid command_id');
  assert(raw.command_type === commandType, 'unsupported command_type');
  assertAllowedCommandKeys(raw, allowedKeys);
  assert(Number.isInteger(raw.target_unit_id) && raw.target_unit_id > 0, 'target_unit_id must be positive integer');
  assert(
    Number.isInteger(raw.medikit_battle_item_id) && raw.medikit_battle_item_id > 0,
    'medikit_battle_item_id must be positive integer',
  );
  assert(typeof raw.active_hand === 'string' && VALID_ACTIVE_HANDS.has(raw.active_hand), 'active_hand invalid');
  const binding = parseBindingFields(raw);
  return {
    ...binding,
    targetUnitId: raw.target_unit_id,
    medikitBattleItemId: raw.medikit_battle_item_id,
    activeHand: raw.active_hand,
  };
}

function parseHealCommand(raw) {
  const parsed = parseMedikitApplicationCommand(raw, COMMAND_TYPE_HEAL, COMMAND_KEYS_HEAL);
  assert(Number.isInteger(raw.body_part), 'body_part required');
  assert(
    raw.body_part >= MEDIKIT_BODY_PART_MIN && raw.body_part <= MEDIKIT_BODY_PART_MAX,
    'body_part must be 0..5',
  );
  return { ...parsed, bodyPart: raw.body_part };
}

function parseStimulantCommand(raw) {
  return parseMedikitApplicationCommand(raw, COMMAND_TYPE_STIMULANT, COMMAND_KEYS_MEDIKIT_APPLICATION);
}

function parsePainKillerCommand(raw) {
  return parseMedikitApplicationCommand(raw, COMMAND_TYPE_PAINKILLER, COMMAND_KEYS_MEDIKIT_APPLICATION);
}

function parsePsiAmpApplicationCommand(raw, expectedType, allowedKeys) {
  assert(isPlainObject(raw), 'command must be an object');
  assert(raw.schema_version === COMMAND_SCHEMA_VERSION, 'unsupported command schema_version');
  assert(typeof raw.command_id === 'string' && COMMAND_ID_PATTERN.test(raw.command_id), 'invalid command_id');
  assert(raw.command_type === expectedType, 'unsupported command_type');
  assertAllowedCommandKeys(raw, allowedKeys);
  assert(Number.isInteger(raw.target_unit_id) && raw.target_unit_id > 0, 'target_unit_id must be positive integer');
  assert(
    Number.isInteger(raw.psi_amp_battle_item_id) && raw.psi_amp_battle_item_id > 0,
    'psi_amp_battle_item_id must be positive integer',
  );
  assert(typeof raw.active_hand === 'string' && VALID_ACTIVE_HANDS.has(raw.active_hand), 'active_hand invalid');
  const binding = parseBindingFields(raw);
  return {
    ...binding,
    targetUnitId: raw.target_unit_id,
    psiAmpBattleItemId: raw.psi_amp_battle_item_id,
    activeHand: raw.active_hand,
  };
}

function parsePsiPanicCommand(raw) {
  return parsePsiAmpApplicationCommand(raw, COMMAND_TYPE_PSI_PANIC, COMMAND_KEYS_PSI_PANIC);
}

function parsePsiMindControlCommand(raw) {
  return parsePsiAmpApplicationCommand(raw, COMMAND_TYPE_PSI_MIND_CONTROL, COMMAND_KEYS_PSI_MIND_CONTROL);
}

function parseMeleeAttackCommand(raw) {
  assert(isPlainObject(raw), 'command must be an object');
  assert(raw.schema_version === COMMAND_SCHEMA_VERSION, 'unsupported command schema_version');
  assert(typeof raw.command_id === 'string' && COMMAND_ID_PATTERN.test(raw.command_id), 'invalid command_id');
  assert(raw.command_type === COMMAND_TYPE_MELEE_ATTACK, 'unsupported command_type');
  assertAllowedCommandKeys(raw, COMMAND_KEYS_MELEE_ATTACK);
  assert(Number.isInteger(raw.target_unit_id) && raw.target_unit_id > 0, 'target_unit_id must be positive integer');
  assert(
    Number.isInteger(raw.melee_weapon_battle_item_id) && raw.melee_weapon_battle_item_id > 0,
    'melee_weapon_battle_item_id must be positive integer',
  );
  assert(typeof raw.active_hand === 'string' && VALID_ACTIVE_HANDS.has(raw.active_hand), 'active_hand invalid');
  const binding = parseBindingFields(raw);
  return {
    ...binding,
    targetUnitId: raw.target_unit_id,
    meleeWeaponBattleItemId: raw.melee_weapon_battle_item_id,
    activeHand: raw.active_hand,
  };
}

function parseMeleeTacticalCommand(raw) {
  if (raw.command_type === COMMAND_TYPE_MELEE_ATTACK) {
    return parseMeleeAttackCommand(raw);
  }
  throw new ValidationError('unsupported command_type');
}

function isMeleeTacticalCommandType(commandType) {
  return MELEE_TACTICAL_COMMAND_TYPES.has(commandType);
}

function isTurnFaceCommandType(commandType) {
  return TURN_FACE_COMMAND_TYPES.has(commandType);
}

/**
 * Parse medikit command JSON (S1 contract). Delegates to type-specific parsers.
 */
function parseMedikitTacticalCommand(raw) {
  if (raw.command_type === COMMAND_TYPE_HEAL) {
    return parseHealCommand(raw);
  }
  if (raw.command_type === COMMAND_TYPE_STIMULANT) {
    return parseStimulantCommand(raw);
  }
  if (raw.command_type === COMMAND_TYPE_PAINKILLER) {
    return parsePainKillerCommand(raw);
  }
  throw new ValidationError('unsupported command_type');
}

function isMedikitCommandType(commandType) {
  return MEDIKIT_COMMAND_TYPES.has(commandType);
}

/**
 * Parse WP10 psi command JSON (S1 — PSI_PANIC and PSI_MIND_CONTROL).
 */
function parsePsiTacticalCommand(raw) {
  if (raw.command_type === COMMAND_TYPE_PSI_PANIC) {
    return parsePsiPanicCommand(raw);
  }
  if (raw.command_type === COMMAND_TYPE_PSI_MIND_CONTROL) {
    return parsePsiMindControlCommand(raw);
  }
  throw new ValidationError('unsupported command_type');
}

function isPsiPanicCommandType(commandType) {
  return PSI_PANIC_COMMAND_TYPES.has(commandType);
}

function isPsiMindControlCommandType(commandType) {
  return PSI_MIND_CONTROL_COMMAND_TYPES.has(commandType);
}

function isPsiTacticalCommandType(commandType) {
  return PSI_TACTICAL_COMMAND_TYPES.has(commandType);
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

function validateMedikitHandAgainstSnapshot(actor, parsed) {
  const handEquip = findHandEquipment(actor, parsed.activeHand);
  assert(handEquip, 'active_hand has no equipment in snapshot');
  assert(
    Number.isInteger(handEquip.battleItemId) && handEquip.battleItemId === parsed.medikitBattleItemId,
    'medikit_battle_item_id does not match active_hand item',
  );
  assert(handEquip.battleType === BT_MEDIKIT, 'active_hand item must be a medikit');
  if (typeof handEquip.slot === 'string' && handEquip.slot.length > 0) {
    assert(handEquip.slot === parsed.activeHand, 'medikit snapshot slot does not match active_hand');
  }
  return handEquip;
}

function validateMedikitTargetAgainstSnapshot(actor, targetUnitId, tactical) {
  const target = tactical.units.find((u) => u && u.id === targetUnitId);
  assert(target, 'target_unit_id not in snapshot');
  assert(isFriendlyRosterSoldier(target), 'target must be a friendly roster soldier in snapshot');
  assert(typeof target.name === 'string' && target.name.length > 0, 'target is not eligible for medikit command');
  assert(target.id === targetUnitId, 'target identity mismatch');
  return target;
}

function validateMedikitChargeAvailable(handEquip, commandType) {
  const chargeKey = MEDIKIT_CHARGE_FIELD[commandType];
  assert(chargeKey, 'internal medikit charge mapping missing');
  if (!handEquip.medikitCharges || typeof handEquip.medikitCharges !== 'object') {
    return {
      advisory: true,
      note: 'medikitCharges not in snapshot; engine enforces charge availability',
    };
  }
  const remaining = handEquip.medikitCharges[chargeKey];
  if (typeof remaining !== 'number') {
    return {
      advisory: true,
      note: `medikitCharges.${chargeKey} not in snapshot; engine enforces charge availability`,
    };
  }
  assert(remaining > 0, 'medikit charge depleted for requested application');
  return null;
}

function validateMedikitTuAgainstSnapshot(actor, activeHand) {
  const useAction = findFireActionOnActor(actor, activeHand, MEDIKIT_USE_ACTION_ID);
  if (!useAction) {
    return {
      advisory: true,
      note: 'BA_USE medikit actionCosts not in snapshot; engine enforces TU',
    };
  }
  assert(useAction.usable !== false, 'medikit use not usable in current conditions');
  assert(useAction.canAffordTu !== false, 'insufficient TU for medikit use (export)');
  return null;
}

function buildMedikitTargetGeometryAdvisory(actor, target) {
  const advisories = [];
  if (target.battlefieldPlacement === 'carried_in_inventory') {
    advisories.push({
      code: 'target_carried_in_inventory',
      note: 'Carried unconscious soldiers are not engine medikit targets until on the map; engine remains authoritative.',
    });
  }
  if (Array.isArray(actor.position) && Array.isArray(target.position)) {
    const sameTile = actor.position[0] === target.position[0]
      && actor.position[1] === target.position[1]
      && actor.position[2] === target.position[2];
    if (!sameTile) {
      advisories.push({
        code: 'target_not_same_tile',
        note: 'Native medikit targeting uses facing and melee-range geometry; adjacency is engine-validated only.',
      });
    }
  }
  if (advisories.length === 0) {
    return null;
  }
  return { advisory: true, items: advisories };
}

function buildHealBodyPartAdvisory(target, bodyPart) {
  if (!Array.isArray(target.fatalWounds) || target.fatalWounds.length !== 6) {
    return {
      advisory: true,
      code: 'fatal_wounds_unavailable',
      note: 'fatalWounds not exported; engine may consume a heal charge with no wound effect on body_part',
    };
  }
  if (target.fatalWounds[bodyPart] > 0) {
    return null;
  }
  return {
    advisory: true,
    code: 'heal_no_fatal_wound_on_part',
    note: 'Engine may spend TU and a heal charge even when the selected body_part has no fatal wound',
    bodyPart,
  };
}

function validateMedikitApplicationAgainstSnapshot(command, tactical, snapshotSha256Lower, commandType) {
  let parsed;
  if (commandType === COMMAND_TYPE_HEAL) {
    parsed = parseHealCommand(command);
  } else if (commandType === COMMAND_TYPE_STIMULANT) {
    parsed = parseStimulantCommand(command);
  } else if (commandType === COMMAND_TYPE_PAINKILLER) {
    parsed = parsePainKillerCommand(command);
  } else {
    throw new ValidationError('unsupported command_type');
  }
  validateBindingAgainstSnapshot(command, tactical, snapshotSha256Lower);
  const actor = validateActorAgainstSnapshot(command, tactical);
  const handEquip = validateMedikitHandAgainstSnapshot(actor, parsed);
  const target = validateMedikitTargetAgainstSnapshot(actor, parsed.targetUnitId, tactical);

  const planningHints = [];
  const chargeAdvisory = validateMedikitChargeAvailable(handEquip, commandType);
  if (chargeAdvisory) {
    planningHints.push(chargeAdvisory);
  }
  const tuAdvisory = validateMedikitTuAgainstSnapshot(actor, parsed.activeHand);
  if (tuAdvisory) {
    planningHints.push(tuAdvisory);
  }
  const geometryAdvisory = buildMedikitTargetGeometryAdvisory(actor, target);
  if (geometryAdvisory) {
    planningHints.push(geometryAdvisory);
  }
  if (commandType === COMMAND_TYPE_HEAL) {
    const healAdvisory = buildHealBodyPartAdvisory(target, parsed.bodyPart);
    if (healAdvisory) {
      planningHints.push(healAdvisory);
    }
  }

  return {
    snapshotId: computeSnapshotId(tactical),
    actor,
    target,
    medikitBattleItemId: parsed.medikitBattleItemId,
    planningHint: planningHints.length
      ? { advisory: true, items: planningHints }
      : { advisory: true, note: 'Medikit geometry and wound checks are engine-authoritative.' },
  };
}

function validateHealAgainstSnapshot(command, tactical, snapshotSha256Lower) {
  return validateMedikitApplicationAgainstSnapshot(
    command,
    tactical,
    snapshotSha256Lower,
    COMMAND_TYPE_HEAL,
  );
}

function validateStimulantAgainstSnapshot(command, tactical, snapshotSha256Lower) {
  return validateMedikitApplicationAgainstSnapshot(
    command,
    tactical,
    snapshotSha256Lower,
    COMMAND_TYPE_STIMULANT,
  );
}

function validatePainKillerAgainstSnapshot(command, tactical, snapshotSha256Lower) {
  return validateMedikitApplicationAgainstSnapshot(
    command,
    tactical,
    snapshotSha256Lower,
    COMMAND_TYPE_PAINKILLER,
  );
}

function validatePsiActorEligibility(actor) {
  assert(isFriendlyRosterSoldier(actor), 'actor must be a friendly roster soldier in snapshot');
  assert(isCommandApplicableForBinding(actor), 'actor is not command-applicable at export');
}

function validatePsiAmpHandAgainstSnapshot(actor, parsed) {
  const handEquip = findHandEquipment(actor, parsed.activeHand);
  assert(handEquip, `no equipment in ${parsed.activeHand}`);
  const battleItemId = handHeldWeaponBattleItemId(actor, handCostsKey(parsed.activeHand));
  assert(
    battleItemId === parsed.psiAmpBattleItemId,
    'psi_amp_battle_item_id must match Psi-Amp in the declared hand',
  );
  assert(handEquip.battleType === BT_PSIAMP, 'active_hand item must be a Psi-Amp');
  if (typeof handEquip.slot === 'string' && handEquip.slot.length > 0) {
    assert(handEquip.slot === parsed.activeHand, 'Psi-Amp snapshot slot does not match active_hand');
  }
  return handEquip;
}

function validatePsiSkillWhenExported(actor) {
  if (typeof actor.psiSkill !== 'number' || !Number.isInteger(actor.psiSkill)) {
    return {
      advisory: true,
      note: 'psiSkill not in snapshot; engine enforces psionic eligibility',
    };
  }
  assert(actor.psiSkill > 0, 'actor psiSkill must be positive for psionic commands');
  return null;
}

function validatePsiAmpTuAgainstSnapshot(actor, activeHand, actionId, actionLabel) {
  const psiAction = findFireActionOnActor(actor, activeHand, actionId);
  if (!psiAction) {
    return {
      advisory: true,
      note: `${actionLabel} actionCosts not in snapshot; engine enforces TU`,
    };
  }
  assert(psiAction.usable !== false, `${actionLabel} action not usable in current conditions`);
  assert(psiAction.canAffordTu !== false, `insufficient TU for ${actionLabel} (export)`);
  return null;
}

function validatePsiPanicTuAgainstSnapshot(actor, activeHand) {
  return validatePsiAmpTuAgainstSnapshot(actor, activeHand, PSI_PANIC_ACTION_ID, 'panic');
}

function validatePsiMindControlTuAgainstSnapshot(actor, activeHand) {
  return validatePsiAmpTuAgainstSnapshot(actor, activeHand, PSI_MIND_CONTROL_ACTION_ID, 'mindcontrol');
}

function validatePsiHostileTargetAgainstSnapshot(tactical, targetUnitId, ineligibleTargetMessage) {
  const target = tactical.units.find((u) => u && u.id === targetUnitId);
  assert(target, 'target_unit_id not in snapshot');
  if (isMindControlledRosterSoldier(target) || isXcomControlledHostileUnit(target)) {
    assert(false, ineligibleTargetMessage);
  }
  if (isFriendlyRosterSoldier(target)) {
    assert(false, 'target must not be a friendly roster soldier');
  }
  if (!isGenuineHostileUnit(target)) {
    assert(false, 'target must be a genuine hostile unit at export');
  }
  const observation = classifyCurrentHostileObservation(tactical, targetUnitId);
  assert(
    observation.availability === 'confirmed_current_los',
    'target must have confirmed current line of sight at export (facing present)',
  );
  return target;
}

function validatePsiPanicTargetAgainstSnapshot(tactical, targetUnitId) {
  return validatePsiHostileTargetAgainstSnapshot(
    tactical,
    targetUnitId,
    'target is not a hostile threat eligible for panic',
  );
}

function validatePsiMindControlTargetAgainstSnapshot(tactical, targetUnitId) {
  return validatePsiHostileTargetAgainstSnapshot(
    tactical,
    targetUnitId,
    'target is not a hostile threat eligible for mind control',
  );
}

function validatePsiPanicAgainstSnapshot(command, tactical, snapshotSha256Lower) {
  const parsed = parsePsiPanicCommand(command);
  validateBindingAgainstSnapshot(command, tactical, snapshotSha256Lower);
  const actor = validateActorAgainstSnapshot(command, tactical);
  validatePsiActorEligibility(actor);
  validatePsiAmpHandAgainstSnapshot(actor, parsed);
  const target = validatePsiPanicTargetAgainstSnapshot(tactical, parsed.targetUnitId);

  const planningHints = [];
  const psiSkillAdvisory = validatePsiSkillWhenExported(actor);
  if (psiSkillAdvisory) {
    planningHints.push(psiSkillAdvisory);
  }
  const tuAdvisory = validatePsiPanicTuAgainstSnapshot(actor, parsed.activeHand);
  if (tuAdvisory) {
    planningHints.push(tuAdvisory);
  }

  return {
    snapshotId: computeSnapshotId(tactical),
    actor,
    target,
    psiAmpBattleItemId: parsed.psiAmpBattleItemId,
    planningHint: buildPsiPlanningHint(planningHints),
  };
}

function buildPsiPlanningHint(planningHints, { mindControl = false } = {}) {
  const mindControlNote = mindControl
    ? ' Faction conversion and mind-controlled aliens remaining non-commandable in M1 are engine-authoritative.'
    : '';
  if (planningHints.length) {
    return {
      advisory: true,
      items: planningHints,
      note: `Psychic success, failure, and TU spend on failed attacks are engine-authoritative (no Node RNG).${mindControlNote}`,
    };
  }
  return {
    advisory: true,
    note: `Psychic resolution and visibility re-checks are engine-authoritative.${mindControlNote}`,
  };
}

function validatePsiMindControlAgainstSnapshot(command, tactical, snapshotSha256Lower) {
  const parsed = parsePsiMindControlCommand(command);
  validateBindingAgainstSnapshot(command, tactical, snapshotSha256Lower);
  const actor = validateActorAgainstSnapshot(command, tactical);
  validatePsiActorEligibility(actor);
  validatePsiAmpHandAgainstSnapshot(actor, parsed);
  const target = validatePsiMindControlTargetAgainstSnapshot(tactical, parsed.targetUnitId);

  const planningHints = [];
  const psiSkillAdvisory = validatePsiSkillWhenExported(actor);
  if (psiSkillAdvisory) {
    planningHints.push(psiSkillAdvisory);
  }
  const tuAdvisory = validatePsiMindControlTuAgainstSnapshot(actor, parsed.activeHand);
  if (tuAdvisory) {
    planningHints.push(tuAdvisory);
  }

  return {
    snapshotId: computeSnapshotId(tactical),
    actor,
    target,
    psiAmpBattleItemId: parsed.psiAmpBattleItemId,
    planningHint: buildPsiPlanningHint(planningHints, { mindControl: true }),
  };
}

/**
 * Dispatch psi snapshot validation (S1). PSI_PANIC and PSI_MIND_CONTROL.
 */
function validatePsiTacticalCommandAgainstSnapshot(command, tactical, snapshotSha256Lower) {
  if (command && command.command_type === COMMAND_TYPE_PSI_PANIC) {
    return validatePsiPanicAgainstSnapshot(command, tactical, snapshotSha256Lower);
  }
  if (command && command.command_type === COMMAND_TYPE_PSI_MIND_CONTROL) {
    return validatePsiMindControlAgainstSnapshot(command, tactical, snapshotSha256Lower);
  }
  throw new ValidationError('unsupported command_type');
}

function validateActorListedInPlayerSoldiers(command, options = {}) {
  if (!options || !options.commandBinding) {
    return;
  }
  const binding = options.commandBinding;
  assert(Array.isArray(binding.player_soldiers), 'commandBinding.player_soldiers required');
  const listed = binding.player_soldiers.some((s) => s && s.id === command.actor_unit_id);
  assert(listed, 'actor_unit_id must be listed in commandBinding.player_soldiers');
}

function validateMeleeActorEligibility(actor) {
  assert(isFriendlyRosterSoldier(actor), 'actor must be a friendly roster soldier in snapshot');
  assert(isCommandApplicableForBinding(actor), 'actor is not command-applicable at export');
}

function validateMeleeWeaponHandAgainstSnapshot(actor, parsed) {
  const handEquip = findHandEquipment(actor, parsed.activeHand);
  assert(handEquip, `no equipment in ${parsed.activeHand}`);
  const battleItemId = handHeldWeaponBattleItemId(actor, handCostsKey(parsed.activeHand));
  assert(
    battleItemId === parsed.meleeWeaponBattleItemId,
    'melee_weapon_battle_item_id must match weapon in the declared hand',
  );
  assert(handEquip.battleType === BT_MELEE, 'active_hand item must be a melee weapon');
  if (typeof handEquip.slot === 'string' && handEquip.slot.length > 0) {
    assert(handEquip.slot === parsed.activeHand, 'melee weapon snapshot slot does not match active_hand');
  }
  return handEquip;
}

function validateMeleeActionAffordanceAgainstSnapshot(actor, activeHand) {
  if (!actor.actionCosts || !actor.actionCosts.hands) {
    return {
      advisory: true,
      note: 'actionCosts not in snapshot; engine enforces melee affordance and TU',
    };
  }
  const meleeAction = findFireActionOnActor(actor, activeHand, MELEE_ACTION_ID);
  assert(meleeAction, 'weapon in active_hand does not expose melee action in actionCosts');
  assert(meleeAction.usable !== false, 'melee action not usable in current conditions');
  assert(meleeAction.canAffordTu !== false, 'insufficient TU for melee (export)');
  return null;
}

function buildMeleeTargetGeometryAdvisory(actor, target) {
  const advisories = [];
  if (!Array.isArray(actor.position) || !Array.isArray(target.position)) {
    return {
      advisory: true,
      code: 'melee_geometry_unknown',
      note: 'Melee range, facing, turning, elevation, and obstruction are engine-authoritative (validMeleeRange / canTargetUnit).',
    };
  }
  const dx = Math.abs(actor.position[0] - target.position[0]);
  const dy = Math.abs(actor.position[1] - target.position[1]);
  const dz = Math.abs(actor.position[2] - target.position[2]);
  if (dx > 1 || dy > 1) {
    advisories.push({
      code: 'target_beyond_one_tile',
      note: 'Export positions suggest the target may be outside native one-step melee range; engine validates validMeleeRange.',
    });
  }
  if (dz > 0) {
    advisories.push({
      code: 'target_different_elevation',
      note: 'Different Z levels may still be melee-legal via floor-hole rules; engine-authoritative.',
    });
  }
  if (advisories.length === 0) {
    return null;
  }
  return { advisory: true, items: advisories };
}

function buildMeleePlanningHint(planningHints) {
  if (planningHints.length) {
    return {
      advisory: true,
      items: planningHints,
      note: 'Melee hit chance, miss outcomes, and incapacitation are engine-authoritative (no Node RNG).',
    };
  }
  return {
    advisory: true,
    note: 'Melee range, turning, obstruction, and elevation are engine-authoritative.',
  };
}

function validateMeleeHostileTargetAgainstSnapshot(tactical, targetUnitId) {
  return validatePsiHostileTargetAgainstSnapshot(
    tactical,
    targetUnitId,
    'target is not a hostile threat eligible for melee attack',
  );
}

function validateMeleeAgainstSnapshot(command, tactical, snapshotSha256Lower, options = {}) {
  const parsed = parseMeleeAttackCommand(command);
  validateBindingAgainstSnapshot(command, tactical, snapshotSha256Lower);
  const actor = validateActorAgainstSnapshot(command, tactical);
  validateMeleeActorEligibility(actor);
  validateActorListedInPlayerSoldiers(command, options);
  validateMeleeWeaponHandAgainstSnapshot(actor, parsed);
  const target = validateMeleeHostileTargetAgainstSnapshot(tactical, parsed.targetUnitId);

  const planningHints = [];
  const affordanceAdvisory = validateMeleeActionAffordanceAgainstSnapshot(actor, parsed.activeHand);
  if (affordanceAdvisory) {
    planningHints.push(affordanceAdvisory);
  }
  const geometryAdvisory = buildMeleeTargetGeometryAdvisory(actor, target);
  if (geometryAdvisory) {
    planningHints.push(geometryAdvisory);
  }

  return {
    snapshotId: computeSnapshotId(tactical),
    actor,
    target,
    meleeWeaponBattleItemId: parsed.meleeWeaponBattleItemId,
    planningHint: buildMeleePlanningHint(planningHints),
  };
}

function validateMeleeTacticalCommandAgainstSnapshot(command, tactical, snapshotSha256Lower, options = {}) {
  if (command && command.command_type === COMMAND_TYPE_MELEE_ATTACK) {
    return validateMeleeAgainstSnapshot(command, tactical, snapshotSha256Lower, options);
  }
  throw new ValidationError('unsupported command_type');
}

/**
 * Dispatch medikit snapshot validation (S1). Also available via validateTacticalCommandAgainstSnapshot.
 */
function validateMedikitTacticalCommandAgainstSnapshot(command, tactical, snapshotSha256Lower) {
  const commandType = command && command.command_type;
  if (commandType === COMMAND_TYPE_HEAL) {
    return validateHealAgainstSnapshot(command, tactical, snapshotSha256Lower);
  }
  if (commandType === COMMAND_TYPE_STIMULANT) {
    return validateStimulantAgainstSnapshot(command, tactical, snapshotSha256Lower);
  }
  if (commandType === COMMAND_TYPE_PAINKILLER) {
    return validatePainKillerAgainstSnapshot(command, tactical, snapshotSha256Lower);
  }
  throw new ValidationError('unsupported command_type');
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
  if (raw.command_type === COMMAND_TYPE_HWP_MOVE) {
    return parseHwpMoveCommand(raw);
  }
  if (raw.command_type === COMMAND_TYPE_HWP_TURN) {
    return parseHwpTurnCommand(raw);
  }
  if (raw.command_type === COMMAND_TYPE_HWP_FIRE) {
    return parseHwpFireCommand(raw);
  }
  if (raw.command_type === COMMAND_TYPE_KNEEL) {
    return parseKneelCommand(raw);
  }
  if (raw.command_type === COMMAND_TYPE_STAND) {
    return parseStandCommand(raw);
  }
  if (raw.command_type === COMMAND_TYPE_TURN_FACE) {
    return parseTurnFaceCommand(raw);
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
  if (raw.command_type === COMMAND_TYPE_GUIDED_LAUNCH) {
    return parseGuidedLaunchCommand(raw);
  }
  if (raw.command_type === COMMAND_TYPE_HEAL) {
    return parseHealCommand(raw);
  }
  if (raw.command_type === COMMAND_TYPE_STIMULANT) {
    return parseStimulantCommand(raw);
  }
  if (raw.command_type === COMMAND_TYPE_PAINKILLER) {
    return parsePainKillerCommand(raw);
  }
  if (raw.command_type === COMMAND_TYPE_PSI_PANIC) {
    return parsePsiPanicCommand(raw);
  }
  if (raw.command_type === COMMAND_TYPE_PSI_MIND_CONTROL) {
    return parsePsiMindControlCommand(raw);
  }
  if (raw.command_type === COMMAND_TYPE_MELEE_ATTACK) {
    return parseMeleeAttackCommand(raw);
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
  assert(isFriendlyRosterSoldier(actor), 'MOVE actor must be a roster soldier, not an HWP');
  return actor;
}

function isHwpOperationalInSnapshot(actor) {
  if (actor.battlefieldPlacement === 'carried_in_inventory') {
    return false;
  }
  const obs = actor.friendlyHwpObservationV1;
  if (obs && typeof obs.health === 'number') {
    return obs.health > 0;
  }
  if (actor.condition && actor.condition.alive === false) {
    return false;
  }
  return true;
}

function validateHwpActorAgainstSnapshot(command, tactical) {
  const actor = tactical.units.find((u) => u.id === command.actor_unit_id);
  assert(actor, 'actor_unit_id not in snapshot');
  assert(isFriendlyHwpUnit(actor), 'HWP command actor must be a friendly HWP in snapshot');
  assert(command.actor_unit_id >= MAX_ROSTER_UNIT_ID_EXCLUSIVE, 'HWP actor id out of band');
  assert(isHwpOperationalInSnapshot(actor), 'HWP actor is not operational at export');
  return actor;
}

function validateHwpActorListedInPlayerHwps(command, options = {}) {
  if (!options || !options.commandBinding) {
    return;
  }
  const binding = options.commandBinding;
  assert(Array.isArray(binding.player_hwps), 'commandBinding.player_hwps required for HWP_MOVE');
  const listed = binding.player_hwps.find((h) => h && h.id === command.actor_unit_id);
  assert(listed, 'actor_unit_id must be listed in commandBinding.player_hwps');
  assert(listed.controlMode === 'ai', 'HWP must be AI-owned in commandBinding for HWP_MOVE');
  assert(listed.commandExecutionSupported === false,
    'binding must keep HWP commandExecutionSupported false for non-MOVE HWP types');
  assert(listed.hwpMoveExecutionSupported === true,
    'binding must report hwpMoveExecutionSupported for HWP_MOVE publish validation');
}

function findHwpFixedWeapon(actor, weaponBattleItemId) {
  const obs = actor?.friendlyHwpObservationV1;
  const weapons = obs?.fixedWeapons;
  if (!Array.isArray(weapons)) {
    return null;
  }
  const matches = weapons.filter((w) => w && w.battleItemId === weaponBattleItemId);
  if (matches.length !== 1) {
    return null;
  }
  return matches[0];
}

function findHwpFireActionOnWeapon(weapon, fireMode) {
  const actionId = HWP_FIRE_MODE_ACTION_IDS[fireMode];
  if (!actionId || !weapon || !Array.isArray(weapon.actionCosts)) {
    return null;
  }
  return weapon.actionCosts.find((entry) => entry && entry.id === actionId) || null;
}

function assertHwpFixedWeaponHasFireableAmmo(weapon) {
  assert(weapon, 'fixed weapon required');
  const hasMagazineFields = weapon.nestedAmmo != null || weapon.loaded != null
    || weapon.noMagazineInserted === true || weapon.empty === true;
  if (!hasMagazineFields) {
    return;
  }
  if (weapon.noMagazineInserted === true) {
    throw new ValidationError('fixed weapon has no magazine inserted');
  }
  if (weapon.empty === true) {
    throw new ValidationError('fixed weapon is empty at export');
  }
  if (weapon.nestedAmmo && weapon.nestedAmmo.rounds === 0) {
    throw new ValidationError('fixed weapon magazine has no rounds');
  }
  if (weapon.loaded && weapon.loaded.rounds === 0) {
    throw new ValidationError('fixed weapon has no rounds loaded');
  }
}

function validateHwpActorListedForHwpFire(command, options = {}) {
  if (!options || !options.commandBinding) {
    return;
  }
  const binding = options.commandBinding;
  assert(Array.isArray(binding.player_hwps), 'commandBinding.player_hwps required for HWP_FIRE');
  const listed = binding.player_hwps.find((h) => h && h.id === command.actor_unit_id);
  assert(listed, 'actor_unit_id must be listed in commandBinding.player_hwps');
  assert(listed.controlMode === 'ai', 'HWP must be AI-owned in commandBinding for HWP_FIRE');
  assert(listed.commandExecutionSupported === false,
    'binding must keep HWP commandExecutionSupported false');
  assert(listed.hwpFireExecutionSupported === true,
    'binding must report hwpFireExecutionSupported for HWP_FIRE publish validation');
}

function validateHwpActorListedForHwpTurn(command, options = {}) {
  if (!options || !options.commandBinding) {
    return;
  }
  const binding = options.commandBinding;
  assert(Array.isArray(binding.player_hwps), 'commandBinding.player_hwps required for HWP_TURN');
  const listed = binding.player_hwps.find((h) => h && h.id === command.actor_unit_id);
  assert(listed, 'actor_unit_id must be listed in commandBinding.player_hwps');
  assert(listed.controlMode === 'ai', 'HWP must be AI-owned in commandBinding for HWP_TURN');
  assert(listed.commandExecutionSupported === false,
    'binding must keep HWP commandExecutionSupported false');
  assert(listed.hwpTurnExecutionSupported === true,
    'binding must report hwpTurnExecutionSupported for HWP_TURN publish validation');
}

function assertHwpTurnTargetDiffersFromActor(command, actor) {
  const obs = actor.friendlyHwpObservationV1;
  const pos = obs?.position
    ? [obs.position.x, obs.position.y, obs.position.z ?? 0]
    : (Array.isArray(actor.position) ? actor.position : null);
  if (!pos || pos.length < 3) {
    return;
  }
  const sameTile = command.target.x === pos[0]
    && command.target.y === pos[1]
    && command.target.z === pos[2];
  assert(!sameTile, 'target must differ from actor position (facing bearing)');
}

function validateHwpTurnCapabilities(command, actor) {
  const obs = actor.friendlyHwpObservationV1;
  assert(obs, 'HWP_TURN requires friendlyHwpObservationV1 on actor');
  assert(obs.capabilities, 'HWP capabilities required for HWP_TURN');
  if (command.turn_part === 'body') {
    assert(obs.capabilities.bodyTurn === true, 'HWP body turn not supported at export');
  } else if (command.turn_part === 'turret') {
    assert(obs.capabilities.turretTurn === true, 'HWP turret turn not supported at export');
  }
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
  const planningHint = buildMovePlanningHint(actor);
  return { snapshotId: computeSnapshotId(tactical), actor, planningHint };
}

function isHwpMoveCommandType(commandType) {
  return commandType === COMMAND_TYPE_HWP_MOVE;
}

function validateHwpMoveAgainstSnapshot(command, tactical, snapshotSha256Lower, options = {}) {
  parseHwpMoveCommand(command);
  validateBindingAgainstSnapshot(command, tactical, snapshotSha256Lower);
  assert(command.destination.x < tactical.map.width
    && command.destination.y < tactical.map.height
    && command.destination.z < tactical.map.depth, 'destination out of map bounds');
  const actor = validateHwpActorAgainstSnapshot(command, tactical);
  validateHwpActorListedInPlayerHwps(command, options);
  const planningHint = buildHwpMovePlanningHint(actor);
  return { snapshotId: computeSnapshotId(tactical), actor, planningHint };
}

function isHwpTurnCommandType(commandType) {
  return commandType === COMMAND_TYPE_HWP_TURN;
}

function isHwpFireCommandType(commandType) {
  return commandType === COMMAND_TYPE_HWP_FIRE;
}

function validateHwpFireAgainstSnapshot(command, tactical, snapshotSha256Lower, options = {}) {
  const parsed = parseHwpFireCommand(command);
  validateBindingAgainstSnapshot(command, tactical, snapshotSha256Lower);
  assert(command.target.x < tactical.map.width
    && command.target.y < tactical.map.height
    && command.target.z < tactical.map.depth, 'target out of map bounds');
  const actor = validateHwpActorAgainstSnapshot(command, tactical);
  validateHwpActorListedForHwpFire(command, options);
  const weapon = findHwpFixedWeapon(actor, parsed.weaponBattleItemId);
  assert(weapon, 'weapon_battle_item_id must match exactly one fixed weapon on HWP actor');
  assertHwpFixedWeaponHasFireableAmmo(weapon);
  const fireAction = findHwpFireActionOnWeapon(weapon, parsed.fireMode);
  assert(fireAction, `fixed weapon does not support ${parsed.fireMode} fire mode at export`);
  assert(fireAction.usable !== false, 'fire mode not usable for weapon or ammunition');
  assert(fireAction.canAffordTu !== false, 'insufficient TU for fire mode (fire TU only)');
  const fireTuCost = typeof fireAction.tuCost === 'number' ? fireAction.tuCost : null;
  const planningHint = buildHwpFirePlanningHint(actor, parsed.target, parsed.fireMode, {
    fireTuCost,
    fireAction,
  });
  return {
    snapshotId: computeSnapshotId(tactical),
    actor,
    target: parsed.target,
    fireMode: parsed.fireMode,
    weaponBattleItemId: parsed.weaponBattleItemId,
    weapon,
    planningHint,
  };
}

function validateHwpTurnAgainstSnapshot(command, tactical, snapshotSha256Lower, options = {}) {
  const parsed = parseHwpTurnCommand(command);
  validateBindingAgainstSnapshot(command, tactical, snapshotSha256Lower);
  assert(command.target.x < tactical.map.width
    && command.target.y < tactical.map.height
    && command.target.z < tactical.map.depth, 'target out of map bounds');
  const actor = validateHwpActorAgainstSnapshot(command, tactical);
  validateHwpTurnCapabilities(command, actor);
  validateHwpActorListedForHwpTurn(command, options);
  assertHwpTurnTargetDiffersFromActor(command, actor);
  const planningHint = buildHwpTurnPlanningHint(actor, parsed.target, parsed.turnPart);
  return {
    snapshotId: computeSnapshotId(tactical),
    actor,
    target: parsed.target,
    turnPart: parsed.turnPart,
    planningHint,
  };
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

function validateTurnFaceActorEligibility(actor) {
  assert(isFriendlyRosterSoldier(actor), 'actor must be a friendly roster soldier in snapshot');
  assert(isCommandApplicableForBinding(actor), 'actor is not command-applicable at export');
}

function validateTurnFaceTargetBounds(command, tactical) {
  assert(command.target.x < tactical.map.width
    && command.target.y < tactical.map.height
    && command.target.z < tactical.map.depth, 'target out of map bounds');
}

function assertTurnFaceTargetDiffersFromActor(command, actor) {
  if (!Array.isArray(actor.position) || actor.position.length < 3) {
    return;
  }
  const sameTile = command.target.x === actor.position[0]
    && command.target.y === actor.position[1]
    && command.target.z === actor.position[2];
  assert(!sameTile, 'target must differ from actor position (facing bearing)');
}

function validateTurnFaceAgainstSnapshot(command, tactical, snapshotSha256Lower, options = {}) {
  const parsed = parseTurnFaceCommand(command);
  validateBindingAgainstSnapshot(command, tactical, snapshotSha256Lower);
  const actor = validateActorAgainstSnapshot(command, tactical);
  validateTurnFaceActorEligibility(actor);
  validateActorListedInPlayerSoldiers(command, options);
  validateTurnFaceTargetBounds(command, tactical);
  assertTurnFaceTargetDiffersFromActor(command, actor);
  const planningHint = buildTurnFacePlanningHint(actor, parsed.target);
  return {
    snapshotId: computeSnapshotId(tactical),
    actor,
    target: parsed.target,
    planningHint,
  };
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
  assert(fireAction.canAffordTu !== false, 'insufficient TU for fire mode (fire TU only)');
  const planningHint = {
    ...buildFirePlanningHint(actor, activeHand, commandType),
    composite: buildDirectedFireCompositeHint(actor, command.target, fireAction.tuCost),
  };
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

function lookupRulesReferenceItem(rulesReference, itemType) {
  if (!rulesReference || typeof itemType !== 'string' || itemType.length === 0) {
    return null;
  }
  const doc = typeof rulesReference === 'string' ? JSON.parse(rulesReference) : rulesReference;
  if (!doc || !Array.isArray(doc.items)) {
    return null;
  }
  return doc.items.find((row) => row && row.type === itemType) || null;
}

/**
 * Mirror BattlescapeGame primaryAction: weapon waypoints, else loaded ammo ruleset cap.
 * @returns {{ kind: 'finite', max: number } | { kind: 'unlimited' } | { kind: 'unknown' }}
 */
function resolveGuidedWaypointLimit(handEquip, rulesReference) {
  if (!handEquip || typeof handEquip.itemType !== 'string') {
    return { kind: 'unknown' };
  }
  const weaponRule = lookupRulesReferenceItem(rulesReference, handEquip.itemType);
  let cap = weaponRule && Number.isInteger(weaponRule.waypoints) ? weaponRule.waypoints : 0;
  if (cap === 0 && handEquip.nestedAmmo && typeof handEquip.nestedAmmo.ammoType === 'string') {
    const ammoRule = lookupRulesReferenceItem(rulesReference, handEquip.nestedAmmo.ammoType);
    if (ammoRule && Number.isInteger(ammoRule.waypoints)) {
      cap = ammoRule.waypoints;
    }
  }
  if (cap === -1) {
    return { kind: 'unlimited' };
  }
  if (cap > 0) {
    return { kind: 'finite', max: cap };
  }
  return { kind: 'unknown' };
}

function assertGuidedLauncherLoaded(handEquip) {
  assert(handEquip, 'no equipment in active_hand');
  assert(handEquip.battleType === BT_FIREARM, 'guided launch requires a firearm-class weapon in hand');
  assert(handEquip.noMagazineInserted !== true, 'guided launcher has no ammunition loaded');
  const nested = handEquip.nestedAmmo;
  assert(nested && Number.isInteger(nested.rounds) && nested.rounds > 0, 'guided launcher ammunition is empty');
}

function assertLaunchActionAffordable(launchAction) {
  assert(launchAction, 'hand item does not support guided launch');
  assert(launchAction.usable !== false, 'guided launch not usable for weapon or ammunition');
  assert(launchAction.canAffordTu !== false, 'insufficient TU for guided launch');
  if (launchAction.canAffordTuWithCurrentReservation === false) {
    throw new ValidationError('insufficient TU with current reservation for guided launch');
  }
  if (launchAction.reservationWouldBlock === true) {
    throw new ValidationError('TU reservation would block guided launch');
  }
}

function validateWaypointMapBounds(waypoints, tactical) {
  const { width, height, depth } = tactical.map;
  for (let i = 0; i < waypoints.length; i += 1) {
    const wp = waypoints[i];
    assert(
      wp.x >= 0 && wp.x < width && wp.y >= 0 && wp.y < height && wp.z >= 0 && wp.z < depth,
      `waypoints[${i}] out of map bounds`,
    );
  }
}

function assertWaypointCountWithinRulesetLimit(waypointCount, limit, rulesReferencePresent) {
  if (limit.kind === 'unlimited') {
    return;
  }
  if (limit.kind === 'finite') {
    assert(
      waypointCount <= limit.max,
      `waypoint count exceeds ruleset maximum (${limit.max})`,
    );
    return;
  }
  assert(
    rulesReferencePresent,
    'rules reference required to validate guided launch waypoint cap for this weapon',
  );
}

function buildGuidedLaunchPlanningHint(actor, activeHand, waypoints, launchAction) {
  const first = waypoints.length > 0 ? waypoints[0] : null;
  const facing = first ? buildDirectedFireCompositeHint(actor, first, launchAction.tuCost) : null;
  return {
    advisory: true,
    note: 'Non-authoritative; trajectory, drift, and leg impacts are engine-owned after launch starts.',
    waypointCount: waypoints.length,
    launchTuCost: typeof launchAction.tuCost === 'number' ? launchAction.tuCost : null,
    ...(facing ? { firstLegFacing: facing } : {}),
  };
}

/**
 * @param {object} [options]
 * @param {object|string} [options.rulesReference] — optional rules-reference JSON for waypoint caps (not a snapshot field).
 */
function validateGuidedLaunchAgainstSnapshot(command, tactical, snapshotSha256Lower, options = {}) {
  parseGuidedLaunchCommand(command);
  validateBindingAgainstSnapshot(command, tactical, snapshotSha256Lower);
  const waypoints = command.waypoints;
  validateWaypointMapBounds(waypoints, tactical);
  const actor = validateActorAgainstSnapshot(command, tactical);
  const activeHand = command.active_hand || command.activeHand;
  const handEquip = findHandEquipment(actor, activeHand);
  assertGuidedLauncherLoaded(handEquip);
  const launchAction = findFireActionOnActor(actor, activeHand, GUIDED_LAUNCH_ACTION_ID);
  assertLaunchActionAffordable(launchAction);
  const limit = resolveGuidedWaypointLimit(handEquip, options.rulesReference);
  assertWaypointCountWithinRulesetLimit(
    waypoints.length,
    limit,
    options.rulesReference != null,
  );
  const planningHint = buildGuidedLaunchPlanningHint(actor, activeHand, waypoints, launchAction);
  if (limit.kind === 'unknown') {
    planningHint.waypointCapVerification = 'deferred_to_engine';
    planningHint.note += ' Waypoint maximum not verified in Node; engine ruleset enforces cap.';
  } else if (limit.kind === 'unlimited') {
    planningHint.waypointCapVerification = 'unlimited_ruleset';
  } else {
    planningHint.waypointCapVerification = 'verified';
    planningHint.waypointMaxRuleset = limit.max;
  }
  return { snapshotId: computeSnapshotId(tactical), actor, planningHint, waypointLimit: limit };
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

function validateTacticalCommandAgainstSnapshot(command, tactical, snapshotSha256Lower, options = {}) {
  if (command && command.command_type === COMMAND_TYPE_MOVE) {
    return validateMoveAgainstSnapshot(command, tactical, snapshotSha256Lower);
  }
  if (command && command.command_type === COMMAND_TYPE_HWP_MOVE) {
    return validateHwpMoveAgainstSnapshot(command, tactical, snapshotSha256Lower, options);
  }
  if (command && command.command_type === COMMAND_TYPE_HWP_TURN) {
    return validateHwpTurnAgainstSnapshot(command, tactical, snapshotSha256Lower, options);
  }
  if (command && command.command_type === COMMAND_TYPE_HWP_FIRE) {
    return validateHwpFireAgainstSnapshot(command, tactical, snapshotSha256Lower, options);
  }
  if (command && command.command_type === COMMAND_TYPE_KNEEL) {
    return validateKneelAgainstSnapshot(command, tactical, snapshotSha256Lower);
  }
  if (command && command.command_type === COMMAND_TYPE_STAND) {
    return validateStandAgainstSnapshot(command, tactical, snapshotSha256Lower);
  }
  if (command && command.command_type === COMMAND_TYPE_TURN_FACE) {
    return validateTurnFaceAgainstSnapshot(command, tactical, snapshotSha256Lower, options);
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
  if (command && command.command_type === COMMAND_TYPE_GUIDED_LAUNCH) {
    return validateGuidedLaunchAgainstSnapshot(command, tactical, snapshotSha256Lower, options);
  }
  if (command && command.command_type === COMMAND_TYPE_HEAL) {
    return validateHealAgainstSnapshot(command, tactical, snapshotSha256Lower);
  }
  if (command && command.command_type === COMMAND_TYPE_STIMULANT) {
    return validateStimulantAgainstSnapshot(command, tactical, snapshotSha256Lower);
  }
  if (command && command.command_type === COMMAND_TYPE_PAINKILLER) {
    return validatePainKillerAgainstSnapshot(command, tactical, snapshotSha256Lower);
  }
  if (command && command.command_type === COMMAND_TYPE_PSI_PANIC) {
    return validatePsiPanicAgainstSnapshot(command, tactical, snapshotSha256Lower);
  }
  if (command && command.command_type === COMMAND_TYPE_PSI_MIND_CONTROL) {
    return validatePsiMindControlAgainstSnapshot(command, tactical, snapshotSha256Lower);
  }
  if (command && command.command_type === COMMAND_TYPE_MELEE_ATTACK) {
    return validateMeleeAgainstSnapshot(command, tactical, snapshotSha256Lower, options);
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

function validateTacticalCommandAgainstSnapshotFile(
  command,
  snapshotPath,
  yaml,
  readFileSync = fs.readFileSync,
  options = {},
) {
  const snapshotBytes = readSnapshotByteBuffer(readFileSync, snapshotPath);
  const digest = sha256HexLower(snapshotBytes);
  const tactical = loadAndValidateSnapshotFromText(snapshotBytes.toString('utf8'), yaml);
  validateTacticalCommandAgainstSnapshot(command, tactical, digest, options);
  return { tactical, digest, snapshotId: computeSnapshotId(tactical) };
}

module.exports = {
  COMMAND_SCHEMA_VERSION,
  RESULT_SCHEMA_VERSION,
  COMMAND_TYPE_MOVE,
  COMMAND_TYPE_HWP_MOVE,
  COMMAND_TYPE_HWP_TURN,
  COMMAND_TYPE_HWP_FIRE,
  HWP_FIRE_MODES,
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
  COMMAND_TYPE_GUIDED_LAUNCH,
  COMMAND_TYPE_HEAL,
  COMMAND_TYPE_STIMULANT,
  COMMAND_TYPE_PAINKILLER,
  COMMAND_TYPE_PSI_PANIC,
  COMMAND_TYPE_PSI_MIND_CONTROL,
  COMMAND_TYPE_MELEE_ATTACK,
  COMMAND_TYPE_TURN_FACE,
  TURN_FACE_COMMAND_TYPES,
  MEDIKIT_COMMAND_TYPES,
  MEDIKIT_USE_ACTION_ID,
  PSI_PANIC_COMMAND_TYPES,
  PSI_MIND_CONTROL_COMMAND_TYPES,
  PSI_TACTICAL_COMMAND_TYPES,
  PSI_PANIC_ACTION_ID,
  PSI_MIND_CONTROL_ACTION_ID,
  MELEE_TACTICAL_COMMAND_TYPES,
  MELEE_ACTION_ID,
  CARRIED_INVENTORY_SLOT_IDS,
  GUIDED_LAUNCH_ACTION_ID,
  DIRECTED_FIRE_COMMAND_TYPES,
  GRENADE_COMMAND_TYPES,
  TERMINAL_STATUSES,
  NON_TERMINAL_STATUSES,
  parseMoveCommand,
  parseHwpMoveCommand,
  parseHwpTurnCommand,
  parseHwpFireCommand,
  parseKneelCommand,
  parseStandCommand,
  parseTurnFaceCommand,
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
  parseGuidedLaunchCommand,
  parseHealCommand,
  parseStimulantCommand,
  parsePainKillerCommand,
  parseMedikitTacticalCommand,
  isMedikitCommandType,
  parsePsiPanicCommand,
  parsePsiMindControlCommand,
  parsePsiTacticalCommand,
  isPsiPanicCommandType,
  isPsiMindControlCommandType,
  isPsiTacticalCommandType,
  parseMeleeAttackCommand,
  parseMeleeTacticalCommand,
  isMeleeTacticalCommandType,
  isTurnFaceCommandType,
  isHwpMoveCommandType,
  isHwpTurnCommandType,
  isHwpFireCommandType,
  parseTacticalCommand,
  commandDigest,
  validateMoveAgainstSnapshot,
  validateHwpMoveAgainstSnapshot,
  validateHwpTurnAgainstSnapshot,
  validateHwpFireAgainstSnapshot,
  validateKneelAgainstSnapshot,
  validateStandAgainstSnapshot,
  validateTurnFaceAgainstSnapshot,
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
  validateGuidedLaunchAgainstSnapshot,
  validateHealAgainstSnapshot,
  validateStimulantAgainstSnapshot,
  validatePainKillerAgainstSnapshot,
  validateMedikitTacticalCommandAgainstSnapshot,
  validatePsiPanicAgainstSnapshot,
  validatePsiMindControlAgainstSnapshot,
  validatePsiTacticalCommandAgainstSnapshot,
  validateMeleeAgainstSnapshot,
  validateMeleeTacticalCommandAgainstSnapshot,
  validateActorListedInPlayerSoldiers,
  resolveGuidedWaypointLimit,
  validateTacticalCommandAgainstSnapshot,
  validateMoveAgainstSnapshotFile,
  validateTacticalCommandAgainstSnapshotFile,
  buildFirePlanningHint,
  buildMovePlanningHint,
  buildDirectedFireCompositeHint,
  buildGrenadePlanningHint,
  buildResultEnvelope,
  parseResultStatus,
  isTerminalStatus,
  canAcceptNewCommand,
};
