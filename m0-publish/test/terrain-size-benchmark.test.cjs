'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { HEADER_BYTES, MAX_TILE_RECORD_BYTES, worstCaseBlobBytes, base64EncodedLength } = require('../lib/terrain-packed-v1.cjs');
const { MAX_INPUT_BYTES } = require('../lib/tactical-publish.cjs');

function estimatePackedV5YamlBytes(map, recordCount, nonTerrainBytes) {
  const rawBlob = HEADER_BYTES + recordCount * MAX_TILE_RECORD_BYTES;
  const dataField = base64EncodedLength(rawBlob);
  const envelope = 120 + dataField;
  return nonTerrainBytes + envelope;
}

describe('packed terrain size projections (M1-17N)', () => {
  const nonTerrainBytes = 12_000;

  it('fits 50x50x4 worst-case heavy records under cap with typical non-terrain payload', () => {
    const cells = 50 * 50 * 4;
    const yamlBytes = estimatePackedV5YamlBytes({ width: 50, height: 50, depth: 4 }, cells, nonTerrainBytes);
    assert.ok(yamlBytes < MAX_INPUT_BYTES, `expected under cap, got ${yamlBytes}`);
  });

  it('matches contract math for 60x60x4 worst-case blob', () => {
    const cells = 60 * 60 * 4;
    assert.equal(worstCaseBlobBytes(cells), 18 + cells * 13);
    assert.equal(base64EncodedLength(worstCaseBlobBytes(cells)), 249_624);
  });

  it('still exceeds cap for full 100x100x2 dense worst-case records', () => {
    const recordCount = 100 * 100 * 2;
    const yamlBytes = estimatePackedV5YamlBytes({ width: 100, height: 100, depth: 2 }, recordCount, nonTerrainBytes);
    assert.ok(yamlBytes > MAX_INPUT_BYTES, `expected over cap, got ${yamlBytes}`);
  });
});
