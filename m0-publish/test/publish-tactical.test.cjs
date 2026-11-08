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

const { SYNTHETIC_RELAY_REPO } = require('./helpers/synthetic-relay-env.cjs');

const FIXTURE = path.join(__dirname, 'fixtures', 'valid-v2.yaml');
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
