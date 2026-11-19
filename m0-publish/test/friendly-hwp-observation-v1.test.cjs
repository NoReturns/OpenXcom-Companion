'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const { loadAndValidateSnapshotFromText } = require('../lib/tactical-publish.cjs');
const { buildCommandBinding } = require('../lib/command-binding.cjs');
const {
  listFriendlyHwpObservations,
  validateFriendlyHwpObservationV1,
  ValidationError,
} = require('../lib/friendly-hwp-observation-v1.cjs');
const {
  buildUnitStateBrief,
  isFriendlyHwpUnit,
  isFriendlyRosterSoldier,
} = require('../lib/unit-state-brief.cjs');

const FIXTURE_SPARSE = path.join(__dirname, 'fixtures', 'friendly-hwp-sparse-v5.yaml');
const FIXTURE_OBS = path.join(__dirname, 'fixtures', 'friendly-hwp-observation-v1.yaml');
const FIXTURE_BATTLE_ITEM_ID_ZERO = path.join(__dirname, 'fixtures', 'friendly-hwp-battle-item-id-zero.yaml');
const FIXTURE_S5_LIVE_CANNON_LASER = path.join(__dirname, 'fixtures', 'friendly-hwp-s5-live-cannon-laser.yaml');

const { buildSoldierControlMirror } = require('../lib/soldier-control-relay.cjs');

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

  it('accepts engine-low fixedWeapons battleItemId 0 through full snapshot validation', () => {
    const text = fs.readFileSync(FIXTURE_BATTLE_ITEM_ID_ZERO, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(text, YAML);
    const obs = tactical.units.find((u) => u.id === 1_000_000).friendlyHwpObservationV1;
    assert.equal(obs.fixedWeapons[0].battleItemId, 0);
    assert.equal(obs.fixedWeapons[0].loaded.battleItemId, 1);
  });

  it('accepts positive fixedWeapons battleItemId (pinned observation fixture)', () => {
    const text = fs.readFileSync(FIXTURE_OBS, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(text, YAML);
    const obs = tactical.units.find((u) => u.id === 1_000_000).friendlyHwpObservationV1;
    assert.equal(obs.fixedWeapons[0].battleItemId, 9001);
    assert.equal(obs.fixedWeapons[0].loaded.battleItemId, 9002);
  });

  it('rejects negative fixedWeapons battleItemId', () => {
    const base = {
      schemaVersion: 1,
      unitId: 1_000_000,
      hwpUnitType: 'STR_TANK_CANNON',
      position: { x: 0, y: 0, z: 0 },
      timeUnits: 10,
      kneeled: false,
      fixedWeapons: [{ battleItemId: -1, itemType: 'STR_TANK_CANNON', battleType: 1 }],
    };
    assert.throws(
      () => validateFriendlyHwpObservationV1(base, 0),
      (err) => err instanceof ValidationError && /battleItemId/.test(err.message),
    );
  });

  it('unitStateBrief skips friendly HWP rows (roster exceptions only)', () => {
    const text = fs.readFileSync(FIXTURE_OBS, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(text, YAML);
    const brief = buildUnitStateBrief(tactical);
    assert.ok(brief.exceptions.every((e) => e.id < 1_000_000));
  });
});

describe('HWP-S5-0 fixed-weapon nestedAmmo normalization', () => {
  const HWP_CANNON_ID = 1_000_000;
  const HWP_LASER_ID = 1_000_001;

  function controlJsonForHwps(hwpIds) {
    const hwp_assignments = {};
    for (const id of hwpIds) hwp_assignments[String(id)] = 'ai';
    return JSON.stringify({
      schema_version: 2,
      session_id: 'a1b2c3d4e5f6789012345678901234cd',
      campaign_id: '0123456789abcdef0123456789abcdef',
      tactical_battle_id: 'fedcba9876543210fedcba9876543210',
      assignments: { 1: 'human' },
      hwp_assignments,
    });
  }

  it('preserves validated Cannon nestedAmmo through publish and command binding', () => {
    const text = fs.readFileSync(FIXTURE_S5_LIVE_CANNON_LASER, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(text, YAML);
    const cannonObs = tactical.units.find((u) => u.id === HWP_CANNON_ID).friendlyHwpObservationV1;
    const weapon = cannonObs.fixedWeapons[0];
    assert.equal(weapon.battleItemId, 0);
    assert.equal(weapon.loaded.rounds, 30);
    assert.equal(weapon.loaded.battleItemId, 1);
    assert.ok(weapon.nestedAmmo);
    assert.equal(weapon.nestedAmmo.battleItemId, 1);
    assert.equal(weapon.nestedAmmo.ammoType, 'STR_HWP_CANNON_SHELLS');
    assert.equal(weapon.nestedAmmo.rounds, 30);
    assert.equal(weapon.nestedAmmo.researchUsable, true);

    const mirror = buildSoldierControlMirror(tactical, {
      soldierControlFileJson: controlJsonForHwps([HWP_CANNON_ID, HWP_LASER_ID]),
      ownershipBindingContext: {
        campaign_id: '0123456789abcdef0123456789abcdef',
        tactical_battle_id: 'fedcba9876543210fedcba9876543210',
      },
    });
    const binding = buildCommandBinding(tactical, 'a'.repeat(64), { soldierControl: mirror });
    const cannonRow = binding.player_hwps.find((h) => h.id === HWP_CANNON_ID);
    assert.ok(cannonRow?.friendlyHwpObservationV1?.fixedWeapons);
    const boundWeapon = cannonRow.friendlyHwpObservationV1.fixedWeapons[0];
    assert.deepEqual(boundWeapon.nestedAmmo, weapon.nestedAmmo);
    assert.deepEqual(boundWeapon.loaded, weapon.loaded);
  });

  it('accepts Laser fixed weapon without nestedAmmo or loaded blocks', () => {
    const text = fs.readFileSync(FIXTURE_S5_LIVE_CANNON_LASER, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(text, YAML);
    const laserObs = tactical.units.find((u) => u.id === HWP_LASER_ID).friendlyHwpObservationV1;
    const weapon = laserObs.fixedWeapons[0];
    assert.equal(weapon.itemType, 'STR_TANK_LASER_CANNON');
    assert.equal(weapon.battleItemId, 2);
    assert.equal(weapon.nestedAmmo, undefined);
    assert.equal(weapon.loaded, undefined);

    const mirror = buildSoldierControlMirror(tactical, {
      soldierControlFileJson: controlJsonForHwps([HWP_LASER_ID]),
      ownershipBindingContext: {
        campaign_id: '0123456789abcdef0123456789abcdef',
        tactical_battle_id: 'fedcba9876543210fedcba9876543210',
      },
    });
    const binding = buildCommandBinding(tactical, 'b'.repeat(64), { soldierControl: mirror });
    const laserRow = binding.player_hwps.find((h) => h.id === HWP_LASER_ID);
    assert.ok(laserRow);
    assert.equal(laserRow.friendlyHwpObservationV1.fixedWeapons[0].nestedAmmo, undefined);
  });

  it('rejects nestedAmmo with unknown fields and incompatible noMagazineInserted', () => {
    const base = {
      schemaVersion: 1,
      unitId: 1_000_000,
      hwpUnitType: 'STR_TANK_CANNON',
      position: { x: 0, y: 0, z: 0 },
      timeUnits: 10,
      kneeled: false,
      fixedWeapons: [{
        battleItemId: 0,
        itemType: 'STR_TANK_CANNON',
        battleType: 1,
        nestedAmmo: {
          battleItemId: 1,
          ammoType: 'STR_HWP_CANNON_SHELLS',
          rounds: 10,
          hacker: true,
        },
      }],
    };
    assert.throws(
      () => validateFriendlyHwpObservationV1(base, 0),
      (err) => err instanceof ValidationError && /unknown field: hacker/.test(err.message),
    );

    const conflict = {
      ...base,
      fixedWeapons: [{
        battleItemId: 0,
        itemType: 'STR_TANK_CANNON',
        battleType: 1,
        noMagazineInserted: true,
        nestedAmmo: {
          battleItemId: 1,
          ammoType: 'STR_HWP_CANNON_SHELLS',
          rounds: 10,
        },
      }],
    };
    assert.throws(
      () => validateFriendlyHwpObservationV1(conflict, 0),
      (err) => err instanceof ValidationError && /nestedAmmo with noMagazineInserted/.test(err.message),
    );
  });
});