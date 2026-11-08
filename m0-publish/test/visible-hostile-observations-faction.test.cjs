'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { buildUnitStateBrief } = require('../lib/unit-state-brief.cjs');

const FACING = { direction: 2, label: 'east', vector: { dx: 1, dy: 0 } };

describe('visibleHostileObservations faction filter (post-mission fix 01)', () => {
  it('includes visible genuine alien (faction 1, originalFaction 1)', () => {
    const tactical = {
      schemaVersion: 5,
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
    const brief = buildUnitStateBrief(tactical);
    assert.equal(brief.visibleHostileObservations.length, 1);
    assert.equal(brief.visibleHostileObservations[0].id, 1_000_002);
  });

  it('excludes visible neutral civilian (faction 2)', () => {
    const tactical = {
      schemaVersion: 5,
      units: [
        {
          id: 50_001,
          faction: 2,
          originalFaction: 2,
          position: [12, 8, 0],
          facing: FACING,
        },
        {
          id: 1_000_003,
          faction: 1,
          originalFaction: 1,
          position: [14, 8, 0],
          facing: FACING,
        },
      ],
    };
    const brief = buildUnitStateBrief(tactical);
    assert.ok(!brief.visibleHostileObservations.some((o) => o.id === 50_001));
    assert.ok(brief.visibleHostileObservations.some((o) => o.id === 1_000_003));
  });

  it('excludes mind-controlled roster soldier from hostiles, retains exception', () => {
    const tactical = {
      schemaVersion: 5,
      units: [
        {
          id: 3,
          faction: 1,
          originalFaction: 0,
          position: [24, 5, 0],
          name: 'Shah',
          facing: FACING,
        },
      ],
    };
    const brief = buildUnitStateBrief(tactical);
    assert.ok(brief.exceptions.some((e) => e.kind === 'mind_controlled_roster_soldier' && e.id === 3));
    assert.equal(brief.visibleHostileObservations.length, 0);
  });

  it('excludes friendly player soldier even with facing', () => {
    const tactical = {
      schemaVersion: 5,
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
    const brief = buildUnitStateBrief(tactical);
    assert.equal(brief.visibleHostileObservations.length, 0);
    assert.equal(brief.friendlyRosterCount, 1);
  });
});
