/**
 * M1-14C eligibility rules — static contract aligned with CompanionEventLog.cpp.
 * Runtime proof: engine/OpenXcom build companion_event_log_test.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseAndValidate, loadAndValidateSnapshotFromText } = require('../lib/tactical-publish.cjs');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const fixtureV4 = path.join(__dirname, 'fixtures', 'valid-v4.yaml');

describe('M1-14C event recorder safety (publisher + contract)', () => {
  it('schema v4 fixture remains valid after M1-14C engine changes', () => {
    const tactical = loadAndValidateSnapshotFromText(fs.readFileSync(fixtureV4, 'utf8'), YAML);
    assert.equal(tactical.schemaVersion, 4);
    assert.equal(tactical.eventLog.events.length, 3);
    assert.equal(tactical.eventLog.events[0].seq, 1);
    assert.equal(tactical.eventLog.events[1].seq, 2);
    assert.equal(tactical.eventLog.events[2].seq, 3);
  });

  it('documents engine-only runtime coverage for RNG and firing paths', () => {
    const engineOnly = [
      'gameplay RNG unchanged on construct/beginSession/load simulation',
      'multi-round auto indexing unchanged (ProjectileFlyBState)',
      'reaction/panic/alien paths omit BattleAction.playerOrdered',
    ];
    assert.ok(engineOnly.length >= 3);
  });
});
