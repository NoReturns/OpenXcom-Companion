'use strict';

const { SNAPSHOT_SHA256_RE } = require('./briefing-request.cjs');

const BINDING_SCHEMA_VERSION = 1;

class CommandBindingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CommandBindingError';
  }
}

function assert(condition, message) {
  if (!condition) throw new CommandBindingError(message);
}

function isPlayerSoldier(unit) {
  return unit && unit.faction === 0 && unit.originalFaction === 0;
}

/**
 * Verified MOVE authoring metadata for remote commanders.
 * Lives on the relay envelope beside `tactical`; does not affect snapshot_id.
 * snapshot_sha256 must be the digest of on-disk tactical YAML bytes at publish time.
 */
function buildCommandBinding(tactical, snapshotSha256Lower) {
  assert(typeof snapshotSha256Lower === 'string' && SNAPSHOT_SHA256_RE.test(snapshotSha256Lower),
    'snapshot_sha256 must be 64 lowercase hex from verified YAML bytes');
  assert(tactical.eventLog && typeof tactical.eventLog.sessionId === 'string',
    'eventLog.sessionId required for command binding');
  assert(Number.isInteger(tactical.eventLog.latestSeq) && tactical.eventLog.latestSeq >= 0,
    'eventLog.latestSeq required for state_version semantics');
  assert(tactical.map && Number.isInteger(tactical.map.width), 'map dimensions required');

  const playerSoldiers = tactical.units.filter(isPlayerSoldier).map((u) => ({
    id: u.id,
    position: u.position,
    timeUnits: u.timeUnits,
    kneeled: u.kneeled === true,
    name: typeof u.name === 'string' ? u.name : undefined,
  }));

  return {
    schema_version: BINDING_SCHEMA_VERSION,
    move_command_schema_version: 1,
    snapshot_sha256: snapshotSha256Lower,
    state_version: tactical.eventLog.latestSeq,
    session_id: tactical.eventLog.sessionId,
    turn: tactical.turn,
    side: tactical.side,
    map: {
      width: tactical.map.width,
      height: tactical.map.height,
      depth: tactical.map.depth,
    },
    selected_unit_id: tactical.selectedUnitId ?? null,
    player_soldiers: playerSoldiers,
    ownership_note: 'All soldiers default to human control locally. Remote commands cannot assign AI; owner must set companion-soldier-control.json.',
    destination_note: 'Choose destination from terrainMapBrief, terrainBrief, terrain-query relay, or visible snapshot geometry only.',
  };
}

function parseCommandBinding(raw) {
  assert(raw && typeof raw === 'object', 'commandBinding must be an object');
  assert(raw.schema_version === BINDING_SCHEMA_VERSION, 'unsupported commandBinding schema_version');
  assert(typeof raw.snapshot_sha256 === 'string' && SNAPSHOT_SHA256_RE.test(raw.snapshot_sha256),
    'commandBinding.snapshot_sha256 invalid');
  assert(Number.isInteger(raw.state_version) && raw.state_version >= 0, 'commandBinding.state_version invalid');
  assert(typeof raw.session_id === 'string' && /^[a-f0-9]{32}$/.test(raw.session_id),
    'commandBinding.session_id invalid');
  assert(Number.isInteger(raw.turn) && raw.turn >= 1, 'commandBinding.turn invalid');
  return raw;
}

/**
 * Build a complete m0/tactical-command.json object from relay-visible binding + choices.
 */
function composeKneelCommand(binding, { commandId, actorUnitId }) {
  const b = parseCommandBinding(binding);
  assert(typeof commandId === 'string' && commandId.length > 0, 'commandId required');
  assert(Number.isInteger(actorUnitId) && actorUnitId > 0, 'actorUnitId required');
  const soldier = b.player_soldiers.find((s) => s.id === actorUnitId);
  assert(soldier, 'actorUnitId must be a listed player_soldier');

  return {
    schema_version: 1,
    command_id: commandId,
    command_type: 'KNEEL',
    actor_unit_id: actorUnitId,
    snapshot_sha256: b.snapshot_sha256,
    session_id: b.session_id,
    turn: b.turn,
    state_version: b.state_version,
  };
}

function composeStandCommand(binding, { commandId, actorUnitId }) {
  const b = parseCommandBinding(binding);
  assert(typeof commandId === 'string' && commandId.length > 0, 'commandId required');
  assert(Number.isInteger(actorUnitId) && actorUnitId > 0, 'actorUnitId required');
  const soldier = b.player_soldiers.find((s) => s.id === actorUnitId);
  assert(soldier, 'actorUnitId must be a listed player_soldier');

  return {
    schema_version: 1,
    command_id: commandId,
    command_type: 'STAND',
    actor_unit_id: actorUnitId,
    snapshot_sha256: b.snapshot_sha256,
    session_id: b.session_id,
    turn: b.turn,
    state_version: b.state_version,
  };
}

function composeMoveCommand(binding, { commandId, actorUnitId, destination }) {
  const b = parseCommandBinding(binding);
  assert(typeof commandId === 'string' && commandId.length > 0, 'commandId required');
  assert(Number.isInteger(actorUnitId) && actorUnitId > 0, 'actorUnitId required');
  assert(destination && Number.isInteger(destination.x), 'destination required');
  const soldier = b.player_soldiers.find((s) => s.id === actorUnitId);
  assert(soldier, 'actorUnitId must be a listed player_soldier');
  assert(destination.x >= 0 && destination.x < b.map.width, 'destination.x out of map');
  assert(destination.y >= 0 && destination.y < b.map.height, 'destination.y out of map');
  assert(destination.z >= 0 && destination.z < b.map.depth, 'destination.z out of map');

  return {
    schema_version: 1,
    command_id: commandId,
    command_type: 'MOVE',
    actor_unit_id: actorUnitId,
    destination: { x: destination.x, y: destination.y, z: destination.z },
    snapshot_sha256: b.snapshot_sha256,
    session_id: b.session_id,
    turn: b.turn,
    state_version: b.state_version,
  };
}

function composeDirectedFireCommand(binding, commandType, { commandId, actorUnitId, target, activeHand }) {
  const b = parseCommandBinding(binding);
  assert(typeof commandId === 'string' && commandId.length > 0, 'commandId required');
  assert(Number.isInteger(actorUnitId) && actorUnitId > 0, 'actorUnitId required');
  assert(typeof activeHand === 'string' && (activeHand === 'STR_LEFT_HAND' || activeHand === 'STR_RIGHT_HAND'),
    'activeHand required');
  assert(target && Number.isInteger(target.x), 'target required');
  const soldier = b.player_soldiers.find((s) => s.id === actorUnitId);
  assert(soldier, 'actorUnitId must be a listed player_soldier');
  assert(target.x >= 0 && target.x < b.map.width, 'target.x out of map');
  assert(target.y >= 0 && target.y < b.map.height, 'target.y out of map');
  assert(target.z >= 0 && target.z < b.map.depth, 'target.z out of map');

  return {
    schema_version: 1,
    command_id: commandId,
    command_type: commandType,
    actor_unit_id: actorUnitId,
    active_hand: activeHand,
    target: { x: target.x, y: target.y, z: target.z },
    snapshot_sha256: b.snapshot_sha256,
    session_id: b.session_id,
    turn: b.turn,
    state_version: b.state_version,
  };
}

function composeSnapShotCommand(binding, options) {
  return composeDirectedFireCommand(binding, 'SNAP_SHOT', options);
}

function composeAutoShotCommand(binding, options) {
  return composeDirectedFireCommand(binding, 'AUTO_SHOT', options);
}

function composeAimedShotCommand(binding, options) {
  return composeDirectedFireCommand(binding, 'AIMED_SHOT', options);
}

function composePrimeCommand(binding, { commandId, actorUnitId, activeHand, fuseTimer }) {
  const b = parseCommandBinding(binding);
  assert(typeof commandId === 'string' && commandId.length > 0, 'commandId required');
  assert(Number.isInteger(actorUnitId) && actorUnitId > 0, 'actorUnitId required');
  assert(typeof activeHand === 'string' && (activeHand === 'STR_LEFT_HAND' || activeHand === 'STR_RIGHT_HAND'),
    'activeHand required');
  assert(Number.isInteger(fuseTimer) && fuseTimer >= 0 && fuseTimer <= 23, 'fuseTimer required');
  const soldier = b.player_soldiers.find((s) => s.id === actorUnitId);
  assert(soldier, 'actorUnitId must be a listed player_soldier');

  return {
    schema_version: 1,
    command_id: commandId,
    command_type: 'PRIME',
    actor_unit_id: actorUnitId,
    active_hand: activeHand,
    fuse_timer: fuseTimer,
    snapshot_sha256: b.snapshot_sha256,
    session_id: b.session_id,
    turn: b.turn,
    state_version: b.state_version,
  };
}

function composeThrowCommand(binding, options) {
  return composeDirectedFireCommand(binding, 'THROW', options);
}

function composeReloadCommand(binding, { commandId, actorUnitId, weaponBattleItemId, ammoBattleItemId }) {
  const b = parseCommandBinding(binding);
  assert(typeof commandId === 'string' && commandId.length > 0, 'commandId required');
  assert(Number.isInteger(actorUnitId) && actorUnitId > 0, 'actorUnitId required');
  assert(Number.isInteger(weaponBattleItemId) && weaponBattleItemId > 0, 'weaponBattleItemId required');
  assert(Number.isInteger(ammoBattleItemId) && ammoBattleItemId > 0, 'ammoBattleItemId required');
  assert(weaponBattleItemId !== ammoBattleItemId, 'weapon and ammo item ids must differ');
  const soldier = b.player_soldiers.find((s) => s.id === actorUnitId);
  assert(soldier, 'actorUnitId must be a listed player_soldier');

  return {
    schema_version: 1,
    command_id: commandId,
    command_type: 'RELOAD',
    actor_unit_id: actorUnitId,
    weapon_battle_item_id: weaponBattleItemId,
    ammo_battle_item_id: ammoBattleItemId,
    snapshot_sha256: b.snapshot_sha256,
    session_id: b.session_id,
    turn: b.turn,
    state_version: b.state_version,
  };
}

function composeUnloadCommand(binding, { commandId, actorUnitId, weaponBattleItemId, loadedAmmoBattleItemId }) {
  const b = parseCommandBinding(binding);
  assert(typeof commandId === 'string' && commandId.length > 0, 'commandId required');
  assert(Number.isInteger(actorUnitId) && actorUnitId > 0, 'actorUnitId required');
  assert(Number.isInteger(weaponBattleItemId) && weaponBattleItemId > 0, 'weaponBattleItemId required');
  assert(Number.isInteger(loadedAmmoBattleItemId) && loadedAmmoBattleItemId > 0, 'loadedAmmoBattleItemId required');
  assert(weaponBattleItemId !== loadedAmmoBattleItemId, 'weapon and loaded magazine item ids must differ');
  const soldier = b.player_soldiers.find((s) => s.id === actorUnitId);
  assert(soldier, 'actorUnitId must be a listed player_soldier');

  return {
    schema_version: 1,
    command_id: commandId,
    command_type: 'UNLOAD',
    actor_unit_id: actorUnitId,
    weapon_battle_item_id: weaponBattleItemId,
    loaded_ammo_battle_item_id: loadedAmmoBattleItemId,
    snapshot_sha256: b.snapshot_sha256,
    session_id: b.session_id,
    turn: b.turn,
    state_version: b.state_version,
  };
}

/**
 * Compose INVENTORY_MOVE from binding (WP8B3). Destination is author-supplied;
 * Node preflight defers geometry/TU overlap checks to the engine when unavailable.
 */
function composeInventoryMoveCommand(binding, {
  commandId,
  actorUnitId,
  itemBattleItemId,
  sourceSlot,
  destinationSlot,
  destinationX,
  destinationY,
  sourceX,
  sourceY,
}) {
  const b = parseCommandBinding(binding);
  assert(typeof commandId === 'string' && commandId.length > 0, 'commandId required');
  assert(Number.isInteger(actorUnitId) && actorUnitId > 0, 'actorUnitId required');
  assert(Number.isInteger(itemBattleItemId) && itemBattleItemId > 0, 'itemBattleItemId required');
  assert(typeof sourceSlot === 'string' && sourceSlot.length > 0, 'sourceSlot required');
  assert(typeof destinationSlot === 'string' && destinationSlot.length > 0, 'destinationSlot required');
  assert(Number.isInteger(destinationX) && destinationX >= 0 && destinationX <= 255, 'destinationX required');
  assert(Number.isInteger(destinationY) && destinationY >= 0 && destinationY <= 255, 'destinationY required');
  const soldier = b.player_soldiers.find((s) => s.id === actorUnitId);
  assert(soldier, 'actorUnitId must be a listed player_soldier');

  const cmd = {
    schema_version: 1,
    command_id: commandId,
    command_type: 'INVENTORY_MOVE',
    actor_unit_id: actorUnitId,
    item_battle_item_id: itemBattleItemId,
    source_slot: sourceSlot,
    destination_slot: destinationSlot,
    destination_x: destinationX,
    destination_y: destinationY,
    snapshot_sha256: b.snapshot_sha256,
    session_id: b.session_id,
    turn: b.turn,
    state_version: b.state_version,
  };
  const hasSx = sourceX !== undefined && sourceX !== null;
  const hasSy = sourceY !== undefined && sourceY !== null;
  assert(hasSx === hasSy, 'sourceX and sourceY must both be set or both omitted');
  if (hasSx) {
    assert(Number.isInteger(sourceX) && sourceX >= 0 && sourceX <= 255, 'sourceX invalid');
    assert(Number.isInteger(sourceY) && sourceY >= 0 && sourceY <= 255, 'sourceY invalid');
    cmd.source_x = sourceX;
    cmd.source_y = sourceY;
  }
  return cmd;
}

/**
 * Compose PICKUP from binding (WP8B4). groundPosition must match the actor's tile export (binding player_soldiers[].position).
 */
function composePickupCommand(binding, {
  commandId,
  actorUnitId,
  itemBattleItemId,
  groundPosition,
  destinationSlot,
  destinationX,
  destinationY,
}) {
  const b = parseCommandBinding(binding);
  assert(typeof commandId === 'string' && commandId.length > 0, 'commandId required');
  assert(Number.isInteger(actorUnitId) && actorUnitId > 0, 'actorUnitId required');
  assert(Number.isInteger(itemBattleItemId) && itemBattleItemId > 0, 'itemBattleItemId required');
  assert(groundPosition && Number.isInteger(groundPosition.x), 'groundPosition required');
  assert(typeof destinationSlot === 'string' && destinationSlot.length > 0, 'destinationSlot required');
  assert(Number.isInteger(destinationX) && destinationX >= 0 && destinationX <= 255, 'destinationX required');
  assert(Number.isInteger(destinationY) && destinationY >= 0 && destinationY <= 255, 'destinationY required');
  const soldier = b.player_soldiers.find((s) => s.id === actorUnitId);
  assert(soldier, 'actorUnitId must be a listed player_soldier');
  assert(Array.isArray(soldier.position) && soldier.position.length === 3, 'binding position must be [x,y,z]');
  assert(
    groundPosition.x === soldier.position[0]
      && groundPosition.y === soldier.position[1]
      && groundPosition.z === soldier.position[2],
    'groundPosition must match actor tile from binding',
  );
  assert(groundPosition.x >= 0 && groundPosition.x < b.map.width, 'groundPosition.x out of map');
  assert(groundPosition.y >= 0 && groundPosition.y < b.map.height, 'groundPosition.y out of map');
  assert(groundPosition.z >= 0 && groundPosition.z < b.map.depth, 'groundPosition.z out of map');

  return {
    schema_version: 1,
    command_id: commandId,
    command_type: 'PICKUP',
    actor_unit_id: actorUnitId,
    item_battle_item_id: itemBattleItemId,
    ground_position: { x: groundPosition.x, y: groundPosition.y, z: groundPosition.z },
    destination_slot: destinationSlot,
    destination_x: destinationX,
    destination_y: destinationY,
    snapshot_sha256: b.snapshot_sha256,
    session_id: b.session_id,
    turn: b.turn,
    state_version: b.state_version,
  };
}

/**
 * Compose DROP from binding (WP8B4). Optional sourceX/sourceY use WP8B3 paired-field semantics.
 */
function composeDropCommand(binding, {
  commandId,
  actorUnitId,
  itemBattleItemId,
  sourceSlot,
  sourceX,
  sourceY,
}) {
  const b = parseCommandBinding(binding);
  assert(typeof commandId === 'string' && commandId.length > 0, 'commandId required');
  assert(Number.isInteger(actorUnitId) && actorUnitId > 0, 'actorUnitId required');
  assert(Number.isInteger(itemBattleItemId) && itemBattleItemId > 0, 'itemBattleItemId required');
  assert(typeof sourceSlot === 'string' && sourceSlot.length > 0, 'sourceSlot required');
  const soldier = b.player_soldiers.find((s) => s.id === actorUnitId);
  assert(soldier, 'actorUnitId must be a listed player_soldier');

  const hasSx = sourceX !== undefined && sourceX !== null;
  const hasSy = sourceY !== undefined && sourceY !== null;
  assert(hasSx === hasSy, 'sourceX and sourceY must both be set or both omitted');
  const cmd = {
    schema_version: 1,
    command_id: commandId,
    command_type: 'DROP',
    actor_unit_id: actorUnitId,
    item_battle_item_id: itemBattleItemId,
    source_slot: sourceSlot,
    snapshot_sha256: b.snapshot_sha256,
    session_id: b.session_id,
    turn: b.turn,
    state_version: b.state_version,
  };
  if (hasSx) {
    assert(Number.isInteger(sourceX) && sourceX >= 0 && sourceX <= 255, 'sourceX invalid');
    assert(Number.isInteger(sourceY) && sourceY >= 0 && sourceY <= 255, 'sourceY invalid');
    cmd.source_x = sourceX;
    cmd.source_y = sourceY;
  }
  return cmd;
}

function bindingMatchesTactical(binding, tactical) {
  const built = buildCommandBinding(tactical, binding.snapshot_sha256);
  return built.state_version === binding.state_version
    && built.session_id === binding.session_id
    && built.turn === binding.turn
    && built.snapshot_sha256 === binding.snapshot_sha256;
}

module.exports = {
  BINDING_SCHEMA_VERSION,
  CommandBindingError,
  buildCommandBinding,
  parseCommandBinding,
  composeMoveCommand,
  composeKneelCommand,
  composeStandCommand,
  composeSnapShotCommand,
  composeAutoShotCommand,
  composeAimedShotCommand,
  composePrimeCommand,
  composeThrowCommand,
  composeReloadCommand,
  composeUnloadCommand,
  composeInventoryMoveCommand,
  composePickupCommand,
  composeDropCommand,
  bindingMatchesTactical,
};
