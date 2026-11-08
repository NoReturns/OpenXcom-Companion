'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  MOVE_OUTCOME_CLASS,
  classifyMoveTerminalOutcome,
  isMoveTacticallySuccessful,
  positionsEqual3d,
  getMoveResultContractMarkdown,
  runMandatoryMoveResultReview,
} = require('../lib/move-result-consumer.cjs');
const {
  runMandatoryPostCommandPrelude: workflowPostCommand,
} = require('../lib/tactical-briefing-ai-workflow.cjs');

const BASE_CMD = {
  command_type: 'MOVE',
  command_id: 'move-test-1',
  destination: { x: 34, y: 23, z: 1 },
};

function moveResult(overrides) {
  return {
    schema_version: 1,
    command_type: 'MOVE',
    command_id: 'move-test-1',
    session_id: 'a1b2c3d4e5f6789012345678abcdef01',
    turn: 8,
    status: 'COMPLETED',
    actor_unit_id: 3,
    final_position: { x: 34, y: 23, z: 1 },
    remaining_tu: 40,
    kneeled: false,
    destination_reached: true,
    ...overrides,
  };
}

describe('move-result-consumer', () => {
  it('COMPLETED with matching destination_reached and final_position is tactically successful', () => {
    const result = moveResult({});
    const out = classifyMoveTerminalOutcome(result, BASE_CMD);
    assert.equal(out.tacticalSuccess, true);
    assert.equal(out.positionMatchesDestination, true);
    assert.equal(out.statusDestinationConsistent, true);
    assert.equal(out.replan.required, false);
    assert.equal(isMoveTacticallySuccessful(result, BASE_CMD), true);
  });

  it('COMPLETED but destination_reached false is not tactically successful', () => {
    const result = moveResult({
      destination_reached: false,
      final_position: { x: 34, y: 22, z: 0 },
    });
    const out = classifyMoveTerminalOutcome(result, BASE_CMD);
    assert.equal(out.tacticalSuccess, false);
    assert.ok(out.contractWarnings.some((w) => w.includes('destination_reached')));
    assert.equal(out.replan.required, true);
    assert.match(out.replan.reason, /completed_without/);
  });

  it('COMPLETED with destination_reached true but wrong final_position is not successful', () => {
    const result = moveResult({
      final_position: { x: 33, y: 23, z: 1 },
    });
    const out = classifyMoveTerminalOutcome(result, BASE_CMD);
    assert.equal(out.tacticalSuccess, false);
    assert.equal(out.positionMatchesDestination, false);
    assert.ok(out.contractWarnings.length > 0);
  });

  it('INTERRUPTED exposes final_position and requires replan', () => {
    const result = moveResult({
      status: 'INTERRUPTED',
      starting_position: { x: 34, y: 18, z: 0 },
      final_position: { x: 34, y: 20, z: 0 },
      destination_reached: false,
      movement_stop_reason: 'reaction_fire',
      public_reason: 'Movement halted: reaction fire.',
    });
    const out = classifyMoveTerminalOutcome(result, BASE_CMD);
    assert.equal(out.tacticalSuccess, false);
    assert.equal(out.terminalMeaning, 'walk_stopped_short_or_interrupted');
    assert.equal(out.replan.required, true);
    assert.equal(out.finalPosition.z, 0);
    assert.equal(out.crossLevelCommand, true);
    assert.match(out.replan.guidance, /final_position/);
  });

  it('cross-level COMPLETED records z in final_position match', () => {
    const cmd = { ...BASE_CMD, destination: { x: 10, y: 5, z: 1 } };
    const result = moveResult({
      starting_position: { x: 10, y: 5, z: 0 },
      final_position: { x: 10, y: 5, z: 1 },
      destination: undefined,
    });
    const out = classifyMoveTerminalOutcome(result, cmd);
    assert.equal(out.tacticalSuccess, true);
    assert.equal(out.crossLevelCommand, true);
    assert.equal(out.crossLevelStop, true);
    assert.ok(positionsEqual3d([10, 5, 1], out.finalPosition));
  });

  it('legacy result without destination_reached uses final_position vs command', () => {
    const result = moveResult({});
    delete result.destination_reached;
    const out = classifyMoveTerminalOutcome(result, BASE_CMD);
    assert.equal(out.destinationReachedKnown, false);
    assert.equal(out.tacticalSuccess, true);
  });

  it('legacy COMPLETED without destination_reached and missing final_position is not success', () => {
    const result = moveResult({});
    delete result.destination_reached;
    delete result.final_position;
    const out = classifyMoveTerminalOutcome(result, BASE_CMD);
    assert.equal(out.tacticalSuccess, false);
    assert.equal(out.replan.required, true);
  });

  it('FAILED with destination_reached true warns and is not tactically successful', () => {
    const result = moveResult({
      status: 'FAILED',
      destination_reached: true,
      final_position: { x: 34, y: 23, z: 1 },
    });
    const out = classifyMoveTerminalOutcome(result, BASE_CMD);
    assert.equal(out.tacticalSuccess, false);
    assert.ok(out.contractWarnings.some((w) => w.includes('FAILED')));
  });

  it('contract markdown includes verification steps and stairs', () => {
    const md = getMoveResultContractMarkdown();
    assert.match(md, /destination_reached/);
    assert.match(md, /pathfindingGuaranteed/);
    assert.match(md, /final_position/);
    assert.match(md, /stairs/);
  });

  it('outcome class completed_verified when x/y/z match', () => {
    const out = classifyMoveTerminalOutcome(moveResult({}), BASE_CMD);
    assert.equal(out.outcomeClass, MOVE_OUTCOME_CLASS.COMPLETED_VERIFIED_DESTINATION);
  });

  it('COMPLETED without command cannot be tactically successful', () => {
    const result = moveResult({ destination_reached: true });
    assert.equal(isMoveTacticallySuccessful(result, null), false);
    const review = runMandatoryMoveResultReview(result, null);
    assert.equal(review.mayPublishNextCommand, false);
  });

  it('FAILED with destination_reached true is failed_or_rejected', () => {
    const result = moveResult({
      status: 'FAILED',
      destination_reached: true,
      final_position: { x: 34, y: 23, z: 1 },
    });
    const out = classifyMoveTerminalOutcome(result, BASE_CMD);
    assert.equal(out.outcomeClass, MOVE_OUTCOME_CLASS.FAILED_OR_REJECTED);
    assert.equal(out.tacticalSuccess, false);
    const post = workflowPostCommand({ result, command: BASE_CMD });
    assert.equal(post.readyForNextCommand, false);
  });

  it('recovery policy case 1: COMPLETED verified may continue prior plan', () => {
    const post = workflowPostCommand({ result: moveResult({}), command: BASE_CMD });
    assert.equal(post.readyForNextCommand, true);
    assert.equal(post.mayContinuePriorMovePlan, true);
    assert.equal(post.requiresFreshBindingBeforeNextPublish, false);
    assert.equal(post.mayPublishAfterFreshBinding, true);
  });

  it('recovery policy case 2: INTERRUPTED blocks chain but allows fresh-binding publish', () => {
    const result = moveResult({
      status: 'INTERRUPTED',
      starting_position: { x: 10, y: 5, z: 0 },
      final_position: { x: 10, y: 5, z: 0 },
      destination_reached: false,
    });
    const cmd = { ...BASE_CMD, destination: { x: 10, y: 5, z: 1 } };
    const post = workflowPostCommand({ result, command: cmd });
    assert.equal(post.readyForNextCommand, false);
    assert.equal(post.mayContinuePriorMovePlan, false);
    assert.equal(post.requiresFreshBindingBeforeNextPublish, true);
    assert.equal(post.mayPublishAfterFreshBinding, true);
    assert.equal(post.move.recovery.republishAnchorPosition.z, 0);
  });

  it('recovery policy case 3: FAILED no success but fresh binding recovery allowed', () => {
    const result = moveResult({ status: 'FAILED', destination_reached: false, final_position: { x: 1, y: 1, z: 0 } });
    const post = workflowPostCommand({ result, command: BASE_CMD });
    assert.equal(post.readyForNextCommand, false);
    assert.equal(post.mayPublishAfterFreshBinding, true);
  });

  it('recovery policy case 4: contradictory COMPLETED requires reconciliation', () => {
    const result = moveResult({ final_position: { x: 0, y: 0, z: 0 } });
    const post = workflowPostCommand({ result, command: BASE_CMD });
    assert.equal(post.readyForNextCommand, false);
    assert.equal(post.requiresFreshBindingBeforeNextPublish, true);
    assert.equal(post.mayPublishAfterFreshBinding, true);
  });

  it('recovery policy case 5: cross-level INTERRUPTED anchors replan at actual z', () => {
    const cmd = { command_type: 'MOVE', command_id: 'z-test', destination: { x: 34, y: 20, z: 1 } };
    const result = moveResult({
      status: 'INTERRUPTED',
      starting_position: { x: 34, y: 18, z: 0 },
      final_position: { x: 34, y: 20, z: 0 },
      destination_reached: false,
    });
    const review = runMandatoryMoveResultReview(result, cmd);
    assert.equal(review.classified.commandedDestination.z, 1);
    assert.equal(review.recovery.republishAnchorPosition.z, 0);
    assert.match(review.assessmentLines.join(' '), /z:0/);
  });

  it('staircase cross-level z mismatch yields interrupted replan class', () => {
    const cmd = { ...BASE_CMD, destination: { x: 12, y: 8, z: 1 } };
    const result = moveResult({
      status: 'INTERRUPTED',
      starting_position: { x: 12, y: 8, z: 0 },
      final_position: { x: 12, y: 8, z: 0 },
      destination_reached: false,
    });
    const out = classifyMoveTerminalOutcome(result, cmd);
    assert.equal(out.outcomeClass, MOVE_OUTCOME_CLASS.INTERRUPTED_KNOWN_FINAL_POSITION);
    assert.match(out.replan.guidance, /stairs|ramp|grav/i);
  });
});
