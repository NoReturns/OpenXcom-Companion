'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseSoldierControlDocument, buildSoldierControlMirror } = require('../lib/soldier-control-relay.cjs');
const YAML = require('yaml');
const { buildCommandBinding } = require('../lib/command-binding.cjs');
const { loadAndValidateSnapshotFromText } = require('../lib/tactical-publish.cjs');
const { isXcomControlledHostileUnit } = require('../lib/unit-state-brief.cjs');

describe('MC-02A mind-controlled hostile ownership', () => {
  const sessionId = 'a1b2c3d4e5f6789012345678abcdef01';
  const campaignId = '0123456789abcdef0123456789abcdef';
  const tacticalBattleId = 'fedcba9876543210fedcba9876543210';

  const tacticalBase = {
    eventLog: { sessionId, latestSeq: 4 },
    turn: 2,
    side: 0,
    map: { width: 40, height: 40, depth: 1 },
    units: [
      {
        id: 1,
        faction: 0,
        originalFaction: 0,
        position: [1, 1, 0],
        name: 'Roster',
        health: 50,
        timeUnits: 50,
        kneeled: false,
      },
      {
        id: 1000042,
        faction: 0,
        originalFaction: 1,
        position: [5, 5, 0],
        kneeled: false,
        observedUnitType: 'STR_SECTOID',
        displayLabel: 'Sectoid',
        xcomControlledHostileObservationV1: {
          schemaVersion: 1,
          unitId: 1000042,
          unitType: 'STR_SECTOID',
          originalFaction: 1,
          faction: 0,
          position: [5, 5, 0],
          timeUnits: 60,
          health: 26,
          hands: { right: null, left: null },
          inventory: [],
        },
      },
      {
        id: 1000099,
        faction: 1,
        originalFaction: 1,
        position: [9, 9, 0],
        observedUnitType: 'STR_MUTON',
      },
    ],
  };

  it('parses schema v3 mc_hostile_assignments', () => {
    const json = JSON.stringify({
      schema_version: 3,
      session_id: sessionId,
      campaign_id: campaignId,
      tactical_battle_id: tacticalBattleId,
      assignments: {},
      hwp_assignments: {},
      mc_hostile_assignments: { 1000042: 'ai' },
    });
    const doc = parseSoldierControlDocument(json);
    assert.equal(doc.mc_hostile_assignments['1000042'], 'ai');
  });

  it('mirror rejects forged mc id for genuine hostile', () => {
    const json = JSON.stringify({
      schema_version: 3,
      session_id: sessionId,
      campaign_id: campaignId,
      tactical_battle_id: tacticalBattleId,
      assignments: {},
      mc_hostile_assignments: { 1000099: 'ai' },
    });
    const mirror = buildSoldierControlMirror(tacticalBase, {
      soldierControlFileJson: json,
      ownershipBindingContext: { campaign_id: campaignId, tactical_battle_id: tacticalBattleId },
    });
    assert.equal(mirror.availability, 'unavailable');
    assert.equal(mirror.unavailable_reason, 'unknown_assignment_mc_hostile_id');
  });

  it('validates pinned xcomControlledHostileObservationV1 fixture (regression)', () => {
    const fixture = path.join(__dirname, 'fixtures', 'xcom-mc-hostile-observation-v5.yaml');
    const text = fs.readFileSync(fixture, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(text, YAML);
    const unit = tactical.units.find((u) => u.id === 1000042);
    assert.ok(unit?.xcomControlledHostileObservationV1);
    assert.equal(unit.xcomControlledHostileObservationV1.unitId, 1000042);
  });

  it('builds player_mc_hostiles binding with observation when assigned', () => {
    const json = JSON.stringify({
      schema_version: 3,
      session_id: sessionId,
      campaign_id: campaignId,
      tactical_battle_id: tacticalBattleId,
      assignments: {},
      mc_hostile_assignments: { 1000042: 'ai' },
    });
    const mirror = buildSoldierControlMirror(tacticalBase, {
      soldierControlFileJson: json,
      ownershipBindingContext: { campaign_id: campaignId, tactical_battle_id: tacticalBattleId },
    });
    assert.equal(mirror.availability, 'available');
    const digest = 'a'.repeat(64);
    const binding = buildCommandBinding(tacticalBase, digest, { soldierControl: mirror });
    assert.equal(binding.schema_version, 3);
    const row = binding.player_mc_hostiles.find((r) => r.id === 1000042);
    assert.ok(row);
    assert.equal(row.controlMode, 'ai');
    assert.equal(row.commandExecutionSupported, false);
    assert.equal(row.observationPresent, true);
    assert.ok(isXcomControlledHostileUnit(tacticalBase.units[1]));
  });
});