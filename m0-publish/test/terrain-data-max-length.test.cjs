'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const {
  ValidationError,
  MAX_INPUT_BYTES,
  loadAndValidateSnapshotFromText,
  parseAndValidate,
  maxPackedTerrainDataBase64Length,
} = require('../lib/tactical-publish.cjs');
const { verifyBriefingSnapshot, sha256HexLower } = require('../lib/briefing-snapshot.cjs');
const { buildTerrainBrief, decodeTerrainTiles } = require('../lib/terrain-brief.cjs');
const { PackedTerrainError } = require('../lib/terrain-packed-v1.cjs');

const LIVE_SNAPSHOT = path.join(__dirname, '../../../local/m0/tactical-live.yaml');
const LIVE_REQUEST = path.join(__dirname, '../../../local/m0/briefing-request.json');

function hexToBuffer(hexText) {
  return Buffer.from(hexText.replace(/\s+/g, ''), 'hex');
}

function headerHex(recordCount, map) {
  const rc = Buffer.alloc(4);
  rc.writeUInt32LE(recordCount, 0);
  const w = Buffer.alloc(2);
  w.writeUInt16LE(map.width, 0);
  const h = Buffer.alloc(2);
  h.writeUInt16LE(map.height, 0);
  const rcHex = rc.toString('hex').match(/../g).join(' ');
  const wHex = w.toString('hex').match(/../g).join(' ');
  const hHex = h.toString('hex').match(/../g).join(' ');
  const depthHex = map.depth.toString(16).padStart(2, '0');
  return `4f585431 01 00 0000 ${wHex} ${hHex} ${depthHex} 00 ${rcHex}`;
}

describe('terrain.data max length (M1-17O)', () => {
  const map5050x4 = { width: 50, height: 50, depth: 4 };

  it('documents map-derived max for 50x50x4 (not the old 256-char default)', () => {
    const maxLen = maxPackedTerrainDataBase64Length(map5050x4);
    assert.equal(maxLen, 173_360);
    assert.ok(20_968 <= maxLen, 'live-scale data length must fit map-derived cap');
  });

  it('regression: rejects terrain.data above map-derived cap', () => {
    const map = { width: 3, height: 3, depth: 1 };
    const maxLen = maxPackedTerrainDataBase64Length(map);
    const data = 'A'.repeat(maxLen + 1);
    const raw = {
      schemaVersion: 5,
      turn: 1,
      side: 0,
      selectedUnitId: -1,
      map,
      units: [{ id: 1, faction: 1, originalFaction: 1, position: [0, 0, 0] }],
      eventLog: {
        sessionId: 'a1b2c3d4e5f6789012345678abcdef01',
        oldestSeq: 0,
        latestSeq: 0,
        droppedCount: 0,
        events: [],
      },
      terrain: {
        memoryNote: 'note',
        encoding: 'packed-v1',
        recordCount: 0,
        data,
      },
    };
    assert.throws(
      () => parseAndValidate(raw),
      (err) => err instanceof ValidationError && /terrain\.data exceeds max length/.test(err.message),
    );
  });

  it('regression M1-17O: live tactical-live.yaml validates (was terrain.data exceeds max length)', () => {
    assert.ok(fs.existsSync(LIVE_SNAPSHOT), 'live snapshot required for regression');
    const text = fs.readFileSync(LIVE_SNAPSHOT, 'utf8');
    assert.ok(Buffer.byteLength(text, 'utf8') < MAX_INPUT_BYTES);
    const tactical = loadAndValidateSnapshotFromText(text, YAML);
    assert.equal(tactical.terrain.encoding, 'packed-v1');
    assert.equal(tactical.terrain.recordCount, 2218);
    assert.equal(tactical.terrain.data.length, 20_968);
  });
});

describe('live F6 artifact read-only verification (M1-17O)', () => {
  it('verifies briefing SHA-256 and packed terrain summary', () => {
    assert.ok(fs.existsSync(LIVE_SNAPSHOT));
    assert.ok(fs.existsSync(LIVE_REQUEST));
    const text = fs.readFileSync(LIVE_SNAPSHOT, 'utf8');
    const bytes = Buffer.from(text, 'utf8');
    const request = JSON.parse(fs.readFileSync(LIVE_REQUEST, 'utf8'));
    const result = verifyBriefingSnapshot({ request, snapshotBytes: bytes, yaml: YAML });
    assert.equal(result.digest, request.snapshot_sha256);

    const tiles = decodeTerrainTiles(result.tactical);
    assert.equal(tiles.length, 2218);
    const perZ = [];
    for (let z = 0; z < result.tactical.map.depth; z += 1) {
      const level = tiles.filter((t) => t.p[2] === z);
      perZ.push({
        z,
        discovered: level.length,
        inLos: level.filter((t) => t.inLos).length,
        offLos: level.filter((t) => !t.inLos).length,
      });
    }
    assert.equal(perZ.reduce((sum, row) => sum + row.discovered, 0), 2218);
    const inLosTotal = tiles.filter((t) => t.inLos).length;
    const offLosTotal = tiles.length - inLosTotal;
    assert.ok(inLosTotal > 0);
    assert.ok(offLosTotal > 0);

    for (const tile of tiles) {
      for (const forbidden of ['unit', 'occupancy', 'hidden', 'smoke', 'items']) {
        assert.ok(!(forbidden in tile), `forbidden field ${forbidden}`);
      }
    }

    const brief = buildTerrainBrief(result.tactical);
    assert.equal(brief.totalDiscoveredRecords, 2218);
    assert.ok(Buffer.byteLength(JSON.stringify(brief), 'utf8') <= 16 * 1024);
  });

  it('rejects incorrect recordCount on live-scale envelope shape', () => {
    const text = fs.readFileSync(LIVE_SNAPSHOT, 'utf8');
    const raw = YAML.parse(text);
    raw.terrain.recordCount = 9999;
    assert.throws(
      () => parseAndValidate(raw),
      (err) => err instanceof ValidationError || err instanceof PackedTerrainError,
    );
  });

  it('rejects invalid coordinates in packed blob', () => {
    const map = { width: 2, height: 2, depth: 1 };
    const blob = hexToBuffer(`
      ${headerHex(1, map)}
      05 00 00 04 00 03
    `);
    const raw = {
      schemaVersion: 5,
      turn: 1,
      side: 0,
      selectedUnitId: -1,
      map,
      units: [{ id: 1, faction: 1, originalFaction: 1, position: [0, 0, 0] }],
      eventLog: {
        sessionId: 'a1b2c3d4e5f6789012345678abcdef01',
        oldestSeq: 0,
        latestSeq: 0,
        droppedCount: 0,
        events: [],
      },
      terrain: {
        memoryNote: 'note',
        encoding: 'packed-v1',
        recordCount: 1,
        data: blob.toString('base64'),
      },
    };
    assert.throws(
      () => parseAndValidate(raw),
      (err) => (err instanceof ValidationError && /out of map bounds/.test(err.message))
        || (err instanceof PackedTerrainError && /out of map bounds/.test(err.message)),
    );
  });
});
