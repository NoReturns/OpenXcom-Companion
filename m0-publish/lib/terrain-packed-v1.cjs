'use strict';

/**
 * Open X-Com Companion — packed-v1 terrain blob decoder/validator (M1-17M).
 * See ../docs/terrain-packed-v1.md for the wire contract.
 */

const MAGIC = Buffer.from('OXT1', 'ascii');
const FORMAT_VERSION = 1;
const HEADER_BYTES = 18;

const DISC_WEST = 1;
const DISC_NORTH = 2;
const DISC_BODY = 4;

const TF_IN_LOS = 1;
const TF_WEST_SECTION = 2;
const TF_NORTH_SECTION = 4;
const TF_RESERVED_MASK = 0xf8;

const BF_AIR = 1;
const BF_NO_FLOOR = 2;
const BF_HAS_WALK_F = 4;
const BF_HAS_WALK_O = 8;
const BF_BLOCK_SIGHT_F = 16;
const BF_BLOCK_SIGHT_O = 32;
const BF_RESERVED_MASK = 0xc0;

const MIN_WALK_TU = 0;
const MAX_WALK_TU = 255;
const MIN_ELEV = -128;
const MAX_ELEV = 127;

/** Longest possible tile record (disc 7, full body, both walls). */
const MAX_TILE_RECORD_BYTES = 13;

class PackedTerrainError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PackedTerrainError';
  }
}

function assert(condition, message) {
  if (!condition) throw new PackedTerrainError(message);
}

function readU16LE(buf, offset) {
  return buf.readUInt16LE(offset);
}

function readU32LE(buf, offset) {
  return buf.readUInt32LE(offset);
}

function requireWalkTu(value, label) {
  assert(Number.isInteger(value) && value >= MIN_WALK_TU && value <= MAX_WALK_TU, `${label} must be ${MIN_WALK_TU}..${MAX_WALK_TU}`);
}

function decodeCanonicalBase64(text) {
  assert(typeof text === 'string', 'base64 input must be a string');
  assert(text.length > 0, 'base64 input must not be empty');
  assert(!/[\s]/.test(text), 'base64 must not contain whitespace');
  assert(text.length % 4 === 0, 'base64 length must be a multiple of 4');
  assert(/^[A-Za-z0-9+/]+={0,2}$/.test(text), 'base64 must use canonical alphabet and padding');
  const padMatch = text.match(/=+$/);
  const padLen = padMatch ? padMatch[0].length : 0;
  assert(padLen <= 2, 'invalid base64 padding');
  if (padLen > 0) {
    assert(text.indexOf('=') === text.length - padLen, 'base64 padding must only appear at end');
  }
  let decoded;
  try {
    decoded = Buffer.from(text, 'base64');
  } catch {
    throw new PackedTerrainError('base64 decode failed');
  }
  assert(decoded.toString('base64') === text, 'non-canonical base64 encoding');
  return decoded;
}

function validateHeader(buf, map) {
  assert(buf.length >= HEADER_BYTES, 'packed blob shorter than header');
  assert(buf.subarray(0, 4).equals(MAGIC), 'invalid packed terrain magic (expected OXT1)');
  assert(buf[4] === FORMAT_VERSION, `unsupported packed format version ${buf[4]}`);
  assert(buf[5] === 0, 'packed header flags must be zero');
  assert(buf[6] === 0 && buf[7] === 0, 'packed headerReserved must be zero');
  const mapWidth = readU16LE(buf, 8);
  const mapHeight = readU16LE(buf, 10);
  const mapDepth = buf[12];
  assert(buf[13] === 0, 'packed blobReserved must be zero');
  const recordCount = readU32LE(buf, 14);
  assert(mapWidth === map.width, 'packed mapWidth does not match snapshot map.width');
  assert(mapHeight === map.height, 'packed mapHeight does not match snapshot map.height');
  assert(mapDepth === map.depth, 'packed mapDepth does not match snapshot map.depth');
  assert(recordCount <= mapWidth * mapHeight * mapDepth, 'recordCount exceeds map volume');
  return { mapWidth, mapHeight, mapDepth, recordCount };
}

function parseBodySection(buf, offset, recordIndex) {
  const label = `record ${recordIndex} body`;
  assert(offset < buf.length, `${label}: missing bodyFlags`);
  const bodyFlags = buf[offset];
  offset += 1;
  assert((bodyFlags & BF_RESERVED_MASK) === 0, `${label}: reserved bodyFlags bits must be zero`);
  if ((bodyFlags & BF_AIR) !== 0) {
    assert((bodyFlags & BF_NO_FLOOR) !== 0, `${label}: air tiles require NO_FLOOR bodyFlag`);
    assert(
      (bodyFlags & (BF_HAS_WALK_F | BF_HAS_WALK_O | BF_BLOCK_SIGHT_F | BF_BLOCK_SIGHT_O)) === 0,
      `${label}: air tiles must not include walk or block flags`
    );
    return { body: { air: true, noFloor: true }, offset };
  }
  assert(offset < buf.length, `${label}: missing elev`);
  const elev = buf.readInt8(offset);
  offset += 1;
  assert(elev >= MIN_ELEV && elev <= MAX_ELEV, `${label}.elev out of supported range ${MIN_ELEV}..${MAX_ELEV}`);
  const body = {
    noFloor: (bodyFlags & BF_NO_FLOOR) !== 0,
    elev,
  };
  if ((bodyFlags & BF_HAS_WALK_F) !== 0) {
    assert(offset < buf.length, `${label}: missing walkF`);
    body.walkF = buf[offset];
    offset += 1;
    requireWalkTu(body.walkF, `${label}.walkF`);
    if ((bodyFlags & BF_BLOCK_SIGHT_F) !== 0) {
      body.blockSightF = true;
    }
  } else {
    assert((bodyFlags & BF_BLOCK_SIGHT_F) === 0, `${label}: blockSightF without walkF`);
  }
  if ((bodyFlags & BF_HAS_WALK_O) !== 0) {
    assert(offset < buf.length, `${label}: missing walkO`);
    body.walkO = buf[offset];
    offset += 1;
    requireWalkTu(body.walkO, `${label}.walkO`);
    if ((bodyFlags & BF_BLOCK_SIGHT_O) !== 0) {
      body.blockSightO = true;
    }
  } else {
    assert((bodyFlags & BF_BLOCK_SIGHT_O) === 0, `${label}: blockSightO without walkO`);
  }
  return { body, offset };
}

function parseWallSection(buf, offset, recordIndex, side) {
  const label = `record ${recordIndex} ${side}`;
  assert(offset + 1 < buf.length, `${label}: truncated wall section`);
  const walk = buf[offset];
  offset += 1;
  const wallFlags = buf[offset];
  offset += 1;
  assert((wallFlags & 0xfe) === 0, `${label}: reserved wallFlags bits must be zero`);
  requireWalkTu(walk, `${label}.walk`);
  const wall = { walk };
  if ((wallFlags & 1) !== 0) {
    wall.blockSight = true;
  }
  return { wall, offset };
}

function parseTileRecord(buf, offset, recordIndex, mapWidth, mapHeight, mapDepth) {
  const start = offset;
  assert(offset + 5 <= buf.length, `record ${recordIndex}: truncated prefix`);
  const x = buf[offset];
  const y = buf[offset + 1];
  const z = buf[offset + 2];
  const disc = buf[offset + 3];
  const tileFlags = buf[offset + 4];
  offset += 5;

  assert(x < mapWidth, `record ${recordIndex}: x out of map bounds`);
  assert(y < mapHeight, `record ${recordIndex}: y out of map bounds`);
  assert(z < mapDepth, `record ${recordIndex}: z out of map bounds`);
  assert(disc >= 1 && disc <= 7, `record ${recordIndex}: disc must be 1..7`);
  assert((tileFlags & TF_RESERVED_MASK) === 0, `record ${recordIndex}: reserved tileFlags bits must be zero`);

  const inLos = (tileFlags & TF_IN_LOS) !== 0;
  const westSection = (tileFlags & TF_WEST_SECTION) !== 0;
  const northSection = (tileFlags & TF_NORTH_SECTION) !== 0;

  assert(!westSection || (disc & DISC_WEST) !== 0, `record ${recordIndex}: west section without west discovery`);
  assert(!northSection || (disc & DISC_NORTH) !== 0, `record ${recordIndex}: north section without north discovery`);

  let body;
  if ((disc & DISC_BODY) !== 0) {
    ({ body, offset } = parseBodySection(buf, offset, recordIndex));
  }

  let west;
  if (westSection) {
    ({ wall: west, offset } = parseWallSection(buf, offset, recordIndex, 'west'));
  }

  let north;
  if (northSection) {
    ({ wall: north, offset } = parseWallSection(buf, offset, recordIndex, 'north'));
  }

  const recordBytes = offset - start;
  assert(recordBytes <= MAX_TILE_RECORD_BYTES, `record ${recordIndex}: exceeds max tile record size`);

  const tile = { p: [x, y, z], disc, inLos };
  if (body !== undefined) tile.body = body;
  if (west !== undefined) tile.west = west;
  if (north !== undefined) tile.north = north;
  return { tile, offset };
}

/**
 * Decode and validate a packed-v1 blob already base64-decoded or read from disk.
 * @param {Buffer} buf
 * @param {{ width: number, height: number, depth: number }} map
 * @param {{ expectedRecordCount?: number }} [options]
 * @returns {{ header: object, tiles: object[] }}
 */
function decodePackedV1Blob(buf, map, options = {}) {
  assert(Buffer.isBuffer(buf), 'blob must be a Buffer');
  assert(map && Number.isInteger(map.width) && Number.isInteger(map.height) && Number.isInteger(map.depth),
    'map width/height/depth required');
  const header = validateHeader(buf, map);
  if (options.expectedRecordCount !== undefined) {
    assert(header.recordCount === options.expectedRecordCount,
      'recordCount does not match terrain.recordCount');
  }
  const maxBlobBytes = HEADER_BYTES + header.recordCount * MAX_TILE_RECORD_BYTES;
  assert(buf.length <= maxBlobBytes, 'packed blob exceeds theoretical maximum size for recordCount');

  const tiles = [];
  const seen = new Set();
  let offset = HEADER_BYTES;
  let prevSortKey = null;

  for (let i = 0; i < header.recordCount; i += 1) {
    const { tile, offset: nextOffset } = parseTileRecord(
      buf,
      offset,
      i,
      header.mapWidth,
      header.mapHeight,
      header.mapDepth
    );
    offset = nextOffset;
    const key = `${tile.p[0]},${tile.p[1]},${tile.p[2]}`;
    assert(!seen.has(key), `record ${i}: duplicate tile position`);
    seen.add(key);
    const sortKey = tile.p[2] * header.mapWidth * header.mapHeight + tile.p[1] * header.mapWidth + tile.p[0];
    if (prevSortKey !== null) {
      assert(sortKey >= prevSortKey, `record ${i}: tiles must be sorted by z, then y, then x`);
    }
    prevSortKey = sortKey;
    tiles.push(tile);
  }

  assert(offset === buf.length, 'packed blob has trailing bytes after last record');
  return { header, tiles };
}

function decodePackedV1Base64(base64Text, map, options = {}) {
  const buf = decodeCanonicalBase64(base64Text);
  return decodePackedV1Blob(buf, map, options);
}

/** Worst-case raw blob bytes for a grid where every cell exports a heavy record. */
function worstCaseBlobBytes(cellCount) {
  assert(Number.isInteger(cellCount) && cellCount >= 0, 'cellCount must be a non-negative integer');
  return HEADER_BYTES + cellCount * MAX_TILE_RECORD_BYTES;
}

/** Approximate base64 length for a raw byte length (no YAML wrapper). */
function base64EncodedLength(rawBytes) {
  assert(Number.isInteger(rawBytes) && rawBytes >= 0, 'rawBytes must be non-negative');
  return Math.ceil(rawBytes / 3) * 4;
}

/** Maximum canonical base64 length for packed `terrain.data` on a map (worst-case blob for full volume). */
function maxPackedTerrainDataBase64Length(map) {
  assert(map && Number.isInteger(map.width) && Number.isInteger(map.height) && Number.isInteger(map.depth),
    'map width/height/depth required');
  const volume = map.width * map.height * map.depth;
  assert(volume >= 0, 'map volume invalid');
  return base64EncodedLength(worstCaseBlobBytes(volume));
}

module.exports = {
  PackedTerrainError,
  MAGIC,
  FORMAT_VERSION,
  HEADER_BYTES,
  MAX_TILE_RECORD_BYTES,
  DISC_WEST,
  DISC_NORTH,
  DISC_BODY,
  decodeCanonicalBase64,
  decodePackedV1Blob,
  decodePackedV1Base64,
  worstCaseBlobBytes,
  base64EncodedLength,
  maxPackedTerrainDataBase64Length,
};
