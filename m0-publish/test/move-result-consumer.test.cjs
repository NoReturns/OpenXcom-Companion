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
  resolveMoveInterruptionCause,
  buildMoveTerminalMessage,
  enrichMoveResultNotification,
  buildMoveOutcomeBrief,
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

describe('move terminal presentation (P1-MOVE-INTERRUPT-02B)', () => {
  it('completed MOVE with exact destination', () => {
    const msg = buildMoveTerminalMessage(moveResult({}), BASE_CMD);
    assert.match(msg, /completed/i);
    assert.match(msg, /\(34,23,1\)/);
  });

  it('hostile sighting interruption', () => {
    const result = moveResult({
      status: 'INTERRUPTED',
      final_position: { x: 34, y: 20, z: 0 },
      movement_stop_reason: 'hostile_spotted',
      remaining_tu: 28,
    });
    const msg = buildMoveTerminalMessage(result, BASE_CMD);
    assert.match(msg, /Hostile spotted/i);
    assert.match(msg, /Requested: \(34,23,1\)/);
    assert.match(msg, /Stopped: \(34,20,0\)/);
    assert.match(msg, /Remaining TU: 28/);
  });

  it('reaction-fire interruption does not claim damage', () => {
    const result = moveResult({
      status: 'INTERRUPTED',
      final_position: { x: 34, y: 20, z: 0 },
      movement_stop_reason: 'reaction_fire',
    });
    const msg = buildMoveTerminalMessage(result, BASE_CMD);
    assert.match(msg, /Reaction fire/i);
    assert.match(msg, /does not confirm hit/i);
  });

  it('path_blocked interruption', () => {
    const msg = buildMoveTerminalMessage(moveResult({
      status: 'INTERRUPTED',
      final_position: { x: 33, y: 23, z: 1 },
      movement_stop_reason: 'path_blocked',
    }), BASE_CMD);
    assert.match(msg, /Path blocked/i);
  });

  it('insufficient_time_units interruption', () => {
    const msg = buildMoveTerminalMessage(moveResult({
      status: 'INTERRUPTED',
      final_position: { x: 34, y: 22, z: 1 },
      movement_stop_reason: 'insufficient_time_units',
    }), BASE_CMD);
    assert.match(msg, /Insufficient time units/i);
  });

  it('insufficient_energy interruption', () => {
    const msg = buildMoveTerminalMessage(moveResult({
      status: 'INTERRUPTED',
      final_position: { x: 34, y: 22, z: 1 },
      movement_stop_reason: 'insufficient_energy',
    }), BASE_CMD);
    assert.match(msg, /Insufficient stamina/i);
  });

  it('proximity_grenade interruption', () => {
    const msg = buildMoveTerminalMessage(moveResult({
      status: 'INTERRUPTED',
      final_position: { x: 34, y: 22, z: 1 },
      movement_stop_reason: 'proximity_grenade',
    }), BASE_CMD);
    assert.match(msg, /Proximity grenade/i);
  });

  it('actor_incapacitated on FAILED', () => {
    const msg = buildMoveTerminalMessage(moveResult({
      status: 'FAILED',
      final_position: { x: 34, y: 18, z: 0 },
      movement_stop_reason: 'actor_incapacitated',
    }), BASE_CMD);
    assert.match(msg, /Actor incapacitated/i);
  });

  it('zero-tile hostile spot stays interrupted without completed message', () => {
    const result = moveResult({
      status: 'INTERRUPTED',
      starting_position: { x: 34, y: 18, z: 0 },
      final_position: { x: 34, y: 18, z: 0 },
      movement_stop_reason: 'hostile_spotted',
    });
    const out = classifyMoveTerminalOutcome(result, BASE_CMD);
    assert.equal(out.tacticalSuccess, false);
    assert.match(buildMoveTerminalMessage(result, BASE_CMD), /Hostile spotted/i);
  });

  it('unknown cause when movement_stop_reason absent', () => {
    const result = moveResult({
      status: 'INTERRUPTED',
      final_position: { x: 34, y: 20, z: 0 },
    });
    const cause = resolveMoveInterruptionCause(result);
    assert.equal(cause.move_interruption_cause, 'unknown');
    assert.equal(cause.cause_confirmed, false);
    const msg = buildMoveTerminalMessage(result, BASE_CMD);
    assert.match(msg, /cause not confirmed/i);
    assert.doesNotMatch(msg, /Hostile spotted/i);
  });

  it('does not infer hostile_spotted from position delta alone', () => {
    const result = moveResult({
      status: 'INTERRUPTED',
      final_position: { x: 10, y: 10, z: 0 },
    });
    assert.equal(resolveMoveInterruptionCause(result).move_interruption_cause, 'unknown');
  });

  it('missing delivered command still builds stop cause from result', () => {
    const result = moveResult({
      status: 'INTERRUPTED',
      final_position: { x: 1, y: 2, z: 0 },
      movement_stop_reason: 'reaction_fire',
    });
    const enrich = enrichMoveResultNotification(result, null);
    assert.equal(enrich.move_interruption_cause, 'reaction_fire');
    assert.equal(enrich.commanded_destination, undefined);
    assert.match(enrich.message, /Reaction fire/i);
  });

  it('missing optional positions omitted from message', () => {
    const result = moveResult({
      status: 'INTERRUPTED',
      movement_stop_reason: 'movement_incomplete',
    });
    delete result.final_position;
    delete result.remaining_tu;
    const msg = buildMoveTerminalMessage(result, null);
    assert.doesNotMatch(msg, /Requested:/);
    assert.doesNotMatch(msg, /Stopped:/);
  });

  it('movement_incomplete: token preserved, operator label shown, cause not confirmed', () => {
    const result = moveResult({
      status: 'INTERRUPTED',
      final_position: { x: 34, y: 19, z: 0 },
      movement_stop_reason: 'movement_incomplete',
    });
    const cause = resolveMoveInterruptionCause(result);
    assert.equal(cause.movement_stop_reason, 'movement_incomplete');
    assert.equal(cause.move_interruption_cause, 'movement_incomplete');
    assert.equal(cause.cause_confirmed, false);
    assert.equal(cause.cause_label, 'Movement incomplete');
    assert.match(buildMoveTerminalMessage(result, BASE_CMD), /Stop detail: Movement incomplete/);
    assert.doesNotMatch(buildMoveTerminalMessage(result, BASE_CMD), /Cause: Movement incomplete/);
    const brief = buildMoveOutcomeBrief(result, BASE_CMD);
    const enrich = enrichMoveResultNotification(result, BASE_CMD);
    assert.equal(brief.interruption_cause_confirmed, false);
    assert.equal(brief.movement_stop_reason, 'movement_incomplete');
    assert.equal(enrich.move_interruption_cause, 'movement_incomplete');
    assert.match(enrich.message, /Movement incomplete/);
  });

  it('no_progress: generic stop is not tactically confirmed', () => {
    const result = moveResult({
      status: 'FAILED',
      final_position: { x: 1, y: 1, z: 0 },
      movement_stop_reason: 'no_progress',
    });
    const cause = resolveMoveInterruptionCause(result);
    assert.equal(cause.cause_confirmed, false);
    assert.match(buildMoveTerminalMessage(result, BASE_CMD), /Stop detail: No progress toward destination/);
    assert.equal(buildMoveOutcomeBrief(result, BASE_CMD).interruption_cause_confirmed, false);
  });

  it('reaction_fire remains tactically confirmed', () => {
    const cause = resolveMoveInterruptionCause(moveResult({
      status: 'INTERRUPTED',
      movement_stop_reason: 'reaction_fire',
    }));
    assert.equal(cause.cause_confirmed, true);
    assert.equal(
      buildMoveOutcomeBrief(
        moveResult({
          status: 'INTERRUPTED',
          final_position: { x: 1, y: 2, z: 0 },
          movement_stop_reason: 'reaction_fire',
        }),
        BASE_CMD,
      ).interruption_cause_confirmed,
      true,
    );
  });

  it('future movement_stop_reason token stays unconfirmed', () => {
    const result = moveResult({
      status: 'INTERRUPTED',
      final_position: { x: 0, y: 0, z: 0 },
      movement_stop_reason: 'companion_future_stop_token',
    });
    const cause = resolveMoveInterruptionCause(result);
    assert.equal(cause.movement_stop_reason, 'companion_future_stop_token');
    assert.equal(cause.cause_confirmed, false);
    const msg = buildMoveTerminalMessage(result, BASE_CMD);
    assert.match(msg, /cause not confirmed/i);
    assert.doesNotMatch(msg, /Cause: companion future stop token/i);
  });

  it('brief includes additive interruption fields', () => {
    const brief = buildMoveOutcomeBrief(moveResult({
      status: 'INTERRUPTED',
      final_position: { x: 34, y: 20, z: 0 },
      movement_stop_reason: 'hostile_spotted',
      remaining_tu: 12,
    }), BASE_CMD);
    assert.equal(brief.movement_stop_reason, 'hostile_spotted');
    assert.equal(brief.move_interruption_cause, 'hostile_spotted');
    assert.equal(brief.interruption_cause_confirmed, true);
    assert.equal(brief.remaining_tu, 12);
    assert.match(brief.terminal_message, /Hostile spotted/i);
  });

  it('EXECUTING is non-terminal for presentation', () => {
    assert.equal(buildMoveTerminalMessage(moveResult({ status: 'EXECUTING' }), BASE_CMD), null);
    assert.equal(enrichMoveResultNotification(moveResult({ status: 'EXECUTING' }), BASE_CMD), null);
  });
});
