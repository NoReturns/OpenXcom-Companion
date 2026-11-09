'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const {
  buildTerrainBrief,
  classifyDiscoveredTile,
  visibilityLabel,
  VIS_CURRENT,
  VIS_DISCOVERED_OFF_LOS,
  WALK_IMPASSABLE,
  decodeTerrainTiles,
  DEFAULT_MAX_BYTES,
} = require('../lib/terrain-brief.cjs');
const { PackedTerrainError } = require('../lib/terrain-packed-v1.cjs');
const { loadAndValidateSnapshotFromText } = require('../lib/tactical-publish.cjs');

const FIXTURE_V5 = path.join(__dirname, 'fixtures', 'valid-v5.yaml');
const FIXTURE_NEAR_FOCUS_DENSITY = path.join(
  __dirname,
  'fixtures',
  'terrain-brief-near-focus-density-v5.yaml',
);

function baseTactical(overrides = {}) {
  return {
    schemaVersion: 5,
    turn: 1,
    side: 0,
    selectedUnitId: 1,
    map: { width: 10, height: 10, depth: 2 },
    units: [
      {
        id: 1,
        faction: 0,
        originalFaction: 0,
        position: [1, 2, 0],
        name: 'Alpha',
        health: 40,
        timeUnits: 50,
      },
      {
        id: 2,
        faction: 0,
        originalFaction: 0,
        position: [9, 9, 0],
        name: 'Bravo',
        health: 35,
        timeUnits: 45,
      },
    ],
    terrain: {
      memoryNote: 'test memory note',
      tiles: [],
    },
    ...overrides,
  };
}

describe('terrain visibility labels', () => {
  it('marks inLos tiles CURRENTLY_VISIBLE and off-LOS DISCOVERED_NOT_CURRENTLY_VISIBLE', () => {
    assert.equal(visibilityLabel({ inLos: true }), VIS_CURRENT);
    assert.equal(visibilityLabel({ inLos: false }), VIS_DISCOVERED_OFF_LOS);
  });

  it('counts undiscovered map cells as UNKNOWN via visibilityTotals', () => {
    const tactical = baseTactical({
      map: { width: 3, height: 3, depth: 1 },
      terrain: {
        memoryNote: 'n',
        tiles: [{
          p: [0, 0, 0], disc: 4, inLos: true, body: { noFloor: false, elev: 0, walkF: 4 },
        }],
      },
    });
    const brief = buildTerrainBrief(tactical);
    assert.equal(brief.visibilityTotals.undiscoveredLabel, 'UNKNOWN');
    assert.equal(brief.visibilityTotals.undiscoveredMapCells, 8);
    assert.equal(brief.visibilityTotals.currentlyVisibleRecords, 1);
  });
});

describe('terrain semantic classification from export fields only', () => {
  it('classifies open air definitively', () => {
    const c = classifyDiscoveredTile({
      p: [1, 1, 1],
      disc: 4,
      inLos: true,
      body: { air: true, noFloor: true },
    });
    assert.equal(c.openTerrain.kind, 'open_air');
    assert.equal(c.visibility, VIS_CURRENT);
    assert.equal(c.sightObstruction.length, 0);
  });

  it('records sight and movement obstruction without naming wall type', () => {
    const c = classifyDiscoveredTile({
      p: [5, 5, 0],
      disc: 7,
      inLos: false,
      body: { noFloor: false, elev: -4, walkF: 6, walkO: 12, blockSightO: true },
      west: { walk: WALK_IMPASSABLE, blockSight: true },
      north: { walk: 8 },
    });
    assert.ok(c.sightObstruction.some((s) => s.source === 'object'));
    assert.ok(c.movementObstruction.some((m) => m.source === 'west_wall'));
    assert.ok(c.knownBarriers.some((b) => b.certainty === 'inferred' && b.note.includes('door-like')));
    assert.equal(c.visibility, VIS_DISCOVERED_OFF_LOS);
  });

  it('notes partial wall discovery without west/north sections', () => {
    const c = classifyDiscoveredTile({ p: [2, 2, 0], disc: 3, inLos: true });
    assert.equal(c.knownBarriers.length, 2);
    assert.ok(c.knownBarriers.every((b) => b.note.includes('no emittable')));
  });

  it('uses engine semantics when present instead of door-like inference', () => {
    const brief = buildTerrainBrief(baseTactical({
      terrain: {
        memoryNote: 'n',
        tiles: [{
          p: [0, 0, 0],
          disc: 4,
          inLos: true,
          body: { noFloor: false, elev: 0, walkO: 12, blockSightO: true },
          sem: { body: 6 },
        }],
      },
    }));
    assert.ok(brief.terrainSemantics.some((s) => s.category === 'ORDINARY_DOOR'));
    assert.ok(!brief.knownBarriers.some((b) => b.note && b.note.includes('door-like')));
  });

  it('does not assert door identities without semantics export', () => {
    const brief = buildTerrainBrief(baseTactical({
      terrain: {
        memoryNote: 'n',
        tiles: [{
          p: [0, 0, 0],
          disc: 4,
          inLos: true,
          body: { noFloor: false, elev: 0, walkO: 12, blockSightO: true },
        }],
      },
    }));
    for (const barrier of brief.knownBarriers) {
      assert.notEqual(barrier.kind, 'door');
      assert.notEqual(barrier.objectType, 'door');
    }
    assert.ok(brief.semanticLimits.notExported.some((s) => s.includes('Undiscovered')));
  });
});

describe('terrainBrief focus and ordering', () => {
  it('prioritizes selected soldier and lists nearby friendlies', () => {
    const text = fs.readFileSync(FIXTURE_V5, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(text, YAML);
    const brief = buildTerrainBrief(tactical);
    assert.equal(brief.focusSoldierId, 1);
    assert.deepEqual(brief.focusPosition, [1, 2, 0]);
    assert.ok(brief.nearbyFriendlies.some((u) => u.id === 2));
    assert.ok(brief.nearFocusTiles[0].distance <= brief.nearFocusTiles[1]?.distance ?? Infinity);
  });

  it('orders near focus tiles deterministically by distance then z,y,x', () => {
    const tactical = baseTactical({
      map: { width: 5, height: 5, depth: 1 },
      units: [{
        id: 1, faction: 0, originalFaction: 0, position: [2, 2, 0], name: 'S', health: 1, timeUnits: 1,
      }],
      terrain: {
        memoryNote: 'n',
        tiles: [
          { p: [2, 3, 0], disc: 4, inLos: true, body: { noFloor: false, elev: 0, walkF: 4 } },
          { p: [2, 1, 0], disc: 4, inLos: true, body: { noFloor: false, elev: 0, walkF: 4 } },
          { p: [3, 2, 0], disc: 4, inLos: true, body: { noFloor: false, elev: 0, walkF: 4 } },
        ],
      },
    });
    const brief = buildTerrainBrief(tactical, { nearFocusRadius: 2 });
    const distances = brief.nearFocusTiles.map((t) => t.distance);
    assert.deepEqual(distances, [...distances].sort((a, b) => a - b));
  });

  it('includes soldier near map boundary in nearFocus when within radius', () => {
    const tactical = baseTactical({
      map: { width: 10, height: 10, depth: 1 },
      units: [
        { id: 1, faction: 0, originalFaction: 0, position: [0, 0, 0], name: 'Edge', health: 1, timeUnits: 1 },
        { id: 2, faction: 0, originalFaction: 0, position: [1, 0, 0], name: 'Near', health: 1, timeUnits: 1 },
      ],
      selectedUnitId: 1,
      terrain: {
        memoryNote: 'n',
        tiles: [{ p: [0, 0, 0], disc: 4, inLos: true, body: { noFloor: false, elev: 0, walkF: 4 } }],
      },
    });
    const brief = buildTerrainBrief(tactical, { nearFocusRadius: 3, friendlyClusterRadius: 3 });
    assert.ok(brief.nearbyFriendlies.some((u) => u.id === 2));
  });
});

describe('terrainBrief budget and packed source', () => {
  it('stays within default byte budget for v5 fixture', () => {
    const tactical = loadAndValidateSnapshotFromText(fs.readFileSync(FIXTURE_V5, 'utf8'), YAML);
    const brief = buildTerrainBrief(tactical);
    assert.ok(Buffer.byteLength(JSON.stringify(brief), 'utf8') <= DEFAULT_MAX_BYTES);
    assert.equal(brief.schemaVersion, 4);
  });

  it('reports omittedDueToBudget when lists are capped', () => {
    const tiles = [];
    for (let i = 0; i < 200; i += 1) {
      tiles.push({
        p: [i % 10, Math.floor(i / 10) % 10, 0],
        disc: 4,
        inLos: i % 2 === 0,
        body: { noFloor: false, elev: 0, walkF: 4, blockSightF: i % 3 === 0 },
      });
    }
    const tactical = baseTactical({
      map: { width: 10, height: 10, depth: 1 },
      terrain: { memoryNote: 'n', tiles },
    });
    const brief = buildTerrainBrief(tactical, { maxBytes: 4096 });
    assert.ok(brief.truncated === true || Object.keys(brief.omittedDueToBudget).length > 0);
  });

  it('rejects invalid packed data via decodeTerrainTiles', () => {
    const tactical = baseTactical({
      terrain: {
        memoryNote: 'n',
        encoding: 'packed-v1',
        recordCount: 1,
        data: 'AAAA',
      },
    });
    assert.throws(() => buildTerrainBrief(tactical), PackedTerrainError);
  });

  it('decodes packed-v1 consistently with verbose fixture semantics', () => {
    const tactical = loadAndValidateSnapshotFromText(fs.readFileSync(FIXTURE_V5, 'utf8'), YAML);
    const verboseTiles = decodeTerrainTiles(tactical);
    assert.equal(verboseTiles.length, 2);
    const offLos = verboseTiles.find((t) => !t.inLos);
    assert.equal(classifyDiscoveredTile(offLos).visibility, VIS_DISCOVERED_OFF_LOS);
  });
});

describe('terrainBrief fog-of-war invariants', () => {
  it('never labels safe path or clear shot', () => {
    const brief = buildTerrainBrief(loadAndValidateSnapshotFromText(fs.readFileSync(FIXTURE_V5, 'utf8'), YAML));
    const text = JSON.stringify(brief).toLowerCase();
    assert.ok(!text.includes('"safe"'));
    assert.ok(!text.includes('clear shot'));
    assert.ok(brief.warnings.some((w) => w.includes('never labels paths safe')));
  });

  it('keeps semantic near-focus detail on live-scale discovered density within budget', () => {
    const tactical = loadAndValidateSnapshotFromText(
      fs.readFileSync(FIXTURE_NEAR_FOCUS_DENSITY, 'utf8'),
      YAML,
    );
    const brief = buildTerrainBrief(tactical);
    assert.ok(Buffer.byteLength(JSON.stringify(brief), 'utf8') <= DEFAULT_MAX_BYTES);
    assert.ok(Array.isArray(brief.nearFocusTiles));
    assert.ok(brief.nearFocusTiles.length > 0);
    assert.ok(brief.nearFocusCandidateCount > brief.nearFocusTiles.length);
    assert.ok(brief.nearFocusTiles.some((t) => (t.sightBlocks ?? 0) > 0 || (t.moveBlocks ?? 0) > 0));
  });

  it('labels adjacent known and unknown via nearFocus plus visibilityTotals', () => {
    const tactical = baseTactical({
      map: { width: 2, height: 1, depth: 1 },
      units: [{ id: 1, faction: 0, originalFaction: 0, position: [0, 0, 0], name: 'S', health: 1, timeUnits: 1 }],
      terrain: {
        memoryNote: 'n',
        tiles: [{ p: [0, 0, 0], disc: 4, inLos: true, body: { noFloor: false, elev: 0, walkF: 4 } }],
      },
    });
    const brief = buildTerrainBrief(tactical, { nearFocusRadius: 2 });
    assert.equal(brief.visibilityTotals.undiscoveredMapCells, 1);
    assert.equal(brief.nearFocusTiles.length, 1);
  });
});
