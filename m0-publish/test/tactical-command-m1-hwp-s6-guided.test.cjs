'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const { buildCommandBinding, composeHwpGuidedLaunchCommand } = require('../lib/command-binding.cjs');
const { buildSoldierControlMirror } = require('../lib/soldier-control-relay.cjs');
const { loadAndValidateSnapshotFromText } = require('../lib/tactical-publish.cjs');
const {
  parseHwpGuidedLaunchCommand,
  validateTacticalCommandAgainstSnapshot,
} = require('../lib/tactical-command.cjs');

const FIXTURE = path.join(__dirname, 'fixtures', 'friendly-hwp-s6-guided-fusion.yaml');
const HWP_ID = 1_000_003;
const WEAPON_ID = 8;
const DIGEST = 'd'.repeat(64);

function mixedControlJson() {
  return JSON.stringify({
    schema_version: 2,
    session_id: 'a1b2c3d4e5f6789012345678901234cd',
    campaign_id: '0123456789abcdef0123456789abcdef',
    tactical_battle_id: 'fedcba9876543210fedcba9876543210',
    assignments: {},
    hwp_assignments: { [String(HWP_ID)]: 'ai' },
  });
}

function bindingForFusion(tactical) {
  const mirror = buildSoldierControlMirror(tactical, {
    soldierControlFileJson: mixedControlJson(),
    ownershipBindingContext: {
      campaign_id: '0123456789abcdef0123456789abcdef',
      tactical_battle_id: 'fedcba9876543210fedcba9876543210',
    },
  });
  const binding = buildCommandBinding(tactical, DIGEST, { soldierControl: mirror });
  return {
    ...binding,
    player_hwps: binding.player_hwps.map((row) => ({
      ...row,
      hwpGuidedLaunchExecutionSupported: true,
    })),
  };
}

describe('M1-HWP-S6 guided fusion HWP_GUIDED_LAUNCH (Node)', () => {
  it('compose + validate waypoints for hovertank fusion launcher', () => {
    const tactical = loadAndValidateSnapshotFromText(fs.readFileSync(FIXTURE, 'utf8'), YAML);
    const binding = bindingForFusion(tactical);
    const waypoints = [
      { x: 25, y: 20, z: 1 },
      { x: 30, y: 20, z: 1 },
      { x: 35, y: 22, z: 1 },
    ];
    const cmd = composeHwpGuidedLaunchCommand(binding, {
      commandId: 'hwp-guided-fusion-s6',
      actorUnitId: HWP_ID,
      weaponBattleItemId: WEAPON_ID,
      waypoints,
    });
    parseHwpGuidedLaunchCommand(cmd);
    validateTacticalCommandAgainstSnapshot(cmd, tactical, DIGEST, {
      commandBinding: binding,
      rulesReference: {
        items: {
          STR_HOVERTANK_LAUNCHER: { waypoints: 9 },
        },
      },
    });
    const weapon = tactical.units.find((u) => u.id === HWP_ID).friendlyHwpObservationV1.fixedWeapons[0];
    assert.equal(weapon.itemType, 'STR_HOVERTANK_LAUNCHER');
    assert.equal(weapon.nestedAmmo.ammoType, 'STR_HWP_FUSION_BOMB');
    assert.equal(weapon.nestedAmmo.rounds, 8);
  });
});