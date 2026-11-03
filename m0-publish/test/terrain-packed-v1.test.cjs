'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  PackedTerrainError,
  HEADER_BYTES,
  MAX_TILE_RECORD_BYTES,
  decodePackedV1Blob,
  decodePackedV1Base64,
  decodeCanonicalBase64,
  worstCaseBlobBytes,
  base64EncodedLength,
} = require('../lib/terrain-packed-v1.cjs');

function hexToBuffer(hexText) {
  const cleaned = hexText.replace(/\s+/g, '');
  assert.equal(cleaned.length % 2, 0, 'hex fixture must have even length');
  return Buffer.from(cleaned, 'hex');
}

/** 18-byte header: map dimensions and recordCount (LE). */
function headerHex(recordCount, map = { width: 3, height: 3, depth: 1 }) {
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

describe('packed-v1 contract constants', () => {
  it('records maximum tile record size', () => {
    assert.equal(MAX_TILE_RECORD_BYTES, 13);
    assert.equal(HEADER_BYTES, 18);
    assert.equal(worstCaseBlobBytes(10_000), 18 + 10_000 * 13);
    assert.equal(base64EncodedLength(worstCaseBlobBytes(10_000)), 173_360);
    assert.equal(worstCaseBlobBytes(14_400), 187_218);
    assert.equal(base64EncodedLength(worstCaseBlobBytes(14_400)), 249_624);
  });
});

describe('packed-v1 golden vectors (hex fixtures)', () => {
  const map331 = { width: 3, height: 3, depth: 1 };

  it('decodes discovered body with negative elevation', () => {
    const blob = hexToBuffer(`
      ${headerHex(1)}
      02 01 00 04 01
      04 fe 04
    `);
    const { tiles } = decodePackedV1Blob(blob, map331);
    assert.equal(tiles.length, 1);
    assert.deepEqual(tiles[0].p, [2, 1, 0]);
    assert.equal(tiles[0].disc, 4);
    assert.equal(tiles[0].inLos, true);
    assert.deepEqual(tiles[0].body, { noFloor: false, elev: -2, walkF: 4 });
    assert.equal(tiles[0].west, undefined);
    assert.equal(tiles[0].north, undefined);
  });

  it('decodes discovered empty air', () => {
    const map = { width: 1, height: 1, depth: 2 };
    const blob = hexToBuffer(`
      ${headerHex(1, map)}
      00 00 01 04 00
      03
    `);
    const { tiles } = decodePackedV1Blob(blob, map);
    assert.deepEqual(tiles[0].body, { air: true, noFloor: true });
  });

  it('decodes west-only wall section', () => {
    const map = { width: 2, height: 2, depth: 1 };
    const blob = hexToBuffer(`
      ${headerHex(1, map)}
      01 00 00 01 02
      ff 01
    `);
    const { tiles } = decodePackedV1Blob(blob, map);
    assert.equal(tiles[0].disc, 1);
    assert.equal(tiles[0].inLos, false);
    assert.deepEqual(tiles[0].west, { walk: 255, blockSight: true });
    assert.equal(tiles[0].body, undefined);
  });

  it('decodes north-only wall section', () => {
    const map = { width: 2, height: 2, depth: 1 };
    const blob = hexToBuffer(`
      ${headerHex(1, map)}
      00 01 00 02 04
      08 00
    `);
    const { tiles } = decodePackedV1Blob(blob, map);
    assert.deepEqual(tiles[0].north, { walk: 8 });
  });

  it('allows discovered west without geometry section', () => {
    const map = { width: 2, height: 2, depth: 1 };
    const blob = hexToBuffer(`
      ${headerHex(1, map)}
      01 00 00 01 00
    `);
    const { tiles } = decodePackedV1Blob(blob, map);
    assert.equal(tiles[0].disc, 1);
    assert.equal(tiles[0].west, undefined);
  });

  it('decodes full body plus both walls', () => {
    const map = { width: 3, height: 3, depth: 1 };
    const blob = hexToBuffer(`
      ${headerHex(1, map)}
      02 01 00 07 07
      2c 00 04 ff
      ff 01
      08 00
    `);
    const { tiles } = decodePackedV1Blob(blob, map);
    assert.deepEqual(tiles[0].body, {
      noFloor: false,
      elev: 0,
      walkF: 4,
      walkO: 255,
      blockSightO: true,
    });
    assert.deepEqual(tiles[0].west, { walk: 255, blockSight: true });
    assert.deepEqual(tiles[0].north, { walk: 8 });
  });

  it('rejects body discovery without body section bytes', () => {
    const blob = hexToBuffer(`
      ${headerHex(1)}
      00 00 00 04 00
    `);
    assert.throws(
      () => decodePackedV1Blob(blob, map331),
      (err) => err instanceof PackedTerrainError && /missing bodyFlags/.test(err.message)
    );
  });

  it('rejects invalid magic', () => {
    const blob = hexToBuffer(`
      00000000 01 00 0000 0300 0300 01 00 01000000
      00 00 00 04 00 03
    `);
    assert.throws(
      () => decodePackedV1Blob(blob, map331),
      (err) => err instanceof PackedTerrainError && /magic/.test(err.message)
    );
  });

  it('rejects invalid west section without discovery bit', () => {
    const blob = hexToBuffer(`
      ${headerHex(1)}
      00 00 00 04 02
      03
    `);
    assert.throws(
      () => decodePackedV1Blob(blob, map331),
      (err) => err instanceof PackedTerrainError && /west section without west discovery/.test(err.message)
    );
  });

  it('rejects truncated record', () => {
    const blob = hexToBuffer(`
      ${headerHex(1)}
      02 01 00 04 01
      04
    `);
    assert.throws(
      () => decodePackedV1Blob(blob, map331),
      (err) => err instanceof PackedTerrainError && /missing elev/.test(err.message)
    );
  });

  it('rejects duplicate positions', () => {
    const blob = hexToBuffer(`
      ${headerHex(2)}
      00 00 00 04 00 03
      00 00 00 04 00 03
    `);
    assert.throws(
      () => decodePackedV1Blob(blob, map331),
      (err) => err instanceof PackedTerrainError && /duplicate tile position/.test(err.message)
    );
  });

  it('rejects out-of-order positions', () => {
    const blob = hexToBuffer(`
      ${headerHex(2)}
      01 00 00 04 00 03
      00 00 00 04 00 03
    `);
    assert.throws(
      () => decodePackedV1Blob(blob, map331),
      (err) => err instanceof PackedTerrainError && /sorted by z/.test(err.message)
    );
  });

  it('rejects trailing bytes after last record', () => {
    const blob = hexToBuffer(`
      ${headerHex(1)}
      02 01 00 04 01
      04 fe 04
      aa
    `);
    assert.throws(
      () => decodePackedV1Blob(blob, map331),
      (err) => err instanceof PackedTerrainError && /trailing bytes/.test(err.message)
    );
  });

  it('rejects reserved tileFlags bits', () => {
    const blob = hexToBuffer(`
      ${headerHex(1)}
      02 01 00 04 80
      03
    `);
    assert.throws(
      () => decodePackedV1Blob(blob, map331),
      (err) => err instanceof PackedTerrainError && /reserved tileFlags/.test(err.message)
    );
  });
});

describe('packed-v1 base64', () => {
  it('round-trips canonical base64', () => {
    const blob = hexToBuffer(`
      ${headerHex(1)}
      02 01 00 04 01
      04 fe 04
    `);
    const b64 = blob.toString('base64');
    const decoded = decodePackedV1Base64(b64, { width: 3, height: 3, depth: 1 });
    assert.equal(decoded.tiles[0].body.elev, -2);
  });

  it('rejects whitespace in base64', () => {
    const blob = hexToBuffer(`
      ${headerHex(1)}
      02 01 00 04 01
      04 fe 04
    `);
    const b64 = `${blob.toString('base64').slice(0, 4)} ${blob.toString('base64').slice(4)}`;
    assert.throws(() => decodeCanonicalBase64(b64), /whitespace/);
  });
});

describe('decoded record integrity', () => {
  it('does not expose hidden occupancy or extra fields', () => {
    const blob = hexToBuffer(`
      ${headerHex(1)}
      02 01 00 07 07
      2c 00 04 ff
      ff 01
      08 00
    `);
    const { tiles } = decodePackedV1Blob(blob, { width: 3, height: 3, depth: 1 });
    assert.deepEqual(Object.keys(tiles[0]).sort(), ['body', 'disc', 'inLos', 'north', 'p', 'west']);
  });
});
