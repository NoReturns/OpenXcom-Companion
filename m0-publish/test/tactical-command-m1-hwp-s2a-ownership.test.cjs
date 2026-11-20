'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const {
  buildCommandBinding,
  parseCommandBinding,
  composeKneelCommand,
  BINDING_SCHEMA_VERSION,
} = require('../lib/command-binding.cjs');
const {
  parseSoldierControlDocument,
  buildSoldierControlMirror,
  SoldierControlParseError,
} = require('../lib/soldier-control-relay.cjs');
const { loadAndValidateSnapshotFromText } = require('../lib/tactical-publish.cjs');

const FIXTURE_OBS = path.join(__dirname, 'fixtures', 'friendly-hwp-observation-v1.yaml');
const SESSION = 'f6e5d4c3b2a19081726354433221100a';
const CAMPAIGN = '0123456789abcdef0123456789abcdef';
const TACTICAL = 'fedcba9876543210fedcba9876543210';
const DIGEST = 'd'.repeat(64);

function mixedControlJson({ soldierAi = [], hwpAi = [], session = SESSION, tacticalBattle = TACTICAL }) {
  const assignments = {};
  for (const id of soldierAi) assignments[String(id)] = 'ai';
  const hwp_assignments = {};
  for (const id of hwpAi) hwp_assignments[String(id)] = 'ai';
  return JSON.stringify({
    schema_version: 2,
    session_id: session,
    campaign_id: CAMPAIGN,
    tactical_battle_id: tacticalBattle,
    assignments,
    hwp_assignments,
  });
}

describe('M1-HWP-S2a ownership and binding', () => {
  it('preserves soldier-only control schema v1', () => {
    const doc = parseSoldierControlDocument(
      JSON.stringify({
        schema_version: 1,
        session_id: SESSION,
        assignments: { 1: 'ai' },
      }),
    );
    assert.deepEqual(doc.assignments, { 1: 'ai' });
    assert.deepEqual(doc.hwp_assignments, {});
  });

  it('rejects roster id in hwp_assignments', () => {
    assert.throws(
      () => parseSoldierControlDocument(
        JSON.stringify({
          schema_version: 2,
          session_id: SESSION,
          assignments: {},
          hwp_assignments: { 1: 'ai' },
        }),
      ),
      (e) => e instanceof SoldierControlParseError && e.reason === 'invalid_assignment_hwp_id',
    );
  });

  it('rejects HWP id in assignments', () => {
    assert.throws(
      () => parseSoldierControlDocument(
        JSON.stringify({
          schema_version: 2,
          session_id: SESSION,
          assignments: { 1000000: 'ai' },
          hwp_assignments: {},
        }),
      ),
      (e) => e instanceof SoldierControlParseError && e.reason === 'invalid_assignment_soldier_id',
    );
  });

  it('human-owned HWP defaults controlMode human in mirror and binding', () => {
    const text = fs.readFileSync(FIXTURE_OBS, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(text, YAML);
    const control = mixedControlJson({ soldierAi: [1], hwpAi: [] });
    const mirror = buildSoldierControlMirror(tactical, {
      soldierControlFileJson: control,
      ownershipBindingContext: { campaign_id: CAMPAIGN, tactical_battle_id: TACTICAL },
    });
    assert.equal(mirror.availability, 'available');
    assert.equal(mirror.hwps.find((h) => h.id === 1_000_000).controlMode, 'human');
    const binding = buildCommandBinding(tactical, DIGEST, { soldierControl: mirror });
    assert.equal(binding.schema_version, 2);
    const hwp = binding.player_hwps.find((h) => h.id === 1_000_000);
    assert.equal(hwp.controlMode, 'human');
    assert.equal(hwp.commandExecutionSupported, false);
    assert.ok(hwp.friendlyHwpObservationV1);
    assert.ok(binding.player_soldiers.every((s) => s.id < 1_000_000));
  });

  it('AI-owned HWP appears in mirror and binding only in player_hwps', () => {
    const text = fs.readFileSync(FIXTURE_OBS, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(text, YAML);
    const control = mixedControlJson({ soldierAi: [], hwpAi: [1_000_000] });
    const mirror = buildSoldierControlMirror(tactical, {
      soldierControlFileJson: control,
      ownershipBindingContext: { campaign_id: CAMPAIGN, tactical_battle_id: TACTICAL },
    });
    assert.equal(mirror.hwps.find((h) => h.id === 1_000_000).controlMode, 'ai');
    const binding = buildCommandBinding(tactical, DIGEST, { soldierControl: mirror });
    const hwp = binding.player_hwps[0];
    assert.equal(hwp.controlMode, 'ai');
    assert.equal(binding.player_soldiers.length, 1);
    assert.equal(binding.player_hwps.length, 1);
  });

  it('mixed soldier and HWP ownership with two HWPs different owners', () => {
    const text = fs.readFileSync(FIXTURE_OBS, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(text, YAML);
    tactical.units.push({
      id: 1_000_001,
      faction: 0,
      originalFaction: 0,
      position: [6, 5, 0],
      friendlyHwpObservationV1: {
        schemaVersion: 1,
        unitId: 1_000_001,
        hwpUnitType: 'STR_TANK_ROCKET',
        position: { x: 6, y: 5, z: 0 },
        timeUnits: 60,
        kneeled: false,
      },
    });
    const control = mixedControlJson({ soldierAi: [1], hwpAi: [1_000_000] });
    const mirror = buildSoldierControlMirror(tactical, {
      soldierControlFileJson: control,
      ownershipBindingContext: { campaign_id: CAMPAIGN, tactical_battle_id: TACTICAL },
    });
    assert.equal(mirror.soldiers.find((s) => s.id === 1).controlMode, 'ai');
    assert.equal(mirror.hwps.find((h) => h.id === 1_000_000).controlMode, 'ai');
    assert.equal(mirror.hwps.find((h) => h.id === 1_000_001).controlMode, 'human');
  });

  it('stale tactical_battle_id rejects control mirror', () => {
    const text = fs.readFileSync(FIXTURE_OBS, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(text, YAML);
    const control = mixedControlJson({ hwpAi: [1_000_000], tacticalBattle: '11111111111111111111111111111111' });
    const mirror = buildSoldierControlMirror(tactical, {
      soldierControlFileJson: control,
      ownershipBindingContext: { campaign_id: CAMPAIGN, tactical_battle_id: TACTICAL },
    });
    assert.equal(mirror.availability, 'unavailable');
    assert.match(mirror.unavailable_reason, /identity_mismatch|stale_session_id/);
  });

  it('unknown HWP id in hwp_assignments fails mirror', () => {
    const text = fs.readFileSync(FIXTURE_OBS, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(text, YAML);
    const control = mixedControlJson({ hwpAi: [1_000_099] });
    const mirror = buildSoldierControlMirror(tactical, {
      soldierControlFileJson: control,
      ownershipBindingContext: { campaign_id: CAMPAIGN, tactical_battle_id: TACTICAL },
    });
    assert.equal(mirror.unavailable_reason, 'unknown_assignment_hwp_id');
  });

  it('existing soldier kneel compose unchanged for HWP-free binding', () => {
    const text = fs.readFileSync(FIXTURE_OBS, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(text, YAML);
    const mirror = buildSoldierControlMirror(tactical, {
      soldierControlFileJson: mixedControlJson({ soldierAi: [1] }),
      ownershipBindingContext: { campaign_id: CAMPAIGN, tactical_battle_id: TACTICAL },
    });
    const binding = buildCommandBinding(tactical, DIGEST, { soldierControl: mirror });
    parseCommandBinding(binding);
    const cmd = composeKneelCommand(binding, { commandId: 'kneel-1', actorUnitId: 1 });
    assert.equal(cmd.command_type, 'KNEEL');
    assert.equal(cmd.actor_unit_id, 1);
  });
});