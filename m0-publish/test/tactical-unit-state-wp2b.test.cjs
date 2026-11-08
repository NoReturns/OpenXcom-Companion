'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { validateReadiness, ValidationError } = require('../lib/tactical-publish.cjs');

describe('M1-WP2B readiness semantics', () => {
  it('accepts engineActingUnitAvailable and rejects deprecated-only snapshots', () => {
    const readiness = validateReadiness(
      {
        summary: 'ready_to_act',
        engineStatus: 'standing',
        liveRosterSoldier: true,
        engineActingUnitAvailable: true,
        observationNote: 'Observational only: not Companion command authorization.',
      },
      'readiness'
    );
    assert.equal(readiness.engineActingUnitAvailable, true);
  });

  it('maps legacy companionCommandActorEligible when new field absent', () => {
    const readiness = validateReadiness(
      {
        summary: 'unconscious',
        engineStatus: 'unconscious',
        liveRosterSoldier: true,
        companionCommandActorEligible: false,
        note: 'legacy note text',
      },
      'readiness'
    );
    assert.equal(readiness.engineActingUnitAvailable, false);
    assert.match(readiness.observationNote, /legacy note/);
  });

  it('rejects unknown readiness fields', () => {
    assert.throws(
      () =>
        validateReadiness(
          {
            summary: 'ready_to_act',
            engineStatus: 'standing',
            liveRosterSoldier: true,
            engineActingUnitAvailable: true,
            observationNote: 'x',
            canAct: true,
          },
          'readiness'
        ),
      (err) => err instanceof ValidationError && /unknown field/.test(err.message)
    );
  });
});
