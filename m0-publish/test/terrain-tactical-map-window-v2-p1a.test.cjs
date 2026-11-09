'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');
const YAML = require('yaml');
const {
  loadAndValidateSnapshotFromText,
  buildRelayPayload,
  computeSnapshotId,
} = require('../lib/tactical-publish.cjs');
const { buildTerrainBrief } = require('../lib/terrain-brief.cjs');
const { buildTerrainMapBrief: buildMapBrief } = require('../lib/terrain-map-brief.cjs');
const { buildFullAsciiBattlefieldMap } = require('../lib/terrain-full-ascii-battlefield.cjs');
const { WALK_IMPASSABLE } = require('../lib/terrain-brief.cjs');
const {
  buildTacticalMapWindowV2,
  DEFAULT_WINDOW_SIZE,
  MAX_TACTICAL_MAP_WINDOW_V2_BYTES,
  assertAsciiLayerCompatibility,
  measureTacticalMapWindowV2Bytes,
  DOOR_STATE_UNKNOWN_OFF_LOS,
  VIS_UNDISCOVERED,
  computeFocusWindow,
} = require('../lib/terrain-tactical-map-window-v2.cjs');
const {
  northEdgeGlyph,
  westEdgeGlyph,
  floorGlyph,
} = require('../lib/terrain-tactical-map.cjs');

const LIVE_SNAPSHOT = path.join(__dirname, '..', '..', '..', 'local', 'm0', 'tactical-live.yaml');

function baseTactical(overrides = {}) {
  return {
    schemaVersion: 5,
    turn: 1,
    side: 0,
    selectedUnitId: 1,
    map: { width: 10, height: 10, depth: 1 },
    units: [{
      id: 1,
      faction: 0,
      originalFaction: 0,
      position: [5, 5, 0],
      name: 'Lead',
    }],
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

function deterministicId(tactical) {
  return computeSnapshotId(tactical);
}

describe('tacticalMapWindowV2 P1A', () => {
  it('1 — ground-level open terrain', () => {
    const tiles = [];
    for (let y = 4; y <= 6; y += 1) {
      for (let x = 4; x <= 6; x += 1) {
        tiles.push(tile([x, y, 0]));
      }
    }
    const tactical = baseTactical({ terrain: { memoryNote: 'n', tiles } });
    const win = buildTacticalMapWindowV2(tactical, { windowSize: 5 });
    assert.equal(win.levels[0].layers.floor[2][2], 'o');
    assert.equal(win.levels[0].layers.visibility[2][2], '.');
  });

  it('2 — walls and blocked movement', () => {
    const tactical = baseTactical({
      map: { width: 5, height: 5, depth: 1 },
      units: [{
        id: 1, faction: 0, originalFaction: 0, position: [2, 2, 0], name: 'S',
      }],
      terrain: {
        memoryNote: 'n',
        tiles: [
          tile([2, 2, 0], { north: { walk: WALK_IMPASSABLE, blockSight: true } }),
          tile([2, 3, 0]),
        ],
      },
    });
    const win = buildTacticalMapWindowV2(tactical, { windowSize: 5 });
    const layers = win.levels[0].layers;
    assert.equal(layers.edgeNorth[2][2], 'W');
    assert.equal(northEdgeGlyph(tile([2, 2, 0], { north: { walk: 255, blockSight: true } })), 'W');
  });

  it('3 — closed and open doors in LOS', () => {
    const closed = tile([3, 3, 0], {
      north: { walk: 2, blockSight: false },
      sem: { north: 6 },
      structureMeta: { doorState: { north: 'closed' } },
    });
    const open = tile([4, 3, 0], {
      west: { walk: 2, blockSight: false },
      sem: { west: 6 },
      structureMeta: { doorState: { west: 'open' } },
    });
    assert.equal(northEdgeGlyph(closed), 'D');
    assert.equal(westEdgeGlyph(open), 'd');
    const tactical = baseTactical({
      terrain: { memoryNote: 'n', tiles: [closed, open, tile([3, 4, 0]), tile([4, 4, 0])] },
    });
    const win = buildTacticalMapWindowV2(tactical, { windowSize: 6 });
    assert.equal(win.levels[0].layers.edgeNorth[1][1], 'D');
    assert.equal(win.levels[0].layers.edgeWest[1][2], 'd');
  });

  it('4 — off-LOS unknown door state', () => {
    const offLos = tile([6, 6, 0], {
      inLos: false,
      north: { walk: 2, blockSight: false },
      sem: { north: 6 },
    });
    assert.equal(northEdgeGlyph(offLos), DOOR_STATE_UNKNOWN_OFF_LOS);
    const tactical = baseTactical({ terrain: { memoryNote: 'n', tiles: [offLos, tile([6, 7, 0], { inLos: false })] } });
    const win = buildTacticalMapWindowV2(tactical, { windowSize: 10 });
    assert.equal(win.levels[0].layers.edgeNorth[6][6], 'U');
    assert.ok(!JSON.stringify(win).includes('"open"'), 'no door state disclosure off-LOS');
  });

  it('5 — multi-level Skyranger ramp (G/g grav floor)', () => {
    const tactical = baseTactical({
      map: { width: 8, height: 8, depth: 3 },
      units: [{
        id: 1, faction: 0, originalFaction: 0, position: [4, 4, 0], name: 'Ramp',
      }],
      terrain: {
        memoryNote: 'n',
        tiles: [
          tile([4, 4, 0], { structureMeta: { floorGravLift: true }, inLos: true }),
          tile([4, 4, 1], { structureMeta: { floorGravLift: true }, inLos: false }),
        ],
      },
    });
    const win = buildTacticalMapWindowV2(tactical, { windowSize: 5 });
    assert.ok(win.levelSelection.includedLevels.includes(0));
    assert.ok(win.levelSelection.includedLevels.includes(1));
    const g0 = win.levels.find((l) => l.z === 0);
    assert.ok(g0.layers.floor.some((row) => row.includes('G')));
    const g1 = win.levels.find((l) => l.z === 1);
    assert.ok(g1.layers.floor.some((row) => row.includes('g')));
    assert.ok(g0.verticalTransitions.some((v) => v.kind === 'floor_grav_lift'));
  });

  it('6 — grav lift semantic category in window', () => {
    const gravSem = tile([5, 5, 0], { sem: { body: 8 } });
    const tactical = baseTactical({ terrain: { memoryNote: 'n', tiles: [gravSem] } });
    const win = buildTacticalMapWindowV2(tactical, { windowSize: 5 });
    assert.ok(win.levels[0].verticalTransitions.some((v) => v.category === 'GRAV_LIFT'));
  });

  it('7 — roof z=3 air cells', () => {
    const tiles = [tile([5, 5, 3], { body: { noFloor: false, elev: 0, walkF: 4, air: true } })];
    const tactical = baseTactical({
      map: { width: 10, height: 10, depth: 4 },
      units: [{
        id: 1, faction: 0, originalFaction: 0, position: [5, 5, 3], name: 'Roof',
      }],
      terrain: { memoryNote: 'n', tiles },
    });
    const win = buildTacticalMapWindowV2(tactical, { levels: [3], windowSize: 5 });
    assert.equal(win.levels[0].layers.floor[2][2], 'A');
    assert.equal(win.levels[0].layers.visibility[2][2], '.');
  });

  it('8 — multi-storey friendly levels reported for on-demand query', () => {
    const tactical = baseTactical({
      map: { width: 10, height: 10, depth: 4 },
      units: [
        { id: 1, faction: 0, originalFaction: 0, position: [5, 5, 0], name: 'A' },
        { id: 2, faction: 0, originalFaction: 0, position: [5, 5, 2], name: 'B' },
      ],
      terrain: {
        memoryNote: 'n',
        tiles: [tile([5, 5, 0]), tile([5, 5, 2])],
      },
    });
    const win = buildTacticalMapWindowV2(tactical, { maxExtraLevels: 0 });
    assert.equal(win.levelSelection.primaryZ, 0);
    assert.ok(win.levelSelection.onDemandLevels.includes(2));
    assert.ok(win.levelSelection.friendlyLevels.includes(2));
  });

  it('9 — unknown cells stay unknown', () => {
    const tactical = baseTactical({
      terrain: { memoryNote: 'n', tiles: [tile([5, 5, 0])] },
    });
    const win = buildTacticalMapWindowV2(tactical, { windowSize: 5 });
    assert.ok(win.levels[0].layers.visibility[0].includes(VIS_UNDISCOVERED));
    assert.ok(win.levels[0].layers.floor[0].includes(VIS_UNDISCOVERED));
  });

  it('10 — boundary window mapContinues flags', () => {
    const tactical = baseTactical({
      map: { width: 30, height: 30, depth: 1 },
      units: [{
        id: 1, faction: 0, originalFaction: 0, position: [2, 2, 0], name: 'Corner',
      }],
      terrain: { memoryNote: 'n', tiles: [tile([2, 2, 0])] },
    });
    const win = buildTacticalMapWindowV2(tactical, { windowSize: 8 });
    const w = win.levels[0].window;
    assert.equal(w.x0, 0);
    assert.equal(w.y0, 0);
    assert.equal(w.mapContinues.west, false);
    assert.equal(w.mapContinues.east, true);
  });

  it('11 — snapshot identity preserved on relay build', () => {
    const tactical = baseTactical({
      terrain: { memoryNote: 'n', tiles: [tile([5, 5, 0])] },
    });
    const snapshotId = deterministicId(tactical);
    const relay = buildRelayPayload(
      tactical,
      new Date().toISOString(),
      {
        request_id: crypto.randomBytes(16).toString('hex'),
        session_id: tactical.eventLog.sessionId,
        turn: tactical.turn,
      },
    );
    assert.equal(relay.snapshot_id, snapshotId);
    assert.ok(relay.tacticalMapWindowV2);
    assert.equal(relay.tacticalMapWindowV2.snapshot_id, snapshotId);
  });

  it('12 — deterministic output for same tactical', () => {
    const tactical = baseTactical({
      terrain: { memoryNote: 'n', tiles: [tile([5, 5, 0]), tile([6, 5, 0])] },
    });
    const a = JSON.stringify(buildTacticalMapWindowV2(tactical));
    const b = JSON.stringify(buildTacticalMapWindowV2(tactical));
    assert.equal(a, b);
  });

  it('13 — relay size limits and byte ceiling', () => {
    const tactical = baseTactical({
      map: { width: 50, height: 50, depth: 1 },
      terrain: {
        memoryNote: 'n',
        tiles: (() => {
          const out = [];
          for (let y = 0; y < 50; y += 1) {
            for (let x = 0; x < 50; x += 1) {
              out.push(tile([x, y, 0]));
            }
          }
          return out;
        })(),
      },
    });
    const win = buildTacticalMapWindowV2(tactical);
    assert.ok(win.byteLength <= MAX_TACTICAL_MAP_WINDOW_V2_BYTES);
    assert.equal(win.levels[0].window.width, DEFAULT_WINDOW_SIZE);
  });

  it('14 — existing ASCII layer compatibility', () => {
    const tactical = baseTactical({
      terrain: {
        memoryNote: 'n',
        tiles: [
          tile([5, 5, 0], { north: { walk: 255, blockSight: true } }),
          tile([6, 5, 0]),
          tile([5, 6, 0]),
          tile([6, 6, 0]),
        ],
      },
    });
    const win = buildTacticalMapWindowV2(tactical, { windowSize: 6 });
    assertAsciiLayerCompatibility(tactical, win);
  });

  it('15 — no new fog-of-war disclosure beyond exported glyphs', () => {
    const tactical = baseTactical({
      terrain: {
        memoryNote: 'n',
        tiles: [
          tile([5, 5, 0], { inLos: false, disc: 7 }),
        ],
      },
    });
    const win = buildTacticalMapWindowV2(tactical, { windowSize: 5 });
    const json = JSON.stringify(win);
    assert.ok(!json.includes('walkF'));
    assert.ok(!json.includes('blockSight'));
    assert.ok(win.fogOfWar.offLosDoorState);
    assert.equal(win.levels[0].layers.visibility[2][2], ':');
    assert.equal(win.levels[0].layers.visibility[2][1], VIS_UNDISCOVERED);
  });

  it('default window size is 24×24', () => {
    const tactical = baseTactical({
      map: { width: 40, height: 40, depth: 1 },
      terrain: { memoryNote: 'n', tiles: [tile([20, 20, 0])] },
      units: [{
        id: 1, faction: 0, originalFaction: 0, position: [20, 20, 0], name: 'Mid',
      }],
    });
    const crop = computeFocusWindow(tactical.map, [20, 20, 0], DEFAULT_WINDOW_SIZE);
    const win = buildTacticalMapWindowV2(tactical);
    assert.equal(crop.width, 24);
    assert.equal(win.levels[0].window.width, 24);
  });
});

describe('tacticalMapWindowV2 byte comparisons (synthetic)', () => {
  it('v2 layer window vs terrainMapBrief vs terrainBrief on dense 10×10', () => {
    const tiles = [];
    for (let y = 0; y < 10; y += 1) {
      for (let x = 0; x < 10; x += 1) {
        tiles.push(tile([x, y, 0]));
      }
    }
    const tactical = baseTactical({ terrain: { memoryNote: 'n', tiles } });
    const v2 = measureTacticalMapWindowV2Bytes(buildTacticalMapWindowV2(tactical, { windowSize: 10 }));
    const mapBrief = Buffer.byteLength(JSON.stringify(buildMapBrief(tactical, { windowSize: 10 })), 'utf8');
    const brief = Buffer.byteLength(JSON.stringify(buildTerrainBrief(tactical)), 'utf8');
    assert.ok(v2 < brief, 'v2 window should be smaller than full terrainBrief on dense map');
    assert.ok(v2 < 24 * 1024, 'v2 stays under relay window budget cap');
  });
});

describe('tacticalMapWindowV2 live snapshot (optional)', () => {
  const liveIt = fs.existsSync(LIVE_SNAPSHOT) ? it : it.skip;

  liveIt('live relay includes v2 under budget', () => {
    const text = fs.readFileSync(LIVE_SNAPSHOT, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(text, YAML);
    const win = buildTacticalMapWindowV2(tactical);
    assert.equal(win.snapshot_id, computeSnapshotId(tactical));
    assert.ok(win.byteLength <= MAX_TACTICAL_MAP_WINDOW_V2_BYTES);
    assertAsciiLayerCompatibility(tactical, win);
    const mapBriefBytes = Buffer.byteLength(JSON.stringify(buildMapBrief(tactical)), 'utf8');
    const fullAsciiBytes = Buffer.byteLength(JSON.stringify(buildFullAsciiBattlefieldMap(tactical)), 'utf8');
    assert.ok(win.byteLength < fullAsciiBytes);
    assert.ok(win.byteLength > mapBriefBytes * 0.5);
  });
});
