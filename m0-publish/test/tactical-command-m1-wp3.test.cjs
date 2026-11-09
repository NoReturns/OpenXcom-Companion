'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  COMMAND_TYPE_AUTO_SHOT,
  COMMAND_TYPE_AIMED_SHOT,
  parseTacticalCommand,
  parseAutoShotCommand,
  parseAimedShotCommand,
  validateAutoShotAgainstSnapshot,
  validateAimedShotAgainstSnapshot,
  buildFirePlanningHint,
} = require('../lib/tactical-command.cjs');
const { ValidationError } = require('../lib/tactical-publish.cjs');
const { composeAutoShotCommand, composeAimedShotCommand } = require('../lib/command-binding.cjs');
const { buildCommandBinding } = require('../lib/command-binding.cjs');

function minimalTactical(overrides = {}) {
  return {
    schemaVersion: 5,
    turn: 1,
    side: 0,
    map: { width: 20, height: 20, depth: 1 },
    eventLog: { sessionId: 'a1b2c3d4e5f6789012345678abcdef01', latestSeq: 3 },
    units: [{
      id: 1,
      faction: 0,
      originalFaction: 0,
      timeUnits: 80,
      actionCosts: {
        hands: {
          right: {
            actions: [
              { id: 'snap', tuCost: 25, usable: true, canAffordTu: true },
              { id: 'auto', tuCost: 40, usable: true, canAffordTu: true },
              { id: 'aimed', tuCost: 50, usable: true, canAffordTu: true },
            ],
          },
        },
      },
    }],
    ...overrides,
  };
}

describe('M1-WP3 AUTO_SHOT and AIMED_SHOT schema', () => {
  it('parses AUTO_SHOT and AIMED_SHOT contracts', () => {
    const tac = minimalTactical();
    const digest = 'b'.repeat(64);
    const auto = {
      schema_version: 1,
      command_id: 'auto-1',
      command_type: COMMAND_TYPE_AUTO_SHOT,
      actor_unit_id: 1,
      active_hand: 'STR_RIGHT_HAND',
      target: { x: 5, y: 5, z: 0 },
      snapshot_sha256: digest,
      session_id: tac.eventLog.sessionId,
      turn: tac.turn,
      state_version: tac.eventLog.latestSeq,
    };
    assert.equal(parseAutoShotCommand(auto).commandType, COMMAND_TYPE_AUTO_SHOT);
    assert.equal(parseTacticalCommand(auto).commandType, COMMAND_TYPE_AUTO_SHOT);

    const aimed = { ...auto, command_id: 'aim-1', command_type: COMMAND_TYPE_AIMED_SHOT };
    assert.equal(parseAimedShotCommand(aimed).commandType, COMMAND_TYPE_AIMED_SHOT);
  });

  it('validates fire modes against snapshot actionCosts', () => {
    const tac = minimalTactical();
    const digest = 'c'.repeat(64);
    const binding = buildCommandBinding(tac, digest);
    const autoCmd = composeAutoShotCommand(binding, {
      commandId: 'auto-bind-1',
      actorUnitId: 1,
      activeHand: 'STR_RIGHT_HAND',
      target: { x: 5, y: 5, z: 0 },
    });
    const { planningHint } = validateAutoShotAgainstSnapshot(autoCmd, tac, digest);
    assert.equal(planningHint.advisory, true);
    assert.equal(planningHint.fireTuCost, 40);
    assert.equal(planningHint.remainingTuEstimate, 40);
    assert.equal(planningHint.snapAffordableAfter, true);

    const aimedCmd = composeAimedShotCommand(binding, {
      commandId: 'aim-bind-1',
      actorUnitId: 1,
      activeHand: 'STR_RIGHT_HAND',
      target: { x: 5, y: 5, z: 0 },
    });
    validateAimedShotAgainstSnapshot(aimedCmd, tac, digest);
  });

  it('buildFirePlanningHint marks estimates as non-authoritative', () => {
    const actor = minimalTactical().units[0];
    const hint = buildFirePlanningHint(actor, 'STR_RIGHT_HAND', COMMAND_TYPE_AUTO_SHOT);
    assert.match(hint.note, /authoritative/);
  });

  it('rejects AUTO_SHOT with missing or invalid active_hand', () => {
    const tac = minimalTactical();
    const digest = 'd'.repeat(64);
    const base = {
      schema_version: 1,
      command_id: 'auto-hand-gate',
      command_type: COMMAND_TYPE_AUTO_SHOT,
      actor_unit_id: 1,
      target: { x: 5, y: 5, z: 0 },
      snapshot_sha256: digest,
      session_id: tac.eventLog.sessionId,
      turn: tac.turn,
      state_version: tac.eventLog.latestSeq,
    };
    assert.throws(() => parseAutoShotCommand(base), (err) => {
      assert.ok(err instanceof ValidationError);
      assert.equal(err.message, 'invalid active_hand');
      return true;
    });
    assert.throws(
      () => parseAutoShotCommand({ ...base, active_hand: 'right' }),
      (err) => err instanceof ValidationError && err.message === 'invalid active_hand',
    );
  });

  it('accepts AUTO_SHOT with STR_RIGHT_HAND and STR_LEFT_HAND', () => {
    const tac = minimalTactical();
    const digest = 'e'.repeat(64);
    const base = {
      schema_version: 1,
      command_id: 'auto-hand-ok',
      command_type: COMMAND_TYPE_AUTO_SHOT,
      actor_unit_id: 1,
      target: { x: 5, y: 5, z: 0 },
      snapshot_sha256: digest,
      session_id: tac.eventLog.sessionId,
      turn: tac.turn,
      state_version: tac.eventLog.latestSeq,
    };
    assert.equal(parseAutoShotCommand({ ...base, active_hand: 'STR_RIGHT_HAND' }).activeHand, 'STR_RIGHT_HAND');
    assert.equal(parseAutoShotCommand({ ...base, active_hand: 'STR_LEFT_HAND' }).activeHand, 'STR_LEFT_HAND');
  });
});
