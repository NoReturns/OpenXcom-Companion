'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const {
  ValidationError,
  loadAndValidateSnapshotFromText,
  parseAndValidate,
  maxPackedTerrainDataBase64Length,
} = require('../lib/tactical-publish.cjs');
const { verifyBriefingSnapshot, sha256HexLower } = require('../lib/briefing-snapshot.cjs');
const { buildTerrainBrief, decodeTerrainTiles } = require('../lib/terrain-brief.cjs');
const { PackedTerrainError } = require('../lib/terrain-packed-v1.cjs');

const FIXTURE_V5 = path.join(__dirname, 'fixtures', 'valid-v5.yaml');

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

function packedRegressionSnapshot() {
  const map = { width: 3, height: 3, depth: 1 };
  const blob = hexToBuffer(`
    ${headerHex(1, map)}
    02 01 00 07 01
    04 fe 04
  `);
  const raw = YAML.parse(fs.readFileSync(FIXTURE_V5, 'utf8'));
  raw.map = map;
  raw.units = raw.units.slice(0, 1);
  raw.terrain = {
    memoryNote: raw.terrain.memoryNote,
    encoding: 'packed-v1',
    recordCount: 1,
    data: blob.toString('base64'),
  };
  return { map, raw, text: YAML.stringify(raw) };
}

describe('terrain.data max length (M1-17O)', () => {
  const map5050x4 = { width: 50, height: 50, depth: 4 };

  it('documents map-derived max for 50x50x4 (not the old 256-char default)', () => {
    const maxLen = maxPackedTerrainDataBase64Length(map5050x4);
    assert.equal(maxLen, 173_360);
    assert.ok(20_968 <= maxLen, 'representative live-scale data length must fit map-derived cap');
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

  it('regression M1-17O: fixture packed snapshot validates and recordCount matches decode', () => {
    const { map, text } = packedRegressionSnapshot();
    const tactical = loadAndValidateSnapshotFromText(text, YAML);
    assert.equal(tactical.terrain.encoding, 'packed-v1');
    const tiles = decodeTerrainTiles(tactical);
    assert.equal(tactical.terrain.recordCount, tiles.length);
    assert.ok(tactical.terrain.data.length <= maxPackedTerrainDataBase64Length(map));
  });
});

describe('briefing SHA and packed terrain summary (M1-17O fixtures)', () => {
  it('verifies briefing SHA-256 and packed terrain summary from deterministic fixture', () => {
    const { text } = packedRegressionSnapshot();
    const bytes = Buffer.from(text, 'utf8');
    const request = {
      snapshot_sha256: sha256HexLower(bytes),
      turn: 1,
      session_id: 'a1b2c3d4e5f6789012345678abcdef01',
    };
    const result = verifyBriefingSnapshot({ request, snapshotBytes: bytes, yaml: YAML });
    assert.equal(result.digest, request.snapshot_sha256);

    const tiles = decodeTerrainTiles(result.tactical);
    assert.equal(tiles.length, result.tactical.terrain.recordCount);
    const inLosTotal = tiles.filter((t) => t.inLos).length;
    const offLosTotal = tiles.length - inLosTotal;
    assert.ok(inLosTotal + offLosTotal === tiles.length);

    for (const tile of tiles) {
      for (const forbidden of ['unit', 'occupancy', 'hidden', 'smoke', 'items']) {
        assert.ok(!(forbidden in tile), `forbidden field ${forbidden}`);
      }
    }

    const brief = buildTerrainBrief(result.tactical);
    assert.equal(brief.totalDiscoveredRecords, tiles.length);
    assert.ok(Buffer.byteLength(JSON.stringify(brief), 'utf8') <= 16 * 1024);
  });

  it('rejects incorrect recordCount on packed fixture envelope', () => {
    const { raw } = packedRegressionSnapshot();
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
