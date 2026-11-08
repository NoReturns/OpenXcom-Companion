'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const { decodeTerrainTiles } = require('../lib/terrain-brief.cjs');
const { categoryLabel } = require('../lib/terrain-semantics-sparse-v1.cjs');
const { isFloorGravLiftTile } = require('../lib/terrain-grav-lift-floor.cjs');
const { buildGravLiftStructures, footprintStatusForLevel } = require('../lib/terrain-grav-lift-structures.cjs');
const { floorGlyph, FLOOR_GRAV_IN_LOS, FLOOR_GRAV_OFF_LOS } = require('../lib/terrain-tactical-map.cjs');
const { buildFullAsciiBattlefieldMap } = require('../lib/terrain-full-ascii-battlefield.cjs');
const { estimateRelayBytesWithFullAscii } = require('../lib/terrain-full-ascii-battlefield.cjs');

function baseTactical(overrides = {}) {
  return {
    schemaVersion: 5,
    turn: 1,
    side: 0,
    map: { width: 8, height: 8, depth: 3 },
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
    body: opts.body ?? { noFloor: false, elev: 0, walkF: 4 },
    ...(opts.sem ? { sem: opts.sem } : {}),
    ...(opts.structureMeta ? { structureMeta: opts.structureMeta } : {}),
  };
}

/** sparse-v2–style reliable floor classification (no floorGravLift = non-grav floor). */
function ordinaryFloor(x, y, z = 0, inLos = true) {
  return tile([x, y, z], { inLos, structureMeta: { inLosAtExport: inLos } });
}

function gravFloor(x, y, z = 0, inLos = true) {
  return tile([x, y, z], {
    inLos,
    structureMeta: { inLosAtExport: inLos, floorGravLift: true },
  });
}

function tilesByPos(tiles) {
  return new Map(tiles.map((t) => [`${t.p[0]},${t.p[1]},${t.p[2]}`, t]));
}

describe('P5 grav-lift floor semantics and structures', () => {
  it('does not treat sem.body GRAV_LIFT without floorGravLift as movement floor', () => {
    const t = tile([1, 1, 0], { sem: { body: 8 } });
    assert.equal(isFloorGravLiftTile(t), false);
    assert.notEqual(floorGlyph(t), FLOOR_GRAV_IN_LOS);
  });

  it('uses G/g glyphs only for floorGravLift tiles', () => {
    const vis = tile([2, 2, 0], { structureMeta: { floorGravLift: true }, inLos: true });
    const off = tile([2, 2, 1], { structureMeta: { floorGravLift: true }, inLos: false });
    assert.equal(floorGlyph(vis), FLOOR_GRAV_IN_LOS);
    assert.equal(floorGlyph(off), FLOOR_GRAV_OFF_LOS);
  });

  it('object-first GRAV_LIFT body without floorGravLift is not a verified floor', () => {
    const t = tile([3, 3, 0], {
      sem: { body: 4 },
      body: { noFloor: false, elev: 0, walkF: 4, walkO: 6 },
    });
    assert.equal(categoryLabel(t.sem.body), 'UFO_INTERIOR');
    assert.equal(isFloorGravLiftTile(t), false);
  });

  it('builds 1x1 verified link on representative 7,5 fixture', () => {
    const tiles = [
      tile([7, 5, 0], { structureMeta: { floorGravLift: true }, inLos: true }),
      tile([7, 5, 1], { structureMeta: { floorGravLift: true }, inLos: false }),
    ];
    const s = buildGravLiftStructures(tiles, { width: 14, height: 10 });
    assert.equal(s.links.length, 1);
    assert.equal(s.links[0].rule, 'engine_same_xy_floor_grav');
    assert.equal(s.links[0].pathfindingGuaranteed, false);
  });

  it('groups 3x3 footprint on one z without inferring missing cells', () => {
    const tiles = [];
    for (let y = 1; y <= 3; y += 1) {
      for (let x = 1; x <= 3; x += 1) {
        tiles.push(gravFloor(x, y, 0));
      }
    }
    for (let x = 0; x <= 4; x += 1) {
      tiles.push(ordinaryFloor(x, 0, 0));
      tiles.push(ordinaryFloor(x, 4, 0));
    }
    for (let y = 1; y <= 3; y += 1) {
      tiles.push(ordinaryFloor(0, y, 0));
      tiles.push(ordinaryFloor(4, y, 0));
    }
    const s = buildGravLiftStructures(tiles, { width: 8, height: 8 });
    assert.equal(s.components.length, 1);
    assert.equal(s.components[0].cellCount, 9);
    assert.equal(s.components[0].footprint.status, 'complete');
    assert.equal(s.components[0].footprint.describedRect, '3x3');
  });

  it('marks partial 3x3 when only five cells discovered', () => {
    const tiles = [
      gravFloor(1, 1, 0),
      gravFloor(2, 1, 0),
      gravFloor(3, 1, 0),
      gravFloor(1, 2, 0),
      gravFloor(2, 2, 0),
    ];
    const status = footprintStatusForLevel(tiles.map((t) => t.p), tilesByPos(tiles), 8, 8);
    assert.equal(status, 'partial');
    const s = buildGravLiftStructures(tiles, { width: 8, height: 8 });
    assert.equal(s.components[0].footprint.status, 'partial');
  });

  describe('footprint boundary completeness', () => {
    it('isolated discovered grav cell with unknown neighbours is partial', () => {
      const s = buildGravLiftStructures([gravFloor(4, 4, 0)], { width: 8, height: 8 });
      assert.equal(s.components[0].footprint.status, 'partial');
    });

    it('fully surrounded 1x1 with verified non-grav boundaries is complete', () => {
      const tiles = [
        gravFloor(4, 4, 0),
        ordinaryFloor(4, 3, 0),
        ordinaryFloor(4, 5, 0),
        ordinaryFloor(3, 4, 0),
        ordinaryFloor(5, 4, 0),
      ];
      const s = buildGravLiftStructures(tiles, { width: 8, height: 8 });
      assert.equal(s.components[0].footprint.status, 'complete');
    });

    it('fully observed 3x3 with boundary ring is complete', () => {
      const tiles = [];
      for (let y = 1; y <= 3; y += 1) {
        for (let x = 1; x <= 3; x += 1) tiles.push(gravFloor(x, y, 0));
      }
      for (let x = 0; x <= 4; x += 1) {
        tiles.push(ordinaryFloor(x, 0, 0));
        tiles.push(ordinaryFloor(x, 4, 0));
      }
      for (let y = 1; y <= 3; y += 1) {
        tiles.push(ordinaryFloor(0, y, 0));
        tiles.push(ordinaryFloor(4, y, 0));
      }
      const s = buildGravLiftStructures(tiles, { width: 8, height: 8 });
      assert.equal(s.components[0].footprint.status, 'complete');
    });

    it('fully bounded irregular L-shaped lift is complete', () => {
      const tiles = [
        gravFloor(2, 2, 0),
        gravFloor(3, 2, 0),
        gravFloor(2, 3, 0),
      ];
      for (const [x, y] of [
        [1, 2], [4, 2], [2, 1], [2, 4], [3, 1], [3, 3], [3, 4], [1, 3], [4, 3],
      ]) {
        tiles.push(ordinaryFloor(x, y, 0));
      }
      const s = buildGravLiftStructures(tiles, { width: 8, height: 8 });
      assert.equal(s.components[0].cellCount, 3);
      assert.equal(s.components[0].footprint.status, 'complete');
    });

    it('map-edge grav pad can be complete when inward boundaries are verified', () => {
      const tiles = [
        gravFloor(0, 0, 0),
        ordinaryFloor(1, 0, 0),
        ordinaryFloor(0, 1, 0),
      ];
      const s = buildGravLiftStructures(tiles, { width: 8, height: 8 });
      assert.equal(s.components[0].footprint.status, 'complete');
    });

    it('boundary neighbour without reliable floorGrav export keeps footprint partial', () => {
      const tiles = [
        gravFloor(4, 4, 0),
        tile([4, 3, 0], { inLos: true }),
        ordinaryFloor(4, 5, 0),
        ordinaryFloor(3, 4, 0),
        ordinaryFloor(5, 4, 0),
      ];
      const s = buildGravLiftStructures(tiles, { width: 8, height: 8 });
      assert.equal(s.components[0].footprint.status, 'partial');
    });
  });

  it('does not link different x,y pads on adjacent z', () => {
    const tiles = [
      tile([1, 1, 0], { structureMeta: { floorGravLift: true } }),
      tile([2, 2, 1], { structureMeta: { floorGravLift: true } }),
    ];
    const s = buildGravLiftStructures(tiles, { width: 8, height: 8 });
    assert.equal(s.links.length, 0);
  });

  it('battleship full-reveal reports same-xy floor grav links from exported geometry', (t) => {
    const yamlPath = path.join(
      __dirname,
      '..',
      '..',
      '..',
      'local',
      'disposable-p5-step5-battleship-cydonia',
      'artifacts',
      'battleship-seed42001-diagnostic-v5-full.yaml',
    );
    if (!fs.existsSync(yamlPath)) {
      return;
    }
    const raw = YAML.parse(fs.readFileSync(yamlPath, 'utf8'));
    const tac = raw.tactical ?? raw;
    const tiles = decodeTerrainTiles(tac);
    const gravBody = tiles.filter((t) => categoryLabel(t.sem?.body) === 'GRAV_LIFT');
    const gravFloor = tiles.filter((t) => isFloorGravLiftTile(t));
    assert.ok(gravBody.length > 0);
    if (gravFloor.length === 0) {
      t.skip('battleship YAML predates structureMeta.floorGravLift — re-export disposable snapshot with updated engine');
    }
    assert.ok(
      gravFloor.length > gravBody.length,
      'floorGravLift from O_FLOOR must exceed object-first sparse GRAV_LIFT body count',
    );
    const s = buildGravLiftStructures(tiles, tac.map);
    assert.equal(s.links.length, 23, 'seed 42001 BattlescapeGenerator harness observed link count');
    for (const link of s.links) {
      assert.equal(link.rule, 'engine_same_xy_floor_grav');
      assert.equal(link.from[0], link.to[0]);
      assert.equal(link.from[1], link.to[1]);
      assert.equal(Math.abs(link.from[2] - link.to[2]), 1);
    }
  });

  it('full ASCII hints include gravLiftStructures schema v2', () => {
    const tactical = baseTactical({
      terrain: {
        memoryNote: 'n',
        tiles: [
          tile([0, 0, 0], { structureMeta: { floorGravLift: true } }),
          tile([0, 0, 1], { structureMeta: { floorGravLift: true } }),
        ],
      },
    });
    const map = buildFullAsciiBattlefieldMap(tactical);
    assert.equal(map.hints.schemaVersion, 2);
    assert.ok(Array.isArray(map.hints.vertical));
    assert.ok(map.hints.gravLiftStructures.links.length === 1);
    assert.equal(map.levels[0].channels.floor[0][0], FLOOR_GRAV_IN_LOS);
  });

  it('relay size accounting still builds with grav lift hints', () => {
    const tactical = baseTactical({
      map: { width: 12, height: 12, depth: 2 },
      terrain: {
        memoryNote: 'n',
        tiles: [
          tile([4, 4, 0], { structureMeta: { floorGravLift: true } }),
        ],
      },
    });
    const est = estimateRelayBytesWithFullAscii(tactical);
    assert.ok(est.withFullAsciiBytes >= est.relayAfterShrinkBytes);
  });
});
