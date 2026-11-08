'use strict';

/**
 * P0 — Edge-joined tactical map renderer (read-only, Node-side).
 * Builds human-readable layer grids from packed/verbose terrain; does not publish to relay.
 */

const { decodeTerrainTiles, WALK_IMPASSABLE } = require('./terrain-brief.cjs');
const { isDoorCategory } = require('./terrain-semantics-sparse-v2.cjs');
const { categoryLabel } = require('./terrain-semantics-sparse-v1.cjs');
const { isFloorGravLiftTile } = require('./terrain-grav-lift-floor.cjs');

const FLOOR_GRAV_IN_LOS = 'G';
const FLOOR_GRAV_OFF_LOS = 'g';

const VIS_UNDISCOVERED = '?';
const VIS_OFF_LOS = ':';
const VIS_IN_LOS = '.';
/** Exported structural edge with walk TU below impassable (255); not a door. */
const PASSABLE_STRUCTURAL_EDGE = 'p';
/** Door discovered off current LOS; open/closed not disclosed (not confirmed closed). */
const DOOR_STATE_UNKNOWN_OFF_LOS = 'U';

const DISC_WEST = 1;
const DISC_NORTH = 2;
const DISC_BODY = 4;

/** Human-readable legend (glyph → meaning) for GitHub-facing output. */
const DEFAULT_LEGEND = Object.freeze({
  visibility: {
    [VIS_UNDISCOVERED]: 'undiscovered',
    [VIS_OFF_LOS]: 'discovered_off_los',
    [VIS_IN_LOS]: 'currently_visible',
  },
  floor: {
    '?': 'undiscovered',
    o: 'open_floor',
    x: 'impassable_floor_or_body',
    O: 'ufo_interior_or_special_floor',
    A: 'open_air_void',
    ':': 'discovered_off_los_floor',
    G: 'grav_lift_floor_currently_visible',
    g: 'grav_lift_floor_discovered_remembered',
  },
  edgeNorth: {
    '?': 'undiscovered',
    ' ': 'no_north_wall_on_this_tile',
    '.': 'discovered_no_emitted_wall',
    W: 'impassable_wall',
    p: 'passable_structural_edge_exported_wall_part',
    D: 'door_closed_confirmed_in_los',
    d: 'door_open_confirmed_in_los',
    U: 'door_remembered_off_los_state_unknown',
    ':': 'off_los_remembered_wall',
  },
  edgeWest: {
    '?': 'undiscovered',
    ' ': 'no_west_wall_on_this_tile',
    '.': 'discovered_no_emitted_wall',
    W: 'impassable_wall',
    p: 'passable_structural_edge_exported_wall_part',
    D: 'door_closed_confirmed_in_los',
    d: 'door_open_confirmed_in_los',
    U: 'door_remembered_off_los_state_unknown',
    ':': 'off_los_remembered_wall',
  },
  unit: {
    '@': 'friendly_player',
    H: 'hostile',
    N: 'neutral',
    M: 'mind_controlled_roster',
  },
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

function visibilityGlyph(tile) {
  if (!tile) return VIS_UNDISCOVERED;
  return tile.inLos ? VIS_IN_LOS : VIS_OFF_LOS;
}

function floorGlyph(tile) {
  if (!tile) return VIS_UNDISCOVERED;
  if (!tile.body) {
    if ((tile.disc & DISC_BODY) !== 0) return tile.inLos ? '.' : ':';
    return VIS_UNDISCOVERED;
  }
  if (isFloorGravLiftTile(tile)) {
    return tile.inLos ? FLOOR_GRAV_IN_LOS : FLOOR_GRAV_OFF_LOS;
  }
  if (tile.body.air) return 'A';
  const bodySem = tile.sem?.body;
  if (bodySem !== undefined) {
    const label = categoryLabel(bodySem);
    if (label === 'ORDINARY_IMPASSABLE') return 'x';
    if (label === 'UFO_INTERIOR' || label === 'UFO_STRUCTURE') return 'O';
  }
  if (tile.body.walkF === WALK_IMPASSABLE || tile.body.walkO === WALK_IMPASSABLE) return 'x';
  return tile.inLos ? 'o' : ':';
}

function doorEdgeGlyph(tile, part) {
  const categoryId = tile.sem?.[part];
  if (categoryId === undefined || !isDoorCategory(categoryId)) {
    return null;
  }
  if (!tile.inLos) {
    return DOOR_STATE_UNKNOWN_OFF_LOS;
  }
  const state = tile.structureMeta?.doorState?.[part];
  if (state === 'open') return 'd';
  if (state === 'closed') return 'D';
  return 'D';
}

function wallEdgeGlyph(tile, part) {
  const wall = part === 'west' ? tile.west : tile.north;
  const discBit = part === 'west' ? DISC_WEST : DISC_NORTH;
  if (wall) {
    if (wall.walk === WALK_IMPASSABLE) {
      return tile.inLos ? 'W' : ':';
    }
    return tile.inLos ? PASSABLE_STRUCTURAL_EDGE : ':';
  }
  if ((tile.disc & discBit) !== 0) {
    return tile.inLos ? '.' : ':';
  }
  return ' ';
}

function westEdgeGlyph(tileAtCell) {
  if (!tileAtCell) return VIS_UNDISCOVERED;
  const door = doorEdgeGlyph(tileAtCell, 'west');
  if (door !== null) return door;
  return wallEdgeGlyph(tileAtCell, 'west');
}

function northEdgeGlyph(tileAtCell) {
  if (!tileAtCell) return VIS_UNDISCOVERED;
  const door = doorEdgeGlyph(tileAtCell, 'north');
  if (door !== null) return door;
  return wallEdgeGlyph(tileAtCell, 'north');
}

function southEdgeGlyph(byPos, x, y, z, height) {
  if (y + 1 >= height) return ' ';
  return northEdgeGlyph(byPos.get(tileKey(x, y + 1, z)));
}

function eastEdgeGlyph(byPos, x, y, z, width) {
  if (x + 1 >= width) return ' ';
  return westEdgeGlyph(byPos.get(tileKey(x + 1, y, z)));
}

function tacticalCellGlyph({
  vis,
  floor,
  n,
  w,
  e,
  s,
}) {
  if (vis === VIS_UNDISCOVERED) return VIS_UNDISCOVERED;
  if (n === 'd' || w === 'd') return 'd';
  if (n === 'D' || w === 'D') return 'D';
  if (n === DOOR_STATE_UNKNOWN_OFF_LOS || w === DOOR_STATE_UNKNOWN_OFF_LOS) return DOOR_STATE_UNKNOWN_OFF_LOS;
  if (n === 'W' || w === 'W' || e === 'W' || s === 'W') return 'w';
  if (floor === 'x') return 'x';
  if (floor === 'A') return 'A';
  if (vis === VIS_OFF_LOS) return ':';
  return floor === 'o' ? 'o' : floor;
}

function unitMarker(unit) {
  if (unit.originalFaction === 0 && unit.faction === 0) return '@';
  if (unit.originalFaction === 0 && unit.faction !== 0) return 'M';
  if (unit.faction === 1) return 'H';
  return 'N';
}

function buildLevelLayers({ width, height, z, byPos, units }) {
  const visibility = [];
  const floor = [];
  const edgeNorth = [];
  const edgeWest = [];
  const edgeSouth = [];
  const edgeEast = [];
  const tactical = [];

  for (let y = 0; y < height; y += 1) {
    let visRow = '';
    let floorRow = '';
    let nRow = '';
    let wRow = '';
    let sRow = '';
    let eRow = '';
    let tacRow = '';
    for (let x = 0; x < width; x += 1) {
      const tile = byPos.get(tileKey(x, y, z));
      const vis = visibilityGlyph(tile);
      const fl = floorGlyph(tile);
      const n = northEdgeGlyph(tile);
      const w = westEdgeGlyph(tile);
      const s = southEdgeGlyph(byPos, x, y, z, height);
      const e = eastEdgeGlyph(byPos, x, y, z, width);
      const tac = tacticalCellGlyph({ vis, floor: fl, n, w, e, s });
      visRow += vis;
      floorRow += fl;
      nRow += n;
      wRow += w;
      sRow += s;
      eRow += e;
      tacRow += tac;
    }
    visibility.push(visRow);
    floor.push(floorRow);
    edgeNorth.push(nRow);
    edgeWest.push(wRow);
    edgeSouth.push(sRow);
    edgeEast.push(eRow);
    tactical.push(tacRow);
  }

  const unitPlacements = [];
  const unitsRow = Array.from({ length: height }, () => ' '.repeat(width));
  const tacticalWithUnits = tactical.map((row) => row);

  for (const unit of units) {
    const [ux, uy, uz] = unit.position;
    if (uz !== z || ux < 0 || uy < 0 || ux >= width || uy >= height) continue;
    const ch = unitMarker(unit);
    unitPlacements.push({
      id: unit.id,
      name: unit.name ?? null,
      faction: unit.faction,
      originalFaction: unit.originalFaction,
      position: [ux, uy, uz],
      marker: ch,
    });
    const row = unitsRow[uy].split('');
    row[ux] = ch;
    unitsRow[uy] = row.join('');
    const tacRow = tacticalWithUnits[uy].split('');
    tacRow[ux] = ch;
    tacticalWithUnits[uy] = tacRow.join('');
  }

  return {
    z,
    layers: {
      visibility,
      floor,
      edgeNorth,
      edgeWest,
      edgeSouth,
      edgeEast,
      tactical,
      units: unitsRow,
      tacticalWithUnits,
    },
    unitPlacements,
  };
}

/**
 * @param {object} tactical — validated tactical snapshot
 * @param {object} [options]
 * @param {number[]} [options.levels] — z indices to render (default all)
 * @param {{ x0, y0, x1, y1 }} [options.crop] — inclusive crop on x/y
 */
function buildTacticalMapView(tactical, options = {}) {
  const { map, units = [] } = tactical;
  const { width, height, depth } = map;
  const tiles = decodeTerrainTiles(tactical);
  const byPos = indexTiles(tiles);
  const levels = options.levels ?? Array.from({ length: depth }, (_, i) => i);
  const crop = options.crop ?? null;

  const applyCrop = (level) => {
    if (!crop) return level;
    const { x0, y0, x1, y1 } = crop;
    const sliceRow = (rows) => rows.slice(y0, y1 + 1).map((row) => row.slice(x0, x1 + 1));
    const sliceUnits = (u) => u.filter((p) => {
      const [x, y] = p.position;
      return x >= x0 && x <= x1 && y >= y0 && y <= y1;
    }).map((p) => ({
      ...p,
      position: [p.position[0] - x0, p.position[1] - y0, p.position[2]],
    }));
    return {
      ...level,
      crop: { x0, y0, x1, y1 },
      layers: Object.fromEntries(
        Object.entries(level.layers).map(([k, rows]) => [k, sliceRow(rows)]),
      ),
      unitPlacements: sliceUnits(level.unitPlacements),
    };
  };

  const viewCrop = crop;
  const perLevel = levels
    .filter((z) => z >= 0 && z < depth)
    .map((z) => {
      const level = applyCrop(buildLevelLayers({
        width,
        height,
        z,
        byPos,
        units,
      }));
      const viewStub = { map: { width, height, depth }, crop: viewCrop };
      level.interleavedAscii = buildInterleavedAsciiForLevel(level, viewStub, options.interleaved ?? {});
      return level;
    });

  return {
    schemaVersion: 1,
    map: { width, height, depth },
    ...(crop ? { crop } : {}),
    legend: DEFAULT_LEGEND,
    legendNote: 'Glyphs are tactical shorthand; use separate layers for visibility vs structure. Doors use engine sparse semantics only (never walk TU alone).',
    levels: perLevel,
  };
}

function measureTacticalMapViewBytes(view, { pretty = false } = {}) {
  const text = pretty ? JSON.stringify(view, null, 2) : JSON.stringify(view);
  return Buffer.byteLength(text, 'utf8');
}

/**
 * Plain-text block suitable for pasting into GitHub (markdown) without base64.
 */
function formatTacticalMapForGitHub(view, options = {}) {
  const maxLevelRows = options.maxLevelRows ?? 80;
  const lines = [];
  lines.push('# Tactical map (edge-joined P0)');
  lines.push('');
  lines.push(`Map ${view.map.width}×${view.map.height}×${view.map.depth}`);
  if (view.crop) {
    lines.push(`Crop x=${view.crop.x0}..${view.crop.x1} y=${view.crop.y0}..${view.crop.y1}`);
  }
  lines.push('');
  lines.push('## Legend (visibility)');
  lines.push('`?` undiscovered | `:` discovered off-LOS | `.` in player LOS');
  lines.push('');
  lines.push('## Legend (tactical composite — use this for play)');
  lines.push('`?` unknown | `:` off-LOS discovered | `o` open floor | `w` impassable wall on a cardinal edge | `x` blocked floor | `D`/`d` door (engine semantics only)');
  lines.push('`@` friendly soldier (tacticalWithUnits row only); does not erase other layers in JSON.');
  lines.push('');
  lines.push('## Legend (edge diagnostic layers)');
  lines.push('`-p-` / `p` = passable **structural** edge (exported wall part with walk TU < 255) — not a door and not a window/breach identity.');
  lines.push('Provenance: off-LOS cells elsewhere use `:` / `D` (door state redacted); this crop is all current LOS at export (visibility `.`).');
  lines.push('');

  for (const level of view.levels) {
    lines.push(`## Level z=${level.z}`);
    lines.push('');
    const rowCount = level.layers.tactical.length;
    const showRows = rowCount <= maxLevelRows ? rowCount : maxLevelRows;
    if (rowCount > showRows) {
      lines.push(`_(showing first ${showRows} of ${rowCount} rows; full data in JSON layers)_`);
      lines.push('');
    }

    const emit = (title, key) => {
      lines.push(`### ${title}`);
      lines.push('```');
      for (let i = 0; i < showRows; i += 1) {
        const y = cropLabel(level, i, view);
        lines.push(`${String(y).padStart(2, '0')} ${level.layers[key][i]}`);
      }
      lines.push('```');
      lines.push('');
    };

    emit('visibility', 'visibility');
    emit('tactical (structure)', 'tactical');
    emit('tactical + units', 'tacticalWithUnits');
  }
  return lines.join('\n');
}

function cropLabel(level, rowIndex, view) {
  if (view.crop) return view.crop.y0 + rowIndex;
  return rowIndex;
}

const INTERLEAVED_COL_WIDTH = 3;

/** @typedef {'unknown'|'passable'|'wall'|'door_closed'|'door_open'|'off_los_wall'|'off_los_passable'} InterleavedEdgeKind */

function interleavedHorizFromNorthGlyph(glyph) {
  if (glyph === VIS_UNDISCOVERED) return '???';
  if (glyph === 'W') return '---';
  if (glyph === ':') return ':-:'; // off-LOS remembered barrier (not passable)
  if (glyph === 'D') return '-D-';
  if (glyph === 'd') return '-d-';
  if (glyph === DOOR_STATE_UNKNOWN_OFF_LOS) return '-U-';
  if (glyph === PASSABLE_STRUCTURAL_EDGE) return '-p-';
  if (glyph === '.' || glyph === ' ') return '   ';
  return '???';
}

function interleavedVertFromWestGlyph(glyph) {
  if (glyph === VIS_UNDISCOVERED) return '?';
  if (glyph === 'W') return '|';
  if (glyph === ':') return ':';
  if (glyph === 'D') return 'D';
  if (glyph === 'd') return 'd';
  if (glyph === DOOR_STATE_UNKNOWN_OFF_LOS) return 'U';
  if (glyph === PASSABLE_STRUCTURAL_EDGE) return 'p';
  if (glyph === '.' || glyph === ' ') return ' ';
  return '?';
}

function interleavedFloorCenter(visibilityChar, floorChar, unitChar) {
  if (unitChar && unitChar !== ' ') return unitChar;
  if (visibilityChar === VIS_UNDISCOVERED || floorChar === VIS_UNDISCOVERED) return VIS_UNDISCOVERED;
  if (visibilityChar === VIS_OFF_LOS) return ':';
  if (floorChar === 'x') return 'x';
  if (floorChar === 'A') return 'A';
  return 'o';
}

/**
 * Edge-interleaved ASCII: walls/doors between cell centers; floors/units in cells.
 * Uses existing edge glyph classification (doors from semantics only).
 */
function tileKey3(x, y, z) {
  return `${x},${y},${z}`;
}

function resolveWestDisplay(wGlyph, absX, absY, boundaryContext) {
  if (!boundaryContext) {
    return interleavedVertFromWestGlyph(wGlyph);
  }
  const { crop, byPos, z } = boundaryContext;
  if (crop.mapContinues?.west && absX === crop.x0) {
    const outside = byPos.get(tileKey3(absX - 1, absY, z));
    if (!outside) return '?';
    return '>';
  }
  return interleavedVertFromWestGlyph(wGlyph);
}

function resolveEastDisplay(eastGlyph, absX, absY, boundaryContext) {
  if (!boundaryContext) {
    return interleavedVertFromWestGlyph(eastGlyph);
  }
  const { crop, byPos, z, map } = boundaryContext;
  if (crop.mapContinues?.east && absX === crop.x1) {
    const outside = byPos.get(tileKey3(absX + 1, absY, z));
    if (!outside) return '?';
    return '<';
  }
  return interleavedVertFromWestGlyph(eastGlyph);
}

function resolveNorthHorizDisplay(nGlyph, absX, absY, boundaryContext) {
  let seg = interleavedHorizFromNorthGlyph(nGlyph);
  if (!boundaryContext) {
    return seg;
  }
  const { crop, byPos, z } = boundaryContext;
  if (crop.mapContinues?.north && absY === crop.y0) {
    const outside = byPos.get(tileKey3(absX, absY - 1, z));
    if (!outside) return '???';
    if (seg === '   ') return '~~~';
  }
  if (crop.mapContinues?.south && absY === crop.y1) {
    const outside = byPos.get(tileKey3(absX, absY + 1, z));
    if (!outside && seg === '   ') return '???';
  }
  return seg;
}

/**
 * @param {object} [options.boundaryContext] — { crop, map, byPos, z } for clip/provenance markers
 */
function buildInterleavedAsciiForLevel(level, view, options = {}) {
  const boundaryContext = options.boundaryContext ?? null;
  const crop = view.crop ?? null;
  const x0 = crop?.x0 ?? 0;
  const y0 = crop?.y0 ?? 0;
  const x1 = crop?.x1 ?? view.map.width - 1;
  const y1 = crop?.y1 ?? view.map.height - 1;
  const rowCount = y1 - y0 + 1;
  const colCount = x1 - x0 + 1;

  const { layers } = level;
  const xLabels = [];
  for (let x = x0; x <= x1; x += 1) {
    xLabels.push(String(x).padStart(INTERLEAVED_COL_WIDTH, ' '));
  }

  const textRows = [];
  const annotatedRows = [];

  for (let row = 0; row < rowCount; row += 1) {
    const absY = y0 + row;
    let northLine = '';
    let floorLine = '';
    for (let col = 0; col < colCount; col += 1) {
      const absX = x0 + col;
      const nGlyph = layers.edgeNorth[row][col];
      const wGlyph = layers.edgeWest[row][col];
      const vis = layers.visibility[row][col];
      const fl = layers.floor[row][col];
      const unit = layers.units[row][col];
      northLine += resolveNorthHorizDisplay(nGlyph, absX, absY, boundaryContext);
      const center = interleavedFloorCenter(vis, fl, unit.trim() ? unit : null);
      floorLine += resolveWestDisplay(wGlyph, absX, absY, boundaryContext) + center + ' ';
    }
    const eastGlyph = layers.edgeEast[row][colCount - 1];
    floorLine += resolveEastDisplay(eastGlyph, x1, absY, boundaryContext);
    textRows.push(northLine);
    textRows.push(floorLine);
    annotatedRows.push({ y: absY, kind: 'north_edges', text: northLine });
    annotatedRows.push({ y: absY, kind: 'floor_row', text: floorLine });
  }

  if (boundaryContext?.crop?.mapContinues?.south) {
    const { byPos: bPos, z: bz } = boundaryContext;
    let southClip = '';
    for (let col = 0; col < colCount; col += 1) {
      const absX = x0 + col;
      const outside = bPos.get(tileKey3(absX, y1 + 1, bz));
      southClip += outside ? 'vvv' : '???';
    }
    textRows.push(southClip);
    annotatedRows.push({ y: y1, kind: 'south_clip', text: southClip });
  }

  const boundaryLegend = boundaryContext
    ? {
      '>': 'map_continues_west',
      '<': 'map_continues_east',
      '~~~': 'map_continues_north_passable',
      v: 'map_continues_south_passable',
    }
    : undefined;

  return {
    schemaVersion: 1,
    presentation: 'edge_interleaved',
    provenanceNote:
      'Floors are walkable unless marked x; walls/doors appear on edges only (|---| |-p-|p). '
      + '`:|` off-LOS remembered vertical edge; `:-:` off-LOS horizontal barrier. '
      + '`-p-`/`p` = passable structural edge (not window/breach naming). Spaces = open boundary, not missing data.'
      + (boundaryLegend ? ' `>`/`<`/`~~~`/`v` mark cropped window edges (not walls).' : ''),
    columnLabels: { x0, x1, labels: xLabels },
    colWidth: INTERLEAVED_COL_WIDTH,
    rows: textRows,
    annotatedRows,
    legend: {
      floor: { o: 'walkable', x: 'blocked', ':': 'off_los_discovered', '?': 'undiscovered' },
      verticalEdge: { ' ': 'open_boundary', p: 'passable_structural', '|': 'impassable_wall', D: 'door_closed', d: 'door_open', U: 'door_off_los_state_unknown', '?': 'unknown', ':': 'off_los_wall' },
      horizontalEdge: { '   ': 'open_boundary', '-p-': 'passable_structural', '---': 'impassable_wall', '-D-': 'door_closed', '-d-': 'door_open', '-U-': 'door_off_los_state_unknown', '???': 'unknown', ':-:': 'off_los_barrier' },
      unit: { '@': 'friendly', H: 'hostile', N: 'neutral', M: 'mind_controlled' },
      ...(boundaryLegend ? { cropBoundary: boundaryLegend } : {}),
    },
    byteLength: Buffer.byteLength(textRows.join('\n'), 'utf8'),
  };
}

function measureInterleavedAsciiBytes(interleaved) {
  if (!interleaved?.rows) return 0;
  return Buffer.byteLength(interleaved.rows.join('\n'), 'utf8');
}

/**
 * Primary human-facing map: one interleaved edge + floor presentation (P0 refinement).
 */
function formatEdgeInterleavedForGitHub(view, options = {}) {
  const maxFloorRows = options.maxFloorRows ?? 80;
  const lines = [];
  lines.push('# Tactical map (edge-interleaved)');
  lines.push('');
  lines.push(`Map ${view.map.width}×${view.map.height}×${view.map.depth}`);
  if (view.crop) {
    lines.push(`Crop x=${view.crop.x0}..${view.crop.x1} y=${view.crop.y0}..${view.crop.y1}`);
  }
  lines.push('');
  lines.push('**One view:** horizontal rows are north edges (`---`, `-p-`, `-D-`, spaces = open boundary);');
  lines.push('floor rows put **units in cells** (`@`) and **walls between cells** (`|`, `D`).');
  lines.push('`o` = walkable floor; `w` is **not** used here. Diagnostic composite layers are optional below.');
  lines.push('');
  lines.push('## Legend');
  lines.push('| Edge | Floor |');
  lines.push('|------|-------|');
  lines.push('| `   ` / ` ` = open boundary | `-p-` / `p` passable structural edge | `o` walkable |');
  lines.push('| `---` / `|` = impassable wall | `x` blocked |');
  lines.push('| `-D-` / `D` closed door (semantics only) | `?` undiscovered |');
  lines.push('| `-d-` / `d` open door | `:` off-LOS discovered |');
  lines.push('| `???` unknown edge | `@` soldier |');
  lines.push('');

  for (const level of view.levels) {
    const il = level.interleavedAscii;
    if (!il) continue;
    lines.push(`## Level z=${level.z} — interleaved`);
    lines.push('');
    lines.push(il.provenanceNote);
    lines.push('');
    lines.push('```');
    lines.push(`    ${il.columnLabels.labels.join('')}`);
    let floorShown = 0;
    for (const row of il.annotatedRows) {
      if (row.kind === 'floor_row') {
        floorShown += 1;
        if (floorShown > maxFloorRows) break;
      }
      if (floorShown > maxFloorRows && row.kind === 'north_edges') break;
      const prefix = row.kind === 'north_edges' ? ' n ' : '   ';
      lines.push(`${String(row.y).padStart(2, '0')}${prefix}${row.text}`);
    }
    lines.push('```');
    lines.push('');
    lines.push(`Interleaved text bytes: ${il.byteLength}`);
    lines.push('');
  }

  if (options.includeDiagnosticComposite) {
    lines.push('---');
    lines.push('');
    lines.push(formatTacticalMapForGitHub(view, options));
  }
  return lines.join('\n');
}

module.exports = {
  DEFAULT_LEGEND,
  DOOR_STATE_UNKNOWN_OFF_LOS,
  VIS_UNDISCOVERED,
  VIS_OFF_LOS,
  VIS_IN_LOS,
  visibilityGlyph,
  floorGlyph,
  FLOOR_GRAV_IN_LOS,
  FLOOR_GRAV_OFF_LOS,
  westEdgeGlyph,
  northEdgeGlyph,
  southEdgeGlyph,
  eastEdgeGlyph,
  buildInterleavedAsciiForLevel,
  buildTacticalMapView,
  measureTacticalMapViewBytes,
  measureInterleavedAsciiBytes,
  formatTacticalMapForGitHub,
  formatEdgeInterleavedForGitHub,
};
