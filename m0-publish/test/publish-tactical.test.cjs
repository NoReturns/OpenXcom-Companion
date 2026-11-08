'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const YAML = require('yaml');
const {
  MAX_INPUT_BYTES,
  ValidationError,
  parseAndValidate,
  validateUnit,
  computeSnapshotId,
  buildRelayPayload,
  loadAndValidateSnapshotFromText,
  FACTION_PLAYER,
  FACTION_HOSTILE,
} = require('../lib/tactical-publish.cjs');
const { buildCommandBinding } = require('../lib/command-binding.cjs');

const { SYNTHETIC_RELAY_REPO } = require('./helpers/synthetic-relay-env.cjs');

const FIXTURE = path.join(__dirname, 'fixtures', 'valid-v2.yaml');
const FIXTURE_FRIENDLY_HWP_V5 = path.join(__dirname, 'fixtures', 'friendly-hwp-sparse-v5.yaml');
const REAL_SNAPSHOT = path.resolve(__dirname, '../../../local/m0/tactical-m1-04.yaml');

describe('tactical snapshot validation', () => {
  it('accepts a valid schema v2 snapshot', () => {
    const text = fs.readFileSync(FIXTURE, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(text, YAML);
    assert.equal(tactical.schemaVersion, 2);
    assert.equal(tactical.units.length, 3);
  });

  it('accepts the real local tactical YAML', () => {
    const text = fs.readFileSync(REAL_SNAPSHOT, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(text, YAML);
    assert.equal(tactical.units.length, 9);
    assert.equal(tactical.units[8].id, 1000000);
    assert.equal(tactical.units[8].health, undefined);
  });

  it('rejects malformed YAML', () => {
    assert.throws(
      () => loadAndValidateSnapshotFromText('turn: [', YAML),
      ValidationError
    );
  });

  it('rejects invalid schema version', () => {
    const text = fs.readFileSync(FIXTURE, 'utf8').replace('schemaVersion: 2', 'schemaVersion: 1');
    assert.throws(() => loadAndValidateSnapshotFromText(text, YAML), /schemaVersion must be/);
  });

  it('rejects unknown root fields', () => {
    const raw = YAML.parse(fs.readFileSync(FIXTURE, 'utf8'));
    raw.secret = true;
    assert.throws(() => parseAndValidate(raw), /unknown root field: secret/);
  });

  it('rejects enemy health, name, and timeUnits', () => {
    const raw = YAML.parse(fs.readFileSync(FIXTURE, 'utf8'));
    raw.units[2].health = 50;
    assert.throws(() => parseAndValidate(raw), /must not include health/);
    delete raw.units[2].health;
    raw.units[2].name = 'Sectoid';
    assert.throws(() => parseAndValidate(raw), /must not include name/);
    delete raw.units[2].name;
    raw.units[2].timeUnits = 10;
    assert.throws(() => parseAndValidate(raw), /must not include timeUnits/);
  });

  it('accepts hostile observedUnitType instead of name', () => {
    const raw = YAML.parse(fs.readFileSync(FIXTURE, 'utf8'));
    raw.units[2].observedUnitType = 'STR_SECTOID_SOLDIER';
    raw.units[2].displayLabel = 'Sectoid Soldier';
    const tactical = parseAndValidate(raw);
    const hostile = tactical.units.find((u) => u.id === raw.units[2].id);
    assert.equal(hostile.observedUnitType, 'STR_SECTOID_SOLDIER');
    assert.equal(hostile.name, undefined);
  });

  it('rejects mind-controlled XCOM tactical fields', () => {
    validateUnit({
      id: 9,
      faction: FACTION_HOSTILE,
      originalFaction: FACTION_PLAYER,
      position: [1, 2, 0],
    }, 0);

    assert.throws(
      () => validateUnit({
        id: 9,
        faction: FACTION_HOSTILE,
        originalFaction: FACTION_PLAYER,
        position: [1, 2, 0],
        health: 20,
      }, 0),
      /must not include health/
    );
  });

  it('rejects mind-controlled alien friendly extras', () => {
    assert.throws(
      () => validateUnit({
        id: 1000000,
        faction: FACTION_PLAYER,
        originalFaction: FACTION_HOSTILE,
        position: [1, 2, 0],
        health: 20,
      }, 0),
      /must not include health/
    );
  });

  it('accepts sparse friendly HWP without roster soldier fields', () => {
    const unit = validateUnit({
      id: 1000000,
      faction: FACTION_PLAYER,
      originalFaction: FACTION_PLAYER,
      position: [32, 16, 0],
    }, 0, 5);
    assert.equal(unit.id, 1000000);
    assert.equal(unit.name, undefined);
    assert.equal(unit.health, undefined);
  });

  it('rejects friendly HWP with soldier-only fields', () => {
    assert.throws(
      () => validateUnit({
        id: 1000000,
        faction: FACTION_PLAYER,
        originalFaction: FACTION_PLAYER,
        position: [32, 16, 0],
        name: 'Tank',
      }, 0, 5),
      /must not include name/
    );
  });

  it('rejects malformed friendly roster soldier missing name', () => {
    assert.throws(
      () => validateUnit({
        id: 6,
        faction: FACTION_PLAYER,
        originalFaction: FACTION_PLAYER,
        position: [1, 2, 0],
      }, 0, 5),
      /name required/
    );
  });

  it('excludes friendly HWP from commandBinding.player_soldiers', () => {
    const tactical = {
      turn: 1,
      side: 0,
      map: { width: 50, height: 50, depth: 4 },
      eventLog: { sessionId: 'a1b2c3d4e5f6789012345678abcdef01', latestSeq: 1 },
      units: [
        {
          id: 1000000,
          faction: FACTION_PLAYER,
          originalFaction: FACTION_PLAYER,
          position: [32, 16, 0],
        },
        {
          id: 1,
          faction: FACTION_PLAYER,
          originalFaction: FACTION_PLAYER,
          position: [2, 2, 0],
          name: 'Rifleman',
          health: 40,
          timeUnits: 50,
          kneeled: false,
          activeHand: 'STR_RIGHT_HAND',
          hands: { right: null, left: null },
          inventory: [],
        },
      ],
    };
    const binding = buildCommandBinding(tactical, 'a'.repeat(64));
    assert.equal(binding.player_soldiers.length, 1);
    assert.equal(binding.player_soldiers[0].id, 1);
    assert.ok(binding.player_soldiers.every((s) => s.id !== 1000000));
  });

  it('validates pinned friendly HWP snapshot (sparse export + binding)', () => {
    const text = fs.readFileSync(FIXTURE_FRIENDLY_HWP_V5, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(text, YAML);
    assert.equal(tactical.schemaVersion, 5);
    const hwp = tactical.units.find((u) => u.id === 1_000_000);
    assert.ok(hwp, 'friendly HWP present in units');
    assert.equal(hwp.faction, FACTION_PLAYER);
    assert.equal(hwp.originalFaction, FACTION_PLAYER);
    assert.equal(hwp.name, undefined);
    assert.equal(hwp.health, undefined);
    assert.equal(hwp.timeUnits, undefined);
    assert.equal(hwp.observedUnitType, undefined);
    assert.equal(hwp.displayLabel, undefined);
    assert.equal(hwp.inventory, undefined);
    const roster = tactical.units.filter((u) => u.id < 1_000_000);
    assert.equal(roster.length, 2);
    assert.ok(roster.every((u) => typeof u.name === 'string' && u.name.length > 0));
    assert.ok(roster.every((u) => Array.isArray(u.inventory)));
    const digest = 'b'.repeat(64);
    const relay = buildRelayPayload(tactical, '2026-11-08T18:30:00.000Z', null, { snapshotSha256: digest });
    assert.equal(relay.commandBinding.player_soldiers.length, 2);
    assert.ok(relay.commandBinding.player_soldiers.every((s) => s.id < 1_000_000));
    assert.deepEqual(
      relay.commandBinding.player_soldiers.map((s) => s.id).sort((a, b) => a - b),
      [1, 2],
    );
  });

  it('produces stable snapshot hashing', () => {
    const text = fs.readFileSync(FIXTURE, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(text, YAML);
    const a = computeSnapshotId(tactical);
    const b = computeSnapshotId(tactical);
    assert.equal(a, b);
    assert.match(a, /^[a-f0-9]{64}$/);

    const relay1 = buildRelayPayload(tactical, '2026-01-01T00:00:00.000Z');
    const relay2 = buildRelayPayload(tactical, '2026-01-02T00:00:00.000Z');
    assert.equal(relay1.snapshot_id, relay2.snapshot_id);
    assert.notEqual(relay1.published_at, relay2.published_at);
  });

  it('rejects oversized input', () => {
    const big = 'schemaVersion: 2\n' + 'x: '.repeat(MAX_INPUT_BYTES);
    assert.throws(() => loadAndValidateSnapshotFromText(big, YAML), /256 KiB/);
  });
});

describe('publish-tactical-once CLI', () => {
  it('defaults to dry-run without network publish', () => {
    const out = execFileSync(process.execPath, [
      path.join(__dirname, '..', 'publish-tactical-once.cjs'),
      '--path', REAL_SNAPSHOT,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        OPENXCOM_COMPANION_RELAY_REPO: SYNTHETIC_RELAY_REPO,
      },
    });
    assert.match(out, /Mode: dry-run/);
    assert.match(out, /Snapshot ID: [a-f0-9]{64}/);
    assert.match(out, new RegExp(`Target: https://github.com/${SYNTHETIC_RELAY_REPO.replace('/', '\\/')}/`));
  });
});
