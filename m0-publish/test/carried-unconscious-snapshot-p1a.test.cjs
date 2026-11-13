'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const YAML = require('yaml');
const {
  ValidationError,
  loadAndValidateSnapshotFromText,
  parseAndValidate,
  buildRelayPayload,
} = require('../lib/tactical-publish.cjs');
const { buildCommandBinding } = require('../lib/command-binding.cjs');

const FIXTURE = path.join(__dirname, 'fixtures', 'carried-unconscious-v5.yaml');
const FIXTURE_V5 = path.join(__dirname, 'fixtures', 'valid-v5.yaml');

function sha256HexLower(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

describe('P1-A carried unconscious snapshot (SEND validation path)', () => {
  it('accepts carried living unconscious soldier with carrier linkage', () => {
    const text = fs.readFileSync(FIXTURE, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(text, YAML);
    const carried = tactical.units.find((u) => u.id === 3);
    assert.equal(carried.battlefieldPlacement, 'carried_in_inventory');
    assert.equal(carried.positionKnown, false);
    assert.equal(carried.carriedByUnitId, 1);
    assert.equal(carried.carriedBodyBattleItemId, 9001);
    assert.equal(carried.position, undefined);
    const carrier = tactical.units.find((u) => u.id === 1);
    const body = carrier.inventory.find((row) => row.battleItemId === 9001);
    assert.equal(body.carriedRosterUnitId, 3);
    const onMapUnconscious = tactical.units.find((u) => u.id === 2);
    assert.deepEqual(onMapUnconscious.position, [4, 4, 0]);
  });

  it('builds relay payload and excludes carried soldier from commandBinding positions', () => {
    const text = fs.readFileSync(FIXTURE, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(text, YAML);
    const digest = sha256HexLower(text);
    const relay = buildRelayPayload(tactical, new Date().toISOString(), null, { snapshotSha256: digest });
    const binding = buildCommandBinding(tactical, digest);
    assert.ok(binding.player_soldiers.find((s) => s.id === 1));
    assert.ok(binding.player_soldiers.find((s) => s.id === 2));
    assert.equal(binding.player_soldiers.find((s) => s.id === 3), undefined);
    assert.ok(relay.commandBinding);
    assert.equal(relay.tactical.units.length, 3);
  });

  it('rejects raw negative unit position (unrelated invalid)', () => {
    const raw = YAML.parse(fs.readFileSync(FIXTURE_V5, 'utf8'));
    raw.units[0].position = [-1, 2, 0];
    assert.throws(() => parseAndValidate(raw), /units\[0\]\.position/);
  });

  it('rejects carried_in_inventory without carrier inventory linkage', () => {
    const raw = YAML.parse(fs.readFileSync(FIXTURE, 'utf8'));
    const carrier = raw.units.find((u) => u.id === 1);
    carrier.inventory = [];
    assert.throws(() => parseAndValidate(raw), /carriedBodyBattleItemId/);
  });

  it('rejects carried_in_inventory with position present', () => {
    const raw = YAML.parse(fs.readFileSync(FIXTURE, 'utf8'));
    const carried = raw.units.find((u) => u.id === 3);
    carried.position = [1, 2, 0];
    assert.throws(() => parseAndValidate(raw), /must not include position/);
  });

  it('rejects mismatched carriedRosterUnitId on inventory row', () => {
    const raw = YAML.parse(fs.readFileSync(FIXTURE, 'utf8'));
    const carrier = raw.units.find((u) => u.id === 1);
    carrier.inventory[0].carriedRosterUnitId = 99;
    assert.throws(() => parseAndValidate(raw), /carriedRosterUnitId mismatch/);
  });

  it('rejects malformed carried placement without positionKnown false', () => {
    const raw = YAML.parse(fs.readFileSync(FIXTURE, 'utf8'));
    const carried = raw.units.find((u) => u.id === 3);
    carried.positionKnown = true;
    assert.throws(() => parseAndValidate(raw), /positionKnown must be false/);
  });

  it('accepts live OpenXcom STR_CORPSE body rows with battleType BT_NONE (0)', () => {
    const raw = YAML.parse(fs.readFileSync(FIXTURE, 'utf8'));
    const carrier = raw.units.find((u) => u.id === 1);
    const body = carrier.inventory.find((row) => row.battleItemId === 9001);
    body.itemType = 'STR_CORPSE';
    body.battleType = 0;
    const tactical = parseAndValidate(raw);
    assert.equal(tactical.units.find((u) => u.id === 3).battlefieldPlacement, 'carried_in_inventory');
  });

  it('rejects carried linkage when inventory row is not a corpse item type', () => {
    const raw = YAML.parse(fs.readFileSync(FIXTURE, 'utf8'));
    const carrier = raw.units.find((u) => u.id === 1);
    const body = carrier.inventory.find((row) => row.battleItemId === 9001);
    body.itemType = 'STR_RIFLE';
    body.battleType = 0;
    assert.throws(() => parseAndValidate(raw), /carried body must be corpse battleType or STR_CORPSE/);
  });

  it('accepts dead corpse inventory row with BT_CORPSE only (no carried unit row)', () => {
    const raw = YAML.parse(fs.readFileSync(FIXTURE, 'utf8'));
    raw.units = raw.units.filter((u) => u.id !== 3);
    const carrier = raw.units.find((u) => u.id === 1);
    carrier.inventory[0].carriedRosterUnitId = undefined;
    delete carrier.inventory[0].carriedRosterUnitId;
    carrier.inventory[0].battleType = 11;
    carrier.inventory[0].itemType = 'STR_XCOM_CORPSE';
    const tactical = parseAndValidate(raw);
    assert.equal(tactical.units.length, 2);
  });
});
