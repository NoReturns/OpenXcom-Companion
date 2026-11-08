'use strict';

/**
 * M1 P4 — Full-map ASCII battlefield (derived presentation only).
 * Canonical terrain remains packed-v1 + sparse-v2 on the engine YAML; snapshot SHA unchanged.
 */

const { decodeTerrainTiles } = require('./terrain-brief.cjs');
const { categoryLabel } = require('./terrain-semantics-sparse-v1.cjs');
const {
  DEFAULT_LEGEND,
  buildTacticalMapView,
  visibilityGlyph,
  floorGlyph,
  northEdgeGlyph,
  westEdgeGlyph,
} = require('./terrain-tactical-map.cjs');
const { buildGravLiftStructures } = require('./terrain-grav-lift-structures.cjs');

const ENCODING = 'full-ascii-battlefield-v1';
const SCHEMA_VERSION = 1;

/** Categories that floor/edge glyphs do not name reliably (sparse hint list). */
const VERTICAL_HINT_CATEGORY_IDS = new Set([7, 8]); // ENTRANCE, GRAV_LIFT

const PRESENTATION_OMISSIONS = Object.freeze([
  'Numeric walkF/walkO TU costs (255 vs passable thresholds)',
  'blockSight and sight-line geometry',
  'Smoke, fire, and terrain destruction / damage generation',
  'Full pathfinding guarantees for grav lifts (unit size, occupancy, flying alternate routes)',
  'Off-LOS door open vs closed (U = door remembered, current state unknown)',
  'South and east walls (derived from neighbor north/west in engine; not separate channels)',
  'Unit positions (remain in tactical.units and visibility-gated export)',
]);

function observationLabel(tile) {
  if (!tile) return 'UNKNOWN';
  if (tile.inLos) return 'CURRENTLY_VISIBLE';
  if (tile.disc) return 'DISCOVERED_NOT_CURRENTLY_VISIBLE';
  return 'UNKNOWN';
}

function hintSortKey(a) {
  const p = a.p;
  return p[2] * 1_000_000 + p[1] * 1_000 + p[0];
}

function collectSparseHints(tiles) {
  const vertical = [];
  for (const tile of tiles) {
    for (const part of ['body', 'west', 'north']) {
      const id = tile.sem?.[part];
      if (id === undefined || !VERTICAL_HINT_CATEGORY_IDS.has(id)) {
        continue;
      }
      const entry = {
        p: [...tile.p],
        part,
        category: categoryLabel(id),
        observation: observationLabel(tile),
      };
      if (part !== 'body') {
        entry.edge = part;
      }
      vertical.push(entry);
    }
  }
  vertical.sort((a, b) => hintSortKey(a) - hintSortKey(b));
  return { vertical };
}

function assertChannelGrid(channels, width, height, levelZ) {
  for (const [name, rows] of Object.entries(channels)) {
    if (rows.length !== height) {
      throw new Error(`level z=${levelZ} channel ${name}: expected ${height} rows, got ${rows.length}`);
    }
    for (let y = 0; y < rows.length; y += 1) {
      if (rows[y].length !== width) {
        throw new Error(`level z=${levelZ} channel ${name} y=${y}: expected width ${width}, got ${rows[y].length}`);
      }
    }
  }
}

/**
 * @param {object} tactical — validated tactical snapshot (schema v5 terrain)
 * @param {object} [options]
 * @param {number[]} [options.levels] — subset of Z indices (default all)
 */
function buildFullAsciiBattlefieldMap(tactical, options = {}) {
  if (!tactical?.map || tactical.schemaVersion < 5 || !tactical.terrain) {
    throw new Error('buildFullAsciiBattlefieldMap requires schema v5 with terrain');
  }

  const view = buildTacticalMapView(tactical, {
    levels: options.levels,
    interleaved: options.interleaved,
  });
  const tiles = decodeTerrainTiles(tactical);
  const sparseHints = collectSparseHints(tiles);
  const gravLiftStructures = buildGravLiftStructures(tiles, view.map);
  const hints = {
    schemaVersion: 2,
    ...sparseHints,
    gravLiftStructures,
  };
  const { width, height } = view.map;

  const levels = view.levels.map((level) => {
    const channels = {
      visibility: level.layers.visibility,
      floor: level.layers.floor,
      edgeNorth: level.layers.edgeNorth,
      edgeWest: level.layers.edgeWest,
    };
    assertChannelGrid(channels, width, height, level.z);
    return {
      z: level.z,
      channels,
    };
  });

  levels.sort((a, b) => a.z - b.z);

  return {
    schemaVersion: SCHEMA_VERSION,
    encoding: ENCODING,
    role: 'derived_tactical_presentation',
    authoritativeNote:
      'Derived for AI/human map reading only. Command authority and snapshot_id bind to full engine YAML (packed-v1); this is not a lossless terrain database.',
    map: { ...view.map },
    memoryNote: tactical.terrain.memoryNote ?? null,
    legend: DEFAULT_LEGEND,
    presentationOmissions: [...PRESENTATION_OMISSIONS],
    levels,
    hints,
  };
}

function serializeFullAsciiBattlefieldMap(map, { pretty = false } = {}) {
  return pretty ? JSON.stringify(map, null, 2) : JSON.stringify(map);
}

function measureFullAsciiBattlefieldMapBytes(map, options = {}) {
  return Buffer.byteLength(serializeFullAsciiBattlefieldMap(map, options), 'utf8');
}

/**
 * Spot-check a sample of decoded tiles against channel glyphs (presentation QA).
 */
function compareGlyphsToDecodedTiles(tactical, { maxSamples = 64 } = {}) {
  const map = buildFullAsciiBattlefieldMap(tactical);
  const tiles = decodeTerrainTiles(tactical);
  const byPos = new Map(tiles.map((t) => [`${t.p[0]},${t.p[1]},${t.p[2]}`, t]));
  const mismatches = [];
  let checked = 0;

  for (const level of map.levels) {
    const { z } = level;
    const { visibility, floor, edgeNorth, edgeWest } = level.channels;
    for (let y = 0; y < visibility.length && checked < maxSamples; y += 1) {
      for (let x = 0; x < visibility[y].length && checked < maxSamples; x += 1) {
        const key = `${x},${y},${z}`;
        const tile = byPos.get(key);
        const expectedVis = visibilityGlyph(tile);
        const expectedFloor = floorGlyph(tile);
        const expectedNorth = northEdgeGlyph(tile);
        const expectedWest = westEdgeGlyph(tile);
        if (visibility[y][x] !== expectedVis
          || floor[y][x] !== expectedFloor
          || edgeNorth[y][x] !== expectedNorth
          || edgeWest[y][x] !== expectedWest) {
          mismatches.push({ p: [x, y, z], key });
        }
        checked += 1;
      }
    }
  }

  return {
    samplesChecked: checked,
    mismatchCount: mismatches.length,
    mismatches: mismatches.slice(0, 8),
    presentationLoss: PRESENTATION_OMISSIONS,
  };
}

/**
 * Measure relay pipeline with experimental full ASCII (uses real shrink + opt-in flag).
 */
function estimateRelayBytesWithFullAscii(tactical, publishedAt = '2026-01-01T00:00:00.000Z', relayOptions = {}) {
  const { buildRelayPayload } = require('./tactical-publish.cjs');
  const { prepareRelayPayloadForPublish } = require('./relay-payload-adaptive-shrink.cjs');
  const { measureRelayAsciiSizeAccounting } = require('./terrain-full-ascii-relay.cjs');
  const relay = buildRelayPayload(tactical, publishedAt, null, relayOptions);
  const baseline = prepareRelayPayloadForPublish(relay, { includeTerrainFullAsciiBattlefield: false });
  const compactStandalone = measureFullAsciiBattlefieldMapBytes(buildFullAsciiBattlefieldMap(tactical));
  const withAscii = prepareRelayPayloadForPublish(relay, {
    ...relayOptions,
    includeTerrainFullAsciiBattlefield: true,
  });
  const beforeRelay = baseline.relay;
  const afterRelay = withAscii.relay;
  return {
    relayAfterShrinkBytes: baseline.bytes,
    withFullAsciiBytes: withAscii.bytes,
    fullAsciiCompactStandaloneBytes: compactStandalone,
    asciiIncluded: Boolean(afterRelay.terrainFullAsciiBattlefield),
    omitted: afterRelay.terrainFullAsciiBattlefieldOmitted ?? null,
    sizeAccounting: measureRelayAsciiSizeAccounting(beforeRelay, afterRelay, compactStandalone),
  };
}

module.exports = {
  ENCODING,
  SCHEMA_VERSION,
  PRESENTATION_OMISSIONS,
  buildFullAsciiBattlefieldMap,
  serializeFullAsciiBattlefieldMap,
  measureFullAsciiBattlefieldMapBytes,
  compareGlyphsToDecodedTiles,
  estimateRelayBytesWithFullAscii,
};
