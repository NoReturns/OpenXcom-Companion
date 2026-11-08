'use strict';

const { ValidationError } = require('./tactical-publish.cjs');
const {
  classifyDiscoveredTile,
  decodeTerrainTiles,
  VIS_CURRENT,
  VIS_DISCOVERED_OFF_LOS,
} = require('./terrain-brief.cjs');
const { computeSnapshotId } = require('./tactical-publish.cjs');

const MAX_QUERY_RADIUS = 12;
const MAX_RECT_SIDE = 25;
const MAX_RESPONSE_BYTES = 8 * 1024;
const VIS_UNKNOWN = 'UNKNOWN';

function assert(condition, message) {
  if (!condition) throw new ValidationError(message);
}

function indexTiles(tiles) {
  const map = new Map();
  for (const tile of tiles) {
    map.set(tile.p.join(','), tile);
  }
  return map;
}

function validateQueryRequest(request) {
  assert(isPlainObject(request), 'terrain query must be an object');
  assert(typeof request.snapshot_id === 'string' && /^[a-f0-9]{64}$/.test(request.snapshot_id),
    'snapshot_id must be 64-char lowercase hex sha256');
  assert(typeof request.center === 'object' && request.center !== null, 'center required');
  assertNumberInRange(request.center.x, 'center.x', 0, 255);
  assertNumberInRange(request.center.y, 'center.y', 0, 255);
  assertNumberInRange(request.center.z, 'center.z', 0, 255);
  if (request.radius !== undefined) {
    assertNumberInRange(request.radius, 'radius', 0, MAX_QUERY_RADIUS);
  }
  if (request.rectangle !== undefined) {
    assert(isPlainObject(request.rectangle), 'rectangle must be object');
    assertNumberInRange(request.rectangle.x0, 'rectangle.x0', 0, 255);
    assertNumberInRange(request.rectangle.y0, 'rectangle.y0', 0, 255);
    assertNumberInRange(request.rectangle.x1, 'rectangle.x1', 0, 255);
    assertNumberInRange(request.rectangle.y1, 'rectangle.y1', 0, 255);
    assert(request.rectangle.x0 <= request.rectangle.x1, 'rectangle x0 must be <= x1');
    assert(request.rectangle.y0 <= request.rectangle.y1, 'rectangle y0 must be <= y1');
    assert((request.rectangle.x1 - request.rectangle.x0 + 1) <= MAX_RECT_SIDE, 'rectangle width exceeds max');
    assert((request.rectangle.y1 - request.rectangle.y0 + 1) <= MAX_RECT_SIDE, 'rectangle height exceeds max');
  }
  assert(request.radius !== undefined || request.rectangle !== undefined,
    'radius or rectangle required');
  if (request.zMin !== undefined) assertNumberInRange(request.zMin, 'zMin', 0, 255);
  if (request.zMax !== undefined) assertNumberInRange(request.zMax, 'zMax', 0, 255);
  if (request.zMin !== undefined && request.zMax !== undefined) {
    assert(request.zMin <= request.zMax, 'zMin must be <= zMax');
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertNumberInRange(value, label, min, max) {
  assert(Number.isInteger(value) && value >= min && value <= max, `${label} must be integer ${min}..${max}`);
}

function cellInQuery(p, center, radius, rectangle, zMin, zMax) {
  if (p[2] < zMin || p[2] > zMax) return false;
  if (rectangle) {
    return p[0] >= rectangle.x0 && p[0] <= rectangle.x1
      && p[1] >= rectangle.y0 && p[1] <= rectangle.y1;
  }
  const md = Math.abs(p[0] - center.x) + Math.abs(p[1] - center.y) + Math.abs(p[2] - center.z);
  return md <= radius;
}

function tileToQueryCell(tile) {
  const classified = classifyDiscoveredTile(tile);
  return {
    p: tile.p,
    visibility: classified.visibility,
    observationNote: classified.visibility === VIS_DISCOVERED_OFF_LOS
      ? 'discovered_structure_identity_off_los_door_state_redacted'
      : (classified.visibility === VIS_CURRENT ? 'currently_in_player_los_at_export' : undefined),
    disc: tile.disc,
    ...(classified.terrainSemantics.length
      ? { terrainSemantics: classified.terrainSemantics }
      : {}),
    ...(classified.structureFacets?.length
      ? { structureFacets: classified.structureFacets }
      : {}),
    ...(tile.body ? { body: tile.body } : {}),
    ...(tile.west ? { west: tile.west } : {}),
    ...(tile.north ? { north: tile.north } : {}),
  };
}

function executeTerrainQuery(tactical, request) {
  validateQueryRequest(request);
  const expectedId = computeSnapshotId(tactical);
  assert(request.snapshot_id === expectedId, 'snapshot_id does not match tactical snapshot');

  const { map } = tactical;
  assert(request.center.x < map.width && request.center.y < map.height && request.center.z < map.depth,
    'center out of map bounds');

  const zMin = request.zMin ?? 0;
  const zMax = request.zMax ?? map.depth - 1;
  const tiles = decodeTerrainTiles(tactical);
  const byPos = indexTiles(tiles);

  const discovered = [];
  const unknown = [];

  const iterate = (x, y, z) => {
    const p = [x, y, z];
    if (!cellInQuery(p, request.center, request.radius ?? 0, request.rectangle, zMin, zMax)) {
      return;
    }
    const key = p.join(',');
    const tile = byPos.get(key);
    if (tile) {
      discovered.push(tileToQueryCell(tile));
    } else {
      unknown.push({ p, visibility: VIS_UNKNOWN });
    }
  };

  if (request.rectangle) {
    for (let z = zMin; z <= zMax; z += 1) {
      for (let y = request.rectangle.y0; y <= request.rectangle.y1; y += 1) {
        for (let x = request.rectangle.x0; x <= request.rectangle.x1; x += 1) {
          iterate(x, y, z);
        }
      }
    }
  } else {
    const r = request.radius;
    for (let z = zMin; z <= zMax; z += 1) {
      for (let dx = -r; dx <= r; dx += 1) {
        for (let dy = -r; dy <= r; dy += 1) {
          for (let dz = -r; dz <= r; dz += 1) {
            if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > r) continue;
            const x = request.center.x + dx;
            const y = request.center.y + dy;
            const zc = request.center.z + dz;
            if (x < 0 || y < 0 || zc < 0 || x >= map.width || y >= map.height || zc >= map.depth) continue;
            iterate(x, y, zc);
          }
        }
      }
    }
  }

  const sortP = (a, b) => {
    const pa = a.p;
    const pb = b.p;
    return pa[2] - pb[2] || pa[1] - pb[1] || pa[0] - pb[0];
  };
  discovered.sort((a, b) => sortP(a, b));
  unknown.sort((a, b) => sortP(a, b));

  const response = {
    schemaVersion: 1,
    snapshot_id: request.snapshot_id,
    query: {
      center: request.center,
      ...(request.radius !== undefined ? { radius: request.radius } : {}),
      ...(request.rectangle ? { rectangle: request.rectangle } : {}),
      zMin,
      zMax,
    },
    visibilityLabels: {
      currentlyVisible: VIS_CURRENT,
      discoveredOffLos: VIS_DISCOVERED_OFF_LOS,
      unknown: VIS_UNKNOWN,
    },
    discovered,
    unknown,
    warnings: [
      'Query uses authorized snapshot terrain only.',
      'UNKNOWN cells were not discovered in the snapshot.',
      'Off-LOS discovered cells reflect export-time engine state, not historical memory.',
      'Walk costs and blockSight do not guarantee movement or clear shots.',
    ],
    omittedDueToBudget: {},
  };

  let serialized = JSON.stringify(response);
  if (Buffer.byteLength(serialized, 'utf8') <= MAX_RESPONSE_BYTES) {
    return response;
  }

  const cap = Math.max(1, Math.floor(discovered.length / 2));
  response.discovered = discovered.slice(0, cap);
  response.unknown = unknown.slice(0, Math.max(1, Math.floor(unknown.length / 2)));
  response.truncated = true;
  response.omittedDueToBudget = {
    discovered: discovered.length - response.discovered.length,
    unknown: unknown.length - response.unknown.length,
  };
  serialized = JSON.stringify(response);
  assert(Buffer.byteLength(serialized, 'utf8') <= MAX_RESPONSE_BYTES, 'terrain query response exceeds max size');
  return response;
}

module.exports = {
  MAX_QUERY_RADIUS,
  MAX_RECT_SIDE,
  MAX_RESPONSE_BYTES,
  VIS_UNKNOWN,
  executeTerrainQuery,
  validateQueryRequest,
};
