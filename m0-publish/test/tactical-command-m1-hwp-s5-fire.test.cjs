'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const {
  buildCommandBinding,
  composeHwpFireCommand,
  composeHwpTurnCommand,
  composeHwpMoveCommand,
  composeSnapShotCommand,
  composeAimedShotCommand,
} = require('../lib/command-binding.cjs');
const { buildSoldierControlMirror } = require('../lib/soldier-control-relay.cjs');
const { loadAndValidateSnapshotFromText } = require('../lib/tactical-publish.cjs');
const {
  parseHwpFireCommand,
  parseTacticalCommand,
  validateHwpFireAgainstSnapshot,
  validateHwpTurnAgainstSnapshot,
  validateHwpMoveAgainstSnapshot,
  validateSnapShotAgainstSnapshot,
  validateTacticalCommandAgainstSnapshot,
  COMMAND_TYPE_HWP_FIRE,
  isHwpFireCommandType,
} = require('../lib/tactical-command.cjs');
const {
  buildHwpFirePlanningHint,
  estimateHwpTurnFacing,
} = require('../lib/tu-composite-advisory.cjs');
const { readSnapshotByteBuffer, sha256HexLower } = require('../lib/briefing-snapshot.cjs');

const FIXTURE_S5 = path.join(__dirname, 'fixtures', 'friendly-hwp-s5-live-cannon-laser.yaml');
const SESSION = 'a1b2c3d4e5f6789012345678901234cd';
const CAMPAIGN = '0123456789abcdef0123456789abcdef';
const TACTICAL = 'fedcba9876543210fedcba9876543210';
const DIGEST = 'c'.repeat(64);
const HWP_CANNON_ID = 1_000_000;
const HWP_LASER_ID = 1_000_001;
const CANNON_WEAPON_ID = 0;
const LASER_WEAPON_ID = 2;

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

function loadTactical() {
  return loadAndValidateSnapshotFromText(fs.readFileSync(FIXTURE_S5, 'utf8'), YAML);
}

function bindingForAiHwp(tactical, hwpAi = [HWP_CANNON_ID, HWP_LASER_ID], { fireEnabled = true } = {}) {
  const mirror = buildSoldierControlMirror(tactical, {
    soldierControlFileJson: mixedControlJson({ soldierAi: [1], hwpAi }),
    ownershipBindingContext: { campaign_id: CAMPAIGN, tactical_battle_id: TACTICAL },
  });
  const binding = buildCommandBinding(tactical, DIGEST, { soldierControl: mirror });
  return {
    ...binding,
    player_hwps: binding.player_hwps.map((row) => ({
      ...row,
      hwpFireExecutionSupported: fireEnabled,
    })),
  };
}

describe('M1-HWP-S5 HWP_FIRE Node contract', () => {
  it('compose + parse Cannon snap and aimed (weapon id 0)', () => {
    const tactical = loadTactical();
    const binding = bindingForAiHwp(tactical);
    for (const fireMode of ['snap', 'aimed']) {
      const cmd = composeHwpFireCommand(binding, {
        commandId: `cannon-${fireMode}`,
        actorUnitId: HWP_CANNON_ID,
        fireMode,
        weaponBattleItemId: CANNON_WEAPON_ID,
        target: { x: 30, y: 10, z: 1 },
      });
      const parsed = parseHwpFireCommand(cmd);
      assert.equal(parsed.commandType, COMMAND_TYPE_HWP_FIRE);
      assert.equal(parsed.fireMode, fireMode);
      assert.equal(parsed.weaponBattleItemId, CANNON_WEAPON_ID);
      assert.equal(isHwpFireCommandType(COMMAND_TYPE_HWP_FIRE), true);
      validateHwpFireAgainstSnapshot(cmd, tactical, DIGEST, { commandBinding: binding });
    }
  });

  it('compose + parse Laser snap without magazine', () => {
    const tactical = loadTactical();
    const binding = bindingForAiHwp(tactical);
    const cmd = composeHwpFireCommand(binding, {
      commandId: 'laser-snap',
      actorUnitId: HWP_LASER_ID,
      fireMode: 'snap',
      weaponBattleItemId: LASER_WEAPON_ID,
      target: { x: 28, y: 11, z: 1 },
    });
    parseHwpFireCommand(cmd);
    const result = validateHwpFireAgainstSnapshot(cmd, tactical, DIGEST, { commandBinding: binding });
    const weapon = result.weapon;
    assert.equal(weapon.nestedAmmo, undefined);
    assert.equal(weapon.loaded, undefined);
  });

  it('rejects auto fire_mode and unknown modes at parse', () => {
    const base = {
      schema_version: 1,
      command_id: 'bad-mode',
      command_type: 'HWP_FIRE',
      actor_unit_id: HWP_CANNON_ID,
      fire_mode: 'auto',
      weapon_battle_item_id: 0,
      target: { x: 1, y: 1, z: 0 },
      snapshot_sha256: DIGEST,
      session_id: SESSION,
      turn: 1,
      state_version: 0,
    };
    assert.throws(() => parseHwpFireCommand(base), /fire_mode must be "snap" or "aimed"/);
    assert.throws(
      () => parseHwpFireCommand({ ...base, fire_mode: 'burst' }),
      /fire_mode must be "snap" or "aimed"/,
    );
    assert.throws(
      () => composeHwpFireCommand(bindingForAiHwp(loadTactical()), {
        commandId: 'compose-auto',
        actorUnitId: HWP_CANNON_ID,
        fireMode: 'auto',
        weaponBattleItemId: 0,
        target: { x: 1, y: 1, z: 0 },
      }),
      /fireMode must be "snap" or "aimed"/,
    );
  });

  it('rejects empty Cannon ammunition at validation', () => {
    const tactical = loadTactical();
    const binding = bindingForAiHwp(tactical);
    const hwp = tactical.units.find((u) => u.id === HWP_CANNON_ID);
    const weapon = hwp.friendlyHwpObservationV1.fixedWeapons[0];
    weapon.nestedAmmo.rounds = 0;
    weapon.loaded.rounds = 0;
    weapon.empty = true;
    const cmd = composeHwpFireCommand(binding, {
      commandId: 'empty-cannon',
      actorUnitId: HWP_CANNON_ID,
      fireMode: 'snap',
      weaponBattleItemId: CANNON_WEAPON_ID,
      target: { x: 30, y: 10, z: 1 },
    });
    assert.throws(
      () => validateHwpFireAgainstSnapshot(cmd, tactical, DIGEST, { commandBinding: binding }),
      /empty|no rounds|magazine/,
    );
  });

  it('rejects wrong weapon id, stale binding, and OOB target', () => {
    const tactical = loadTactical();
    const binding = bindingForAiHwp(tactical);
    assert.throws(
      () => composeHwpFireCommand(binding, {
        commandId: 'wrong-weapon',
        actorUnitId: HWP_CANNON_ID,
        fireMode: 'snap',
        weaponBattleItemId: 999,
        target: { x: 10, y: 10, z: 1 },
      }),
      /exactly one fixed weapon/,
    );
    const cmd = composeHwpFireCommand(binding, {
      commandId: 'stale',
      actorUnitId: HWP_LASER_ID,
      fireMode: 'snap',
      weaponBattleItemId: LASER_WEAPON_ID,
      target: { x: 28, y: 11, z: 1 },
    });
    cmd.state_version = tactical.eventLog.latestSeq + 3;
    assert.throws(
      () => validateHwpFireAgainstSnapshot(cmd, tactical, DIGEST, { commandBinding: binding }),
      /state_version/,
    );
    cmd.state_version = tactical.eventLog.latestSeq;
    cmd.target = { x: 99, y: 99, z: 1 };
    assert.throws(
      () => validateHwpFireAgainstSnapshot(cmd, tactical, DIGEST, { commandBinding: binding }),
      /target out of map bounds/,
    );
  });

  it('turret-facing advisory differs from hull bearing and omits invented TU without actionCosts', () => {
    const tactical = loadTactical();
    const actor = tactical.units.find((u) => u.id === HWP_CANNON_ID);
    const target = { x: 40, y: 8, z: 1 };
    const turretFacing = estimateHwpTurnFacing(actor, target, 'turret');
    const bodyWouldBe = estimateHwpTurnFacing(
      { ...actor, friendlyHwpObservationV1: { ...actor.friendlyHwpObservationV1, turretFacing: undefined } },
      target,
      'body',
    );
    assert.notEqual(turretFacing.steps, bodyWouldBe.steps);
    const hint = buildHwpFirePlanningHint(actor, target, 'snap', { fireTuCost: null });
    assert.equal(hint.fireTuCostUnavailable, true);
    assert.equal(hint.fireTuCost, null);
    assert.equal(hint.turretFacingDiffersFromHull, true);

    const boundHint = validateHwpFireAgainstSnapshot(
      composeHwpFireCommand(bindingForAiHwp(tactical), {
        commandId: 'hint-check',
        actorUnitId: HWP_CANNON_ID,
        fireMode: 'snap',
        weaponBattleItemId: CANNON_WEAPON_ID,
        target,
      }),
      tactical,
      DIGEST,
      { commandBinding: bindingForAiHwp(tactical) },
    ).planningHint;
    assert.equal(boundHint.fireTuCost, 23);
    assert.equal(boundHint.compositeMinTuEstimate, 23 + (turretFacing.steps ?? 0));
    assert.equal(boundHint.fireTuCostUnavailable, false);
  });

  it('rejects insufficient TU and surfaces reaction reservation in advisory only', () => {
    const tactical = loadTactical();
    const binding = bindingForAiHwp(tactical);
    const actor = tactical.units.find((u) => u.id === HWP_LASER_ID);
    const snap = actor.friendlyHwpObservationV1.fixedWeapons[0].actionCosts.find((a) => a.id === 'snap');
    snap.canAffordTu = false;
    const cmd = composeHwpFireCommand(binding, {
      commandId: 'no-tu',
      actorUnitId: HWP_LASER_ID,
      fireMode: 'snap',
      weaponBattleItemId: LASER_WEAPON_ID,
      target: { x: 28, y: 11, z: 1 },
    });
    assert.throws(
      () => validateHwpFireAgainstSnapshot(cmd, tactical, DIGEST, { commandBinding: binding }),
      /insufficient TU/,
    );
    snap.canAffordTu = true;
    snap.canAffordTuWithCurrentReservation = false;
    const ok = validateHwpFireAgainstSnapshot(cmd, tactical, DIGEST, { commandBinding: binding });
    assert.ok(ok.planningHint.reactionReservationAdvisory);
    assert.equal(ok.planningHint.canAffordTuWithCurrentReservation, false);
  });

  it('rejects HWP actor on soldier SNAP_SHOT compose', () => {
    const tactical = loadTactical();
    const bytes = readSnapshotByteBuffer(fs.readFileSync, FIXTURE_S5);
    const digest = sha256HexLower(bytes);
    const mirror = buildSoldierControlMirror(tactical, {
      soldierControlFileJson: mixedControlJson({ soldierAi: [1] }),
      ownershipBindingContext: { campaign_id: CAMPAIGN, tactical_battle_id: TACTICAL },
    });
    const binding = buildCommandBinding(tactical, digest, { soldierControl: mirror });
    assert.throws(
      () => composeSnapShotCommand(binding, {
        commandId: 'hwp-snap',
        actorUnitId: HWP_CANNON_ID,
        activeHand: 'STR_RIGHT_HAND',
        target: { x: 1, y: 1, z: 0 },
      }),
      /player_soldier/,
    );
    assert.throws(
      () => composeAimedShotCommand(binding, {
        commandId: 'hwp-aim',
        actorUnitId: HWP_LASER_ID,
        activeHand: 'STR_RIGHT_HAND',
        target: { x: 1, y: 1, z: 0 },
      }),
      /player_soldier/,
    );
  });

  it('binding reports hwpFireExecutionSupported false by default; gate rejects when off', () => {
    const tactical = loadTactical();
    const binding = bindingForAiHwp(tactical, undefined, { fireEnabled: false });
    const cannon = binding.player_hwps.find((h) => h.id === HWP_CANNON_ID);
    assert.equal(cannon.hwpFireExecutionSupported, false);
    assert.equal(cannon.hwpTurnExecutionSupported, true);
    const cmd = composeHwpFireCommand(
      bindingForAiHwp(tactical),
      {
        commandId: 'gate',
        actorUnitId: HWP_CANNON_ID,
        fireMode: 'snap',
        weaponBattleItemId: CANNON_WEAPON_ID,
        target: { x: 30, y: 10, z: 1 },
      },
    );
    assert.throws(
      () => validateHwpFireAgainstSnapshot(cmd, tactical, DIGEST, { commandBinding: binding }),
      /hwpFireExecutionSupported/,
    );
  });

  it('validateTacticalCommandAgainstSnapshot dispatches HWP_FIRE', () => {
    const tactical = loadTactical();
    const binding = bindingForAiHwp(tactical);
    const cmd = composeHwpFireCommand(binding, {
      commandId: 'dispatch',
      actorUnitId: HWP_LASER_ID,
      fireMode: 'aimed',
      weaponBattleItemId: LASER_WEAPON_ID,
      target: { x: 28, y: 12, z: 1 },
    });
    parseTacticalCommand(cmd);
    validateTacticalCommandAgainstSnapshot(cmd, tactical, DIGEST, { commandBinding: binding });
  });

  it('regression: soldier snap, HWP MOVE, and HWP_TURN unchanged', () => {
    const tactical = loadTactical();
    const soldierTac = {
      schemaVersion: 5,
      turn: 1,
      side: 0,
      map: { width: 20, height: 20, depth: 1 },
      eventLog: { sessionId: SESSION, latestSeq: 0 },
      units: [{
        id: 1,
        faction: 0,
        originalFaction: 0,
        position: [1, 1, 0],
        name: 'Regression Soldier',
        timeUnits: 80,
        actionCosts: {
          hands: {
            right: {
              actions: [{ id: 'snap', tuCost: 25, usable: true, canAffordTu: true }],
            },
          },
        },
      }],
    };
    const soldierDigest = 'd'.repeat(64);
    const soldierBinding = buildCommandBinding(soldierTac, soldierDigest);
    const snap = composeSnapShotCommand(soldierBinding, {
      commandId: 'soldier-snap',
      actorUnitId: 1,
      activeHand: 'STR_RIGHT_HAND',
      target: { x: 6, y: 5, z: 0 },
    });
    validateSnapShotAgainstSnapshot(snap, soldierTac, soldierDigest);

    const hwpBinding = bindingForAiHwp(tactical, [HWP_CANNON_ID]);
    const move = composeHwpMoveCommand(hwpBinding, {
      commandId: 'move-reg',
      actorUnitId: HWP_CANNON_ID,
      destination: { x: 33, y: 8, z: 1 },
    });
    validateHwpMoveAgainstSnapshot(move, tactical, DIGEST, { commandBinding: hwpBinding });
    const turn = composeHwpTurnCommand(hwpBinding, {
      commandId: 'turn-reg',
      actorUnitId: HWP_CANNON_ID,
      turnPart: 'turret',
      target: { x: 35, y: 8, z: 1 },
    });
    validateHwpTurnAgainstSnapshot(turn, tactical, DIGEST, { commandBinding: hwpBinding });
  });
});