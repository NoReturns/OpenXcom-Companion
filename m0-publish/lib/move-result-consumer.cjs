'use strict';

/**
 * MOVE tactical-result contract for agents and relay tooling (M1 post-terror #8).
 * Mirrors engine evaluateWalkTerminalStatus + CompanionCommandRuntime buildMoveResultJson.
 * Does not validate pathfinding or movement legality — results only.
 */

const MOVE_RESULT_CONSUMER_RULES = [
  {
    id: 'completed_means_dest_tile',
    rule:
      'COMPLETED means the walk finished with the actor on the commanded destination tile: same integer x, y, and z as the MOVE destination object. Engine sets destination_reached: true and final_position to that tile.',
  },
  {
    id: 'status_over_optimistic_flags',
    rule:
      'Terminal status is authoritative. FAILED or INTERRUPTED with destination_reached: true is valid (engine walk evaluator); never treat the move as tactically successful from destination_reached alone.',
  },
  {
    id: 'interrupted_partial',
    rule:
      'INTERRUPTED means partial progress or authority loss. Use final_position as the only authoritative stop tile; never assume the commanded destination.',
  },
  {
    id: 'verify_before_chain',
    rule:
      'Before the next MOVE or dependent order, verify command_id, session_id, status, destination_reached (when present), and final_position against the published command destination. status COMPLETED without a matching final_position is not a successful move.',
  },
  {
    id: 'cross_level_z',
    rule:
      'Destination z is part of the command. Ramps, stairs, multi-level staircases, UFO grav lifts, and Skyranger decks require correct z; cross-level paths are engine pathfinding only. gravLiftStructures links have pathfindingGuaranteed: false — stage multi-tile MOVEs and confirm each final_position.',
  },
  {
    id: 'fair_play_terrain',
    rule:
      'ASCII and terrain-query do not guarantee MOVE success. Use floor G/g and grav hints for planning only; engine result fields and refreshed commandBinding positions after terminal MOVE are authoritative.',
  },
  {
    id: 'legacy_optional_fields',
    rule:
      'When destination_reached is absent (legacy result), infer success only from COMPLETED plus final_position matching the command destination when the command is known; otherwise require operator SEND or refreshed state before replanning.',
  },
];

const TERMINAL_MOVE_STATUSES = new Set(['COMPLETED', 'INTERRUPTED', 'FAILED', 'REJECTED']);

/** Engine movement_stop_reason values observed in CompanionCommandCore (authoritative only). */
const KNOWN_MOVEMENT_STOP_REASONS = new Set([
  'hostile_spotted',
  'reaction_fire',
  'path_blocked',
  'proximity_grenade',
  'insufficient_time_units',
  'insufficient_energy',
  'actor_incapacitated',
  'authority_lost',
  'movement_incomplete',
  'no_progress',
]);

const MOVEMENT_STOP_REASON_LABELS = Object.freeze({
  hostile_spotted: 'Hostile spotted',
  reaction_fire: 'Reaction fire interrupted movement',
  path_blocked: 'Path blocked',
  proximity_grenade: 'Proximity grenade',
  insufficient_time_units: 'Insufficient time units',
  insufficient_energy: 'Insufficient stamina',
  actor_incapacitated: 'Actor incapacitated',
  authority_lost: 'Authority lost (no longer AI-controlled)',
  movement_incomplete: 'Movement incomplete',
  no_progress: 'No progress toward destination',
});

/** Engine bucket stops — not confirmed tactical battlefield events (P1-REACTION-RISK-02D). */
const GENERIC_MOVEMENT_STOP_REASONS = new Set(['movement_incomplete', 'no_progress']);

function shouldPresentStopCauseInMessage(stopCause) {
  if (!stopCause?.cause_label) {
    return false;
  }
  if (stopCause.cause_confirmed) {
    return true;
  }
  const raw = stopCause.movement_stop_reason;
  return typeof raw === 'string' && GENERIC_MOVEMENT_STOP_REASONS.has(raw);
}

/** Operator label: confirmed tactical stops use Cause; generic engine buckets use Stop detail (02E). */
function formatStopCausePresentationLine(stopCause) {
  if (!shouldPresentStopCauseInMessage(stopCause)) {
    return null;
  }
  const prefix = stopCause.cause_confirmed ? 'Cause' : 'Stop detail';
  return `${prefix}: ${stopCause.cause_label}`;
}

function formatPositionTriplet(pos) {
  const n = normalizePosition(pos);
  if (!n) {
    return null;
  }
  return `(${n.x},${n.y},${n.z})`;
}

/**
 * Derives interruption cause from engine movement_stop_reason only — never from position delta.
 * @param {object|null|undefined} result
 */
function resolveMoveInterruptionCause(result) {
  const raw = typeof result?.movement_stop_reason === 'string'
    ? result.movement_stop_reason.trim()
    : '';
  if (!raw) {
    const terminal = result?.status === 'INTERRUPTED' || result?.status === 'FAILED';
    return {
      movement_stop_reason: null,
      move_interruption_cause: terminal ? 'unknown' : null,
      cause_confirmed: false,
      cause_label: null,
    };
  }
  const known = KNOWN_MOVEMENT_STOP_REASONS.has(raw);
  const generic = GENERIC_MOVEMENT_STOP_REASONS.has(raw);
  return {
    movement_stop_reason: raw,
    move_interruption_cause: raw,
    cause_confirmed: known && !generic,
    cause_label: MOVEMENT_STOP_REASON_LABELS[raw] ?? raw.replace(/_/g, ' '),
  };
}

const MOVE_OUTCOME_CLASS = Object.freeze({
  COMPLETED_VERIFIED_DESTINATION: 'completed_verified_destination',
  INTERRUPTED_KNOWN_FINAL_POSITION: 'interrupted_known_final_position',
  FAILED_OR_REJECTED: 'failed_or_rejected',
  CONTRACT_INCOMPLETE_OR_UNVERIFIED: 'contract_incomplete_or_unverified',
  NON_TERMINAL: 'non_terminal',
  NOT_MOVE: 'not_move',
});

function resolveMoveOutcomeClass(result, command, classified) {
  if (!result || result.command_type !== 'MOVE') {
    return MOVE_OUTCOME_CLASS.NOT_MOVE;
  }
  const status = classified?.status ?? result.status;
  if (status === 'ACCEPTED' || status === 'EXECUTING') {
    return MOVE_OUTCOME_CLASS.NON_TERMINAL;
  }
  if (status === 'REJECTED' || status === 'FAILED') {
    return MOVE_OUTCOME_CLASS.FAILED_OR_REJECTED;
  }
  if (status === 'INTERRUPTED') {
    return classified?.finalPosition
      ? MOVE_OUTCOME_CLASS.INTERRUPTED_KNOWN_FINAL_POSITION
      : MOVE_OUTCOME_CLASS.CONTRACT_INCOMPLETE_OR_UNVERIFIED;
  }
  if (status === 'COMPLETED') {
    return classified.tacticalSuccess
      ? MOVE_OUTCOME_CLASS.COMPLETED_VERIFIED_DESTINATION
      : MOVE_OUTCOME_CLASS.CONTRACT_INCOMPLETE_OR_UNVERIFIED;
  }
  return MOVE_OUTCOME_CLASS.CONTRACT_INCOMPLETE_OR_UNVERIFIED;
}

function normalizePosition(pos) {
  if (!pos) {
    return null;
  }
  if (Array.isArray(pos)) {
    if (pos.length < 3) {
      return null;
    }
    return { x: pos[0], y: pos[1], z: pos[2] };
  }
  if (
    typeof pos === 'object'
    && Number.isInteger(pos.x)
    && Number.isInteger(pos.y)
    && Number.isInteger(pos.z)
  ) {
    return { x: pos.x, y: pos.y, z: pos.z };
  }
  return null;
}

function positionsEqual3d(a, b) {
  const na = normalizePosition(a);
  const nb = normalizePosition(b);
  if (!na || !nb) {
    return false;
  }
  return na.x === nb.x && na.y === nb.y && na.z === nb.z;
}

function commandedDestinationFromMoveCommand(command) {
  if (!command || command.command_type !== 'MOVE') {
    return null;
  }
  return normalizePosition(command.destination);
}

/**
 * @param {object|null|undefined} result — parsed tactical-result.json for MOVE
 * @param {object|null|undefined} [command] — original MOVE command (for destination compare)
 */
function classifyMoveTerminalOutcome(result, command = null) {
  const dest = commandedDestinationFromMoveCommand(command);
  const finalPosition = normalizePosition(result?.final_position);
  const startingPosition = normalizePosition(result?.starting_position);
  const status = typeof result?.status === 'string' ? result.status : null;
  const hasDestinationReachedField = result != null
    && Object.prototype.hasOwnProperty.call(result, 'destination_reached');
  const destinationReached = hasDestinationReachedField
    ? result.destination_reached === true
    : null;

  const contractWarnings = [];
  const positionMatchesDestination = dest != null && finalPosition != null
    ? positionsEqual3d(finalPosition, dest)
    : null;

  let statusDestinationConsistent = null;
  if (status === 'COMPLETED') {
    if (hasDestinationReachedField && destinationReached !== true) {
      contractWarnings.push('COMPLETED with destination_reached not true');
      statusDestinationConsistent = false;
    } else if (dest != null && finalPosition != null && !positionMatchesDestination) {
      contractWarnings.push('COMPLETED but final_position does not match command destination');
      statusDestinationConsistent = false;
    } else if (dest != null && finalPosition == null) {
      contractWarnings.push('COMPLETED missing final_position for destination check');
      statusDestinationConsistent = false;
    } else if (hasDestinationReachedField) {
      statusDestinationConsistent = destinationReached === true
        && (dest == null || positionMatchesDestination !== false);
    } else {
      statusDestinationConsistent = dest == null || positionMatchesDestination === true;
    }
  } else if (status === 'INTERRUPTED' || status === 'FAILED') {
    if (hasDestinationReachedField && destinationReached === true) {
      contractWarnings.push(`${status} with destination_reached true — trust status, not the flag for success`);
    }
    statusDestinationConsistent = hasDestinationReachedField
      ? destinationReached === false
      : null;
  }

  let tacticalSuccess = false;
  if (status === 'COMPLETED' && dest != null && finalPosition != null) {
    tacticalSuccess = positionMatchesDestination === true
      && (!hasDestinationReachedField || destinationReached === true);
  }

  const replan = buildMoveReplanGuidance({
    status,
    tacticalSuccess,
    finalPosition,
    startingPosition,
    dest,
    destinationReached,
    contractWarnings,
    movementStopReason: result?.movement_stop_reason,
    publicReason: result?.public_reason,
  });

  let terminalMeaning = 'non_terminal_or_unknown';
  if (status === 'COMPLETED') {
    terminalMeaning = tacticalSuccess
      ? 'walk_finished_on_commanded_destination'
      : 'completed_status_but_destination_not_verified';
  } else if (status === 'INTERRUPTED') {
    terminalMeaning = 'walk_stopped_short_or_interrupted';
  } else if (status === 'FAILED') {
    terminalMeaning = 'walk_failed_terminal';
  } else if (status === 'REJECTED') {
    terminalMeaning = 'command_rejected';
  }

  const crossLevelCommand = dest != null && startingPosition != null
    ? dest.z !== startingPosition.z
    : null;
  const crossLevelStop = dest != null && finalPosition != null && startingPosition != null
    ? finalPosition.z !== startingPosition.z
    : null;

  const outcomeClass = resolveMoveOutcomeClass(result, command, {
    status,
    finalPosition,
    tacticalSuccess,
  });

  return {
    status,
    outcomeClass,
    terminalMeaning,
    finalPosition,
    startingPosition,
    commandedDestination: dest,
    destinationReached,
    destinationReachedKnown: hasDestinationReachedField,
    positionMatchesDestination,
    statusDestinationConsistent,
    tacticalSuccess,
    crossLevelCommand,
    crossLevelStop,
    contractWarnings,
    replan,
  };
}

/**
 * Derived agent brief (does not alter engine tactical-result.json).
 * @param {object} result
 * @param {object|null} command — delivered MOVE command when available
 */
/**
 * Operator-facing terminal summary (derived; does not alter engine JSON).
 * @param {object|null|undefined} result
 * @param {object|null} [command]
 * @returns {string|null}
 */
function buildMoveTerminalMessage(result, command = null) {
  if (!result || result.command_type !== 'MOVE') {
    return null;
  }
  const status = result.status;
  if (status === 'ACCEPTED' || status === 'EXECUTING') {
    return null;
  }

  const classified = classifyMoveTerminalOutcome(result, command);
  const dest = commandedDestinationFromMoveCommand(command) ?? classified.commandedDestination;
  const finalPos = classified.finalPosition ?? normalizePosition(result.final_position);
  const destLabel = formatPositionTriplet(dest);
  const finalLabel = formatPositionTriplet(finalPos);
  const stopCause = resolveMoveInterruptionCause(result);
  const tuLine = typeof result.remaining_tu === 'number'
    ? `Remaining TU: ${result.remaining_tu}`
    : null;

  if (status === 'COMPLETED') {
    if (classified.tacticalSuccess) {
      const lines = ['MOVE completed'];
      if (destLabel) {
        lines.push(`Destination: ${destLabel}`);
      } else if (finalLabel) {
        lines.push(`Final position: ${finalLabel}`);
      }
      if (tuLine) {
        lines.push(tuLine);
      }
      return lines.join('\n');
    }
    return 'MOVE COMPLETED but destination not verified — refresh tactical state before replanning.';
  }

  if (status === 'REJECTED') {
    const pr = typeof result.public_reason === 'string' && result.public_reason.trim()
      ? result.public_reason.trim()
      : 'Command rejected before execution.';
    return `MOVE rejected before execution: ${pr}`;
  }

  if (status === 'FAILED') {
    const lines = ['MOVE failed'];
    const stopLine = formatStopCausePresentationLine(stopCause);
    if (stopLine) {
      lines.push(stopLine);
    } else if (typeof result.public_reason === 'string' && result.public_reason.trim()) {
      lines.push(result.public_reason.trim());
    }
    if (finalLabel) {
      lines.push(`Stopped: ${finalLabel}`);
    }
    if (tuLine) {
      lines.push(tuLine);
    }
    lines.push('Refresh tactical state before replanning.');
    return lines.join('\n');
  }

  if (status === 'INTERRUPTED') {
    const lines = ['MOVE interrupted'];
    const stopLine = formatStopCausePresentationLine(stopCause);
    if (stopLine) {
      lines.push(stopLine);
      if (stopCause.cause_confirmed && stopCause.move_interruption_cause === 'reaction_fire') {
        lines.push('Reaction fire does not confirm hit or damage.');
      }
    } else {
      lines.push('Movement stopped before the requested destination; cause not confirmed.');
    }
    if (destLabel) {
      lines.push(`Requested: ${destLabel}`);
    }
    if (finalLabel) {
      lines.push(`Stopped: ${finalLabel}`);
    }
    if (tuLine) {
      lines.push(tuLine);
    }
    lines.push('Refresh tactical state before replanning.');
    return lines.join('\n');
  }

  return null;
}

/**
 * Notification / relay enrichment fields for terminal MOVE results.
 * @param {object} result
 * @param {object|null} command
 */
function enrichMoveResultNotification(result, command = null) {
  if (!result || result.command_type !== 'MOVE') {
    return null;
  }
  const status = result.status;
  if (status === 'ACCEPTED' || status === 'EXECUTING') {
    return null;
  }
  const brief = buildMoveOutcomeBrief(result, command);
  const stopCause = resolveMoveInterruptionCause(result);
  const message = buildMoveTerminalMessage(result, command);
  const out = {
    command_type: 'MOVE',
    message,
  };
  if (brief) {
    out.move_outcome_class = brief.outcome_class;
    out.move_tactical_success = brief.tactical_success;
    out.may_chain_next_command = brief.may_chain_next_command;
    out.requires_fresh_binding = brief.requires_fresh_binding_before_next_publish;
    if (brief.commanded_destination) {
      out.commanded_destination = brief.commanded_destination;
    }
    if (brief.final_position) {
      out.final_position = brief.final_position;
    }
  }
  if (stopCause.movement_stop_reason) {
    out.movement_stop_reason = stopCause.movement_stop_reason;
  }
  if (stopCause.move_interruption_cause) {
    out.move_interruption_cause = stopCause.move_interruption_cause;
  }
  if (typeof result.remaining_tu === 'number') {
    out.remaining_tu = result.remaining_tu;
  }
  return out;
}

function buildMoveOutcomeBrief(result, command = null) {
  if (!result || result.command_type !== 'MOVE') {
    return null;
  }
  const classified = classifyMoveTerminalOutcome(result, command);
  const recovery = resolveMoveRecoveryPolicy(classified);
  const stopCause = resolveMoveInterruptionCause(result);
  const terminalMessage = buildMoveTerminalMessage(result, command);
  const lines = [];
  if (classified.outcomeClass === MOVE_OUTCOME_CLASS.COMPLETED_VERIFIED_DESTINATION) {
    const p = classified.finalPosition;
    lines.push(
      `MOVE verified on commanded destination (x:${p.x}, y:${p.y}, z:${p.z}). Safe to refresh binding before the next order — do not auto-chain without fresh commandBinding.`,
    );
  } else if (classified.outcomeClass === MOVE_OUTCOME_CLASS.INTERRUPTED_KNOWN_FINAL_POSITION) {
    const p = classified.finalPosition;
    if (stopCause.cause_confirmed && stopCause.cause_label) {
      lines.push(`MOVE interrupted (${stopCause.cause_label}); replan from final_position (x:${p.x}, y:${p.y}, z:${p.z}).`);
      if (stopCause.move_interruption_cause === 'reaction_fire') {
        lines.push('Reaction fire on the result does not confirm hit or damage — read refreshed state for injuries.');
      }
    } else {
      lines.push(
        `MOVE interrupted; replan from final_position (x:${p.x}, y:${p.y}, z:${p.z}). Do not assume the original destination.`,
      );
    }
    if (classified.crossLevelStop || classified.crossLevelCommand) {
      lines.push('Cross-level move (ramp/stairs/grav lift): stage short MOVEs and confirm each z before chaining.');
    }
  } else if (classified.outcomeClass === MOVE_OUTCOME_CLASS.FAILED_OR_REJECTED) {
    lines.push(`MOVE ${classified.status}: do not treat as successful. ${classified.replan.guidance}`);
  } else if (classified.outcomeClass === MOVE_OUTCOME_CLASS.CONTRACT_INCOMPLETE_OR_UNVERIFIED) {
    lines.push(
      'MOVE result not verified for chaining — check final_position, destination_reached (all x/y/z), and matching published destination.',
    );
    if (classified.contractWarnings.length) {
      lines.push(classified.contractWarnings.join('; '));
    }
    lines.push(classified.replan.guidance);
  } else {
    lines.push('MOVE not terminal; wait for engine result.');
  }

  return {
    schema_version: 1,
    command_id: result.command_id,
    command_type: 'MOVE',
    status: result.status,
    outcome_class: classified.outcomeClass,
    tactical_success: classified.tacticalSuccess,
    may_chain_next_command: recovery.mayContinuePriorMovePlan,
    may_continue_prior_move_plan: recovery.mayContinuePriorMovePlan,
    requires_fresh_binding_before_next_publish: recovery.requiresFreshBindingBeforeNextPublish,
    may_publish_after_fresh_binding: recovery.mayPublishAfterFreshBinding,
    republish_anchor_position: recovery.republishAnchorPosition,
    final_position: classified.finalPosition,
    commanded_destination: classified.commandedDestination,
    destination_reached: classified.destinationReached,
    contract_warnings: classified.contractWarnings,
    assessment_lines: lines,
    replan_required: classified.replan.required === true,
    movement_stop_reason: stopCause.movement_stop_reason,
    move_interruption_cause: stopCause.move_interruption_cause,
    interruption_cause_confirmed: stopCause.cause_confirmed,
    cause_label: stopCause.cause_label,
    remaining_tu: typeof result.remaining_tu === 'number' ? result.remaining_tu : null,
    terminal_message: terminalMessage,
  };
}

/**
 * Mandatory agent workflow step after terminal MOVE (programmatic mirror).
 */
/**
 * Separates chaining the prior MOVE plan from publishing a new command after fresh binding.
 * readyForNextCommand / mayContinuePriorMovePlan are false after INTERRUPTED — not a permanent publish ban.
 */
function resolveMoveRecoveryPolicy(classified) {
  const terminal = Boolean(classified?.status && TERMINAL_MOVE_STATUSES.has(classified.status));
  const mayContinuePriorMovePlan = classified?.tacticalSuccess === true;
  return {
    mayContinuePriorMovePlan,
    requiresFreshBindingBeforeNextPublish: terminal && !mayContinuePriorMovePlan,
    mayPublishAfterFreshBinding: terminal,
    replanFromFinalPositionOnly:
      classified?.outcomeClass === MOVE_OUTCOME_CLASS.INTERRUPTED_KNOWN_FINAL_POSITION,
    republishAnchorPosition: classified?.outcomeClass === MOVE_OUTCOME_CLASS.INTERRUPTED_KNOWN_FINAL_POSITION
      ? classified.finalPosition
      : null,
  };
}

function runMandatoryMoveResultReview(result, command = null) {
  if (!result || result.command_type !== 'MOVE') {
    return {
      sequenceCompleted: false,
      skipped: true,
      reason: 'not_move',
    };
  }
  const classified = classifyMoveTerminalOutcome(result, command);
  const brief = buildMoveOutcomeBrief(result, command);
  const recovery = resolveMoveRecoveryPolicy(classified);
  return {
    sequenceCompleted: true,
    classified,
    brief,
    recovery,
    mayPublishNextCommand: recovery.mayContinuePriorMovePlan,
    mayContinuePriorMovePlan: recovery.mayContinuePriorMovePlan,
    requiresFreshBindingBeforeNextPublish: recovery.requiresFreshBindingBeforeNextPublish,
    mayPublishAfterFreshBinding: recovery.mayPublishAfterFreshBinding,
    mustReplanFromFinalPosition: recovery.replanFromFinalPositionOnly,
    assessmentLines: brief?.assessment_lines ?? [],
  };
}

function isMoveTacticallySuccessful(result, command = null) {
  return classifyMoveTerminalOutcome(result, command).tacticalSuccess;
}

function buildMoveReplanGuidance(ctx) {
  const {
    status,
    tacticalSuccess,
    finalPosition,
    dest,
    contractWarnings,
    movementStopReason,
    publicReason,
  } = ctx;

  if (status == null || status === 'ACCEPTED' || status === 'EXECUTING') {
    return {
      required: false,
      reason: 'not_terminal',
      guidance: 'Wait for terminal MOVE result.',
    };
  }

  if (status === 'COMPLETED' && tacticalSuccess) {
    return {
      required: false,
      reason: 'destination_verified',
      guidance: 'Move succeeded on commanded tile. Refresh commandBinding or wait for post-command state before the next order.',
    };
  }

  if (status === 'COMPLETED' && !tacticalSuccess) {
    return {
      required: true,
      reason: 'completed_without_verified_destination',
      guidance:
        'Treat as incomplete: read refreshed m0/state.json or request SEND. Do not chain on this result. '
        + (contractWarnings.length ? contractWarnings.join('; ') : 'Verify final_position and destination_reached.'),
    };
  }

  if (status === 'INTERRUPTED' || status === 'FAILED') {
    const stop = finalPosition
      ? `(x:${finalPosition.x}, y:${finalPosition.y}, z:${finalPosition.z})`
      : 'unknown tile';
    const nearVertical = dest != null && finalPosition != null && dest.z !== finalPosition.z;
    const rampHint = nearVertical
      ? ' Near ramp/stairs/grav lift: stage a short MOVE to an adjacent tile at the correct z (floor G/g / grav hints), not a long diagonal across levels.'
      : '';
    const doorHint = movementStopReason === 'path_blocked'
      ? ' Path blocked — try an adjacent staging tile or wait for door state change after refresh.'
      : '';
    return {
      required: true,
      reason: status === 'INTERRUPTED' ? 'interrupted' : 'failed',
      guidance:
        `Replan from final_position ${stop}, not the original destination.${rampHint}${doorHint}`
        + (publicReason ? ` Engine: ${publicReason}` : ''),
    };
  }

  if (status === 'REJECTED') {
    return {
      required: true,
      reason: 'rejected',
      guidance: 'Fix binding, ownership, or validation errors before replanning MOVE.',
    };
  }

  return {
    required: true,
    reason: 'unknown_terminal',
    guidance: 'Verify terminal result and refreshed binding before another MOVE.',
  };
}

function getMoveResultContractMarkdown() {
  const lines = [
    '## MOVE result verification (mandatory before chaining orders)',
    '',
    'After RETRIEVE, for `command_type: MOVE` only:',
    '',
    '1. Match `command_id` and `session_id` to the published command.',
    '2. Read `status`, `final_position`, and `destination_reached` (when present).',
    '3. **Tactical success** = `status` is `COMPLETED` **and** `final_position` equals the command `destination` (x, y, z) **and** (`destination_reached` is `true` or absent with matching `final_position`).',
    '4. `INTERRUPTED` / `FAILED`: use `final_position` only; replan with a **new** `command_id` and fresh binding.',
    '5. Cross-level ramps, stairs, grav lifts, Skyranger decks: z matters; use grav floor **G**/**g** and `terrainFullAsciiBattlefield.hints.gravLiftStructures` for planning — `pathfindingGuaranteed: false` on vertical links.',
    '',
    'Contract rules:',
    '',
  ];
  for (const item of MOVE_RESULT_CONSUMER_RULES) {
    lines.push(`- **${item.id}:** ${item.rule}`);
  }
  return lines.join('\n');
}

module.exports = {
  MOVE_RESULT_CONSUMER_RULES,
  MOVE_OUTCOME_CLASS,
  TERMINAL_MOVE_STATUSES,
  KNOWN_MOVEMENT_STOP_REASONS,
  MOVEMENT_STOP_REASON_LABELS,
  normalizePosition,
  positionsEqual3d,
  commandedDestinationFromMoveCommand,
  classifyMoveTerminalOutcome,
  isMoveTacticallySuccessful,
  buildMoveReplanGuidance,
  resolveMoveInterruptionCause,
  buildMoveTerminalMessage,
  enrichMoveResultNotification,
  buildMoveOutcomeBrief,
  resolveMoveRecoveryPolicy,
  runMandatoryMoveResultReview,
  getMoveResultContractMarkdown,
};
