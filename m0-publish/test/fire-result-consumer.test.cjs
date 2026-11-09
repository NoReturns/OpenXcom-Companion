'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  DIRECTED_FIRE_COMMAND_TYPES,
  ENGINE_PREFLIGHT_NO_LOF_PUBLIC_REASON,
  POST_ACCEPT_NO_LOF_REASON,
  FIRE_OUTCOME_CLASS,
  buildFireTerminalMessage,
  buildFireOutcomeBrief,
  resolveFireOutcomeClass,
  isDirectedFireCommandType,
} = require('../lib/fire-result-consumer.cjs');

function fireResult(commandType, overrides = {}) {
  return {
    schema_version: 1,
    command_type: commandType,
    command_id: 'fire-test-1',
    session_id: 'a1b2c3d4e5f6789012345678abcdef01',
    turn: 3,
    actor_unit_id: 1,
    status: 'COMPLETED',
    destination_reached: false,
    public_reason: '',
    ...overrides,
  };
}

describe('fire-result-consumer', () => {
  it('recognizes all directed-fire command types', () => {
    for (const t of DIRECTED_FIRE_COMMAND_TYPES) {
      assert.equal(isDirectedFireCommandType(t), true);
    }
    assert.equal(isDirectedFireCommandType('MOVE'), false);
  });

  for (const commandType of ['SNAP_SHOT', 'AIMED_SHOT', 'AUTO_SHOT']) {
    it(`${commandType} COMPLETED → projectile launched message`, () => {
      const result = fireResult(commandType, { status: 'COMPLETED' });
      assert.equal(buildFireTerminalMessage(result), 'Shot fired. Hit not confirmed.');
      const brief = buildFireOutcomeBrief(result);
      assert.equal(brief.outcome_class, FIRE_OUTCOME_CLASS.PROJECTILE_LAUNCHED);
      assert.equal(brief.execution_launched, true);
    });
  }

  it('preflight NO_LINE_OF_FIRE REJECTED', () => {
    const result = fireResult('SNAP_SHOT', {
      status: 'REJECTED',
      public_reason: ENGINE_PREFLIGHT_NO_LOF_PUBLIC_REASON,
    });
    assert.equal(
      buildFireTerminalMessage(result),
      'Shot rejected before execution: no line of fire.',
    );
    assert.equal(resolveFireOutcomeClass(result), FIRE_OUTCOME_CLASS.REJECTED_BEFORE_EXECUTION);
  });

  it('post-accept STR_NO_LINE_OF_FIRE FAILED', () => {
    const result = fireResult('AUTO_SHOT', {
      status: 'FAILED',
      public_reason: POST_ACCEPT_NO_LOF_REASON,
    });
    assert.equal(
      buildFireTerminalMessage(result),
      'Shot failed after acceptance: no line of fire.',
    );
    assert.equal(resolveFireOutcomeClass(result), FIRE_OUTCOME_CLASS.FAILED_AFTER_ACCEPTANCE);
  });

  it('generic FAILED with public_reason', () => {
    const result = fireResult('SNAP_SHOT', {
      status: 'FAILED',
      public_reason: 'Weapon fire did not resolve.',
    });
    assert.equal(
      buildFireTerminalMessage(result),
      'Shot failed after acceptance: Weapon fire did not resolve.',
    );
  });

  it('generic REJECTED with public_reason', () => {
    const result = fireResult('AIMED_SHOT', {
      status: 'REJECTED',
      public_reason: 'Not enough time units for aimed shot.',
    });
    assert.equal(
      buildFireTerminalMessage(result),
      'Shot rejected before execution: Not enough time units for aimed shot.',
    );
  });

  it('INTERRUPTED', () => {
    const result = fireResult('SNAP_SHOT', {
      status: 'INTERRUPTED',
      public_reason: 'Weapon fire interrupted or incomplete.',
    });
    assert.match(buildFireTerminalMessage(result), /^Fire command interrupted\./);
    assert.equal(resolveFireOutcomeClass(result), FIRE_OUTCOME_CLASS.INTERRUPTED);
  });

  it('missing public_reason on FAILED', () => {
    const result = fireResult('SNAP_SHOT', { status: 'FAILED', public_reason: undefined });
    assert.equal(buildFireTerminalMessage(result), 'Shot failed after acceptance.');
  });

  it('missing public_reason on REJECTED', () => {
    const result = fireResult('SNAP_SHOT', { status: 'REJECTED', public_reason: '' });
    assert.equal(buildFireTerminalMessage(result), 'Shot rejected before execution.');
  });

  it('nonterminal EXECUTING returns null brief', () => {
    const result = fireResult('SNAP_SHOT', { status: 'EXECUTING' });
    assert.equal(buildFireTerminalMessage(result), null);
    assert.equal(buildFireOutcomeBrief(result), null);
    assert.equal(resolveFireOutcomeClass(result), FIRE_OUTCOME_CLASS.NON_TERMINAL);
  });

  it('MOVE is not fire', () => {
    const result = {
      command_type: 'MOVE',
      status: 'COMPLETED',
    };
    assert.equal(buildFireOutcomeBrief(result), null);
    assert.equal(buildFireTerminalMessage(result), null);
  });

  it('ignores destination_reached semantics (message unchanged)', () => {
    const result = fireResult('SNAP_SHOT', {
      status: 'COMPLETED',
      destination_reached: true,
    });
    assert.equal(buildFireTerminalMessage(result), 'Shot fired. Hit not confirmed.');
  });
});
