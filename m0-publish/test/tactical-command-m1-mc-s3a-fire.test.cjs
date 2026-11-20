'use strict';

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildCommandBinding,
  composeMcSnapShotCommand,
  composeMcAutoShotCommand,
  composeMcAimedShotCommand,
  composeSnapShotCommand,
} = require('../lib/command-binding.cjs');
const { buildSoldierControlMirror } = require('../lib/soldier-control-relay.cjs');
const {
  validateMcSnapShotAgainstSnapshot,
  validateTacticalCommandAgainstSnapshotFile,
  parseMcSnapShotCommand,
  parseMcAutoShotCommand,
} = require('../lib/tactical-command.cjs');
const { loadAndValidateSnapshotFromText } = require('../lib/tactical-publish.cjs');
const { sha256HexLower } = require('../lib/briefing-snapshot.cjs');

describe('MC-03A mind-controlled hostile weapon fire', () => {
  const sessionId = 'a1b2c3d4e5f6789012345678abcdef01';
  const campaignId = '0123456789abcdef0123456789abcdef';
  const tacticalBattleId = 'fedcba9876543210fedcba9876543210';
  const tactical = {
    eventLog: { sessionId, latestSeq: 4 },
    turn: 2,
    side: 0,
    map: { width: 40, height: 40, depth: 1 },
    units: [
      {
        id: 1000042,
        faction: 0,
        originalFaction: 1,
        position: [5, 5, 0],
        kneeled: false,
        hands: { right: { battleItemId: 9001, type: 'STR_ALIEN_RIFLE', battleType: 0 } },
        actionCosts: {
          hands: {
            right: {
              actions: [
                { id: 'snap', tuCost: 33, usable: true, canAffordTu: true },
                { id: 'auto', tuCost: 39, usable: true, canAffordTu: true },
                { id: 'aimed', tuCost: 55, usable: true, canAffordTu: true },
              ],
            },
          },
        },
        xcomControlledHostileObservationV1: {
          schemaVersion: 1,
          unitId: 1000042,
          unitType: 'STR_SECTOID',
          originalFaction: 1,
          faction: 0,
          position: [5, 5, 0],
          timeUnits: 60,
          health: 26,
        },
      },
    ],
  };

  const controlJson = JSON.stringify({
    schema_version: 3,
    session_id: sessionId,
    campaign_id: campaignId,
    tactical_battle_id: tacticalBattleId,
    assignments: {},
    mc_hostile_assignments: { 1000042: 'ai' },
  });

  const digest = sha256HexLower(Buffer.from(JSON.stringify(tactical), 'utf8'));
  const mirror = buildSoldierControlMirror(tactical, {
    soldierControlFileJson: controlJson,
    ownershipBindingContext: { campaign_id: campaignId, tactical_battle_id: tacticalBattleId },
  });
  const binding = buildCommandBinding(tactical, digest, { soldierControl: mirror });

  it('enables MC fire execution flags when AI-owned with observation', () => {
    const row = binding.player_mc_hostiles.find((h) => h.id === 1000042);
    assert(row);
    assert.equal(row.mcSnapShotExecutionSupported, true);
    assert.equal(row.mcAutoShotExecutionSupported, true);
    assert.equal(row.mcAimedShotExecutionSupported, true);
  });

  it('composes and validates MC_SNAP_SHOT MC_AUTO_SHOT MC_AIMED_SHOT', () => {
    const snap = composeMcSnapShotCommand(binding, {
      commandId: 'mc-snap-1',
      actorUnitId: 1000042,
      activeHand: 'STR_RIGHT_HAND',
      target: { x: 8, y: 5, z: 0 },
    });
    parseMcSnapShotCommand(snap);
    validateMcSnapShotAgainstSnapshot(snap, tactical, digest, { commandBinding: binding });
    assert.equal(snap.command_type, 'MC_SNAP_SHOT');

    const auto = composeMcAutoShotCommand(binding, {
      commandId: 'mc-auto-1',
      actorUnitId: 1000042,
      activeHand: 'STR_RIGHT_HAND',
      target: { x: 8, y: 5, z: 0 },
    });
    parseMcAutoShotCommand(auto);

    const aimed = composeMcAimedShotCommand(binding, {
      commandId: 'mc-aim-1',
      actorUnitId: 1000042,
      activeHand: 'STR_RIGHT_HAND',
      target: { x: 8, y: 5, z: 0 },
    });
    assert.equal(aimed.command_type, 'MC_AIMED_SHOT');
  });

  it('rejects soldier SNAP_SHOT compose for MC hostile id', () => {
    assert.throws(
      () => composeSnapShotCommand(binding, {
        commandId: 'bad-snap',
        actorUnitId: 1000042,
        activeHand: 'STR_RIGHT_HAND',
        target: { x: 8, y: 5, z: 0 },
      }),
      /player_soldier/,
    );
  });

  it('validates MC fire when actionCosts live only under xcomControlledHostileObservationV1', () => {
    const sparseTactical = {
      eventLog: { sessionId, latestSeq: 4 },
      turn: 2,
      side: 0,
      map: { width: 40, height: 40, depth: 1 },
      units: [{
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
          health: 26,
          activeHand: 'STR_RIGHT_HAND',
          actionCosts: {
            hands: {
              right: {
                actions: [
                  { id: 'snap', tuCost: 16, usable: true, canAffordTu: true },
                ],
              },
            },
          },
        },
      }],
    };
    const sparseDigest = sha256HexLower(Buffer.from(JSON.stringify(sparseTactical), 'utf8'));
    const sparseBinding = buildCommandBinding(sparseTactical, sparseDigest, { soldierControl: mirror });
    const snap = composeMcSnapShotCommand(sparseBinding, {
      commandId: 'mc-snap-sparse-export',
      actorUnitId: 1000042,
      activeHand: 'STR_RIGHT_HAND',
      target: { x: 8, y: 5, z: 0 },
    });
    validateMcSnapShotAgainstSnapshot(snap, sparseTactical, sparseDigest, { commandBinding: sparseBinding });
  });

  it('sidecar snapshot-file validation reads actionCosts under xcomControlledHostileObservationV1', () => {
    const fixturePath = path.join(__dirname, 'fixtures/mc-hostile-nested-actioncosts-v5.yaml');
    const yamlText = fs.readFileSync(fixturePath, 'utf8');
    const digest = sha256HexLower(Buffer.from(yamlText, 'utf8'));
    const tactical = loadAndValidateSnapshotFromText(yamlText, YAML);
    const controlJson = JSON.stringify({
      schema_version: 3,
      session_id: sessionId,
      campaign_id: campaignId,
      tactical_battle_id: tacticalBattleId,
      assignments: {},
      mc_hostile_assignments: { 1000042: 'ai' },
    });
    const mirror = buildSoldierControlMirror(tactical, {
      soldierControlFileJson: controlJson,
      ownershipBindingContext: { campaign_id: campaignId, tactical_battle_id: tacticalBattleId },
    });
    const binding = buildCommandBinding(tactical, digest, { soldierControl: mirror });
    const snap = composeMcSnapShotCommand(binding, {
      commandId: 'mc-snap-sidecar-nested-costs',
      actorUnitId: 1000042,
      activeHand: 'STR_RIGHT_HAND',
      target: { x: 3, y: 10, z: 0 },
    });
    validateTacticalCommandAgainstSnapshotFile(
      snap,
      fixturePath,
      YAML,
      fs.readFileSync,
      { commandBinding: binding },
    );
  });
});