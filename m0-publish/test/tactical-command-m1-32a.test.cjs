'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { loadAndValidateSnapshotFromText } = require('../lib/tactical-publish.cjs');
const { composeSnapShotCommand, buildCommandBinding } = require('../lib/command-binding.cjs');
const {
  parseSnapShotCommand,
  parseTacticalCommand,
  parseMoveCommand,
  parseKneelCommand,
  validateSnapShotAgainstSnapshot,
  validateMoveAgainstSnapshot,
  validateKneelAgainstSnapshot,
  validateTacticalCommandAgainstSnapshot,
  buildResultEnvelope,
  canAcceptNewCommand,
  isTerminalStatus,
  COMMAND_TYPE_SNAP_SHOT,
  COMMAND_TYPE_MOVE,
  COMMAND_TYPE_KNEEL,
} = require('../lib/tactical-command.cjs');

const FIXTURE_COSTS = path.join(__dirname, 'fixtures', 'valid-v3-action-costs.yaml');
const FIXTURE_V5 = path.join(__dirname, 'fixtures', 'valid-v5.yaml');

function tacticalV5() {
  return loadAndValidateSnapshotFromText(fs.readFileSync(FIXTURE_V5, 'utf8'), YAML);
}

const SNAPSHOT_SHA = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

function tacticalWithSnapCosts() {
  const tac = tacticalV5();
  const costsOnly = loadAndValidateSnapshotFromText(fs.readFileSync(FIXTURE_COSTS, 'utf8'), YAML);
  const donor = costsOnly.units.find((u) => u.id === 2);
  const actor = tac.units.find((u) => u.id === 1);
  actor.actionCosts = donor.actionCosts;
  return tac;
}

function snapBase(tac) {
  return {
    schema_version: 1,
    command_id: 'snap-1',
    command_type: COMMAND_TYPE_SNAP_SHOT,
    actor_unit_id: 1,
    active_hand: 'STR_RIGHT_HAND',
    target: { x: 5, y: 5, z: 0 },
    snapshot_sha256: SNAPSHOT_SHA,
    session_id: tac.eventLog.sessionId,
    turn: tac.turn,
    state_version: tac.eventLog.latestSeq,
  };
}

describe('tactical SNAP_SHOT command schema (M1-32A)', () => {
  it('parses valid SNAP_SHOT contract', () => {
    const tac = tacticalWithSnapCosts();
    const cmd = parseSnapShotCommand(snapBase(tac));
    assert.equal(cmd.commandType, 'SNAP_SHOT');
    assert.equal(cmd.activeHand, 'STR_RIGHT_HAND');
    assert.deepEqual(cmd.target, { x: 5, y: 5, z: 0 });
  });

  it('parseTacticalCommand routes SNAP_SHOT', () => {
    const tac = tacticalWithSnapCosts();
    assert.equal(parseTacticalCommand(snapBase(tac)).commandType, 'SNAP_SHOT');
  });

  it('rejects invalid target coordinates', () => {
    const tac = tacticalWithSnapCosts();
    assert.throws(() => validateSnapShotAgainstSnapshot({
      ...snapBase(tac),
      target: { x: 99, y: 5, z: 0 },
    }, tac, SNAPSHOT_SHA), /target out of map bounds/);
  });

  it('rejects stale snapshot binding', () => {
    const tac = tacticalWithSnapCosts();
    assert.throws(() => validateSnapShotAgainstSnapshot({
      ...snapBase(tac),
      snapshot_sha256: '0000000000000000000000000000000000000000000000000000000000000001',
    }, tac, SNAPSHOT_SHA), /snapshot_sha256 mismatch/);
  });

  it('rejects stale state version', () => {
    const tac = tacticalWithSnapCosts();
    assert.throws(() => validateSnapShotAgainstSnapshot({
      ...snapBase(tac),
      state_version: tac.eventLog.latestSeq + 1,
    }, tac, SNAPSHOT_SHA), /state_version/);
  });

  it('rejects wrong turn', () => {
    const tac = tacticalWithSnapCosts();
    assert.throws(() => validateSnapShotAgainstSnapshot({
      ...snapBase(tac),
      turn: tac.turn + 1,
    }, tac, SNAPSHOT_SHA), /turn mismatch/);
  });

  it('rejects missing actor in snapshot', () => {
    const tac = tacticalWithSnapCosts();
    assert.throws(() => validateSnapShotAgainstSnapshot({
      ...snapBase(tac),
      actor_unit_id: 999,
    }, tac, SNAPSHOT_SHA), /actor_unit_id not in snapshot/);
  });

  it('rejects unsupported weapon (no actionCosts snap)', () => {
    const tac = tacticalV5();
    const cmd = {
      ...snapBase(tac),
      actor_unit_id: 1,
      session_id: tac.eventLog.sessionId,
      turn: tac.turn,
      state_version: tac.eventLog.latestSeq,
    };
    assert.throws(() => validateSnapShotAgainstSnapshot(cmd, tac, SNAPSHOT_SHA),
      /does not support snap/);
  });

  it('rejects insufficient TU from snapshot actionCosts', () => {
    const tac = tacticalWithSnapCosts();
    const actor = tac.units.find((u) => u.id === 1);
    actor.actionCosts.hands.right.actions[0].canAffordTu = false;
    assert.throws(() => validateSnapShotAgainstSnapshot(snapBase(tac), tac, SNAPSHOT_SHA),
      /insufficient TU/);
  });

  it('rejects unusable snap (no ammunition metadata)', () => {
    const tac = tacticalWithSnapCosts();
    const actor = tac.units.find((u) => u.id === 1);
    actor.actionCosts.hands.right.actions[0].usable = false;
    assert.throws(() => validateSnapShotAgainstSnapshot(snapBase(tac), tac, SNAPSHOT_SHA),
      /not usable/);
  });

  it('accepts valid snap against actionCosts fixture', () => {
    const tac = tacticalWithSnapCosts();
    validateSnapShotAgainstSnapshot(snapBase(tac), tac, SNAPSHOT_SHA);
  });

  it('composeSnapShotCommand builds relay object', () => {
    const tac = tacticalWithSnapCosts();
    const binding = buildCommandBinding(tac, SNAPSHOT_SHA);
    const cmd = composeSnapShotCommand(binding, {
      commandId: 'snap-compose-1',
      actorUnitId: 1,
      activeHand: 'STR_RIGHT_HAND',
      target: { x: 5, y: 5, z: 0 },
    });
    assert.equal(cmd.command_type, 'SNAP_SHOT');
    parseSnapShotCommand(cmd);
  });

  it('lifecycle: EXECUTING is non-terminal; COMPLETED requires resolved shot semantics in engine', () => {
    const tac = tacticalWithSnapCosts();
    const cmd = snapBase(tac);
    assert.equal(isTerminalStatus('EXECUTING'), false);
    assert.equal(isTerminalStatus('COMPLETED'), true);
    assert.equal(isTerminalStatus('FAILED'), true);
    assert.equal(canAcceptNewCommand('EXECUTING'), false);
    assert.equal(canAcceptNewCommand('COMPLETED'), true);
    assert.equal(canAcceptNewCommand('FAILED'), true);
    buildResultEnvelope(cmd, 'FAILED', { public_reason: 'STR_NO_LINE_OF_FIRE' });
  });

  it('MOVE and KNEEL regression still parse', () => {
    const tac = tacticalV5();
    parseMoveCommand({
      schema_version: 1,
      command_id: 'move-1',
      command_type: COMMAND_TYPE_MOVE,
      actor_unit_id: 1,
      destination: { x: 2, y: 2, z: 0 },
      snapshot_sha256: SNAPSHOT_SHA,
      session_id: tac.eventLog.sessionId,
      turn: tac.turn,
      state_version: tac.eventLog.latestSeq,
    });
    parseKneelCommand({
      schema_version: 1,
      command_id: 'kneel-1',
      command_type: COMMAND_TYPE_KNEEL,
      actor_unit_id: 1,
      snapshot_sha256: SNAPSHOT_SHA,
      session_id: tac.eventLog.sessionId,
      turn: tac.turn,
      state_version: tac.eventLog.latestSeq,
    });
    validateMoveAgainstSnapshot({
      schema_version: 1,
      command_id: 'move-1',
      command_type: COMMAND_TYPE_MOVE,
      actor_unit_id: 1,
      destination: { x: 2, y: 2, z: 0 },
      snapshot_sha256: SNAPSHOT_SHA,
      session_id: tac.eventLog.sessionId,
      turn: tac.turn,
      state_version: tac.eventLog.latestSeq,
    }, tac, SNAPSHOT_SHA);
    validateKneelAgainstSnapshot({
      schema_version: 1,
      command_id: 'kneel-1',
      command_type: COMMAND_TYPE_KNEEL,
      actor_unit_id: 1,
      snapshot_sha256: SNAPSHOT_SHA,
      session_id: tac.eventLog.sessionId,
      turn: tac.turn,
      state_version: tac.eventLog.latestSeq,
    }, tac, SNAPSHOT_SHA);
    validateTacticalCommandAgainstSnapshot({
      schema_version: 1,
      command_id: 'kneel-1',
      command_type: COMMAND_TYPE_KNEEL,
      actor_unit_id: 1,
      snapshot_sha256: SNAPSHOT_SHA,
      session_id: tac.eventLog.sessionId,
      turn: tac.turn,
      state_version: tac.eventLog.latestSeq,
    }, tac, SNAPSHOT_SHA);
  });
});
