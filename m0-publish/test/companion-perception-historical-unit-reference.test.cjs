'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { loadAndValidateSnapshotFromText } = require('../lib/tactical-publish.cjs');

const FIXTURE = path.join(
  __dirname,
  'fixtures',
  'historical-perception-dead-reaction-shooter-v4.yaml',
);

const DEAD_SHOOTER_ID = 1_000_001;

describe('historical perception unit references (ASTER-M1-HISTORICAL-PERCEPTION-VALIDATION-FIX-01)', () => {
  it('accepts reaction_attack_executed when historical shooter is absent from export-time units[]', () => {
    const text = fs.readFileSync(FIXTURE, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(text, YAML);
    const reaction = tactical.perceptionLog.events.find(
      (e) => e.type === 'reaction_attack_executed' && e.subjectUnitId === DEAD_SHOOTER_ID,
    );
    assert.ok(reaction, 'expected historical reaction_attack_executed for absent alien shooter');
    assert.equal(reaction.confidence, 'source_visible');
    const exportedHostileIds = tactical.units.filter((u) => u.id >= 1_000_000).map((u) => u.id);
    assert.ok(!exportedHostileIds.includes(DEAD_SHOOTER_ID), 'shooter must stay absent from export-time units[]');
  });

  it('documents pre-patch failure shape: source_visible identity without export-time units[] row', () => {
    const doc = YAML.parse(fs.readFileSync(FIXTURE, 'utf8'));
    const reaction = doc.perceptionLog.events.find(
      (e) => e.type === 'reaction_attack_executed' && e.subjectUnitId === DEAD_SHOOTER_ID,
    );
    assert.equal(reaction.confidence, 'source_visible');
    assert.ok(!doc.units.some((u) => u.id === DEAD_SHOOTER_ID));
  });
});
