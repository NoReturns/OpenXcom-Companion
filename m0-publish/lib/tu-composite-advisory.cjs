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
  buildTurnFacePlanningHint,
  buildDirectedFireCompositeHint,
};