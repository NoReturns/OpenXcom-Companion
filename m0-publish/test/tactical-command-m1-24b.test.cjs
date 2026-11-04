'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { loadAndValidateSnapshotFromText, computeSnapshotId } = require('../lib/tactical-publish.cjs');
const { buildCommandBinding, composeKneelCommand, composeMoveCommand } = require('../lib/command-binding.cjs');
const {
  parseMoveCommand,
  parseKneelCommand,
  parseTacticalCommand,
  validateMoveAgainstSnapshot,
  validateKneelAgainstSnapshot,
  validateTacticalCommandAgainstSnapshot,
  buildResultEnvelope,
  canAcceptNewCommand,
  isTerminalStatus,
  COMMAND_TYPE_MOVE,
  COMMAND_TYPE_KNEEL,
} = require('../lib/tactical-command.cjs');

const FIXTURE_V5 = path.join(__dirname, 'fixtures', 'valid-v5.yaml');

function tactical() {
  return loadAndValidateSnapshotFromText(fs.readFileSync(FIXTURE_V5, 'utf8'), YAML);
}

function bindingFields(tac, digest) {
  return {
    snapshot_sha256: digest,
    session_id: tac.eventLog.sessionId,
    turn: tac.turn,
    state_version: tac.eventLog.latestSeq,
  };
}

describe('tactical KNEEL command schema (M1-24B)', () => {
  it('parses valid KNEEL command', () => {
    const tac = tactical();
    const cmd = parseKneelCommand({
      schema_version: 1,
      command_id: 'kneel-1',
      command_type: COMMAND_TYPE_KNEEL,
      actor_unit_id: 1,
      snapshot_sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      session_id: tac.eventLog.sessionId,
      turn: tac.turn,
      state_version: tac.eventLog.latestSeq,
    });
    assert.equal(cmd.commandType, 'KNEEL');
    assert.equal(cmd.destination, undefined);
  });

  it('parseTacticalCommand accepts KNEEL and MOVE', () => {
    const tac = tactical();
    const base = {
      schema_version: 1,
      command_id: 'cmd-1',
      actor_unit_id: 1,
      snapshot_sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      session_id: tac.eventLog.sessionId,
      turn: tac.turn,
      state_version: tac.eventLog.latestSeq,
    };
    assert.equal(parseTacticalCommand({ ...base, command_type: 'KNEEL' }).commandType, 'KNEEL');
    assert.equal(parseTacticalCommand({
      ...base,
      command_type: 'MOVE',
      destination: { x: 1, y: 2, z: 0 },
    }).commandType, 'MOVE');
  });

  it('MOVE regression: still requires destination', () => {
    const tac = tactical();
    assert.throws(() => parseMoveCommand({
      schema_version: 1,
      command_id: 'move-no-dest',
      command_type: COMMAND_TYPE_MOVE,
      actor_unit_id: 1,
      snapshot_sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      session_id: tac.eventLog.sessionId,
      turn: tac.turn,
      state_version: tac.eventLog.latestSeq,
    }), /destination required/);
  });

  it('rejects KNEEL with destination field', () => {
    const tac = tactical();
    assert.throws(() => parseKneelCommand({
      schema_version: 1,
      command_id: 'kneel-bad',
      command_type: COMMAND_TYPE_KNEEL,
      actor_unit_id: 1,
      destination: { x: 1, y: 1, z: 0 },
      snapshot_sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      session_id: tac.eventLog.sessionId,
      turn: tac.turn,
      state_version: tac.eventLog.latestSeq,
    }), /unknown command field: destination/);
  });

  it('rejects unsupported command types', () => {
    const tac = tactical();
    const base = {
      schema_version: 1,
      command_id: 'fire-1',
      command_type: 'FIRE',
      actor_unit_id: 1,
      snapshot_sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      session_id: tac.eventLog.sessionId,
      turn: tac.turn,
      state_version: tac.eventLog.latestSeq,
    };
    assert.throws(() => parseTacticalCommand(base), /unsupported command_type/);
  });

  it('rejects missing required binding fields', () => {
    const tac = tactical();
    assert.throws(() => parseKneelCommand({
      schema_version: 1,
      command_id: 'kneel-missing',
      command_type: COMMAND_TYPE_KNEEL,
      actor_unit_id: 1,
      session_id: tac.eventLog.sessionId,
      turn: tac.turn,
      state_version: tac.eventLog.latestSeq,
    }), /snapshot_sha256/);
  });

  it('validates KNEEL against snapshot binding', () => {
    const tac = tactical();
    const digest = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
    const cmd = {
      schema_version: 1,
      command_id: 'kneel-bind',
      command_type: 'KNEEL',
      actor_unit_id: 1,
      snapshot_sha256: digest,
      session_id: tac.eventLog.sessionId,
      turn: tac.turn,
      state_version: tac.eventLog.latestSeq,
    };
    const v = validateKneelAgainstSnapshot(cmd, tac, digest);
    assert.equal(v.snapshotId, computeSnapshotId(tac));
  });

  it('validateTacticalCommandAgainstSnapshot dispatches by type', () => {
    const tac = tactical();
    const digest = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
    const kneel = {
      schema_version: 1,
      command_id: 'k1',
      command_type: 'KNEEL',
      actor_unit_id: 1,
      snapshot_sha256: digest,
      session_id: tac.eventLog.sessionId,
      turn: tac.turn,
      state_version: tac.eventLog.latestSeq,
    };
    validateTacticalCommandAgainstSnapshot(kneel, tac, digest);
    const move = {
      ...kneel,
      command_id: 'm1',
      command_type: 'MOVE',
      destination: { x: 1, y: 2, z: 0 },
    };
    validateTacticalCommandAgainstSnapshot(move, tac, digest);
  });

  it('rejects stale state_version for KNEEL', () => {
    const tac = tactical();
    const digest = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
    const cmd = {
      schema_version: 1,
      command_id: 'kneel-stale',
      command_type: 'KNEEL',
      actor_unit_id: 1,
      snapshot_sha256: digest,
      session_id: tac.eventLog.sessionId,
      turn: tac.turn,
      state_version: tac.eventLog.latestSeq + 99,
    };
    assert.throws(() => validateKneelAgainstSnapshot(cmd, tac, digest), /state_version/);
  });

  it('composeKneelCommand from relay binding', () => {
    const tac = tactical();
    const digest = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
    const binding = buildCommandBinding(tac, digest);
    const cmd = composeKneelCommand(binding, { commandId: 'kneel-compose', actorUnitId: 1 });
    parseKneelCommand(cmd);
    validateKneelAgainstSnapshot(cmd, tac, digest);
  });

  it('composeMoveCommand regression unchanged', () => {
    const tac = tactical();
    const digest = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
    const binding = buildCommandBinding(tac, digest);
    const cmd = composeMoveCommand(binding, {
      commandId: 'move-compose',
      actorUnitId: 1,
      destination: { x: 1, y: 2, z: 0 },
    });
    parseMoveCommand(cmd);
    validateMoveAgainstSnapshot(cmd, tac, digest);
  });

  it('preserves one-active-command and terminal gating for KNEEL results', () => {
    assert.equal(canAcceptNewCommand(null), true);
    assert.equal(canAcceptNewCommand('EXECUTING'), false);
    const result = buildResultEnvelope({
      command_id: 'kneel-x',
      command_type: 'KNEEL',
      session_id: 'a1b2c3d4e5f6789012345678abcdef01',
      turn: 1,
    }, 'COMPLETED', { kneeled: true });
    assert.equal(isTerminalStatus(result.status), true);
    assert.equal(canAcceptNewCommand('COMPLETED'), true);
  });
});
