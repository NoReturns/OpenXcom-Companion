'use strict';

/**
 * GUIDED_LAUNCH tactical-result presentation (blaster / waypoint explosives).
 * Derived messages only — does not alter engine JSON.
 */

const COMMAND_TYPE_GUIDED_LAUNCH = 'GUIDED_LAUNCH';

const TERMINAL_GUIDED_LAUNCH_STATUSES = new Set(['REJECTED', 'COMPLETED', 'INTERRUPTED', 'FAILED']);

const GUIDED_LAUNCH_OUTCOME_CLASS = Object.freeze({
  PROJECTILE_LAUNCHED: 'projectile_launched',
  REJECTED_BEFORE_EXECUTION: 'rejected_before_execution',
  FAILED_AFTER_ACCEPTANCE: 'failed_after_acceptance',
  INTERRUPTED: 'interrupted',
  NON_TERMINAL: 'non_terminal',
  NOT_GUIDED_LAUNCH: 'not_guided_launch',
});

const GUIDED_LAUNCH_RESULT_CONSUMER_RULES = [
  {
    id: 'completed_not_detonation',
    rule:
      'COMPLETED means the guided projectile stack finished for this command while battle was idle (lift-off occurred earlier). It does not confirm waypoint detonation, damage, or kills.',
  },
  {
    id: 'rejected_vs_failed',
    rule:
      'REJECTED means the command did not execute. FAILED means execution began but did not reach successful launch completion.',
  },
  {
    id: 'preflight_waypoints',
    rule:
      'Preflight INVALID_WAYPOINT or WAYPOINT_LIMIT_EXCEEDED are REJECTED with engine public_reason; treat as binding/snapshot validation failures, not in-mission interrupt.',
  },
  {
    id: 'tu_ammo_not_inferred',
    rule:
      'Do not infer TU spent or ammunition consumed from status alone; use remaining_tu and a fresh tactical export when needed.',
  },
  {
    id: 'ignore_destination_reached',
    rule:
      'Guided launch results include destination_reached: false from shared JSON shape — ignore it for launch commands.',
  },
];

function isGuidedLaunchCommandType(commandType) {
  return commandType === COMMAND_TYPE_GUIDED_LAUNCH;
}

/**
 * @param {object|null|undefined} result
 * @returns {string|null}
 */
function buildGuidedLaunchTerminalMessage(result) {
  if (!result || !isGuidedLaunchCommandType(result.command_type)) {
    return null;
  }
  const status = result.status;
  const publicReason = typeof result.public_reason === 'string'
    ? result.public_reason.trim()
    : '';

  if (status === 'COMPLETED') {
    return 'Guided launch completed. Detonation or damage not confirmed.';
  }
  if (status === 'REJECTED') {
    if (publicReason) {
      return `Guided launch rejected before execution: ${publicReason}`;
    }
    return 'Guided launch rejected before execution.';
  }
  if (status === 'FAILED') {
    if (publicReason) {
      return `Guided launch failed after acceptance: ${publicReason}`;
    }
    return 'Guided launch failed after acceptance.';
  }
  if (status === 'INTERRUPTED') {
    if (publicReason && publicReason.length > 0) {
      return `Guided launch interrupted. ${publicReason}`;
    }
    return 'Guided launch interrupted.';
  }
  return null;
}

function resolveGuidedLaunchOutcomeClass(result) {
  if (!result || !isGuidedLaunchCommandType(result.command_type)) {
    return GUIDED_LAUNCH_OUTCOME_CLASS.NOT_GUIDED_LAUNCH;
  }
  const status = result.status;
  if (status === 'EXECUTING' || status === 'ACCEPTED') {
    return GUIDED_LAUNCH_OUTCOME_CLASS.NON_TERMINAL;
  }
  if (status === 'COMPLETED') {
    return GUIDED_LAUNCH_OUTCOME_CLASS.PROJECTILE_LAUNCHED;
  }
  if (status === 'REJECTED') {
    return GUIDED_LAUNCH_OUTCOME_CLASS.REJECTED_BEFORE_EXECUTION;
  }
  if (status === 'FAILED') {
    return GUIDED_LAUNCH_OUTCOME_CLASS.FAILED_AFTER_ACCEPTANCE;
  }
  if (status === 'INTERRUPTED') {
    return GUIDED_LAUNCH_OUTCOME_CLASS.INTERRUPTED;
  }
  return GUIDED_LAUNCH_OUTCOME_CLASS.NON_TERMINAL;
}

/**
 * @param {object} result
 */
function buildGuidedLaunchOutcomeBrief(result) {
  if (!result || !isGuidedLaunchCommandType(result.command_type)) {
    return null;
  }
  const outcomeClass = resolveGuidedLaunchOutcomeClass(result);
  if (outcomeClass === GUIDED_LAUNCH_OUTCOME_CLASS.NON_TERMINAL) {
    return null;
  }
  const message = buildGuidedLaunchTerminalMessage(result);
  const status = result.status;
  const executionLaunched = status === 'COMPLETED';

  return {
    command_type: result.command_type,
    status,
    outcome_class: outcomeClass,
    message,
    execution_launched: executionLaunched,
    may_publish_after_fresh_binding: TERMINAL_GUIDED_LAUNCH_STATUSES.has(status),
  };
}

function getGuidedLaunchResultContractMarkdown() {
  return [
    '# Guided launch — result verification (derived)',
    '',
    ...GUIDED_LAUNCH_RESULT_CONSUMER_RULES.map((r) => `- **${r.id}:** ${r.rule}`),
    '',
  ].join('\n');
}

module.exports = {
  COMMAND_TYPE_GUIDED_LAUNCH,
  GUIDED_LAUNCH_OUTCOME_CLASS,
  GUIDED_LAUNCH_RESULT_CONSUMER_RULES,
  TERMINAL_GUIDED_LAUNCH_STATUSES,
  isGuidedLaunchCommandType,
  buildGuidedLaunchTerminalMessage,
  buildGuidedLaunchOutcomeBrief,
  resolveGuidedLaunchOutcomeClass,
  getGuidedLaunchResultContractMarkdown,
};