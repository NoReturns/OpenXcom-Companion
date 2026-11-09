'use strict';

/**
 * P1A — Snapshot-bound tactical map windows (pre-decoded layer rows).
 * Reuses terrain-tactical-map.cjs / decodeTerrainTiles; no independent packed decoder.
 */

const { decodeTerrainTiles } = require('./terrain-brief.cjs');
const { categoryLabel } = require('./terrain-semantics-sparse-v1.cjs');
const {
  resolveFocus,
  computeFocusWindow,
  PROVENANCE_LIVE_EXPORT,
} = require('./terrain-map-brief.cjs');
const {
  buildTacticalMapView,
  DEFAULT_LEGEND,
  VIS_UNDISCOVERED,
  DOOR_STATE_UNKNOWN_OFF_LOS,
} = require('./terrain-tactical-map.cjs');
const { isFloorGravLiftTile } = require('./terrain-grav-lift-floor.cjs');

const SCHEMA_VERSION = 2;
const DEFAULT_WINDOW_SIZE = 24;
const MAX_TACTICAL_MAP_WINDOW_V2_BYTES = 32 * 1024;

const VERTICAL_SEM_IDS = new Set([7, 8]); // ENTRANCE, GRAV_LIFT

const COMPACT_LEGEND = Object.freeze({
  visibility: { '?': 'undiscovered', ':': 'off_los_discovered', '.': 'in_los' },
  floor: DEFAULT_LEGEND.floor,
  edgeNorth: DEFAULT_LEGEND.edgeNorth,
  edgeWest: DEFAULT_LEGEND.edgeWest,
  edgeSouth: 'derived from neighbor north edge',
  edgeEast: 'derived from neighbor west edge',
  doorOffLos: { U: 'door_remembered_state_not_disclosed' },
});

const FOG_OF_WAR_NOTES = Object.freeze({
  undiscovered: 'Cells with visibility ? have no terrain record (no coordinate leak).',
  offLosLiveGeometry:
    'Off-LOS discovered cells reflect live engine export at F6, not guaranteed historical memory.',
  offLosDoorState: 'Door open/closed is redacted off-LOS (glyph U); never infer from walk TU alone.',
});

function tileKey(x, y, z) {
  return `${x},${y},${z}`;
}

function indexTiles(tiles) {
  const map = new Map();
  for (const tile of tiles) {
    map.set(tileKey(tile.p[0], tile.p[1], tile.p[2]), tile);
  }
  return map;
}

function friendlyOccupiedLevels(tactical) {
  const levels = new Set();
  for (const unit of tactical.units ?? []) {
    if (unit.originalFaction === 0 && unit.faction === 0 && unit.position) {
      levels.add(unit.position[2]);
    }
  }
  return [...levels].sort((a, b) => a - b);
}

function verticalInterestLevels(tactical, crop, primaryZ, byPos) {
  const extra = new Set();
  const { map } = tactical;
  for (let y = crop.y0; y <= crop.y1; y += 1) {
    for (let x = crop.x0; x <= crop.x1; x += 1) {
      const t = byPos.get(tileKey(x, y, primaryZ));
      if (!t) continue;
      if (isFloorGravLiftTile(t)) {
        for (const dz of [-1, 1]) {
          const nz = primaryZ + dz;
          if (nz >= 0 && nz < map.depth && byPos.get(tileKey(x, y, nz))) {
            extra.add(nz);
          }
        }
      }
      for (const part of ['body', 'west', 'north']) {
        const id = t.sem?.[part];
        if (id !== undefined && VERTICAL_SEM_IDS.has(id)) {
          extra.add(primaryZ);
          for (let z = 0; z < map.depth; z += 1) {
            if (z !== primaryZ && byPos.get(tileKey(x, y, z))) {
              extra.add(z);
            }
          }
        }
      }
    }
  }
  return [...extra].sort((a, b) => a - b);
}

function selectLevels(tactical, focus, crop, byPos, options = {}) {
  const primaryZ = focus.position[2];
  const maxExtra = options.maxExtraLevels ?? 2;
  const friendlyLevels = friendlyOccupiedLevels(tactical);
  const verticalLevels = verticalInterestLevels(tactical, crop, primaryZ, byPos);
  const included = new Set([primaryZ]);
  for (const z of verticalLevels) {
    if (z !== primaryZ && included.size < 1 + maxExtra) {
      included.add(z);
    }
  }
  const onDemand = new Set(friendlyLevels);
  for (const z of included) onDemand.delete(z);
  for (const z of verticalLevels) onDemand.delete(z);

  const omitted = [];
  for (let z = 0; z < tactical.map.depth; z += 1) {
    if (!included.has(z)) omitted.push(z);
  }

  return {
    primaryZ,
    includedLevels: [...included].sort((a, b) => a - b),
    omittedLevels: omitted,
    friendlyLevels,
    onDemandLevels: [...onDemand].sort((a, b) => a - b),
    note:
      onDemand.size > 0
        ? 'Additional Z levels occupied by friendlies or outside window require on-demand terrain-query.'
        : 'Primary and vertically linked levels included in this publish.',
  };
}

function collectVerticalTransitions(tiles, crop, z) {
  const entries = [];
  for (const tile of tiles) {
    const [x, y, tz] = tile.p;
    if (tz !== z) continue;
    if (x < crop.x0 || x > crop.x1 || y < crop.y0 || y > crop.y1) continue;
    if (isFloorGravLiftTile(tile)) {
      entries.push({
        kind: 'floor_grav_lift',
        p: [x, y, z],
        observation: tile.inLos ? 'CURRENTLY_VISIBLE' : 'DISCOVERED_NOT_CURRENTLY_VISIBLE',
        pathfindingGuaranteed: false,
      });
    }
    for (const part of ['body', 'west', 'north']) {
      const id = tile.sem?.[part];
      if (id === undefined || !VERTICAL_SEM_IDS.has(id)) continue;
      entries.push({
        kind: categoryLabel(id) === 'ENTRANCE' ? 'entrance' : 'grav_lift_semantic',
        p: [x, y, z],
        ...(part !== 'body' ? { edge: part } : {}),
        category: categoryLabel(id),
        observation: tile.inLos ? 'CURRENTLY_VISIBLE' : 'DISCOVERED_NOT_CURRENTLY_VISIBLE',
      });
    }
  }
  entries.sort((a, b) => {
    const pa = a.p;
    const pb = b.p;
    return pa[2] - pb[2] || pa[1] - pb[1] || pa[0] - pb[0];
  });
  return entries;
}

function layerRowsFromLevel(level) {
  const { layers } = level;
  return {
    visibility: layers.visibility,
    floor: layers.floor,
    edgeNorth: layers.edgeNorth,
    edgeWest: layers.edgeWest,
    edgeSouth: layers.edgeSouth,
    edgeEast: layers.edgeEast,
  };
}

function assertLayerDimensions(layers, width, height, label) {
  for (const [name, rows] of Object.entries(layers)) {
    if (rows.length !== height) {
      throw new Error(`${label}: ${name} expected ${height} rows, got ${rows.length}`);
    }
    for (const row of rows) {
      if (row.length !== width) {
        throw new Error(`${label}: ${name} row width expected ${width}, got ${row.length}`);
      }
    }
  }
}

function buildLevelWindow(tactical, z, crop, byPos, tiles) {
  const view = buildTacticalMapView(tactical, {
    levels: [z],
    crop: { x0: crop.x0, y0: crop.y0, x1: crop.x1, y1: crop.y1 },
  });
  const level = view.levels[0];
  const layers = layerRowsFromLevel(level);
  assertLayerDimensions(layers, crop.width, crop.height, `z=${z}`);

  return {
    z,
    window: {
      x0: crop.x0,
      y0: crop.y0,
      x1: crop.x1,
      y1: crop.y1,
      width: crop.width,
      height: crop.height,
      mapContinues: crop.mapContinues,
    },
    layers,
    verticalTransitions: collectVerticalTransitions(tiles, crop, z),
  };
}

function payloadBytes(obj) {
  return Buffer.byteLength(JSON.stringify(obj), 'utf8');
}

function resolveSnapshotId(tactical, options) {
  if (options.snapshotId) {
    return options.snapshotId;
  }
  const { computeSnapshotId } = require('./tactical-publish.cjs');
  return computeSnapshotId(tactical);
}

/**
 * @param {object} tactical
 * @param {object} [options]
 * @param {number} [options.windowSize]
 * @param {number} [options.maxBytes]
 * @param {object} [options.focus]
 * @param {number[]} [options.levels] — explicit Z list (overrides auto selection)
 * @param {{ x0, y0, x1, y1 }} [options.crop] — explicit crop (absolute coords)
 */
function buildTacticalMapWindowV2(tactical, options = {}) {
  const maxBytes = options.maxBytes ?? MAX_TACTICAL_MAP_WINDOW_V2_BYTES;
  if (tactical.schemaVersion < 5 || !tactical.terrain) {
    return null;
  }

  const snapshotId = resolveSnapshotId(tactical, options);
  const focus = options.focus ?? resolveFocus(tactical);
  if (!focus) {
    return {
      schemaVersion: SCHEMA_VERSION,
      snapshot_id: snapshotId,
      omitted: true,
      reason: 'no_focus_soldier',
      note: 'tacticalMapWindowV2 requires a friendly focus soldier with position',
    };
  }

  const tiles = decodeTerrainTiles(tactical);
  const byPos = indexTiles(tiles);
  const primaryZ = focus.position[2];
  if (primaryZ < 0 || primaryZ >= tactical.map.depth) {
    return {
      schemaVersion: SCHEMA_VERSION,
      snapshot_id: snapshotId,
      omitted: true,
      reason: 'focus_level_out_of_bounds',
    };
  }

  let windowSize = options.windowSize ?? DEFAULT_WINDOW_SIZE;
  let crop = options.crop
    ? {
        ...options.crop,
        width: options.crop.x1 - options.crop.x0 + 1,
        height: options.crop.y1 - options.crop.y0 + 1,
        mapContinues: options.crop.mapContinues ?? {
          west: options.crop.x0 > 0,
          east: options.crop.x1 < tactical.map.width - 1,
          north: options.crop.y0 > 0,
          south: options.crop.y1 < tactical.map.height - 1,
        },
      }
    : computeFocusWindow(tactical.map, focus.position, windowSize);

  let levelSelection = options.levels
    ? {
        primaryZ,
        includedLevels: [...options.levels].sort((a, b) => a - b),
        omittedLevels: Array.from({ length: tactical.map.depth }, (_, i) => i).filter(
          (z) => !options.levels.includes(z),
        ),
        friendlyLevels: friendlyOccupiedLevels(tactical),
        onDemandLevels: [],
        note: 'Explicit levels option',
      }
    : selectLevels(tactical, focus, crop, byPos, options);

  const buildPayload = () => {
    const levelWindows = levelSelection.includedLevels.map((z) =>
      buildLevelWindow(tactical, z, crop, byPos, tiles),
    );
    return {
      schemaVersion: SCHEMA_VERSION,
      presentation: 'layer_rows_v2',
      provenance: PROVENANCE_LIVE_EXPORT,
      provenanceNote: FOG_OF_WAR_NOTES.offLosLiveGeometry,
      snapshot_id: snapshotId,
      focus: {
        soldierId: focus.soldierId,
        ...(focus.soldierName ? { soldierName: focus.soldierName } : {}),
        position: focus.position,
        z: primaryZ,
      },
      levelSelection,
      fogOfWar: FOG_OF_WAR_NOTES,
      legendCompact: COMPACT_LEGEND,
      compatibility: {
        terrainMapBrief: 'Same window origin via computeFocusWindow; mapBrief default 20×20, v2 default 24×24.',
        terrainQuery: 'Use terrain-query for levels in levelSelection.onDemandLevels or wider radius.',
        fullAscii: 'layers match buildTacticalMapView crop semantics',
      },
      levels: levelWindows,
      truncated: false,
      byteLength: 0,
    };
  };

  let payload = buildPayload();
  let truncated = false;
  const truncation = [];

  while (payloadBytes(payload) > maxBytes && windowSize > 8 && !options.crop) {
    windowSize -= 2;
    crop = computeFocusWindow(tactical.map, focus.position, windowSize);
    levelSelection = selectLevels(tactical, focus, crop, byPos, options);
    payload = buildPayload();
    truncated = true;
    truncation.push({ step: 'window_shrunk', windowSize });
  }

  while (payloadBytes(payload) > maxBytes && payload.levels.length > 1) {
    const drop = payload.levels[payload.levels.length - 1];
    if (drop.z === primaryZ) break;
    levelSelection.includedLevels = levelSelection.includedLevels.filter((z) => z !== drop.z);
    levelSelection.omittedLevels = Array.from({ length: tactical.map.depth }, (_, i) => i).filter(
      (z) => !levelSelection.includedLevels.includes(z),
    );
    levelSelection.onDemandLevels = [...new Set([...levelSelection.onDemandLevels, drop.z])].sort(
      (a, b) => a - b,
    );
    payload = buildPayload();
    truncated = true;
    truncation.push({ step: 'level_dropped', z: drop.z });
  }

  payload.truncated = truncated;
  if (truncation.length) payload.truncation = truncation;
  payload.byteLength = payloadBytes(payload);

  if (payload.byteLength > maxBytes) {
    return {
      schemaVersion: SCHEMA_VERSION,
      snapshot_id: snapshotId,
      omitted: true,
      reason: 'exceeds_max_bytes_after_shrink',
      maxBytes,
      attemptedBytes: payload.byteLength,
    };
  }

  return payload;
}

function measureTacticalMapWindowV2Bytes(window) {
  return payloadBytes(window);
}

/** Layers from v2 must match cropped buildTacticalMapView for same crop/level. */
function assertAsciiLayerCompatibility(tactical, window) {
  for (const lw of window.levels) {
    const { x0, y0, x1, y1 } = lw.window;
    const view = buildTacticalMapView(tactical, {
      levels: [lw.z],
      crop: { x0, y0, x1, y1 },
    });
    const expected = layerRowsFromLevel(view.levels[0]);
    const a = JSON.stringify(lw.layers);
    const b = JSON.stringify(expected);
    if (a !== b) {
      throw new Error(`layer mismatch at z=${lw.z}`);
    }
  }
}

module.exports = {
  SCHEMA_VERSION,
  DEFAULT_WINDOW_SIZE,
  MAX_TACTICAL_MAP_WINDOW_V2_BYTES,
  COMPACT_LEGEND,
  FOG_OF_WAR_NOTES,
  VIS_UNDISCOVERED,
  DOOR_STATE_UNKNOWN_OFF_LOS,
  computeFocusWindow,
  selectLevels,
  collectVerticalTransitions,
  buildTacticalMapWindowV2,
  measureTacticalMapWindowV2Bytes,
  assertAsciiLayerCompatibility,
  layerRowsFromLevel,
};
