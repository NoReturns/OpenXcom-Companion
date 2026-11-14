'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadAndValidateSnapshotFromText } = require('../lib/tactical-publish.cjs');

const YAML = require('yaml');

const FIXTURE_V4 = path.join(__dirname, 'fixtures', 'valid-v4.yaml');

describe('tactical tuReservation (M1 visibility)', () => {
  it('accepts optional tuReservation root block', () => {
    const base = YAML.parse(fs.readFileSync(FIXTURE_V4, 'utf8'));
    base.tuReservation = {
      schemaVersion: 1,
      fireMode: 'snap',
      fireModeActionType: 4,
      kneelReserve: true,
      engineReservationCheckAvailable: true,
      observationNote: 'Advisory only.',
    };
    const tactical = loadAndValidateSnapshotFromText(YAML.stringify(base), YAML);
    assert.equal(tactical.tuReservation.fireMode, 'snap');
    assert.equal(tactical.tuReservation.engineReservationCheckAvailable, true);
  });

  it('accepts optional action/posture reservation advisory fields', () => {
    const base = YAML.parse(
      fs.readFileSync(path.join(__dirname, 'fixtures', 'valid-v3-action-costs.yaml'), 'utf8'),
    );
    base.schemaVersion = 4;
    base.eventLog = {
      sessionId: 'a1b2c3d4e5f6789012345678abcdef01',
      oldestSeq: 0,
      latestSeq: 0,
      droppedCount: 0,
      events: [],
    };
    base.units[0].actionCosts.hands.right.actions[0].canAffordTuWithCurrentReservation = false;
    base.units[0].actionCosts.hands.right.actions[0].reservationWouldBlock = true;
    base.units[0].actionCosts.posture.reservationWouldBlockKneelDown = true;
    const tactical = loadAndValidateSnapshotFromText(YAML.stringify(base), YAML);
    assert.equal(tactical.units[0].actionCosts.hands.right.actions[0].reservationWouldBlock, true);
    assert.equal(tactical.units[0].actionCosts.posture.reservationWouldBlockKneelDown, true);
  });

  it('legacy snapshots without tuReservation still validate', () => {
    const doc = fs.readFileSync(FIXTURE_V4, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(doc, YAML);
    assert.equal(tactical.tuReservation, undefined);
  });
});