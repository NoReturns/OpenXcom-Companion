'use strict';

/**
 * sparse-v1 terrain semantics decoder (M1-WP1).
 * See ../docs/terrain-semantics-sparse-v1.md
 */

const MAGIC = Buffer.from('OXTS', 'ascii');
const FORMAT_VERSION = 1;
const HEADER_BYTES = 12;
const MAX_RECORD_BYTES = 7;

const PART_BODY = 1;
const PART_WEST = 2;
const PART_NORTH = 4;

/** Numeric ids mirrored from CompanionSnapshotTerrainSemantics.h */
const CATEGORY_BY_ID = Object.freeze({
  0: 'UNKNOWN',
  1: 'ORDINARY',
  2: 'ORDINARY_IMPASSABLE',
  3: 'UFO_STRUCTURE',
  4: 'UFO_INTERIOR',
  5: 'UFO_DOOR',
  6: 'ORDINARY_DOOR',
  7: 'ENTRANCE',
  8: 'GRAV_LIFT',
  9: 'XCOM_CRAFT',
  10: 'XCOM_BASE_MODULE',
});

const ALLOWED_CATEGORY_IDS = new Set(Object.keys(CATEGORY_BY_ID).map(Number));

class SparseSemanticsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SparseSemanticsError';
  }
}

function assert(condition, message) {
  if (!condition) throw new SparseSemanticsError(message);
}

function decodeCanonicalBase64(text) {
  assert(typeof text === 'string' && text.length > 0, 'semantics base64 required');
  assert(!/[\s]/.test(text), 'semantics base64 must not contain whitespace');
  const decoded = Buffer.from(text, 'base64');
  assert(decoded.toString('base64') === text, 'non-canonical semantics base64');
  return decoded;
}

function tileKey(p) {
  return `${p[0]},${p[1]},${p[2]}`;
}

function decodeSparseV1Base64(dataBase64, { expectedRecordCount } = {}) {
  const buf = decodeCanonicalBase64(dataBase64);
  assert(buf.length >= HEADER_BYTES, 'semantics blob shorter than header');
  assert(buf.subarray(0, 4).equals(MAGIC), 'invalid semantics magic (expected OXTS)');
  assert(buf[4] === FORMAT_VERSION, `unsupported semantics format version ${buf[4]}`);
  assert(buf[5] === 0 && buf[6] === 0 && buf[7] === 0, 'semantics header reserved must be zero');
  const recordCount = buf.readUInt32LE(8);
  if (expectedRecordCount !== undefined) {
    assert(recordCount === expectedRecordCount, 'semantics recordCount mismatch');
  }

  const byPos = new Map();
  let offset = HEADER_BYTES;
  for (let i = 0; i < recordCount; i += 1) {
    assert(offset + 4 <= buf.length, 'truncated semantics record header');
    const x = buf[offset];
    const y = buf[offset + 1];
    const z = buf[offset + 2];
    const partFlags = buf[offset + 3];
    offset += 4;
    const sem = {};
    if (partFlags & PART_BODY) {
      assert(offset < buf.length, 'truncated semantics body category');
      const id = buf[offset];
      assert(ALLOWED_CATEGORY_IDS.has(id), `invalid semantics body category ${id}`);
      sem.body = id;
      offset += 1;
    }
    if (partFlags & PART_WEST) {
      assert(offset < buf.length, 'truncated semantics west category');
      const id = buf[offset];
      assert(ALLOWED_CATEGORY_IDS.has(id), `invalid semantics west category ${id}`);
      sem.west = id;
      offset += 1;
    }
    if (partFlags & PART_NORTH) {
      assert(offset < buf.length, 'truncated semantics north category');
      const id = buf[offset];
      assert(ALLOWED_CATEGORY_IDS.has(id), `invalid semantics north category ${id}`);
      sem.north = id;
      offset += 1;
    }
    const recordLen = 4
      + (sem.body !== undefined ? 1 : 0)
      + (sem.west !== undefined ? 1 : 0)
      + (sem.north !== undefined ? 1 : 0);
    assert(recordLen <= MAX_RECORD_BYTES, 'semantics record too long');
    byPos.set(tileKey([x, y, z]), { p: [x, y, z], sem });
  }
  assert(offset === buf.length, 'trailing semantics bytes');
  return { recordCount, byPos };
}

function categoryLabel(id) {
  return CATEGORY_BY_ID[id] ?? 'UNKNOWN';
}

function attachSemanticsToTiles(tiles, semanticsByPos) {
  if (!semanticsByPos || semanticsByPos.size === 0) {
    return tiles;
  }
  return tiles.map((tile) => {
    const entry = semanticsByPos.get(tileKey(tile.p));
    if (!entry) {
      return tile;
    }
    return { ...tile, sem: entry.sem };
  });
}

module.exports = {
  CATEGORY_BY_ID,
  categoryLabel,
  decodeSparseV1Base64,
  attachSemanticsToTiles,
  SparseSemanticsError,
};
