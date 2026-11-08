'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const { loadAndValidateSnapshotFromText } = require('../lib/tactical-publish.cjs');
const { decodeTerrainTiles } = require('../lib/terrain-brief.cjs');
const { northEdgeGlyph, VIS_UNDISCOVERED } = require('../lib/terrain-tactical-map.cjs');
const {
  DOOR_STATE_UNKNOWN_OFF_LOS,
} = require('../lib/terrain-tactical-map.cjs');
const {
  buildFullAsciiBattlefieldMap,
  measureFullAsciiBattlefieldMapBytes,
  serializeFullAsciiBattlefieldMap,
  compareGlyphsToDecodedTiles,
  estimateRelayBytesWithFullAscii,
  ENCODING,
} = require('../lib/terrain-full-ascii-battlefield.cjs');

const LIVE_SNAPSHOT = path.join(__dirname, '..', '..', '..', 'local', 'm0', 'tactical-live.yaml');
const REPRESENTATIVE_FIXTURE = path.join(__dirname, 'fixtures', 'full-ascii-battlefield-representative.json');

function baseTactical(overrides = {}) {
  return {
    schemaVersion: 5,
    turn: 1,
    side: 0,
    selectedUnitId: 1,
    map: { width: 5, height: 5, depth: 1 },
    units: [{
      id: 1, faction: 0, originalFaction: 0, position: [2, 2, 0], name: 'Test',
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

function sparseMap(width, height, depth, discoveredFraction) {
  const tiles = [];
  const volume = width * height * depth;
  const cap = Math.floor(volume * discoveredFraction);
  for (let z = 0; z < depth; z += 1) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const idx = z * width * height + y * width + x;
        if (idx >= cap) break;
        tiles.push(tile([x, y, z], { inLos: x + y === 0 }));
      }
    }
  }
  return baseTactical({ map: { width, height, depth }, terrain: { memoryNote: 'n', tiles } });
}

function buildRepresentativeTactical() {
  const w = 14;
  const h = 10;
  const tiles = [];
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (x >= 12 && y >= 8) continue;
      const inLos = x < 9 && y < 7;
      const body = { noFloor: false, elev: 0, walkF: 4 };
      const t = tile([x, y, 0], { inLos, body });
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) {
        if (x > 0) t.west = { walk: 255, blockSight: true };
        if (y > 0) t.north = { walk: 255, blockSight: true };
      }
      tiles.push(t);
    }
  }
  tiles.push(tile([5, 4, 0], {
    inLos: true,
    north: { walk: 4, blockSight: false },
    sem: { north: 6 },
    structureMeta: { doorState: { north: 'open' } },
  }));
  tiles.push(tile([8, 4, 0], {
    inLos: false,
    north: { walk: 4, blockSight: false },
    sem: { north: 6 },
    structureMeta: { doorState: { north: 'open' } },
  }));
  tiles.push(tile([7, 5, 0], {
    inLos: true,
    sem: { body: 8 },
    body: { elev: 0, noFloor: false, walkF: 4 },
    structureMeta: { floorGravLift: true },
  }));
  tiles.push(tile([7, 5, 1], {
    inLos: false,
    sem: { body: 8 },
    body: { elev: 0, noFloor: false, walkF: 4 },
    structureMeta: { floorGravLift: true },
  }));
  return baseTactical({
    map: { width: w, height: h, depth: 2 },
    units: [{ id: 1, faction: 0, originalFaction: 0, position: [3, 3, 0], name: 'Alpha' }],
    terrain: { memoryNote: 'Representative P4 fixture', tiles },
  });
}

describe('M1 P4 full ASCII battlefield map', () => {
  it('exports encoding metadata and fixed-width channels for full map', () => {
    const tactical = buildRepresentativeTactical();
    const map = buildFullAsciiBattlefieldMap(tactical);
    assert.equal(map.encoding, ENCODING);
    assert.ok(map.authoritativeNote.includes('packed-v1'));
    assert.equal(map.levels.length, 2);
    const level0 = map.levels[0];
    assert.equal(level0.channels.visibility[0].length, 14);
    assert.equal(level0.channels.visibility.length, 10);
  });

  it('keeps undiscovered cells as ? on all structure channels', () => {
    const tactical = buildRepresentativeTactical();
    const map = buildFullAsciiBattlefieldMap(tactical);
    assert.equal(map.levels[0].channels.visibility[9][12], VIS_UNDISCOVERED);
    assert.equal(map.levels[0].channels.floor[9][13], VIS_UNDISCOVERED);
    assert.equal(map.levels[0].channels.edgeNorth[9][12], VIS_UNDISCOVERED);
  });

  it('uses U for off-LOS doors (unknown state, not confirmed closed)', () => {
    const openLos = tile([1, 1, 0], {
      inLos: true,
      north: { walk: 4, blockSight: false },
      sem: { north: 6 },
      structureMeta: { doorState: { north: 'open' } },
    });
    const openOffLos = tile([2, 1, 0], {
      inLos: false,
      north: { walk: 4, blockSight: false },
      sem: { north: 6 },
      structureMeta: { doorState: { north: 'open' } },
    });
    assert.equal(northEdgeGlyph(openLos), 'd');
    assert.equal(northEdgeGlyph(openOffLos), DOOR_STATE_UNKNOWN_OFF_LOS);

    const tactical = baseTactical({
      terrain: { memoryNote: 'n', tiles: [openLos, openOffLos] },
    });
    const decoded = decodeTerrainTiles(tactical);
    const off = decoded.find((t) => t.p[0] === 2);
    assert.ok(off);
    const map = buildFullAsciiBattlefieldMap(tactical);
    assert.equal(map.levels[0].channels.edgeNorth[1][1], 'd');
    assert.equal(map.levels[0].channels.edgeNorth[1][2], DOOR_STATE_UNKNOWN_OFF_LOS);
  });

  it('omits unit glyphs from exported channels (units stay in tactical.units)', () => {
    const tactical = buildRepresentativeTactical();
    const map = buildFullAsciiBattlefieldMap(tactical);
    const floor = map.levels[0].channels.floor[3][3];
    assert.notEqual(floor, '@');
    assert.equal(floor, 'o');
  });

  it('emits sparse vertical hints for grav lift on multiple Z levels', () => {
    const tactical = buildRepresentativeTactical();
    const map = buildFullAsciiBattlefieldMap(tactical);
    assert.ok(map.hints.vertical.length >= 2);
    assert.ok(map.hints.vertical.some((h) => h.category === 'GRAV_LIFT' && h.p[2] === 0));
    assert.ok(map.hints.vertical.some((h) => h.category === 'GRAV_LIFT' && h.p[2] === 1));
    assert.ok(map.hints.vertical.some((h) => h.category === 'GRAV_LIFT' && h.observation === 'DISCOVERED_NOT_CURRENTLY_VISIBLE'));
    assert.equal(map.hints.schemaVersion, 2);
    assert.equal(map.hints.gravLiftStructures.links.length, 1);
    assert.equal(map.levels[0].channels.floor[5][7], 'G');
    assert.equal(map.levels[1].channels.floor[5][7], 'g');
  });

  it('glyph channels match decoded tile presentation sample', () => {
    const tactical = buildRepresentativeTactical();
    const cmp = compareGlyphsToDecodedTiles(tactical);
    assert.equal(cmp.mismatchCount, 0, JSON.stringify(cmp.mismatches));
    assert.ok(cmp.presentationLoss.length > 0);
  });

  it('measures compact JSON size for 50×50×4 and 60×60×4 (discovered vs sparse)', () => {
    const cases = [
      { label: '50×50×4 full discovered inLOS', tactical: syntheticDiscoveredMap(50, 50, 4) },
      { label: '60×60×4 full discovered inLOS', tactical: syntheticDiscoveredMap(60, 60, 4) },
      { label: '60×60×4 10% discovered', tactical: sparseMap(60, 60, 4, 0.1) },
    ];
    const report = [];
    for (const { label, tactical } of cases) {
      const map = buildFullAsciiBattlefieldMap(tactical);
      const compact = measureFullAsciiBattlefieldMapBytes(map, { pretty: false });
      const pretty = measureFullAsciiBattlefieldMapBytes(map, { pretty: true });
      report.push({ label, compactBytes: compact, prettyBytes: pretty });
      assert.ok(compact < 200 * 1024, `${label} compact JSON should stay under 200 KiB, got ${compact}`);
      if (label.includes('60×60×4 full')) {
        assert.ok(compact < 120 * 1024, `expected <120 KiB compact 5-channel proxy, got ${compact}`);
      }
    }
    const gridBytesDelta = Math.abs(report[1].compactBytes - report[2].compactBytes);
    assert.ok(gridBytesDelta < 2048, 'full grid channel size is independent of discovery fraction');
  });

  it('writes human-inspectable representative multi-level fixture', () => {
    const tactical = buildRepresentativeTactical();
    const map = buildFullAsciiBattlefieldMap(tactical);
    const text = serializeFullAsciiBattlefieldMap(map, { pretty: true });
    fs.mkdirSync(path.dirname(REPRESENTATIVE_FIXTURE), { recursive: true });
    fs.writeFileSync(REPRESENTATIVE_FIXTURE, `${text}\n`, 'utf8');
    assert.ok(fs.existsSync(REPRESENTATIVE_FIXTURE));
  });

  const liveIt = fs.existsSync(LIVE_SNAPSHOT) ? it : it.skip;

  liveIt('measures live snapshot full map and hypothetical relay headroom', () => {
    const text = fs.readFileSync(LIVE_SNAPSHOT, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(text, YAML);
    const map = buildFullAsciiBattlefieldMap(tactical);
    const asciiBytes = measureFullAsciiBattlefieldMapBytes(map);
    const est = estimateRelayBytesWithFullAscii(tactical);
    assert.ok(asciiBytes > 1000);
    assert.ok(est.fullAsciiCompactStandaloneBytes === asciiBytes);
    if (est.asciiIncluded) {
      assert.ok(est.withFullAsciiBytes > est.relayAfterShrinkBytes);
      assert.ok(est.sizeAccounting.relayIncrementalBytes >= est.fullAsciiCompactStandaloneBytes);
    } else {
      assert.equal(est.omitted?.reason, 'exceeds_relay_target_bytes');
    }
    assert.ok(est.withFullAsciiBytes <= 256 * 1024);
  });
});
