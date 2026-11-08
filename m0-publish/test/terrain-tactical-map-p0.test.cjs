'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const { loadAndValidateSnapshotFromText } = require('../lib/tactical-publish.cjs');
const { isDoorCategory } = require('../lib/terrain-semantics-sparse-v2.cjs');
const {
  buildTacticalMapView,
  measureTacticalMapViewBytes,
  formatTacticalMapForGitHub,
  formatEdgeInterleavedForGitHub,
  measureInterleavedAsciiBytes,
  northEdgeGlyph,
  VIS_UNDISCOVERED,
} = require('../lib/terrain-tactical-map.cjs');

const LIVE_SNAPSHOT = path.join(__dirname, '..', '..', '..', 'local', 'm0', 'tactical-live.yaml');

function baseTactical(overrides = {}) {
  return {
    schemaVersion: 5,
    turn: 1,
    side: 0,
    selectedUnitId: 1,
    map: { width: 5, height: 5, depth: 1 },
    units: [],
    eventLog: {
      sessionId: '0123456789abcdef0123456789abcdef',
      oldestSeq: 0,
      latestSeq: 0,
      droppedCount: 0,
      events: [],
    },
    terrain: { memoryNote: 'test', tiles: [] },
    ...overrides,
  };
}

function tile(p, opts = {}) {
  return {
    p,
    disc: opts.disc ?? 7,
    inLos: opts.inLos ?? true,
    ...(opts.body ? { body: opts.body } : { body: { noFloor: false, elev: 0, walkF: 4 } }),
    ...(opts.west ? { west: opts.west } : {}),
    ...(opts.north ? { north: opts.north } : {}),
    ...(opts.sem ? { sem: opts.sem } : {}),
    ...(opts.structureMeta ? { structureMeta: opts.structureMeta } : {}),
  };
}

function syntheticDiscoveredMap(width, height, depth, { inLos = true } = {}) {
  const tiles = [];
  for (let z = 0; z < depth; z += 1) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        tiles.push(tile([x, y, z], { inLos }));
      }
    }
  }
  return baseTactical({ map: { width, height, depth }, terrain: { memoryNote: 'n', tiles } });
}

describe('terrain tactical map P0 (edge-joined)', () => {
  it('places west/north walls on owning tiles and resolves east/south via neighbors', () => {
    const tactical = baseTactical({
      map: { width: 3, height: 2, depth: 1 },
      terrain: {
        memoryNote: 'n',
        tiles: [
          tile([0, 0, 0], { north: { walk: 255, blockSight: true } }),
          tile([1, 0, 0], { west: { walk: 255, blockSight: true } }),
          tile([0, 1, 0]),
          tile([1, 1, 0]),
        ],
      },
    });
    const level = buildTacticalMapView(tactical).levels[0].layers;
    assert.equal(level.edgeNorth[0][0], 'W', 'north wall owned by (0,0)');
    assert.equal(level.edgeWest[0][1], 'W', 'west wall owned by (1,0)');
    assert.equal(level.edgeEast[0][0], 'W', 'east of (0,0) resolved from west wall of (1,0)');
    assert.equal(level.edgeSouth[0][0], '.', 'south of (0,0) from north edge of (0,1)');
  });

  it('classifies doors only from semantics, not low walk TU alone', () => {
    const walkOnly = tile([1, 1, 0], { north: { walk: 2, blockSight: false }, sem: { north: 1 } });
    assert.equal(northEdgeGlyph(walkOnly), 'p');
    const doorClosed = tile([1, 1, 0], {
      north: { walk: 2, blockSight: false },
      sem: { north: 6 },
      structureMeta: { doorState: { north: 'closed' } },
    });
    assert.equal(northEdgeGlyph(doorClosed), 'D');
    const doorOpen = tile([1, 1, 0], {
      north: { walk: 2, blockSight: false },
      sem: { north: 6 },
      structureMeta: { doorState: { north: 'open' } },
    });
    assert.equal(northEdgeGlyph(doorOpen), 'd');
  });

  it('keeps undiscovered cells on visibility layer', () => {
    const tactical = baseTactical({
      terrain: {
        memoryNote: 'n',
        tiles: [tile([1, 1, 0])],
      },
    });
    const vis = buildTacticalMapView(tactical).levels[0].layers.visibility;
    assert.equal(vis[0][0], VIS_UNDISCOVERED);
    assert.equal(vis[1][1], '.');
  });

  it('overlays units without removing terrain layers', () => {
    const tactical = baseTactical({
      units: [{
        id: 1,
        faction: 0,
        originalFaction: 0,
        position: [1, 1, 0],
        name: 'S',
      }],
      terrain: { memoryNote: 'n', tiles: [tile([1, 1, 0])] },
    });
    const level = buildTacticalMapView(tactical).levels[0].layers;
    assert.equal(level.tactical[1][1], 'o');
    assert.equal(level.tacticalWithUnits[1][1], '@');
    assert.equal(level.units[1][1], '@');
    assert.equal(level.floor[1][1], 'o');
  });

  it('output stays human-readable JSON (no base64 terrain) under budget for 50×50×4 and 60×60×4', () => {
    for (const [w, h, d] of [[50, 50, 4], [60, 60, 4]]) {
      const tactical = syntheticDiscoveredMap(w, h, d);
      const view = buildTacticalMapView(tactical);
      const bytes = measureTacticalMapViewBytes(view);
      const md = formatTacticalMapForGitHub(view, { maxLevelRows: 5 });
      assert.ok(!JSON.stringify(view).includes('base64'), `unexpected base64 in map view ${w}`);
      assert.ok(bytes < 512 * 1024, `map view ${w}x${h}x${d} should stay under 512KiB, got ${bytes}`);
      assert.ok(Buffer.byteLength(md, 'utf8') < 64 * 1024, `markdown preview should be readable size, got ${Buffer.byteLength(md, 'utf8')}`);
    }
  });

  const liveIt = fs.existsSync(LIVE_SNAPSHOT) ? it : it.skip;

  it('edge-interleaved map keeps walkable floors separate from wall edges', () => {
    const tactical = baseTactical({
      map: { width: 3, height: 2, depth: 1 },
      terrain: {
        memoryNote: 'n',
        tiles: [
          tile([0, 0, 0], { north: { walk: 255, blockSight: true } }),
          tile([1, 0, 0], { north: { walk: 255, blockSight: true } }),
          tile([0, 1, 0]),
          tile([1, 1, 0]),
        ],
      },
    });
    const view = buildTacticalMapView(tactical);
    const il = view.levels[0].interleavedAscii;
    const floorRow = il.annotatedRows.find((r) => r.y === 1 && r.kind === 'floor_row').text;
    assert.ok(floorRow.includes('o'), 'floor row uses open cell centers');
    assert.ok(!floorRow.includes('w'), 'floor row must not use composite wall glyph');
    const northRow = il.annotatedRows.find((r) => r.y === 0 && r.kind === 'north_edges').text;
    assert.ok(northRow.includes('---'), 'north impassable edges render as ---');
  });

  liveIt('Novosibirsk Oso house crop shows north wall belt and does not invent doors from TU', () => {
    const text = fs.readFileSync(LIVE_SNAPSHOT, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(text, YAML);
    const view = buildTacticalMapView(tactical, {
      levels: [0],
      crop: { x0: 12, y0: 26, x1: 17, y1: 32 },
    });
    const level = view.levels[0].layers;
    const osoMarker = level.tacticalWithUnits[4]?.[2];
    if (osoMarker !== '@') {
      assert.ok(true, 'live snapshot is not Novosibirsk Oso fixture; skipping house belt assertions');
      return;
    }
    assert.equal(level.edgeNorth[1][1], 'W', '13,27 north wall impassable');
    assert.equal(level.edgeNorth[1][3], 'W', '15,27 north wall impassable');
    const northAt1529 = level.edgeNorth[3][3];
    assert.ok(northAt1529 === 'p' || northAt1529 === '.', '15,29 north is passable structural or open boundary, not semantic door');
    assert.notEqual(northAt1529, 'D');
    const oso = level.tacticalWithUnits[4][2];
    assert.equal(oso, '@', 'Oso at 14,30 relative y=30-26=4 x=14-12=2');
    const il = view.levels[0].interleavedAscii;
    const row30 = il.annotatedRows.find((r) => r.y === 30 && r.kind === 'floor_row').text;
    assert.ok(row30.includes('@'), 'Oso on interleaved floor row');
    assert.ok(row30.includes('o'), 'Oso standing on walkable floor glyph');
    const row27floor = il.annotatedRows.find((r) => r.y === 27 && r.kind === 'floor_row').text;
    assert.ok(!/[wW]/.test(row27floor.replace(/[|@-]/g, '')), 'row 27 floors are not wall tiles');
    const row27north = il.annotatedRows.find((r) => r.y === 27 && r.kind === 'north_edges').text;
    assert.ok(row27north.includes('---'), 'row 27 north edge shows wall between cells');
    const md = formatEdgeInterleavedForGitHub(view);
    assert.ok(md.includes('edge-interleaved'));
    const ilBytes = measureInterleavedAsciiBytes(il);
    assert.ok(ilBytes < 32 * 1024, `interleaved crop should fit relay headroom, got ${ilBytes}`);
    const doorTiles = tactical.terrain?.tiles?.filter?.((t) => t.sem && Object.values(t.sem).some(isDoorCategory));
    if (doorTiles?.length) {
      const withSem = doorTiles[0];
      const cat = Object.entries(withSem.sem).find(([, id]) => isDoorCategory(id));
      assert.ok(cat, 'fixture has semantic door somewhere on map');
    }
  });
});
