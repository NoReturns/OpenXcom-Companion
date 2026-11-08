'use strict';

const { decodeTerrainTiles } = require('./terrain-brief.cjs');

const FACTION_PLAYER = 0;

function isFriendlyPlayerControlled(unit) {
  return unit.originalFaction === FACTION_PLAYER && unit.faction === FACTION_PLAYER;
}
const {
  buildTacticalMapView,
  buildInterleavedAsciiForLevel,
  measureInterleavedAsciiBytes,
} = require('./terrain-tactical-map.cjs');

const SCHEMA_VERSION = 1;
const DEFAULT_WINDOW_SIZE = 20;
const MAX_TERRAIN_MAP_BRIEF_BYTES = 24 * 1024;
const PROVENANCE_LIVE_EXPORT = 'live_export';

const LEGEND_SHORT = [
  'o=walkable floor; x=blocked; ?=undiscovered; :=off-LOS discovered.',
  '---/|=impassable wall; -p-/p=passable structural edge; D/d=door in LOS; U/-U-=door off-LOS state unknown.',
  '@=friendly H=hostile N=neutral M=MC roster.',
  '>/</~~~/v=crop continues (not a wall); space on edge=known passable.',
  `provenance=${PROVENANCE_LIVE_EXPORT} (live engine tiles, not historical memory).`,
].join(' ');

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

function resolveFocus(tactical) {
  const friendly = (tactical.units ?? []).filter((u) => isFriendlyPlayerControlled(u));
  const selected = friendly.find((u) => u.id === tactical.selectedUnitId) ?? friendly[0] ?? null;
  if (!selected?.position) {
    return null;
  }
  return {
    soldierId: selected.id,
    soldierName: selected.name ?? null,
    position: [...selected.position],
  };
}

function computeFocusWindow(map, focusPosition, windowSize = DEFAULT_WINDOW_SIZE) {
  const [fx, fy] = focusPosition;
  const span = windowSize;
  const half = Math.floor(span / 2);
  let x0 = fx - half;
  let y0 = fy - half;
  let x1 = x0 + span - 1;
  let y1 = y0 + span - 1;
  if (x0 < 0) {
    x1 -= x0;
    x0 = 0;
  }
  if (y0 < 0) {
    y1 -= y0;
    y0 = 0;
  }
  if (x1 >= map.width) {
    x0 = Math.max(0, x1 - (span - 1));
    x1 = map.width - 1;
  }
  if (y1 >= map.height) {
    y0 = Math.max(0, y1 - (span - 1));
    y1 = map.height - 1;
  }
  return {
    x0,
    y0,
    x1,
    y1,
    width: x1 - x0 + 1,
    height: y1 - y0 + 1,
    mapContinues: {
      west: x0 > 0,
      east: x1 < map.width - 1,
      north: y0 > 0,
      south: y1 < map.height - 1,
    },
  };
}

function interleavedToMapText(interleaved) {
  const lines = [];
  if (interleaved?.columnLabels?.labels?.length) {
    lines.push(`    ${interleaved.columnLabels.labels.join('')}`);
  }
  for (const row of interleaved?.annotatedRows ?? []) {
    const prefix = row.kind === 'north_edges' ? 'n ' : row.kind === 'south_clip' ? 's ' : '  ';
    lines.push(`${String(row.y).padStart(2, '0')}${prefix}${row.text}`);
  }
  return lines.join('\n');
}

function buildTerrainMapBrief(tactical, options = {}) {
  const maxBytes = options.maxBytes ?? MAX_TERRAIN_MAP_BRIEF_BYTES;
  if (tactical.schemaVersion < 5 || !tactical.terrain) {
    return null;
  }
  const focus = options.focus ?? resolveFocus(tactical);
  if (!focus) {
    return {
      schemaVersion: SCHEMA_VERSION,
      omitted: true,
      reason: 'no_focus_soldier',
      note: 'terrainMapBrief requires a friendly focus soldier with position',
    };
  }
  const z = focus.position[2];
  const { map } = tactical;
  if (z < 0 || z >= map.depth) {
    return {
      schemaVersion: SCHEMA_VERSION,
      omitted: true,
      reason: 'focus_level_out_of_bounds',
    };
  }

  const tiles = decodeTerrainTiles(tactical);
  const byPos = indexTiles(tiles);

  let windowSize = options.windowSize ?? DEFAULT_WINDOW_SIZE;
  let crop = computeFocusWindow(map, focus.position, windowSize);
  let view = buildTacticalMapView(tactical, {
    levels: [z],
    crop: { x0: crop.x0, y0: crop.y0, x1: crop.x1, y1: crop.y1 },
  });
  let level = view.levels[0];
  let interleaved = buildInterleavedAsciiForLevel(
    level,
    { map, crop: { ...crop, mapContinues: crop.mapContinues } },
    { boundaryContext: { crop: { ...crop, mapContinues: crop.mapContinues }, map, byPos, z } },
  );

  const buildPayload = () => ({
    schemaVersion: SCHEMA_VERSION,
    presentation: 'edge_interleaved',
    provenance: PROVENANCE_LIVE_EXPORT,
    provenanceNote:
      'Geometry reflects live engine export for discovered cells; off-LOS is not guaranteed historical memory.',
    legendShort: LEGEND_SHORT,
    focus: {
      soldierId: focus.soldierId,
      ...(focus.soldierName ? { soldierName: focus.soldierName } : {}),
      position: focus.position,
      z,
    },
    window: {
      x0: crop.x0,
      y0: crop.y0,
      x1: crop.x1,
      y1: crop.y1,
      z,
      sizeRequested: windowSize,
      width: crop.width,
      height: crop.height,
      mapContinues: crop.mapContinues,
    },
    mapText: interleavedToMapText(interleaved),
    truncated: false,
    byteLength: 0,
  });

  let brief = buildPayload();

  const fitBytes = (obj) => Buffer.byteLength(JSON.stringify(obj), 'utf8');

  while (fitBytes(brief) > maxBytes && windowSize > 8) {
    windowSize -= 2;
    crop = computeFocusWindow(map, focus.position, windowSize);
    view = buildTacticalMapView(tactical, {
      levels: [z],
      crop: { x0: crop.x0, y0: crop.y0, x1: crop.x1, y1: crop.y1 },
    });
    level = view.levels[0];
    interleaved = buildInterleavedAsciiForLevel(
      level,
      { map, crop: { ...crop, mapContinues: crop.mapContinues } },
      { boundaryContext: { crop: { ...crop, mapContinues: crop.mapContinues }, map, byPos, z } },
    );
    brief = buildPayload();
    brief.truncated = true;
    brief.truncation = { reason: 'window_shrunk', windowSize };
  }

  if (fitBytes(brief) > maxBytes) {
    const lines = brief.mapText.split('\n');
    while (lines.length > 4 && fitBytes({ ...brief, mapText: lines.join('\n') }) > maxBytes) {
      lines.pop();
    }
    brief.mapText = lines.join('\n');
    brief.truncated = true;
    brief.truncation = { ...(brief.truncation ?? {}), reason: 'map_text_tail_trimmed', linesKept: lines.length };
  }

  brief.byteLength = fitBytes(brief);
  brief.mapTextBytes = Buffer.byteLength(brief.mapText, 'utf8');

  if (brief.byteLength > maxBytes) {
    return {
      schemaVersion: SCHEMA_VERSION,
      omitted: true,
      reason: 'exceeds_max_bytes_after_shrink',
      maxBytes,
      attemptedBytes: brief.byteLength,
    };
  }

  return brief;
}

function compactTerrainBriefForRelay(terrainBrief) {
  if (!terrainBrief || typeof terrainBrief !== 'object') {
    return null;
  }
  return {
    schemaVersion: terrainBrief.schemaVersion,
    focusSoldierId: terrainBrief.focusSoldierId ?? null,
    focusPosition: terrainBrief.focusPosition ?? null,
    visibilityTotals: terrainBrief.visibilityTotals ?? undefined,
    warnings: terrainBrief.warnings ?? undefined,
    truncated: true,
    compactedForRelay: true,
    note: 'Detail lists omitted for relay size; use terrainMapBrief for local geometry.',
    omittedDueToBudget: terrainBrief.omittedDueToBudget ?? undefined,
  };
}

module.exports = {
  SCHEMA_VERSION,
  DEFAULT_WINDOW_SIZE,
  MAX_TERRAIN_MAP_BRIEF_BYTES,
  PROVENANCE_LIVE_EXPORT,
  LEGEND_SHORT,
  resolveFocus,
  computeFocusWindow,
  buildTerrainMapBrief,
  compactTerrainBriefForRelay,
  interleavedToMapText,
  measureInterleavedAsciiBytes,
};
