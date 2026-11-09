'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const {
  loadAndValidateSnapshotFromText,
  computeSnapshotId,
} = require('../lib/tactical-publish.cjs');
const {
  buildTacticalMapWindowV2,
  MAX_TACTICAL_MAP_WINDOW_V2_BYTES,
  selectLevels,
  computeFocusWindow,
  gravColumnSymmetricLevelsInWindow,
} = require('../lib/terrain-tactical-map-window-v2.cjs');
const { decodeTerrainTiles } = require('../lib/terrain-brief.cjs');

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
    ...(opts.structureMeta ? { structureMeta: opts.structureMeta } : {}),
    ...(opts.sem ? { sem: opts.sem } : {}),
  };
}

function gravTile(p, extra = {}) {
  return tile(p, {
    structureMeta: { floorGravLift: true, inLosAtExport: true },
    ...extra,
  });
}

function indexByPos(tiles) {
  const map = new Map();
  for (const t of tiles) {
    map.set(`${t.p[0]},${t.p[1]},${t.p[2]}`, t);
  }
  return map;
}

describe('tacticalMapWindowV2 P1D grav-aware level selection', () => {
  it('A0 — maxExtraLevels:0 with triple grav keeps focus Z only (explicit cap)', () => {
    const tactical = baseTactical({
      map: { width: 8, height: 8, depth: 4 },
      units: [{
        id: 1, faction: 0, originalFaction: 0, position: [4, 4, 1], name: 'Mid',
      }],
      terrain: {
        memoryNote: 'n',
        tiles: [0, 1, 2].map((z) => gravTile([4, 4, z])),
      },
    });
    const win = buildTacticalMapWindowV2(tactical, { windowSize: 6, maxExtraLevels: 0 });
    assert.deepEqual(win.levelSelection.includedLevels, [1]);
    assert.equal(win.levelSelection.gravColumnInWindow, undefined);
  });

  it('A — three-high discovered grav column, focus z=1 includes [0,1,2]', () => {
    const tactical = baseTactical({
      map: { width: 8, height: 8, depth: 4 },
      units: [{
        id: 1, faction: 0, originalFaction: 0, position: [4, 4, 1], name: 'Mid',
      }],
      terrain: {
        memoryNote: 'n',
        tiles: [
          gravTile([4, 4, 0]),
          gravTile([4, 4, 1]),
          gravTile([4, 4, 2]),
        ],
      },
    });
    const win = buildTacticalMapWindowV2(tactical, { windowSize: 6, maxExtraLevels: 1 });
    assert.deepEqual(win.levelSelection.includedLevels, [0, 1, 2]);
    assert.equal(win.levelSelection.gravColumnInWindow, true);
    assert.ok(!win.levelSelection.omittedLevels.includes(2));
  });

  it('B — normal two-level grav (no triple column) unchanged with maxExtraLevels=1', () => {
    const tactical = baseTactical({
      map: { width: 8, height: 8, depth: 3 },
      units: [{
        id: 1, faction: 0, originalFaction: 0, position: [4, 4, 0], name: 'Ramp',
      }],
      terrain: {
        memoryNote: 'n',
        tiles: [
          gravTile([4, 4, 0], { inLos: true }),
          gravTile([4, 4, 1], { inLos: false }),
        ],
      },
    });
    const win = buildTacticalMapWindowV2(tactical, { windowSize: 5, maxExtraLevels: 1 });
    assert.deepEqual(win.levelSelection.includedLevels, [0, 1]);
    assert.equal(win.levelSelection.gravColumnInWindow, undefined);
  });

  it('C — no grav structure: does not expand to three Z', () => {
    const tactical = baseTactical({
      map: { width: 10, height: 10, depth: 4 },
      units: [{
        id: 1, faction: 0, originalFaction: 0, position: [5, 5, 1], name: 'A',
      }],
      terrain: {
        memoryNote: 'n',
        tiles: [tile([5, 5, 0]), tile([5, 5, 1]), tile([5, 5, 2])],
      },
    });
    const win = buildTacticalMapWindowV2(tactical, { maxExtraLevels: 1 });
    assert.deepEqual(win.levelSelection.includedLevels, [1]);
    assert.equal(win.levelSelection.gravColumnInWindow, undefined);
  });

  it('D — four-high grav column: [0,1,2] included, z=3 omitted', () => {
    const tactical = baseTactical({
      map: { width: 8, height: 8, depth: 5 },
      units: [{
        id: 1, faction: 0, originalFaction: 0, position: [4, 4, 1], name: 'Mid',
      }],
      terrain: {
        memoryNote: 'n',
        tiles: [0, 1, 2, 3].map((z) => gravTile([4, 4, z])),
      },
    });
    const win = buildTacticalMapWindowV2(tactical, { windowSize: 6, maxExtraLevels: 1 });
    assert.deepEqual(win.levelSelection.includedLevels, [0, 1, 2]);
    assert.ok(win.levelSelection.omittedLevels.includes(3));
  });

  it('E — fog: missing z=2 record does not invent triple column', () => {
    const tactical = baseTactical({
      map: { width: 8, height: 8, depth: 4 },
      units: [{
        id: 1, faction: 0, originalFaction: 0, position: [4, 4, 1], name: 'Mid',
      }],
      terrain: {
        memoryNote: 'n',
        tiles: [gravTile([4, 4, 0]), gravTile([4, 4, 1])],
      },
    });
    const win = buildTacticalMapWindowV2(tactical, { maxExtraLevels: 1, windowSize: 6 });
    assert.deepEqual(win.levelSelection.includedLevels, [0, 1]);
    assert.equal(win.levelSelection.gravColumnInWindow, undefined);
  });

  it('F — grav column outside window does not alter selection', () => {
    const tactical = baseTactical({
      map: { width: 30, height: 30, depth: 4 },
      units: [{
        id: 1, faction: 0, originalFaction: 0, position: [5, 5, 1], name: 'Mid',
      }],
      terrain: {
        memoryNote: 'n',
        tiles: [0, 1, 2].map((z) => gravTile([25, 25, z])),
      },
    });
    const win = buildTacticalMapWindowV2(tactical, { windowSize: 8, maxExtraLevels: 1 });
    assert.deepEqual(win.levelSelection.includedLevels, [1]);
    assert.equal(win.levelSelection.gravColumnInWindow, undefined);
  });

  it('G — capacity: triple grav 50×50 under 32 KiB', () => {
    const tiles = [];
    for (let z = 0; z < 4; z += 1) {
      for (let y = 0; y < 50; y += 1) {
        for (let x = 0; x < 50; x += 1) {
          const grav = x === 20 && y === 20;
          tiles.push(
            grav
              ? gravTile([x, y, z])
              : tile([x, y, z], { inLos: x >= 8 && x <= 31 && y >= 8 && y <= 31 }),
          );
        }
      }
    }
    const tactical = baseTactical({
      map: { width: 50, height: 50, depth: 4 },
      units: [{
        id: 1, faction: 0, originalFaction: 0, position: [20, 20, 1], name: 'Mid',
      }],
      terrain: { memoryNote: 'n', tiles },
    });
    const win = buildTacticalMapWindowV2(tactical, { maxExtraLevels: 1 });
    assert.ok(win.byteLength <= MAX_TACTICAL_MAP_WINDOW_V2_BYTES);
    assert.deepEqual(win.levelSelection.includedLevels, [0, 1, 2]);
  });

  it('H — determinism: byte-identical JSON on repeat', () => {
    const tactical = baseTactical({
      map: { width: 8, height: 8, depth: 4 },
      units: [{
        id: 1, faction: 0, originalFaction: 0, position: [4, 4, 1], name: 'Mid',
      }],
      terrain: {
        memoryNote: 'n',
        tiles: [0, 1, 2].map((z) => gravTile([4, 4, z])),
      },
    });
    const a = JSON.stringify(buildTacticalMapWindowV2(tactical, { maxExtraLevels: 1 }));
    const b = JSON.stringify(buildTacticalMapWindowV2(tactical, { maxExtraLevels: 1 }));
    assert.equal(a, b);
  });

  it('J — snapshot_id unchanged by level policy', () => {
    const tactical = baseTactical({
      map: { width: 8, height: 8, depth: 4 },
      terrain: {
        memoryNote: 'n',
        tiles: [0, 1, 2].map((z) => gravTile([4, 4, z])),
      },
    });
    const id = computeSnapshotId(tactical);
    const win = buildTacticalMapWindowV2(tactical, { maxExtraLevels: 1 });
    assert.equal(win.snapshot_id, id);
  });

  it('selectLevels / gravColumnSymmetricLevelsInWindow unit checks', () => {
    const tactical = baseTactical({
      map: { width: 8, height: 8, depth: 4 },
    });
    const tiles = decodeTerrainTiles({ ...tactical, terrain: { tiles: [0, 1, 2].map((z) => gravTile([4, 4, z])) } });
    const byPos = indexByPos(tiles);
    const crop = computeFocusWindow(tactical.map, [4, 4, 1], 6);
    const gravSet = gravColumnSymmetricLevelsInWindow(crop, 1, 4, byPos);
    assert.deepEqual([...gravSet].sort(), [0, 1, 2]);
    const sel = selectLevels(
      { ...tactical, terrain: { tiles } },
      { position: [4, 4, 1] },
      crop,
      byPos,
      { maxExtraLevels: 1 },
    );
    assert.deepEqual(sel.includedLevels, [0, 1, 2]);
  });
});

describe('tacticalMapWindowV2 P1D live snapshot (optional)', () => {
  const liveIt = fs.existsSync(LIVE_SNAPSHOT) ? it : it.skip;
  liveIt('default publish maxExtraLevels=1 still ≤ 32 KiB', () => {
    const text = fs.readFileSync(LIVE_SNAPSHOT, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(text, YAML);
    const win = buildTacticalMapWindowV2(tactical, { maxExtraLevels: 1 });
    assert.ok(win.byteLength <= MAX_TACTICAL_MAP_WINDOW_V2_BYTES);
  });
});
