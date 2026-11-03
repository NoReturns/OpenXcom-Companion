'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { loadAndValidateSnapshotFromText, computeSnapshotId } = require('../lib/tactical-publish.cjs');
const { executeTerrainQuery, MAX_QUERY_RADIUS, MAX_RESPONSE_BYTES } = require('../lib/terrain-query.cjs');
const {
  parseMoveCommand,
  validateMoveAgainstSnapshot,
  buildResultEnvelope,
  isTerminalStatus,
  canAcceptNewCommand,
  COMMAND_TYPE_MOVE,
} = require('../lib/tactical-command.cjs');

const FIXTURE_V5 = path.join(__dirname, 'fixtures', 'valid-v5.yaml');

describe('terrain query', () => {
  it('returns discovered and UNKNOWN cells in radius', () => {
    const tactical = loadAndValidateSnapshotFromText(fs.readFileSync(FIXTURE_V5, 'utf8'), YAML);
    const snapshotId = computeSnapshotId(tactical);
    const result = executeTerrainQuery(tactical, {
      snapshot_id: snapshotId,
      center: { x: 1, y: 2, z: 0 },
      radius: 2,
    });
    assert.ok(result.discovered.length >= 1);
    assert.ok(result.unknown.length >= 1);
    assert.equal(result.discovered[0].visibility, 'CURRENTLY_VISIBLE');
    assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= MAX_RESPONSE_BYTES);
  });

  it('rejects stale snapshot_id', () => {
    const tactical = loadAndValidateSnapshotFromText(fs.readFileSync(FIXTURE_V5, 'utf8'), YAML);
    assert.throws(() => executeTerrainQuery(tactical, {
      snapshot_id: '0'.repeat(64),
      center: { x: 1, y: 2, z: 0 },
      radius: 1,
    }), /snapshot_id does not match/);
  });

  it('rejects radius above max', () => {
    const tactical = loadAndValidateSnapshotFromText(fs.readFileSync(FIXTURE_V5, 'utf8'), YAML);
    assert.throws(() => executeTerrainQuery(tactical, {
      snapshot_id: computeSnapshotId(tactical),
      center: { x: 1, y: 2, z: 0 },
      radius: MAX_QUERY_RADIUS + 1,
    }), /radius/);
  });
});

describe('tactical MOVE command schema', () => {
  const tactical = () => loadAndValidateSnapshotFromText(fs.readFileSync(FIXTURE_V5, 'utf8'), YAML);

  it('parses valid MOVE command', () => {
    const cmd = parseMoveCommand({
      schema_version: 1,
      command_id: 'move-1',
      command_type: COMMAND_TYPE_MOVE,
      actor_unit_id: 1,
      destination: { x: 2, y: 2, z: 0 },
      snapshot_sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      session_id: tactical().eventLog.sessionId,
      turn: 1,
      state_version: 1,
    });
    assert.equal(cmd.commandType, 'MOVE');
  });

  it('validates against snapshot session and turn', () => {
    const tac = tactical();
    const cmd = {
      schema_version: 1,
      command_id: 'move-2',
      command_type: 'MOVE',
      actor_unit_id: 1,
      destination: { x: 1, y: 2, z: 0 },
      snapshot_sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      session_id: tac.eventLog.sessionId,
      turn: tac.turn,
      state_version: 1,
    };
    const v = validateMoveAgainstSnapshot(cmd, tac, cmd.snapshot_sha256);
    assert.equal(v.snapshotId, computeSnapshotId(tac));
  });

  it('rejects stale turn', () => {
    const tac = tactical();
    const cmd = {
      schema_version: 1,
      command_id: 'move-3',
      command_type: 'MOVE',
      actor_unit_id: 1,
      destination: { x: 1, y: 2, z: 0 },
      snapshot_sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      session_id: tac.eventLog.sessionId,
      turn: 99,
      state_version: 1,
    };
    assert.throws(() => validateMoveAgainstSnapshot(cmd, tac, cmd.snapshot_sha256), /turn mismatch/);
  });

  it('tracks terminal command acknowledgement gating', () => {
    assert.equal(canAcceptNewCommand(null), true);
    assert.equal(canAcceptNewCommand('EXECUTING'), false);
    assert.equal(canAcceptNewCommand('COMPLETED'), true);
    const result = buildResultEnvelope({
      command_id: 'x',
      command_type: 'MOVE',
      session_id: 'a1b2c3d4e5f6789012345678abcdef01',
      turn: 1,
    }, 'COMPLETED', { destination_reached: true });
    assert.equal(isTerminalStatus(parseResult(result)), true);
  });

  it('rejects array destination (must be { x, y, z } object)', () => {
    const tac = tactical();
    const base = {
      schema_version: 1,
      command_id: 'move-array-dest',
      command_type: COMMAND_TYPE_MOVE,
      actor_unit_id: 1,
      destination: [45, 37, 0],
      snapshot_sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      session_id: tac.eventLog.sessionId,
      turn: tac.turn,
      state_version: tac.eventLog.latestSeq,
    };
    assert.throws(() => parseMoveCommand(base), /not a JSON array/);
  });

  it('accepts object destination shape required by engine JSON parser', () => {
    const tac = tactical();
    const cmd = parseMoveCommand({
      schema_version: 1,
      command_id: 'move-obj-dest',
      command_type: 'MOVE',
      actor_unit_id: 1,
      destination: { x: 45, y: 37, z: 0 },
      snapshot_sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      session_id: tac.eventLog.sessionId,
      turn: tac.turn,
      state_version: tac.eventLog.latestSeq,
    });
    assert.deepEqual(cmd.destination, { x: 45, y: 37, z: 0 });
  });
});

function parseResult(result) {
  return result.status;
}

describe('snapshot_id preservation', () => {
  it('computeSnapshotId unchanged when validating command context', () => {
    const tac = loadAndValidateSnapshotFromText(fs.readFileSync(FIXTURE_V5, 'utf8'), YAML);
    const before = computeSnapshotId(tac);
    executeTerrainQuery(tac, {
      snapshot_id: before,
      center: { x: 5, y: 5, z: 0 },
      radius: 1,
    });
    assert.equal(computeSnapshotId(tac), before);
  });
});
