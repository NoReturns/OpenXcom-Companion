'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const {
  buildCommandBinding,
  composeHwpTurnCommand,
  composeHwpMoveCommand,
  composeTurnFaceCommand,
  composeMoveCommand,
} = require('../lib/command-binding.cjs');
const { buildSoldierControlMirror } = require('../lib/soldier-control-relay.cjs');
const { loadAndValidateSnapshotFromText } = require('../lib/tactical-publish.cjs');
const {
  parseHwpTurnCommand,
  parseTacticalCommand,
  parseHwpMoveCommand,
  parseTurnFaceCommand,
  validateHwpTurnAgainstSnapshot,
  validateHwpMoveAgainstSnapshot,
  validateTurnFaceAgainstSnapshot,
  validateTacticalCommandAgainstSnapshot,
  COMMAND_TYPE_HWP_TURN,
  isHwpTurnCommandType,
} = require('../lib/tactical-command.cjs');
const { readSnapshotByteBuffer, sha256HexLower } = require('../lib/briefing-snapshot.cjs');

const FIXTURE_OBS = path.join(__dirname, 'fixtures', 'friendly-hwp-observation-v1.yaml');
const SESSION = 'f6e5d4c3b2a19081726354433221100a';
const CAMPAIGN = '0123456789abcdef0123456789abcdef';
const TACTICAL = 'fedcba9876543210fedcba9876543210';
const DIGEST = 'd'.repeat(64);
const HWP_CANNON_ID = 1_000_000;
const HWP_LASER_ID = 1_000_001;

function mixedControlJson({ soldierAi = [], hwpAi = [] }) {
  const assignments = {};
  for (const id of soldierAi) assignments[String(id)] = 'ai';
  const hwp_assignments = {};
  for (const id of hwpAi) hwp_assignments[String(id)] = 'ai';
  return JSON.stringify({
    schema_version: 2,
    session_id: SESSION,
    campaign_id: CAMPAIGN,
    tactical_battle_id: TACTICAL,
    assignments,
    hwp_assignments,
  });
}

function laserHwpUnit() {
  return {
    id: HWP_LASER_ID,
    faction: 0,
    originalFaction: 0,
    position: [7, 5, 0],
    friendlyHwpObservationV1: {
      schemaVersion: 1,
      unitId: HWP_LASER_ID,
      hwpUnitType: 'STR_TANK_LASER_CANNON',
      displayLabel: 'Tank/Laser Cannon',
      position: { x: 7, y: 5, z: 0 },
      bodyFacing: {
        direction: 0,
        label: 'north',
        vector: { dx: 0, dy: -1 },
      },
      turretFacing: {
        direction: 2,
        label: 'east',
        vector: { dx: 1, dy: 0 },
      },
      turretTypeId: 2,
      timeUnits: 80,
      maxTimeUnits: 80,
      health: 120,
      maxHealth: 120,
      kneeled: false,
      movementType: 'walk',
      capabilities: {
        bodyTurn: true,
        turretTurn: true,
      },
      fixedWeapons: [
        {
          battleItemId: 9101,
          itemType: 'STR_TANK_LASER_CANNON',
          battleType: 1,
        },
      ],
    },
  };
}

function tacticalFixture() {
  const base = loadAndValidateSnapshotFromText(fs.readFileSync(FIXTURE_OBS, 'utf8'), YAML);
  return {
    ...base,
    units: [...base.units, laserHwpUnit()],
  };
}

function bindingForAiHwp(tactical, hwpAi = [HWP_CANNON_ID, HWP_LASER_ID]) {
  const mirror = buildSoldierControlMirror(tactical, {
    soldierControlFileJson: mixedControlJson({ hwpAi }),
    ownershipBindingContext: { campaign_id: CAMPAIGN, tactical_battle_id: TACTICAL },
  });
  return buildCommandBinding(tactical, DIGEST, { soldierControl: mirror });
}

/** Mirror production gate until S4-1c enables runtime HWP_TURN. */
function bindingWithTurnGate(baseBinding, enabled) {
  return {
    ...baseBinding,
    player_hwps: baseBinding.player_hwps.map((row) => ({
      ...row,
      hwpTurnExecutionSupported: enabled,
    })),
  };
}

describe('M1-HWP-S4 HWP_TURN Node contract', () => {
  it('compose + parse Cannon body and turret turns', () => {
    const tactical = tacticalFixture();
    const binding = bindingForAiHwp(tactical);
    for (const turnPart of ['body', 'turret']) {
      const cmd = composeHwpTurnCommand(binding, {
        commandId: `cannon-${turnPart}`,
        actorUnitId: HWP_CANNON_ID,
        turnPart,
        target: { x: 8, y: 5, z: 0 },
      });
      assert.equal(cmd.command_type, COMMAND_TYPE_HWP_TURN);
      assert.equal(cmd.turn_part, turnPart);
      assert.equal(isHwpTurnCommandType(COMMAND_TYPE_HWP_TURN), true);
      const parsed = parseHwpTurnCommand(cmd);
      assert.equal(parsed.turnPart, turnPart);
      assert.deepEqual(parsed.target, { x: 8, y: 5, z: 0 });
      assert.equal(parseTacticalCommand(cmd).commandType, COMMAND_TYPE_HWP_TURN);
    }
  });

  it('compose + parse Laser Cannon turret turn with advisory', () => {
    const tactical = tacticalFixture();
    const binding = bindingForAiHwp(tactical);
    const cmd = composeHwpTurnCommand(binding, {
      commandId: 'laser-turret-north',
      actorUnitId: HWP_LASER_ID,
      turnPart: 'turret',
      target: { x: 7, y: 3, z: 0 },
    });
    const out = validateHwpTurnAgainstSnapshot(cmd, tactical, DIGEST, { commandBinding: binding });
    assert.equal(out.actor.id, HWP_LASER_ID);
    assert.equal(out.turnPart, 'turret');
    assert.equal(out.planningHint.advisory, true);
    assert.equal(out.planningHint.engineStrafeRequiredForTurret, true);
    assert.equal(out.planningHint.facingTuStepsEstimated, 2);
    assert.equal(out.planningHint.turnAffordableEstimate, true);
  });

  it('rejects missing or invalid turn_part', () => {
    const tactical = tacticalFixture();
    const binding = bindingForAiHwp(tactical);
    assert.throws(
      () => composeHwpTurnCommand(binding, {
        commandId: 'no-part',
        actorUnitId: HWP_CANNON_ID,
        target: { x: 6, y: 5, z: 0 },
      }),
      /turnPart/,
    );
    const bad = composeHwpTurnCommand(binding, {
      commandId: 'bad-part',
      actorUnitId: HWP_CANNON_ID,
      turnPart: 'body',
      target: { x: 6, y: 5, z: 0 },
    });
    bad.turn_part = 'hull';
    assert.throws(() => parseHwpTurnCommand(bad), /turn_part/);
  });

  it('rejects human-owned HWP and roster soldier actor', () => {
    const tactical = tacticalFixture();
    const humanMirror = buildSoldierControlMirror(tactical, {
      soldierControlFileJson: mixedControlJson({ hwpAi: [] }),
      ownershipBindingContext: { campaign_id: CAMPAIGN, tactical_battle_id: TACTICAL },
    });
    const binding = buildCommandBinding(tactical, DIGEST, { soldierControl: humanMirror });
    assert.throws(
      () => composeHwpTurnCommand(binding, {
        commandId: 'human-hwp',
        actorUnitId: HWP_CANNON_ID,
        turnPart: 'turret',
        target: { x: 8, y: 5, z: 0 },
      }),
      /AI-owned/,
    );
    const aiBinding = bindingForAiHwp(tactical);
    assert.throws(
      () => composeHwpTurnCommand(aiBinding, {
        commandId: 'soldier-as-hwp',
        actorUnitId: 1,
        turnPart: 'body',
        target: { x: 2, y: 2, z: 0 },
      }),
      /HWP_TURN actor must be/,
    );
    assert.throws(
      () => composeTurnFaceCommand(aiBinding, {
        commandId: 'turnface-hwp',
        actorUnitId: HWP_CANNON_ID,
        target: { x: 8, y: 5, z: 0 },
      }),
      /player_soldier/,
    );
  });

  it('rejects turret turn when capabilities.turretTurn is false', () => {
    const tactical = tacticalFixture();
    const noTurret = {
      ...tactical,
      units: tactical.units.map((u) => (u.id === HWP_CANNON_ID
        ? {
          ...u,
          friendlyHwpObservationV1: {
            ...u.friendlyHwpObservationV1,
            turretFacing: undefined,
            turretTypeId: undefined,
            capabilities: { bodyTurn: true, turretTurn: false },
          },
        }
        : u)),
    };
    const binding = bindingForAiHwp(noTurret, [HWP_CANNON_ID, HWP_LASER_ID]);
    const cmd = composeHwpTurnCommand(binding, {
      commandId: 'no-turret-cap',
      actorUnitId: HWP_CANNON_ID,
      turnPart: 'turret',
      target: { x: 8, y: 5, z: 0 },
    });
    assert.throws(
      () => validateHwpTurnAgainstSnapshot(cmd, noTurret, DIGEST, { commandBinding: binding }),
      /turret turn not supported/,
    );
    const bodyOk = composeHwpTurnCommand(binding, {
      commandId: 'body-still-ok',
      actorUnitId: HWP_CANNON_ID,
      turnPart: 'body',
      target: { x: 8, y: 5, z: 0 },
    });
    validateHwpTurnAgainstSnapshot(bodyOk, noTurret, DIGEST, { commandBinding: binding });
  });

  it('rejects same-tile target, OOB, and stale binding', () => {
    const tactical = tacticalFixture();
    const binding = bindingForAiHwp(tactical);
    assert.throws(
      () => composeHwpTurnCommand(binding, {
        commandId: 'same-tile',
        actorUnitId: HWP_CANNON_ID,
        turnPart: 'body',
        target: { x: 5, y: 5, z: 0 },
      }),
      /target must differ/,
    );
    const oob = composeHwpTurnCommand(binding, {
      commandId: 'oob',
      actorUnitId: HWP_CANNON_ID,
      turnPart: 'turret',
      target: { x: 8, y: 5, z: 0 },
    });
    oob.target = { x: 99, y: 5, z: 0 };
    assert.throws(
      () => validateHwpTurnAgainstSnapshot(oob, tactical, DIGEST, { commandBinding: binding }),
      /target out of map bounds/,
    );
    const stale = composeHwpTurnCommand(binding, {
      commandId: 'stale',
      actorUnitId: HWP_LASER_ID,
      turnPart: 'turret',
      target: { x: 9, y: 5, z: 0 },
    });
    stale.state_version = tactical.eventLog.latestSeq + 5;
    assert.throws(
      () => validateHwpTurnAgainstSnapshot(stale, tactical, DIGEST, { commandBinding: binding }),
      /state_version/,
    );
  });

  it('binding reports hwpTurnExecutionSupported when relay gate is on (S4-1c)', () => {
    const tactical = tacticalFixture();
    const binding = bindingForAiHwp(tactical);
    const cannon = binding.player_hwps.find((h) => h.id === HWP_CANNON_ID);
    const laser = binding.player_hwps.find((h) => h.id === HWP_LASER_ID);
    assert.equal(cannon.commandExecutionSupported, false);
    assert.equal(cannon.hwpTurnExecutionSupported, true);
    assert.equal(cannon.hwpMoveExecutionSupported, true);
    assert.equal(laser.hwpTurnExecutionSupported, true);
  });

  it('validate rejects publish when hwpTurnExecutionSupported is false', () => {
    const tactical = tacticalFixture();
    const binding = bindingWithTurnGate(bindingForAiHwp(tactical), false);
    const cmd = composeHwpTurnCommand(binding, {
      commandId: 'gate-off',
      actorUnitId: HWP_CANNON_ID,
      turnPart: 'body',
      target: { x: 8, y: 5, z: 0 },
    });
    assert.throws(
      () => validateHwpTurnAgainstSnapshot(cmd, tactical, DIGEST, { commandBinding: binding }),
      /hwpTurnExecutionSupported/,
    );
  });

  it('validateTacticalCommandAgainstSnapshot dispatches HWP_TURN', () => {
    const tactical = tacticalFixture();
    const binding = bindingForAiHwp(tactical);
    const cmd = composeHwpTurnCommand(binding, {
      commandId: 'via-dispatch',
      actorUnitId: HWP_LASER_ID,
      turnPart: 'body',
      target: { x: 7, y: 6, z: 0 },
    });
    validateTacticalCommandAgainstSnapshot(cmd, tactical, DIGEST, { commandBinding: binding });
  });

  it('regression: TURN_FACE and HWP_MOVE unchanged', () => {
    const tactical = tacticalFixture();
    const bytes = readSnapshotByteBuffer(fs.readFileSync, FIXTURE_OBS);
    const digest = sha256HexLower(bytes);
    const mirror = buildSoldierControlMirror(tactical, {
      soldierControlFileJson: mixedControlJson({ soldierAi: [1] }),
      ownershipBindingContext: { campaign_id: CAMPAIGN, tactical_battle_id: TACTICAL },
    });
    const binding = buildCommandBinding(tactical, digest, { soldierControl: mirror });
    const turn = composeTurnFaceCommand(binding, {
      commandId: 'turn-regression',
      actorUnitId: 1,
      target: { x: 6, y: 5, z: 0 },
    });
    parseTurnFaceCommand(turn);
    validateTurnFaceAgainstSnapshot(turn, tactical, digest, { commandBinding: binding });

    const hwpBinding = bindingForAiHwp(tactical, [HWP_CANNON_ID]);
    const move = composeHwpMoveCommand(hwpBinding, {
      commandId: 'hwp-move-regression',
      actorUnitId: HWP_CANNON_ID,
      destination: { x: 6, y: 5, z: 0 },
    });
    parseHwpMoveCommand(move);
    validateHwpMoveAgainstSnapshot(move, tactical, DIGEST, { commandBinding: hwpBinding });
  });
});