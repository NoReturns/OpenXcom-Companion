'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildCommandBinding,
  composeMcMoveCommand,
  composeMcTurnFaceCommand,
  composeMcKneelCommand,
  composeMcStandCommand,
} = require('../lib/command-binding.cjs');
const { buildSoldierControlMirror } = require('../lib/soldier-control-relay.cjs');
const {
  validateMcMoveAgainstSnapshot,
  validateMcTurnFaceAgainstSnapshot,
  validateMcKneelAgainstSnapshot,
  validateMcStandAgainstSnapshot,
  parseMcMoveCommand,
} = require('../lib/tactical-command.cjs');
const { sha256HexLower } = require('../lib/briefing-snapshot.cjs');

describe('MC-02B mind-controlled hostile execution binding', () => {
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

  it('enables MC execution flags when AI-owned with observation', () => {
    const row = binding.player_mc_hostiles.find((h) => h.id === 1000042);
    assert(row);
    assert.equal(row.controlMode, 'ai');
    assert.equal(row.mcMoveExecutionSupported, true);
    assert.equal(row.mcTurnFaceExecutionSupported, true);
    assert.equal(row.mcKneelExecutionSupported, true);
  });

  it('composes and validates MC_MOVE', () => {
    const cmd = composeMcMoveCommand(binding, {
      commandId: 'mc-move-1',
      actorUnitId: 1000042,
      destination: { x: 6, y: 5, z: 0 },
    });
    parseMcMoveCommand(cmd);
    validateMcMoveAgainstSnapshot(cmd, tactical, digest, { commandBinding: binding });
    assert.equal(cmd.command_type, 'MC_MOVE');
  });

  it('composes and validates MC_TURN_FACE MC_KNEEL MC_STAND', () => {
    const turn = composeMcTurnFaceCommand(binding, {
      commandId: 'mc-turn-1',
      actorUnitId: 1000042,
      target: { x: 7, y: 5, z: 0 },
    });
    validateMcTurnFaceAgainstSnapshot(turn, tactical, digest, { commandBinding: binding });

    const kneel = composeMcKneelCommand(binding, { commandId: 'mc-kneel-1', actorUnitId: 1000042 });
    validateMcKneelAgainstSnapshot(kneel, tactical, digest, { commandBinding: binding });

    const stand = composeMcStandCommand(binding, { commandId: 'mc-stand-1', actorUnitId: 1000042 });
    validateMcStandAgainstSnapshot(stand, tactical, digest, { commandBinding: binding });
  });

  it('rejects MC_MOVE for human-owned MC hostile in binding', () => {
    const humanMirror = buildSoldierControlMirror(tactical, {
      soldierControlFileJson: JSON.stringify({
        schema_version: 3,
        session_id: sessionId,
        campaign_id: campaignId,
        tactical_battle_id: tacticalBattleId,
        assignments: {},
        mc_hostile_assignments: { 1000042: 'human' },
      }),
      ownershipBindingContext: { campaign_id: campaignId, tactical_battle_id: tacticalBattleId },
    });
    const humanBinding = buildCommandBinding(tactical, digest, { soldierControl: humanMirror });
    const row = humanBinding.player_mc_hostiles.find((h) => h.id === 1000042);
    assert.equal(row.mcMoveExecutionSupported, false);
    assert.throws(
      () => composeMcMoveCommand(humanBinding, {
        commandId: 'mc-move-bad',
        actorUnitId: 1000042,
        destination: { x: 6, y: 5, z: 0 },
      }),
      /AI-owned/,
    );
  });
});