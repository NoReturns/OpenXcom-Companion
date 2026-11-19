'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const { loadAndValidateSnapshotFromText } = require('../lib/tactical-publish.cjs');
const { buildCommandBinding } = require('../lib/command-binding.cjs');
const { listFriendlyHwpObservations } = require('../lib/friendly-hwp-observation-v1.cjs');
const {
  buildUnitStateBrief,
  isFriendlyHwpUnit,
  isFriendlyRosterSoldier,
} = require('../lib/unit-state-brief.cjs');

const FIXTURE_SPARSE = path.join(__dirname, 'fixtures', 'friendly-hwp-sparse-v5.yaml');
const FIXTURE_OBS = path.join(__dirname, 'fixtures', 'friendly-hwp-observation-v1.yaml');

describe('HWP-S1 friendlyHwpObservationV1', () => {
  it('preserves sparse v5 fixture without observation extension', () => {
    const text = fs.readFileSync(FIXTURE_SPARSE, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(text, YAML);
    const hwp = tactical.units.find((u) => u.id === 1_000_000);
    assert.ok(hwp);
    assert.equal(hwp.friendlyHwpObservationV1, undefined);
    assert.ok(isFriendlyHwpUnit(hwp));
    assert.equal(isFriendlyRosterSoldier(hwp), false);
    assert.equal(listFriendlyHwpObservations(tactical).length, 0);
  });

  it('validates pinned observation fixture and excludes HWP from binding', () => {
    const text = fs.readFileSync(FIXTURE_OBS, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(text, YAML);
    const hwp = tactical.units.find((u) => u.id === 1_000_000);
    const obs = hwp.friendlyHwpObservationV1;
    assert.ok(obs);
    assert.equal(obs.hwpUnitType, 'STR_TANK_CANNON');
    assert.equal(obs.fixedWeapons[0].loaded.rounds, 6);
    assert.equal(hwp.name, undefined);
    assert.equal(hwp.health, undefined);

    const binding = buildCommandBinding(tactical, 'c'.repeat(64));
    assert.ok(binding.player_soldiers.every((s) => s.id < 1_000_000));
    assert.ok(binding.player_soldiers.every((s) => s.id !== 1_000_000));

    const listed = listFriendlyHwpObservations(tactical);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].unitId, 1_000_000);
  });

  it('unitStateBrief skips friendly HWP rows (roster exceptions only)', () => {
    const text = fs.readFileSync(FIXTURE_OBS, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(text, YAML);
    const brief = buildUnitStateBrief(tactical);
    assert.ok(brief.exceptions.every((e) => e.id < 1_000_000));
  });
});