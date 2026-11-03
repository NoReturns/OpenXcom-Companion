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
    destination_note: 'Choose destination from terrainBrief, terrain-query relay, or visible snapshot geometry only.',
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
  bindingMatchesTactical,
};
