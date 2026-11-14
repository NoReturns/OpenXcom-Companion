'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadAndValidateSnapshotFromText, ValidationError } = require('../lib/tactical-publish.cjs');

const YAML = require('yaml');

const FIXTURE_V3_ACTION_COSTS = path.join(__dirname, 'fixtures', 'valid-v3-action-costs.yaml');

function minimalV4FromV3(base) {
  return {
    ...base,
    schemaVersion: 4,
    eventLog: {
      sessionId: 'a1b2c3d4e5f6789012345678abcdef01',
      oldestSeq: 0,
      latestSeq: 0,
      droppedCount: 0,
      events: [],
    },
  };
}

describe('tactical pre-fire displayedFiringAccuracy export (P0)', () => {
  it('accepts optional displayedFiringAccuracy on firearm actions', () => {
    const base = minimalV4FromV3(YAML.parse(fs.readFileSync(FIXTURE_V3_ACTION_COSTS, 'utf8')));
    const snap = base.units[0].actionCosts.hands.right.actions[0];
    snap.displayedFiringAccuracy = 26;
    snap.twoHandedPenaltyActive = true;
    const tactical = loadAndValidateSnapshotFromText(YAML.stringify(base), YAML);
    const out = tactical.units[0].actionCosts.hands.right.actions[0];
    assert.equal(out.displayedFiringAccuracy, 26);
    assert.equal(out.twoHandedPenaltyActive, true);
    assert.equal(out.tuCost, 17);
    assert.equal(out.canAffordTu, true);
  });

  it('legacy snapshots without pre-fire accuracy fields still validate', () => {
    const base = minimalV4FromV3(YAML.parse(fs.readFileSync(FIXTURE_V3_ACTION_COSTS, 'utf8')));
    const tactical = loadAndValidateSnapshotFromText(YAML.stringify(base), YAML);
    const snap = tactical.units[0].actionCosts.hands.right.actions[0];
    assert.equal(snap.displayedFiringAccuracy, undefined);
    assert.equal(snap.twoHandedPenaltyActive, undefined);
  });

  it('rejects out-of-range displayedFiringAccuracy', () => {
    const base = minimalV4FromV3(YAML.parse(fs.readFileSync(FIXTURE_V3_ACTION_COSTS, 'utf8')));
    base.units[0].actionCosts.hands.right.actions[0].displayedFiringAccuracy = 400;
    assert.throws(
      () => loadAndValidateSnapshotFromText(YAML.stringify(base), YAML),
      ValidationError,
    );
  });
});