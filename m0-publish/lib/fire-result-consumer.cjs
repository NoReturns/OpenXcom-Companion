'use strict';

/**
 * Directed-fire tactical-result presentation (SNAP_SHOT, AUTO_SHOT, AIMED_SHOT).
 * Mirrors move-result-consumer: derived messages only — does not alter engine JSON.
 */

const DIRECTED_FIRE_COMMAND_TYPES = new Set(['SNAP_SHOT', 'AUTO_SHOT', 'AIMED_SHOT']);

/** Engine preflight reject publicReason (P1-FIRE-LANE-03). */
const ENGINE_PREFLIGHT_NO_LOF_PUBLIC_REASON = 'No line of fire to visible target.';

const POST_ACCEPT_NO_LOF_REASON = 'STR_NO_LINE_OF_FIRE';

const TERMINAL_FIRE_STATUSES = new Set(['REJECTED', 'COMPLETED', 'INTERRUPTED', 'FAILED']);

const FIRE_OUTCOME_CLASS = Object.freeze({
  PROJECTILE_LAUNCHED: 'projectile_launched',
  REJECTED_BEFORE_EXECUTION: 'rejected_before_execution',
  FAILED_AFTER_ACCEPTANCE: 'failed_after_acceptance',
  INTERRUPTED: 'interrupted',
  NON_TERMINAL: 'non_terminal',
  NOT_FIRE: 'not_fire',
});

const FIRE_RESULT_CONSUMER_RULES = [
  {
    id: 'completed_not_hit',
    rule:
      'COMPLETED means at least one projectile launched for this command (AUTO may still be mid-burst while EXECUTING). It does not confirm hit, damage, or kill.',
  },
  {
    id: 'rejected_vs_failed',
    rule:
      'REJECTED means the command did not execute. FAILED means execution began but did not reach successful fire completion (no projectile launched when idle).',
  },
  {
    id: 'lof_preflight_vs_post',
    rule:
      'Preflight NO_LINE_OF_FIRE is REJECTED with engine public_reason about visible target blockage. Post-accept STR_NO_LINE_OF_FIRE is FAILED.',
  },
  {
    id: 'tu_ammo_not_inferred',
    rule:
      'Do not infer TU spent, refunded, or ammunition consumed from status alone; use remaining_tu and refreshed tactical state when needed.',
  },
  {
    id: 'ignore_destination_reached',
    rule:
      'Fire results may include destination_reached: false from shared JSON shape — ignore it for fire commands.',
  },
];

function isDirectedFireCommandType(commandType) {
  return typeof commandType === 'string' && DIRECTED_FIRE_COMMAND_TYPES.has(commandType);
}

function isPreflightNoLineOfFireReject(publicReason) {
  return publicReason === ENGINE_PREFLIGHT_NO_LOF_PUBLIC_REASON;
}

function isPostAcceptNoLineOfFireFail(publicReason) {
  return publicReason === POST_ACCEPT_NO_LOF_REASON;
}

/**
 * One-line human summary from authoritative result fields only.
 * @param {object|null|undefined} result
 * @returns {string|null}
 */
function buildFireTerminalMessage(result) {
  if (!result || !isDirectedFireCommandType(result.command_type)) {
    return null;
  }
  const status = result.status;
  const publicReason = typeof result.public_reason === 'string'
    ? result.public_reason.trim()
    : '';

  if (status === 'COMPLETED') {
    return 'Shot fired. Hit not confirmed.';
  }
  if (status === 'REJECTED') {
    if (isPreflightNoLineOfFireReject(publicReason)) {
      return 'Shot rejected before execution: no line of fire.';
    }
    if (publicReason) {
      return `Shot rejected before execution: ${publicReason}`;
    }
    return 'Shot rejected before execution.';
  }
  if (status === 'FAILED') {
    if (isPostAcceptNoLineOfFireFail(publicReason)) {
      return 'Shot failed after acceptance: no line of fire.';
    }
    if (publicReason) {
      return `Shot failed after acceptance: ${publicReason}`;
    }
    return 'Shot failed after acceptance.';
  }
  if (status === 'INTERRUPTED') {
    if (publicReason && publicReason.length > 0) {
      return `Fire command interrupted. ${publicReason}`;
    }
    return 'Fire command interrupted.';
  }
  return null;
}

function resolveFireOutcomeClass(result) {
  if (!result || !isDirectedFireCommandType(result.command_type)) {
    return FIRE_OUTCOME_CLASS.NOT_FIRE;
  }
  const status = result.status;
  if (status === 'EXECUTING' || status === 'ACCEPTED') {
    return FIRE_OUTCOME_CLASS.NON_TERMINAL;
  }
  if (status === 'COMPLETED') {
    return FIRE_OUTCOME_CLASS.PROJECTILE_LAUNCHED;
  }
  if (status === 'REJECTED') {
    return FIRE_OUTCOME_CLASS.REJECTED_BEFORE_EXECUTION;
  }
  if (status === 'FAILED') {
    return FIRE_OUTCOME_CLASS.FAILED_AFTER_ACCEPTANCE;
  }
  if (status === 'INTERRUPTED') {
    return FIRE_OUTCOME_CLASS.INTERRUPTED;
  }
  return FIRE_OUTCOME_CLASS.NON_TERMINAL;
}

/**
 * Derived agent/operator brief (does not alter tactical-result.json).
 * @param {object} result
 */
function buildFireOutcomeBrief(result) {
  if (!result || !isDirectedFireCommandType(result.command_type)) {
    return null;
  }
  const outcomeClass = resolveFireOutcomeClass(result);
  if (outcomeClass === FIRE_OUTCOME_CLASS.NON_TERMINAL) {
    return null;
  }
  const message = buildFireTerminalMessage(result);
  const status = result.status;
  const executionLaunched = status === 'COMPLETED';

  return {
    command_type: result.command_type,
    status,
    outcome_class: outcomeClass,
    message,
    execution_launched: executionLaunched,
    may_publish_after_fresh_binding: TERMINAL_FIRE_STATUSES.has(status),
  };
}

function getFireResultContractMarkdown() {
  return [
    '# Directed fire — result verification (derived)',
    '',
    ...FIRE_RESULT_CONSUMER_RULES.map((r) => `- **${r.id}:** ${r.rule}`),
    '',
  ].join('\n');
}

module.exports = {
  DIRECTED_FIRE_COMMAND_TYPES,
  ENGINE_PREFLIGHT_NO_LOF_PUBLIC_REASON,
  POST_ACCEPT_NO_LOF_REASON,
  FIRE_OUTCOME_CLASS,
  FIRE_RESULT_CONSUMER_RULES,
  isDirectedFireCommandType,
  buildFireTerminalMessage,
  buildFireOutcomeBrief,
  resolveFireOutcomeClass,
  getFireResultContractMarkdown,
};
