'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  GUIDED_LAUNCH_OUTCOME_CLASS,
  isGuidedLaunchCommandType,
  buildGuidedLaunchTerminalMessage,
  buildGuidedLaunchOutcomeBrief,
  resolveGuidedLaunchOutcomeClass,
} = require('../lib/guided-launch-result-consumer.cjs');

function launchResult(overrides = {}) {
  return {
    schema_version: 1,
    command_type: 'GUIDED_LAUNCH',
    command_id: 'gl-test-1',
    session_id: 'a1b2c3d4e5f6789012345678abcdef01',
    turn: 3,
    actor_unit_id: 1,
    status: 'COMPLETED',
    destination_reached: false,
    public_reason: '',
    ...overrides,
  };
}

describe('guided-launch-result-consumer', () => {
  it('recognizes GUIDED_LAUNCH only', () => {
    assert.equal(isGuidedLaunchCommandType('GUIDED_LAUNCH'), true);
    assert.equal(isGuidedLaunchCommandType('THROW'), false);
    assert.equal(isGuidedLaunchCommandType('SNAP_SHOT'), false);
  });

  it('COMPLETED → projectile launched message', () => {
    const result = launchResult({ status: 'COMPLETED' });
    assert.equal(
      buildGuidedLaunchTerminalMessage(result),
      'Guided launch completed. Detonation or damage not confirmed.',
    );
    const brief = buildGuidedLaunchOutcomeBrief(result);
    assert.equal(brief.outcome_class, GUIDED_LAUNCH_OUTCOME_CLASS.PROJECTILE_LAUNCHED);
    assert.equal(brief.execution_launched, true);
    assert.equal(brief.may_publish_after_fresh_binding, true);
  });

  it('INVALID_WAYPOINT REJECTED preflight', () => {
    const result = launchResult({
      status: 'REJECTED',
      public_reason: 'One or more waypoints are out of map bounds.',
      reject_code: 'INVALID_WAYPOINT',
    });
    assert.match(
      buildGuidedLaunchTerminalMessage(result),
      /rejected before execution: One or more waypoints are out of map bounds/,
    );
    assert.equal(
      resolveGuidedLaunchOutcomeClass(result),
      GUIDED_LAUNCH_OUTCOME_CLASS.REJECTED_BEFORE_EXECUTION,
    );
  });

  it('EXECUTING is non-terminal brief', () => {
    const result = launchResult({ status: 'EXECUTING' });
    assert.equal(buildGuidedLaunchOutcomeBrief(result), null);
    assert.equal(
      resolveGuidedLaunchOutcomeClass(result),
      GUIDED_LAUNCH_OUTCOME_CLASS.NON_TERMINAL,
    );
  });

  it('FAILED after acceptance', () => {
    const result = launchResult({
      status: 'FAILED',
      public_reason: 'Guided launch did not resolve.',
    });
    assert.match(buildGuidedLaunchTerminalMessage(result), /failed after acceptance/);
  });
});