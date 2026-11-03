'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const {
  parseAndValidate,
  loadAndValidateSnapshotFromText,
  buildRelayPayload,
  computeSnapshotId,
} = require('../lib/tactical-publish.cjs');
const { buildTerrainBrief } = require('../lib/terrain-brief.cjs');
const { decodePackedV1Blob } = require('../lib/terrain-packed-v1.cjs');

const FIXTURE_V5_VERBOSE = path.join(__dirname, 'fixtures', 'valid-v5.yaml');

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

describe('packed-v1 tactical validation', () => {
  it('accepts valid packed terrain envelope', () => {
    const map = { width: 3, height: 3, depth: 1 };
    const blob = hexToBuffer(`
      ${headerHex(1, map)}
      02 01 00 04 01
      04 fe 04
    `);
    const raw = YAML.parse(fs.readFileSync(FIXTURE_V5_VERBOSE, 'utf8'));
    raw.terrain = {
      memoryNote: raw.terrain.memoryNote,
      encoding: 'packed-v1',
      recordCount: 1,
      data: blob.toString('base64'),
    };
    raw.map = map;
    raw.units = raw.units.slice(0, 1);
    const tactical = parseAndValidate(raw);
    assert.equal(tactical.terrain.encoding, 'packed-v1');
    assert.equal(tactical.terrain.recordCount, 1);
  });

  it('rejects mixed verbose tiles and packed fields', () => {
    const raw = YAML.parse(fs.readFileSync(FIXTURE_V5_VERBOSE, 'utf8'));
    raw.terrain.encoding = 'packed-v1';
    raw.terrain.recordCount = 1;
    raw.terrain.data = 'AAAA';
    assert.throws(() => parseAndValidate(raw), /mutually exclusive/);
  });

  it('rejects invalid packed base64', () => {
    const raw = YAML.parse(fs.readFileSync(FIXTURE_V5_VERBOSE, 'utf8'));
    raw.terrain = {
      memoryNote: raw.terrain.memoryNote,
      encoding: 'packed-v1',
      recordCount: 1,
      data: '!!!',
    };
    assert.throws(() => parseAndValidate(raw), /base64/);
  });
});

describe('terrainBrief relay integration', () => {
  it('adds terrainBrief without changing snapshot_id', () => {
    const text = fs.readFileSync(FIXTURE_V5_VERBOSE, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(text, YAML);
    const snapshotId = computeSnapshotId(tactical);
    const relay = buildRelayPayload(tactical, '2026-01-01T00:00:00.000Z');
    assert.equal(relay.snapshot_id, snapshotId);
    assert.ok(relay.terrainBrief);
    assert.equal(relay.terrainBrief.totalDiscoveredRecords, 2);
  });

  it('builds bounded terrainBrief from packed terrain', () => {
    const map = { width: 10, height: 10, depth: 2 };
    const blob = hexToBuffer(`
      ${headerHex(1, map)}
      01 02 00 04 01
      04 00 04
    `);
    const tactical = {
      schemaVersion: 5,
      turn: 1,
      side: 0,
      selectedUnitId: 1,
      map,
      units: [{
        id: 1,
        faction: 0,
        originalFaction: 0,
        position: [1, 2, 0],
        name: 'Test Soldier',
        health: 40,
        timeUnits: 50,
      }],
      terrain: {
        memoryNote: 'note',
        encoding: 'packed-v1',
        recordCount: 1,
        data: blob.toString('base64'),
      },
    };
    const brief = buildTerrainBrief(tactical);
    assert.equal(brief.totalDiscoveredRecords, 1);
    assert.ok(Buffer.byteLength(JSON.stringify(brief), 'utf8') <= 16 * 1024);
    const decoded = decodePackedV1Blob(blob, map);
    assert.equal(decoded.tiles[0].p.join(','), '1,2,0');
  });
});
