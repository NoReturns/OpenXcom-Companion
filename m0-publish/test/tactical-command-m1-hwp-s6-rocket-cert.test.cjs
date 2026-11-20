'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const { buildCommandBinding, composeHwpFireCommand } = require('../lib/command-binding.cjs');
const { buildSoldierControlMirror } = require('../lib/soldier-control-relay.cjs');
const { loadAndValidateSnapshotFromText } = require('../lib/tactical-publish.cjs');
const {
  parseHwpFireCommand,
  validateHwpFireAgainstSnapshot,
  validateTacticalCommandAgainstSnapshot,
  COMMAND_TYPE_HWP_FIRE,
} = require('../lib/tactical-command.cjs');
const { buildHwpFirePlanningHint, estimateHwpTurnFacing } = require('../lib/tu-composite-advisory.cjs');

const FIXTURE = path.join(__dirname, 'fixtures', 'friendly-hwp-s6-rocket-cert.yaml');
const SESSION = 'a1b2c3d4e5f6789012345678901234cd';
const CAMPAIGN = '0123456789abcdef0123456789abcdef';
const TACTICAL = 'fedcba9876543210fedcba9876543210';
const DIGEST = 'd'.repeat(64);
const HWP_ROCKET_ID = 1_000_002;
const ROCKET_WEAPON_ID = 5;

function mixedControlJson({ soldierAi = [1], hwpAi = [HWP_ROCKET_ID] }) {
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
  return loadAndValidateSnapshotFromText(fs.readFileSync(FIXTURE, 'utf8'), YAML);
}

function bindingForRocket(tactical) {
  const mirror = buildSoldierControlMirror(tactical, {
    soldierControlFileJson: mixedControlJson({ soldierAi: [1], hwpAi: [HWP_ROCKET_ID] }),
    ownershipBindingContext: { campaign_id: CAMPAIGN, tactical_battle_id: TACTICAL },
  });
  const binding = buildCommandBinding(tactical, DIGEST, { soldierControl: mirror });
  return {
    ...binding,
    player_hwps: binding.player_hwps.map((row) => ({
      ...row,
      hwpFireExecutionSupported: true,
    })),
  };
}

describe('M1-HWP-S6 rocket HWP_FIRE certification (Node)', () => {
  it('compose + validate snap and aimed with 8-round magazine export', () => {
    const tactical = loadTactical();
    const binding = bindingForRocket(tactical);
    const actor = tactical.units.find((u) => u.id === HWP_ROCKET_ID);
    const weapon = actor.friendlyHwpObservationV1.fixedWeapons[0];
    assert.equal(weapon.itemType, 'STR_TANK_ROCKET_LAUNCHER');
    assert.equal(weapon.nestedAmmo.ammoType, 'STR_HWP_ROCKETS');
    assert.equal(weapon.nestedAmmo.rounds, 8);
    assert.equal(weapon.loaded.rounds, 8);

    for (const fireMode of ['snap', 'aimed']) {
      const cmd = composeHwpFireCommand(binding, {
        commandId: `rocket-${fireMode}-s6`,
        actorUnitId: HWP_ROCKET_ID,
        fireMode,
        weaponBattleItemId: ROCKET_WEAPON_ID,
        target: { x: 20, y: 10, z: 1 },
      });
      const parsed = parseHwpFireCommand(cmd);
      assert.equal(parsed.commandType, COMMAND_TYPE_HWP_FIRE);
      const result = validateHwpFireAgainstSnapshot(cmd, tactical, DIGEST, { commandBinding: binding });
      assert.equal(result.weapon.itemType, 'STR_TANK_ROCKET_LAUNCHER');
      const expectedTu = fireMode === 'snap' ? 54 : 90;
      assert.equal(result.planningHint.fireTuCost, expectedTu);
    }
  });

  it('turret advisory + composite TU for rocket launcher', () => {
    const tactical = loadTactical();
    const binding = bindingForRocket(tactical);
    const actor = tactical.units.find((u) => u.id === HWP_ROCKET_ID);
    const target = { x: 12, y: 20, z: 1 };
    const turret = estimateHwpTurnFacing(actor, target, 'turret');
    assert.ok(turret.steps > 0);
    const hint = validateHwpFireAgainstSnapshot(
      composeHwpFireCommand(binding, {
        commandId: 'rocket-hint',
        actorUnitId: HWP_ROCKET_ID,
        fireMode: 'snap',
        weaponBattleItemId: ROCKET_WEAPON_ID,
        target,
      }),
      tactical,
      DIGEST,
      { commandBinding: binding },
    ).planningHint;
    assert.equal(hint.fireTuCost, 54);
    assert.equal(hint.compositeMinTuEstimate, 54 + turret.steps);
    assert.equal(hint.turretFacingDiffersFromHull, true);
  });

  it('rejects empty rocket magazine at validation', () => {
    const tactical = loadTactical();
    const binding = bindingForRocket(tactical);
    const actor = tactical.units.find((u) => u.id === HWP_ROCKET_ID);
    const weapon = actor.friendlyHwpObservationV1.fixedWeapons[0];
    weapon.nestedAmmo.rounds = 0;
    weapon.loaded.rounds = 0;
    weapon.empty = true;
    const cmd = composeHwpFireCommand(binding, {
      commandId: 'rocket-empty',
      actorUnitId: HWP_ROCKET_ID,
      fireMode: 'snap',
      weaponBattleItemId: ROCKET_WEAPON_ID,
      target: { x: 20, y: 10, z: 1 },
    });
    assert.throws(
      () => validateHwpFireAgainstSnapshot(cmd, tactical, DIGEST, { commandBinding: binding }),
      /empty|no rounds|magazine/,
    );
  });

  it('validateTacticalCommandAgainstSnapshot dispatches rocket HWP_FIRE', () => {
    const tactical = loadTactical();
    const binding = bindingForRocket(tactical);
    const cmd = composeHwpFireCommand(binding, {
      commandId: 'rocket-dispatch',
      actorUnitId: HWP_ROCKET_ID,
      fireMode: 'aimed',
      weaponBattleItemId: ROCKET_WEAPON_ID,
      target: { x: 18, y: 12, z: 1 },
    });
    validateTacticalCommandAgainstSnapshot(cmd, tactical, DIGEST, { commandBinding: binding });
  });
});