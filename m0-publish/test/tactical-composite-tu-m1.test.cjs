'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  octagonalTurnSteps,
  estimateDirectedFireFacing,
  buildDirectedFireCompositeHint,
  buildMovePlanningHint,
} = require('../lib/tu-composite-advisory.cjs');

describe('tu composite advisory (M1)', () => {
  it('octagonalTurnSteps matches 2-step bearing', () => {
    assert.equal(octagonalTurnSteps(0, 2), 2);
  });

  it('31 TU with 30 fire and 2 facing steps is not composite affordable', () => {
    const actor = {
      position: [1, 1, 0],
      facing: { direction: 0 },
      timeUnits: 31,
    };
    const hint = buildDirectedFireCompositeHint(actor, { x: 3, y: 1, z: 0 }, 30);
    assert.equal(hint.facingTuStepsEstimated, 2);
    assert.equal(hint.compositeMinTuEstimate, 32);
    assert.equal(hint.compositeAffordableEstimate, false);
  });

  it('31 TU with 30 fire and 0 facing steps is composite affordable', () => {
    const actor = {
      position: [1, 1, 0],
      facing: { direction: 2 },
      timeUnits: 31,
    };
    const target = { x: 3, y: 1, z: 0 };
    assert.equal(estimateDirectedFireFacing(actor, target).steps, 0);
    const hint = buildDirectedFireCompositeHint(actor, target, 30);
    assert.equal(hint.compositeAffordableEstimate, true);
  });

  it('kneeled MOVE hint includes stand-up before path', () => {
    const actor = {
      kneeled: true,
      timeUnits: 12,
      movementTuAdvisory: { standUpTuBeforeWalk: 8, standUpRequiredBeforeWalk: true },
    };
    const hint = buildMovePlanningHint(actor);
    assert.equal(hint.standUpTuBeforeWalk, 8);
    assert.equal(hint.timeUnitsAfterStandEstimate, 4);
    assert.equal(hint.pathTuEstimateIncluded, false);
  });
});