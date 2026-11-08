'use strict';

/**
 * sparse-v2 terrain semantics decoder (M1-WP8).
 * Extends sparse-v1 with discovered off-LOS structure categories and in-LOS door open bits.
 * See ../docs/terrain-semantics-sparse-v2.md
 */

const {
  CATEGORY_BY_ID,
  categoryLabel,
  decodeSparseV1Base64,
  SparseSemanticsError,
} = require('./terrain-semantics-sparse-v1.cjs');

const FORMAT_VERSION_V2 = 2;
const MAX_RECORD_BYTES_V2 = 8;

const PART_BODY = 1;
const PART_WEST = 2;
const PART_NORTH = 4;

const META_IN_LOS = 1;
const META_BODY_DOOR_OPEN = 2;
const META_WEST_DOOR_OPEN = 4;
const META_NORTH_DOOR_OPEN = 8;
const META_FLOOR_GRAV_LIFT = 16;

function assert(condition, message) {
  if (!condition) throw new SparseSemanticsError(message);
}

function decodeSparseV2Base64(dataBase64, { expectedRecordCount } = {}) {
  const buf = decodeCanonicalBase64(dataBase64);
  assertBlob(buf, expectedRecordCount);

  const byPos = new Map();
  let offset = 12;
  const recordCount = buf.readUInt32LE(8);
  for (let i = 0; i < recordCount; i += 1) {
    assert(offset + 5 <= buf.length, 'truncated sparse-v2 record');
    const x = buf[offset];
    const y = buf[offset + 1];
    const z = buf[offset + 2];
    const partFlags = buf[offset + 3];
    offset += 4;
    const sem = {};
    if (partFlags & PART_BODY) {
      sem.body = readCategory(buf, offset, 'body');
      offset += 1;
    }
    if (partFlags & PART_WEST) {
      sem.west = readCategory(buf, offset, 'west');
      offset += 1;
    }
    if (partFlags & PART_NORTH) {
      sem.north = readCategory(buf, offset, 'north');
      offset += 1;
    }
    const meta = buf[offset];
    offset += 1;
    const recordLen = 5
      + (sem.body !== undefined ? 1 : 0)
      + (sem.west !== undefined ? 1 : 0)
      + (sem.north !== undefined ? 1 : 0);
    assert(recordLen <= MAX_RECORD_BYTES_V2, 'sparse-v2 record too long');

    const inLos = (meta & META_IN_LOS) !== 0;
    const floorGravLift = (meta & META_FLOOR_GRAV_LIFT) !== 0;
    const doorState = {};
    if (inLos && sem.body !== undefined && isDoorCategory(sem.body)) {
      doorState.body = (meta & META_BODY_DOOR_OPEN) !== 0 ? 'open' : 'closed';
    }
    if (inLos && sem.west !== undefined && isDoorCategory(sem.west)) {
      doorState.west = (meta & META_WEST_DOOR_OPEN) !== 0 ? 'open' : 'closed';
    }
    if (inLos && sem.north !== undefined && isDoorCategory(sem.north)) {
      doorState.north = (meta & META_NORTH_DOOR_OPEN) !== 0 ? 'open' : 'closed';
    }

    byPos.set(tileKey([x, y, z]), {
      p: [x, y, z],
      sem,
      structureMeta: {
        inLosAtExport: inLos,
        ...(floorGravLift ? { floorGravLift: true } : {}),
        ...(Object.keys(doorState).length ? { doorState } : {}),
      },
    });
  }
  assert(offset === buf.length, 'trailing sparse-v2 bytes');
  return { recordCount, byPos };
}

function decodeCanonicalBase64(text) {
  if (typeof text !== 'string' || text.length === 0) {
    throw new SparseSemanticsError('semantics base64 required');
  }
  if (/[\s]/.test(text)) {
    throw new SparseSemanticsError('semantics base64 must not contain whitespace');
  }
  const decoded = Buffer.from(text, 'base64');
  if (decoded.toString('base64') !== text) {
    throw new SparseSemanticsError('non-canonical semantics base64');
  }
  return decoded;
}

function assertBlob(buf, expectedRecordCount) {
  if (buf.length < 12) throw new SparseSemanticsError('semantics blob shorter than header');
  if (!buf.subarray(0, 4).equals(Buffer.from('OXTS', 'ascii'))) {
    throw new SparseSemanticsError('invalid semantics magic (expected OXTS)');
  }
  if (buf[4] !== FORMAT_VERSION_V2) {
    throw new SparseSemanticsError(`unsupported semantics format version ${buf[4]} (expected sparse-v2)`);
  }
  if (buf[5] !== 0 || buf[6] !== 0 || buf[7] !== 0) {
    throw new SparseSemanticsError('semantics header reserved must be zero');
  }
  const recordCount = buf.readUInt32LE(8);
  if (expectedRecordCount !== undefined && recordCount !== expectedRecordCount) {
    throw new SparseSemanticsError('semantics recordCount mismatch');
  }
}

function readCategory(buf, offset, part) {
  if (offset >= buf.length) {
    throw new SparseSemanticsError(`truncated semantics ${part} category`);
  }
  const id = buf[offset];
  if (!Object.prototype.hasOwnProperty.call(CATEGORY_BY_ID, id)) {
    throw new SparseSemanticsError(`invalid semantics ${part} category ${id}`);
  }
  return id;
}

function isDoorCategory(id) {
  return id === 5 || id === 6;
}

function tileKey(p) {
  return `${p[0]},${p[1]},${p[2]}`;
}

function decodeSparseSemanticsBase64(dataBase64, encoding, options = {}) {
  if (encoding === 'sparse-v1') {
    const v1 = decodeSparseV1Base64(dataBase64, options);
    return {
      recordCount: v1.recordCount,
      byPos: v1.byPos,
      encoding: 'sparse-v1',
    };
  }
  if (encoding === 'sparse-v2') {
    const v2 = decodeSparseV2Base64(dataBase64, options);
    return {
      recordCount: v2.recordCount,
      byPos: v2.byPos,
      encoding: 'sparse-v2',
    };
  }
  throw new SparseSemanticsError(`unsupported semantics encoding ${encoding}`);
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
    return {
      ...tile,
      sem: entry.sem,
      ...(entry.structureMeta ? { structureMeta: entry.structureMeta } : {}),
    };
  });
}

module.exports = {
  decodeSparseV2Base64,
  decodeSparseSemanticsBase64,
  attachSemanticsToTiles,
  isDoorCategory,
};
