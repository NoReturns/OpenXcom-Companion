'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { ValidationError, computeSnapshotId, loadAndValidateSnapshotFromText } = require('./tactical-publish.cjs');
const { readSnapshotByteBuffer, sha256HexLower } = require('./briefing-snapshot.cjs');

const COMMAND_SCHEMA_VERSION = 1;
const RESULT_SCHEMA_VERSION = 1;
const COMMAND_TYPE_MOVE = 'MOVE';
const COMMAND_TYPE_KNEEL = 'KNEEL';

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

const DESTINATION_KEYS = new Set(['x', 'y', 'z']);

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
  assertAllowedCommandKeys(raw, COMMAND_KEYS_COMMON);
  return parseBindingFields(raw);
}

function parseTacticalCommand(raw) {
  assert(isPlainObject(raw), 'command must be an object');
  if (raw.command_type === COMMAND_TYPE_MOVE) {
    return parseMoveCommand(raw);
  }
  if (raw.command_type === COMMAND_TYPE_KNEEL) {
    return parseKneelCommand(raw);
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

function validateTacticalCommandAgainstSnapshot(command, tactical, snapshotSha256Lower) {
  if (command && command.command_type === COMMAND_TYPE_KNEEL) {
    return validateKneelAgainstSnapshot(command, tactical, snapshotSha256Lower);
  }
  return validateMoveAgainstSnapshot(command, tactical, snapshotSha256Lower);
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
  TERMINAL_STATUSES,
  NON_TERMINAL_STATUSES,
  parseMoveCommand,
  parseKneelCommand,
  parseTacticalCommand,
  commandDigest,
  validateMoveAgainstSnapshot,
  validateKneelAgainstSnapshot,
  validateTacticalCommandAgainstSnapshot,
  validateMoveAgainstSnapshotFile,
  validateTacticalCommandAgainstSnapshotFile,
  buildResultEnvelope,
  parseResultStatus,
  isTerminalStatus,
  canAcceptNewCommand,
};
