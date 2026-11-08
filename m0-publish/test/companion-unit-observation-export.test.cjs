'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { loadAndValidateSnapshotFromText } = require('../lib/tactical-publish.cjs');
const { buildUnitStateBrief } = require('../lib/unit-state-brief.cjs');
const { classifyCurrentHostileObservation } = require('../lib/hostile-intelligence-consumer.cjs');

const FIXTURE_V5 = path.join(__dirname, 'fixtures', 'valid-v5.yaml');

function parseYamlUnit(patch) {
  const raw = YAML.parse(fs.readFileSync(FIXTURE_V5, 'utf8'));
  const unit = { ...raw.units[2], ...patch };
  raw.units[2] = unit;
  const tactical = loadAndValidateSnapshotFromText(YAML.stringify(raw), YAML);
  return tactical.units.find((u) => u.id === unit.id);
}

describe('M1 unit observation export validation', () => {
  it('visible identified Sectoid may export observedUnitType + displayLabel', () => {
    const unit = parseYamlUnit({
      id: 1_000_002,
      faction: 1,
      originalFaction: 1,
      position: [10, 10, 0],
      facing: { direction: 2, label: 'east', vector: { dx: 1, dy: 0 } },
      kneeled: false,
      observedUnitType: 'STR_SECTOID_SOLDIER',
      displayLabel: 'Sectoid Soldier',
    });
    assert.equal(unit.observedUnitType, 'STR_SECTOID_SOLDIER');
    assert.equal(unit.displayLabel, 'Sectoid Soldier');
  });

  it('visible Cyberdisc exports STR_CYBERDISC_TERRORIST not race-only fiction', () => {
    const unit = parseYamlUnit({
      id: 1_000_007,
      faction: 1,
      originalFaction: 1,
      position: [18, 15, 0],
      facing: { direction: 2, label: 'east', vector: { dx: 1, dy: 0 } },
      kneeled: false,
      observedUnitType: 'STR_CYBERDISC_TERRORIST',
      displayLabel: 'Cyberdisc Terrorist',
    });
    assert.equal(unit.observedUnitType, 'STR_CYBERDISC_TERRORIST');
    assert.match(unit.displayLabel, /Cyberdisc/i);
  });

  it('hidden hostile shape: no unit row in validation scope', () => {
    const raw = YAML.parse(fs.readFileSync(FIXTURE_V5, 'utf8'));
    raw.units = raw.units.filter((u) => u.id !== 1_000_002);
    const tactical = loadAndValidateSnapshotFromText(YAML.stringify(raw), YAML);
    assert.ok(!tactical.units.some((u) => u.id === 1_000_002));
  });

  it('mind-controlled roster soldier may carry name without hostile fields', () => {
    const raw = YAML.parse(fs.readFileSync(FIXTURE_V5, 'utf8'));
    raw.units.push({
      id: 15,
      faction: 1,
      originalFaction: 0,
      position: [5, 5, 0],
      facing: { direction: 0, label: 'north', vector: { dx: 0, dy: -1 } },
      kneeled: false,
      name: 'Virender Shah',
    });
    const tactical = loadAndValidateSnapshotFromText(YAML.stringify(raw), YAML);
    const unit = tactical.units.find((u) => u.id === 15);
    assert.equal(unit.name, 'Virender Shah');
    assert.equal(unit.observedUnitType, undefined);
  });

  it('friendly roster soldier rejects observedUnitType', () => {
    const raw = YAML.parse(fs.readFileSync(FIXTURE_V5, 'utf8'));
    const idx = raw.units.findIndex((u) => u.id === 1);
    assert.ok(idx >= 0);
    raw.units[idx].observedUnitType = 'STR_SECTOID';
    assert.throws(
      () => loadAndValidateSnapshotFromText(YAML.stringify(raw), YAML),
      /observed unit identity|observedUnitType/,
    );
  });

  it('neutral civilian rejects observedUnitType', () => {
    assert.throws(
      () => parseYamlUnit({
        id: 50_001,
        faction: 2,
        originalFaction: 2,
        position: [1, 1, 0],
        observedUnitType: 'STR_CIVILIAN',
      }),
      /observedUnitType/,
    );
  });

  it('X-COM-controlled alien may export observed unit type', () => {
    const unit = parseYamlUnit({
      id: 1_000_001,
      faction: 0,
      originalFaction: 1,
      position: [12, 12, 0],
      facing: { direction: 4, label: 'south', vector: { dx: 0, dy: 1 } },
      kneeled: false,
      observedUnitType: 'STR_MUTON_SOLDIER',
      displayLabel: 'Muton Soldier',
    });
    assert.equal(unit.observedUnitType, 'STR_MUTON_SOLDIER');
  });

  it('unitStateBrief propagates hostile observation labels', () => {
    const tactical = {
      units: [
        {
          id: 1_000_003,
          faction: 1,
          originalFaction: 1,
          position: [3, 3, 0],
          kneeled: false,
          observedUnitType: 'STR_FLOATER_SOLDIER',
          displayLabel: 'Floater Soldier',
          facing: { direction: 6, label: 'west', vector: { dx: -1, dy: 0 } },
        },
      ],
    };
    const brief = buildUnitStateBrief(tactical);
    const obs = brief.visibleHostileObservations.find((o) => o.id === 1_000_003);
    assert.equal(obs.observedUnitType, 'STR_FLOATER_SOLDIER');
    assert.equal(obs.displayLabel, 'Floater Soldier');
    const intel = classifyCurrentHostileObservation(tactical, 1_000_003);
    assert.equal(intel.availability, 'confirmed_current_los');
  });

  it('v5 fixture still validates without observation fields (backward compatible)', () => {
    const tactical = loadAndValidateSnapshotFromText(fs.readFileSync(FIXTURE_V5, 'utf8'), YAML);
    assert.ok(tactical.units.length > 0);
  });
});
