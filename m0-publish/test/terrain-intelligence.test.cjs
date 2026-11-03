'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const {
  MAX_INPUT_BYTES,
  parseAndValidate,
  loadAndValidateSnapshotFromText,
} = require('../lib/tactical-publish.cjs');
const { verifyBriefingSnapshot, sha256HexLower } = require('../lib/briefing-snapshot.cjs');

const FIXTURE_V4 = path.join(__dirname, 'fixtures', 'valid-v4.yaml');
const FIXTURE_V5 = path.join(__dirname, 'fixtures', 'valid-v5.yaml');

describe('schema v5 terrain validation', () => {
  it('accepts valid v4 fixture without terrain', () => {
    const text = fs.readFileSync(FIXTURE_V4, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(text, YAML);
    assert.equal(tactical.schemaVersion, 4);
    assert.equal(tactical.terrain, undefined);
  });

  it('accepts valid v5 fixture with terrain', () => {
    const text = fs.readFileSync(FIXTURE_V5, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(text, YAML);
    assert.equal(tactical.schemaVersion, 5);
    assert.ok(tactical.terrain);
    assert.equal(tactical.terrain.tiles.length, 2);
  });

  it('rejects v5 without terrain', () => {
    const raw = YAML.parse(fs.readFileSync(FIXTURE_V5, 'utf8'));
    delete raw.terrain;
    assert.throws(() => parseAndValidate(raw), /terrain required/);
  });

  it('rejects v4 with terrain', () => {
    const raw = YAML.parse(fs.readFileSync(FIXTURE_V4, 'utf8'));
    raw.terrain = { memoryNote: 'x', tiles: [] };
    assert.throws(() => parseAndValidate(raw), /unknown root field: terrain/);
  });

  it('rejects body without body discovery bit', () => {
    const raw = YAML.parse(fs.readFileSync(FIXTURE_V5, 'utf8'));
    raw.terrain.tiles[0].disc = 1;
    raw.terrain.tiles[0].body = { noFloor: false, elev: 0 };
    assert.throws(() => parseAndValidate(raw), /must not include body without body discovery/);
  });

  it('rejects out-of-map terrain positions', () => {
    const raw = YAML.parse(fs.readFileSync(FIXTURE_V5, 'utf8'));
    raw.terrain.tiles.push({
      p: [99, 0, 0],
      disc: 4,
      inLos: false,
      body: { noFloor: false, elev: 0 },
    });
    assert.throws(() => parseAndValidate(raw), /out of map bounds/);
  });

  it('rejects unsorted terrain tiles', () => {
    const raw = YAML.parse(fs.readFileSync(FIXTURE_V5, 'utf8'));
    raw.terrain.tiles = [raw.terrain.tiles[1], raw.terrain.tiles[0]];
    assert.throws(() => parseAndValidate(raw), /sorted by z/);
  });

  it('verifies v5 briefing SHA binding', () => {
    const text = fs.readFileSync(FIXTURE_V5, 'utf8');
    const bytes = Buffer.from(text, 'utf8');
    const request = {
      snapshot_sha256: sha256HexLower(bytes),
      turn: 1,
      session_id: 'a1b2c3d4e5f6789012345678abcdef01',
    };
    const result = verifyBriefingSnapshot({ request, snapshotBytes: bytes, yaml: YAML });
    assert.equal(result.tactical.schemaVersion, 5);
  });
});

describe('terrain payload size (synthetic)', () => {
  it('documents discovered-tile packed payload bytes under cap for moderate maps', () => {
    const { worstCaseBlobBytes, base64EncodedLength, HEADER_BYTES, MAX_TILE_RECORD_BYTES } = require('../lib/terrain-packed-v1.cjs');
    const recordCount = 40 * 40;
    const rawBlob = HEADER_BYTES + recordCount * 4; // typical body-only records (~9 bytes), use 4-byte body + 5 prefix = 9
    const typicalRecordBytes = 9;
    const typicalBlob = HEADER_BYTES + recordCount * typicalRecordBytes;
    const dataLen = base64EncodedLength(typicalBlob);
    const yamlBytes = 12000 + dataLen + 200;
    assert.ok(yamlBytes < MAX_INPUT_BYTES, `expected synthetic 40x40 packed terrain under cap, got ${yamlBytes}`);
    assert.ok(worstCaseBlobBytes(recordCount) > typicalBlob, 'worst-case projection must exceed typical sparse body records');
    assert.equal(MAX_TILE_RECORD_BYTES, 13);
  });

  it('reports full-map worst-case packed records would exceed 256 KiB cap', () => {
    const { worstCaseBlobBytes, base64EncodedLength } = require('../lib/terrain-packed-v1.cjs');
    const recordCount = 100 * 100 * 2;
    const raw = worstCaseBlobBytes(recordCount);
    const yamlBytes = 12000 + base64EncodedLength(raw) + 200;
    assert.ok(yamlBytes > MAX_INPUT_BYTES, `expected 100x100x2 heavy packed terrain to exceed cap, got ${yamlBytes}`);
  });
});
