'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const { loadAndValidateSnapshotFromText } = require('../lib/tactical-publish.cjs');
const {
  buildTacticalMapView,
  northEdgeGlyph,
  westEdgeGlyph,
  buildInterleavedAsciiForLevel,
  measureInterleavedAsciiBytes,
} = require('../lib/terrain-tactical-map.cjs');
const {
  buildTerrainMapBrief,
  MAX_TERRAIN_MAP_BRIEF_BYTES,
  DEFAULT_WINDOW_SIZE,
} = require('../lib/terrain-map-brief.cjs');
const { decodeTerrainTiles } = require('../lib/terrain-brief.cjs');
const { computeFocusWindow } = require('../lib/terrain-map-brief.cjs');

const LIVE_SNAPSHOT = path.join(__dirname, '..', '..', '..', 'local', 'm0', 'tactical-live.yaml');
const LEON_POS = [25, 28, 0];

function tileAt(tactical, x, y, z) {
  const tiles = decodeTerrainTiles(tactical);
  return tiles.find((t) => t.p[0] === x && t.p[1] === y && t.p[2] === z);
}

describe('P1.1 passable structural edges (Leon alien-base fixture)', () => {
  const liveIt = fs.existsSync(LIVE_SNAPSHOT) ? it : it.skip;

  liveIt('edge glyphs distinguish passable structural parts from impassable walls', () => {
    const tactical = loadAndValidateSnapshotFromText(fs.readFileSync(LIVE_SNAPSHOT, 'utf8'), YAML);
    const leon = tactical.units.find((u) => u.id === 8);
    assert.ok(leon);
    assert.deepEqual(leon.position, LEON_POS);

    const windowTile = tileAt(tactical, 34, 27, 0);
    const breachTile = tileAt(tactical, 35, 27, 0);
    assert.ok(windowTile?.north);
    assert.ok(breachTile?.west);

    assert.equal(northEdgeGlyph(windowTile), 'p');
    assert.equal(westEdgeGlyph(breachTile), 'p');

    for (const x of [30, 31, 32, 33]) {
      const t = tileAt(tactical, x, 27, 0);
      assert.equal(northEdgeGlyph(t), 'W', `impassable north at ${x},27`);
    }

    const openNorth = tileAt(tactical, 36, 27, 0);
    assert.ok(!openNorth.north);
    assert.notEqual(northEdgeGlyph(openNorth), 'p');
    assert.notEqual(northEdgeGlyph(openNorth), 'W');
  });

  liveIt('interleaved map shows -p- and p for Leon 20×20 window without x=35', () => {
    const tactical = loadAndValidateSnapshotFromText(fs.readFileSync(LIVE_SNAPSHOT, 'utf8'), YAML);
    const leon = tactical.units.find((u) => u.id === 8);
    const crop = computeFocusWindow(tactical.map, leon.position, DEFAULT_WINDOW_SIZE);
    assert.equal(crop.x0, 15);
    assert.equal(crop.x1, 34);
    assert.equal(crop.y0, 18);
    assert.equal(crop.y1, 37);

    const view = buildTacticalMapView(tactical, {
      levels: [0],
      crop: { x0: crop.x0, y0: crop.y0, x1: crop.x1, y1: crop.y1 },
    });
    const level = view.levels[0];
    const relX = (x) => x - crop.x0;
    const relY = (y) => y - crop.y0;

    assert.equal(level.layers.edgeNorth[relY(27)][relX(34)], 'p');

    for (const x of [30, 31, 32, 33]) {
      assert.equal(level.layers.edgeNorth[relY(27)][relX(x)], 'W');
    }

    const tiles = decodeTerrainTiles(tactical);
    const byPos = new Map(tiles.map((t) => [t.p.join(','), t]));
    const interleaved = buildInterleavedAsciiForLevel(
      level,
      { map: tactical.map, crop: { ...crop, mapContinues: crop.mapContinues } },
      { boundaryContext: { crop: { ...crop, mapContinues: crop.mapContinues }, map: tactical.map, byPos, z: 0 } },
    );

    const north27 = interleaved.annotatedRows.find((r) => r.y === 27 && r.kind === 'north_edges');
    assert.ok(north27.text.includes('-p-'), 'passable north structural edge renders as -p-');
    for (const x of [30, 31, 32, 33]) {
      const col = relX(x);
      const seg = north27.text.slice(col * 3, col * 3 + 3);
      assert.equal(seg, '---', `x=${x} north impassable segment`);
    }

    const floor27 = interleaved.annotatedRows.find((r) => r.y === 27 && r.kind === 'floor_row');
    assert.ok(floor27.text.endsWith('<'), 'x=35 excluded: east clip shows continuation, not breach west p');

    assert.equal(crop.x1, 34);
    assert.equal(level.layers.edgeWest[relY(27)].length, crop.width);
  });

  liveIt('terrainMapBrief stays within byte ceiling with new edge glyphs', () => {
    const tactical = loadAndValidateSnapshotFromText(fs.readFileSync(LIVE_SNAPSHOT, 'utf8'), YAML);
    const leon = tactical.units.find((u) => u.id === 8);
    const brief = buildTerrainMapBrief(tactical, {
      focus: {
        soldierId: leon.id,
        soldierName: leon.name,
        position: [...leon.position],
      },
    });
    assert.ok(brief.mapText.includes('-p-'), 'brief shows passable structural north edges');
    assert.ok(brief.byteLength <= MAX_TERRAIN_MAP_BRIEF_BYTES);
    assert.ok(brief.window.x1 === 34);
  });
});
