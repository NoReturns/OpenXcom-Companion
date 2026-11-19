'use strict';

/**
 * Advisory TU composites (posture-on-MOVE, facing-on-FIRE) — non-authoritative planning mirrors.
 */

function directionToGrid(from, to) {
  const ox = to.x - from.x;
  const oy = to.y - from.y;
  const angle = Math.atan2(ox, -oy);
  const quarter = Math.PI / 4;
  const pies = [
    quarter * 4 - quarter / 2,
    quarter * 3 - quarter / 2,
    quarter * 2 - quarter / 2,
    quarter - quarter / 2,
  ];
  if (angle > pies[0] || angle < -pies[0]) return 4;
  if (angle > pies[1]) return 3;
  if (angle > pies[2]) return 2;
  if (angle > pies[3]) return 1;
  if (angle < -pies[1]) return 5;
  if (angle < -pies[2]) return 6;
  if (angle < -pies[3]) return 7;
  return 0;
}

function octagonalTurnSteps(fromDir, toDir) {
  const a = fromDir & 7;
  const b = toDir & 7;
  let d = Math.abs(a - b);
  if (d > 4) d = 8 - d;
  return d;
}

function estimateDirectedFireFacing(actor, target) {
  if (!actor || !Array.isArray(actor.position) || actor.position.length < 2) {
    return { steps: null, facingTu: null, uncertainty: 'missing_actor_position' };
  }
  if (!target || typeof target.x !== 'number' || typeof target.y !== 'number') {
    return { steps: null, facingTu: null, uncertainty: 'missing_target' };
  }
  if (!actor.facing || typeof actor.facing.direction !== 'number') {
    return { steps: null, facingTu: null, uncertainty: 'missing_facing' };
  }
  const from = { x: actor.position[0], y: actor.position[1], z: actor.position[2] ?? 0 };
  const desired = directionToGrid(from, target);
  const steps = octagonalTurnSteps(actor.facing.direction, desired);
  return { steps, facingTu: steps, uncertainty: null };
}

function buildHwpMovePlanningHint(actor) {
  const tu = actor?.friendlyHwpObservationV1?.timeUnits ?? actor?.timeUnits;
  return {
    advisory: true,
    note: 'Non-authoritative. Engine Pathfinding::calculate owns path legality, 2x2 footprint, '
      + 'TU costs, doors, terrain, occupancy, and partial walk stops. Node validates binding and map bounds only.',
    pathTuEstimateIncluded: false,
    footprintEstimateIncluded: false,
    ...(typeof tu === 'number' ? { exportTimeUnits: tu } : {}),
  };
}

function buildMovePlanningHint(actor) {
  if (!actor || typeof actor.timeUnits !== 'number') {
    return { advisory: true, note: 'MOVE planning hint unavailable.' };
  }
  const standTu = actor.movementTuAdvisory?.standUpTuBeforeWalk
    ?? (actor.kneeled === true ? 8 : 0);
  const needsStand = actor.kneeled === true || actor.movementTuAdvisory?.standUpRequiredBeforeWalk === true;
  const afterStand = needsStand ? actor.timeUnits - standTu : actor.timeUnits;
  return {
    advisory: true,
    note: 'Non-authoritative; path TU not estimated. Kneeling implies standUpTuBeforeWalk before first step.',
    standUpRequiredBeforeWalk: needsStand,
    standUpTuBeforeWalk: needsStand ? standTu : 0,
    timeUnitsAfterStandEstimate: needsStand ? afterStand : actor.timeUnits,
    pathTuEstimateIncluded: false,
  };
}

const HWP_TURN_PARTS = new Set(['body', 'turret']);

function actorPositionForHwpTurn(actor) {
  const obs = actor?.friendlyHwpObservationV1;
  if (obs?.position && typeof obs.position.x === 'number') {
    return { x: obs.position.x, y: obs.position.y, z: obs.position.z ?? 0 };
  }
  if (Array.isArray(actor?.position) && actor.position.length >= 2) {
    return {
      x: actor.position[0],
      y: actor.position[1],
      z: actor.position[2] ?? 0,
    };
  }
  return null;
}

function estimateHwpTurnFacing(actor, target, turnPart) {
  const fromPos = actorPositionForHwpTurn(actor);
  if (!fromPos) {
    return { steps: null, facingTu: null, uncertainty: 'missing_actor_position' };
  }
  if (!target || typeof target.x !== 'number' || typeof target.y !== 'number') {
    return { steps: null, facingTu: null, uncertainty: 'missing_target' };
  }
  const obs = actor.friendlyHwpObservationV1;
  if (!obs) {
    return { steps: null, facingTu: null, uncertainty: 'missing_hwp_observation' };
  }
  let fromDir;
  if (turnPart === 'turret') {
    if (obs.capabilities?.turretTurn !== true) {
      return { steps: null, facingTu: null, uncertainty: 'turret_turn_not_supported' };
    }
    if (!obs.turretFacing || typeof obs.turretFacing.direction !== 'number') {
      return { steps: null, facingTu: null, uncertainty: 'missing_turret_facing' };
    }
    fromDir = obs.turretFacing.direction;
  } else if (turnPart === 'body') {
    if (obs.bodyFacing && typeof obs.bodyFacing.direction === 'number') {
      fromDir = obs.bodyFacing.direction;
    } else if (actor.facing && typeof actor.facing.direction === 'number') {
      fromDir = actor.facing.direction;
    } else {
      return { steps: null, facingTu: null, uncertainty: 'missing_body_facing' };
    }
  } else {
    return { steps: null, facingTu: null, uncertainty: 'invalid_turn_part' };
  }
  const desired = directionToGrid(fromPos, target);
  const steps = octagonalTurnSteps(fromDir, desired);
  return { steps, facingTu: steps, uncertainty: null };
}

function buildHwpTurnPlanningHint(actor, target, turnPart) {
  const facing = estimateHwpTurnFacing(actor, target, turnPart);
  const facingTu = facing.steps != null ? facing.steps : null;
  const tu = actor?.friendlyHwpObservationV1?.timeUnits ?? actor?.timeUnits;
  let turnAffordableEstimate = null;
  if (typeof tu === 'number' && facingTu != null) {
    turnAffordableEstimate = tu >= facingTu;
  }
  const notes = [
    'Non-authoritative; engine charges up to 1 TU per facing step.',
    'Hull turn couples turret to body in native gameplay.',
    'turn_part "turret" requires Options::strafe at execution (engine-enforced).',
    'Engine must preflight full turn cost before mutation (see ASTER-M1-HWP-S4-TURN-AUDIT-01).',
  ];
  return {
    advisory: true,
    turnPart,
    note: notes.join(' '),
    facingTuStepsEstimated: facing.steps,
    facingTuEstimate: facingTu,
    facingStepsUncertainty: facing.uncertainty,
    turnAffordableEstimate,
    engineStrafeRequiredForTurret: turnPart === 'turret',
    ...(typeof tu === 'number' ? { exportTimeUnits: tu } : {}),
  };
}

function buildTurnFacePlanningHint(actor, target) {
  const facing = estimateDirectedFireFacing(actor, target);
  const facingTu = facing.steps != null ? facing.steps : null;
  let turnAffordableEstimate = null;
  if (typeof actor?.timeUnits === 'number' && facingTu != null) {
    turnAffordableEstimate = actor.timeUnits >= facingTu;
  }
  return {
    advisory: true,
    note: 'Non-authoritative; engine UnitTurnBState charges up to 1 TU per facing step. '
      + 'Door open on turn-to-tile is engine-only (not modeled in Node).',
    facingTuStepsEstimated: facing.steps,
    facingTuEstimate: facingTu,
    facingStepsUncertainty: facing.uncertainty,
    turnAffordableEstimate,
  };
}

function buildDirectedFireCompositeHint(actor, target, fireTuCost) {
  const facing = estimateDirectedFireFacing(actor, target);
  const fireTu = typeof fireTuCost === 'number' ? fireTuCost : null;
  const facingTu = facing.steps != null ? facing.steps : null;
  let compositeMinTu = null;
  let compositeAffordable = null;
  if (typeof actor?.timeUnits === 'number' && fireTu != null) {
    if (facingTu != null) {
      compositeMinTu = fireTu + facingTu;
      compositeAffordable = actor.timeUnits >= compositeMinTu;
    } else {
      compositeMinTu = fireTu;
      compositeAffordable = null;
    }
  }
  return {
    advisory: true,
    note: 'canAffordTu is fire-only; composite uses 1 TU per facing step when bearing is known.',
    fireTuCost: fireTu,
    facingTuStepsEstimated: facing.steps,
    facingTuEstimate: facingTu,
    facingStepsUncertainty: facing.uncertainty,
    compositeMinTuEstimate: compositeMinTu,
    compositeAffordableEstimate: compositeAffordable,
  };
}

module.exports = {
  directionToGrid,
  octagonalTurnSteps,
  estimateDirectedFireFacing,
  buildMovePlanningHint,
  buildHwpMovePlanningHint,
  buildHwpTurnPlanningHint,
  HWP_TURN_PARTS,
  buildTurnFacePlanningHint,
  buildDirectedFireCompositeHint,
};