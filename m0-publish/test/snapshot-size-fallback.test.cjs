'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const {
  loadAndValidateSnapshotFromText,
  MAX_INPUT_BYTES,
} = require('../lib/tactical-publish.cjs');
const { verifyBriefingSnapshot, sha256HexLower } = require('../lib/briefing-snapshot.cjs');

const FIXTURE_V4 = path.join(__dirname, 'fixtures', 'valid-v4.yaml');
const FIXTURE_V5 = path.join(__dirname, 'fixtures', 'valid-v5.yaml');

describe('snapshot size-cap fallback (M1-17H)', () => {
  it('keeps small v5 snapshots with terrain valid', () => {
    const text = fs.readFileSync(FIXTURE_V5, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(text, YAML);
    assert.equal(tactical.schemaVersion, 5);
    assert.ok(tactical.terrain);
    const bytes = Buffer.byteLength(text, 'utf8');
    assert.ok(bytes < MAX_INPUT_BYTES, `fixture must be under cap (${bytes})`);
  });

  it('accepts v4 fallback shape without terrain (companion pipeline)', () => {
    const text = fs.readFileSync(FIXTURE_V4, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(text, YAML);
    assert.equal(tactical.schemaVersion, 4);
    assert.equal(tactical.terrain, undefined);
    assert.ok(tactical.eventLog);
    assert.ok(tactical.units.length >= 1);
  });

  it('binds briefing SHA-256 to final fallback YAML bytes', () => {
    const text = fs.readFileSync(FIXTURE_V4, 'utf8');
    const snapshotBytes = Buffer.from(text, 'utf8');
    const request = {
      request_id: '0123456789abcdef0123456789abcdef',
      session_id: 'a1b2c3d4e5f6789012345678abcdef01',
      turn: 1,
      snapshot_sha256: sha256HexLower(snapshotBytes),
    };
    const result = verifyBriefingSnapshot({ request, snapshotBytes, yaml: YAML });
    assert.equal(result.tactical.schemaVersion, 4);
    assert.equal(result.digest, request.snapshot_sha256);
  });

  it('still rejects snapshots over the 256 KiB cap', () => {
    const big = 'schemaVersion: 4\n' + 'x: '.repeat(MAX_INPUT_BYTES);
    assert.throws(() => loadAndValidateSnapshotFromText(big, YAML), /256 KiB/);
  });
});
