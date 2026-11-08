'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  classifyCurrentHostileObservation,
  resolveHostileIntel,
  isConfirmedCurrentLosAvailability,
} = require('../lib/hostile-intelligence-consumer.cjs');

const FACING = { direction: 2, label: 'east', vector: { dx: 1, dy: 0 } };

describe('classifyCurrentHostileObservation (Fix 02)', () => {
  it('genuine visible alien: confirmed_current_los', () => {
    const tactical = {
      units: [
        {
          id: 1_000_002,
          faction: 1,
          originalFaction: 1,
          position: [10, 10, 0],
          facing: FACING,
        },
      ],
    };
    const intel = classifyCurrentHostileObservation(tactical, 1_000_002);
    assert.equal(intel.availability, 'confirmed_current_los');
    assert.equal(intel.mindControlledRoster, false);
    const resolved = resolveHostileIntel(tactical, 1_000_002);
    assert.deepEqual(resolved.confirmedCurrentPosition, [10, 10, 0]);
  });

  it('visible neutral civilian: LOS without hostile target semantics', () => {
    const tactical = {
      units: [
        {
          id: 50_001,
          faction: 2,
          originalFaction: 2,
          position: [12, 8, 0],
          facing: FACING,
        },
      ],
    };
    const intel = classifyCurrentHostileObservation(tactical, 50_001);
    assert.equal(intel.availability, 'confirmed_current_los_neutral_civilian');
    assert.equal(intel.mindControlledRoster, false);
    assert.ok(isConfirmedCurrentLosAvailability(intel.availability));
    const resolved = resolveHostileIntel(tactical, 50_001);
    assert.deepEqual(resolved.confirmedCurrentPosition, [12, 8, 0]);
    assert.notEqual(resolved.current.availability, 'confirmed_current_los');
  });

  it('visible mind-controlled roster soldier: distinct MC LOS', () => {
    const tactical = {
      units: [
        {
          id: 3,
          faction: 1,
          originalFaction: 0,
          position: [24, 5, 0],
          facing: FACING,
        },
      ],
    };
    const intel = classifyCurrentHostileObservation(tactical, 3);
    assert.equal(intel.availability, 'confirmed_current_los_mind_controlled_roster');
    assert.equal(intel.mindControlledRoster, true);
    assert.ok(isConfirmedCurrentLosAvailability(intel.availability));
    const resolved = resolveHostileIntel(tactical, 3);
    assert.deepEqual(resolved.confirmedCurrentPosition, [24, 5, 0]);
  });

  it('friendly X-COM soldier with facing: commandable roster, not hostile observation', () => {
    const tactical = {
      units: [
        {
          id: 1,
          faction: 0,
          originalFaction: 0,
          position: [0, 0, 0],
          name: 'Reyes',
          facing: FACING,
        },
      ],
    };
    const intel = classifyCurrentHostileObservation(tactical, 1);
    assert.equal(intel.availability, 'friendly_commandable_roster');
    const resolved = resolveHostileIntel(tactical, 1);
    assert.equal(resolved.confirmedCurrentPosition, null);
  });

  it('xcom-controlled hostile visible: friendly-controlled asset LOS', () => {
    const tactical = {
      units: [
        {
          id: 1_000_001,
          faction: 0,
          originalFaction: 1,
          position: [5, 5, 0],
          facing: FACING,
        },
      ],
    };
    const intel = classifyCurrentHostileObservation(tactical, 1_000_001);
    assert.equal(intel.availability, 'confirmed_current_los_xcom_controlled_hostile');
    assert.deepEqual(resolveHostileIntel(tactical, 1_000_001).confirmedCurrentPosition, [5, 5, 0]);
  });
});
