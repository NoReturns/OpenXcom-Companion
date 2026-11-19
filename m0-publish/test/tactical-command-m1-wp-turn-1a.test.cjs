'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { loadAndValidateSnapshotFromText } = require('../lib/tactical-publish.cjs');
const {
  buildCommandBinding,
  composeTurnFaceCommand,
  composeKneelCommand,
} = require('../lib/command-binding.cjs');
const {
  parseTurnFaceCommand,
  parseTacticalCommand,
  parseKneelCommand,
  validateTurnFaceAgainstSnapshot,
  validateKneelAgainstSnapshot,
  validateTacticalCommandAgainstSnapshot,
  COMMAND_TYPE_TURN_FACE,
  COMMAND_TYPE_KNEEL,
  isTurnFaceCommandType,
} = require('../lib/tactical-command.cjs');
const { readSnapshotByteBuffer, sha256HexLower } = require('../lib/briefing-snapshot.cjs');

const FIXTURE_V5 = path.join(__dirname, 'fixtures', 'valid-v5.yaml');

function tacticalFromFixture() {
  return loadAndValidateSnapshotFromText(fs.readFileSync(FIXTURE_V5, 'utf8'), YAML);
}

function digestForFixture() {
  const bytes = readSnapshotByteBuffer(fs.readFileSync, FIXTURE_V5);
  return sha256HexLower(bytes);
}

function bindingFor(tac, digest) {
  return buildCommandBinding(tac, digest);
}

describe('M1-WP-TURN-1a TURN_FACE Node contract', () => {
  it('parseTurnFaceCommand accepts valid envelope', () => {
    const tac = tacticalFromFixture();
    const digest = digestForFixture();
    const parsed = parseTurnFaceCommand({
      schema_version: 1,
      command_id: 'turn-face-001',
      command_type: COMMAND_TYPE_TURN_FACE,
      actor_unit_id: 1,
      target: { x: 2, y: 2, z: 0 },
      snapshot_sha256: digest,
      session_id: tac.eventLog.sessionId,
      turn: tac.turn,
      state_version: tac.eventLog.latestSeq,
    });
    assert.equal(parsed.commandType, COMMAND_TYPE_TURN_FACE);
    assert.deepEqual(parsed.target, { x: 2, y: 2, z: 0 });
    assert.equal(isTurnFaceCommandType(COMMAND_TYPE_TURN_FACE), true);
  });

  it('parseTacticalCommand dispatches TURN_FACE', () => {
    const tac = tacticalFromFixture();
    const digest = digestForFixture();
    const cmd = parseTacticalCommand({
      schema_version: 1,
      command_id: 'turn-dispatch',
      command_type: COMMAND_TYPE_TURN_FACE,
      actor_unit_id: 1,
      target: { x: 3, y: 2, z: 0 },
      snapshot_sha256: digest,
      session_id: tac.eventLog.sessionId,
      turn: tac.turn,
      state_version: tac.eventLog.latestSeq,
    });
    assert.equal(cmd.commandType, COMMAND_TYPE_TURN_FACE);
  });

  it('rejects unknown fields and missing target', () => {
    const tac = tacticalFromFixture();
    const digest = digestForFixture();
    const base = {
      schema_version: 1,
      command_id: 'turn-bad',
      command_type: COMMAND_TYPE_TURN_FACE,
      actor_unit_id: 1,
      snapshot_sha256: digest,
      session_id: tac.eventLog.sessionId,
      turn: tac.turn,
      state_version: tac.eventLog.latestSeq,
    };
    assert.throws(() => parseTurnFaceCommand({ ...base, destination: { x: 1, y: 1, z: 0 } }), /unknown command field/);
    assert.throws(() => parseTurnFaceCommand(base), /target required/);
  });

  it('validateTurnFaceAgainstSnapshot passes with binding and facing advisory', () => {
    const tac = tacticalFromFixture();
    const digest = digestForFixture();
    const binding = bindingFor(tac, digest);
    const cmd = composeTurnFaceCommand(binding, {
      commandId: 'turn-valid',
      actorUnitId: 1,
      target: { x: 2, y: 3, z: 0 },
    });
    const tacWithFacing = {
      ...tac,
      units: tac.units.map((u) => (u.id === 1
        ? { ...u, facing: { direction: 0, vector: { dx: 0, dy: -1 } } }
        : u)),
    };
    const out = validateTurnFaceAgainstSnapshot(cmd, tacWithFacing, digest, { commandBinding: binding });
    assert.equal(out.actor.id, 1);
    assert.equal(out.planningHint.advisory, true);
    assert.equal(typeof out.planningHint.facingTuStepsEstimated, 'number');
    assert.ok(out.planningHint.facingTuStepsEstimated >= 0);
  });

  it('rejects stale binding', () => {
    const tac = tacticalFromFixture();
    const digest = digestForFixture();
    const binding = bindingFor(tac, digest);
    const cmd = composeTurnFaceCommand(binding, {
      commandId: 'turn-stale',
      actorUnitId: 1,
      target: { x: 4, y: 2, z: 0 },
    });
    cmd.state_version = tac.eventLog.latestSeq + 1;
    assert.throws(
      () => validateTurnFaceAgainstSnapshot(cmd, tac, digest, { commandBinding: binding }),
      /state_version/,
    );
  });

  it('rejects target out of map bounds', () => {
    const tac = tacticalFromFixture();
    const digest = digestForFixture();
    const binding = bindingFor(tac, digest);
    const cmd = composeTurnFaceCommand(binding, {
      commandId: 'turn-oob',
      actorUnitId: 1,
      target: { x: 9, y: 9, z: 0 },
    });
    cmd.target = { x: 10, y: 5, z: 0 };
    assert.throws(
      () => validateTurnFaceAgainstSnapshot(cmd, tac, digest, { commandBinding: binding }),
      /target out of map bounds/,
    );
  });

  it('rejects target on actor tile', () => {
    const tac = tacticalFromFixture();
    const digest = digestForFixture();
    const binding = bindingFor(tac, digest);
    assert.throws(
      () => composeTurnFaceCommand(binding, {
        commandId: 'turn-same',
        actorUnitId: 1,
        target: { x: 1, y: 2, z: 0 },
      }),
      /target must differ/,
    );
  });

  it('rejects actor not in player_soldiers when binding provided', () => {
    const tac = tacticalFromFixture();
    const digest = digestForFixture();
    const binding = bindingFor(tac, digest);
    const bindingWithoutActor = {
      ...binding,
      player_soldiers: binding.player_soldiers.filter((s) => s.id !== 1),
    };
    const cmd = composeTurnFaceCommand(binding, {
      commandId: 'turn-not-listed',
      actorUnitId: 1,
      target: { x: 2, y: 2, z: 0 },
    });
    assert.throws(
      () => validateTurnFaceAgainstSnapshot(cmd, tac, digest, { commandBinding: bindingWithoutActor }),
      /actor_unit_id must be listed/,
    );
  });

  it('compose rejects HWP / unlisted actor id', () => {
    const tac = tacticalFromFixture();
    const digest = digestForFixture();
    const binding = bindingFor(tac, digest);
    assert.throws(
      () => composeTurnFaceCommand(binding, {
        commandId: 'turn-hwp',
        actorUnitId: 1000000,
        target: { x: 5, y: 5, z: 0 },
      }),
      /player_soldier/,
    );
  });

  it('validateTacticalCommandAgainstSnapshot dispatches TURN_FACE', () => {
    const tac = tacticalFromFixture();
    const digest = digestForFixture();
    const binding = bindingFor(tac, digest);
    const cmd = composeTurnFaceCommand(binding, {
      commandId: 'turn-via-dispatch',
      actorUnitId: 1,
      target: { x: 0, y: 2, z: 0 },
    });
    validateTacticalCommandAgainstSnapshot(cmd, tac, digest, { commandBinding: binding });
  });

  it('parser regression: KNEEL unchanged', () => {
    const tac = tacticalFromFixture();
    const digest = digestForFixture();
    const binding = bindingFor(tac, digest);
    const kneel = composeKneelCommand(binding, { commandId: 'k-regression', actorUnitId: 1 });
    parseKneelCommand(kneel);
    validateKneelAgainstSnapshot(kneel, tac, digest);
    assert.throws(
      () => parseKneelCommand({ ...kneel, target: { x: 1, y: 1, z: 0 } }),
      /unknown command field/,
    );
  });
});