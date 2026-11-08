'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildTerrainBrief,
  classifyDiscoveredTile,
  decodeTerrainTiles,
  VIS_CURRENT,
  VIS_DISCOVERED_OFF_LOS,
} = require('../lib/terrain-brief.cjs');
const { executeTerrainQuery } = require('../lib/terrain-query.cjs');
const { computeSnapshotId, loadAndValidateSnapshotFromText } = require('../lib/tactical-publish.cjs');
const { decodeSparseSemanticsBase64 } = require('../lib/terrain-semantics-sparse-v2.cjs');
const { DOOR_REDACTED, OBS_REMEMBERED, collectStructureFacets } = require('../lib/terrain-structure-wp8.cjs');
const YAML = require('yaml');

function baseTactical(overrides = {}) {
  return {
    schemaVersion: 5,
    turn: 1,
    side: 0,
    selectedUnitId: 1,
    missionContext: {
      schemaVersion: 1,
      missionType: 'STR_UFO_CRASH_RECOVERY',
      missionClass: 'ufo_crash',
      siteKind: 'ufo_site',
    },
    map: { width: 8, height: 8, depth: 3 },
    units: [{
      id: 1,
      faction: 0,
      originalFaction: 0,
      position: [1, 1, 0],
      name: 'S',
      health: 40,
      timeUnits: 50,
      kneeled: false,
      activeHand: 'STR_RIGHT_HAND',
      hands: { right: null, left: null },
      inventory: [],
    }],
    eventLog: {
      sessionId: '0123456789abcdef0123456789abcdef',
      oldestSeq: 0,
      latestSeq: 0,
      droppedCount: 0,
      events: [],
    },
    terrain: {
      memoryNote: 'test',
      tiles: [],
    },
    ...overrides,
  };
}

function tile(p, opts = {}) {
  return {
    p,
    disc: opts.disc ?? 4,
    inLos: opts.inLos ?? true,
    ...(opts.body ? { body: opts.body } : {}),
    ...(opts.west ? { west: opts.west } : {}),
    ...(opts.north ? { north: opts.north } : {}),
    ...(opts.sem ? { sem: opts.sem } : {}),
    ...(opts.structureMeta ? { structureMeta: opts.structureMeta } : {}),
  };
}

describe('M1-WP8 UFO structure semantics', () => {
  it('identifies discovered UFO hull from engine category', () => {
    const c = classifyDiscoveredTile(tile([2, 2, 0], {
      sem: { west: 3 },
      west: { walk: 255, blockSight: true },
    }));
    const facet = c.structureFacets.find((f) => f.edge === 'west');
    assert.equal(facet.structureKind, 'ufo_hull');
    assert.equal(facet.observationStatus, VIS_CURRENT);
  });

  it('labels visible UFO door with closed state', () => {
    const c = classifyDiscoveredTile(tile([3, 3, 0], {
      sem: { body: 5 },
      body: { noFloor: false, elev: 0, walkO: 12 },
      structureMeta: { inLosAtExport: true, doorState: { body: 'closed' } },
    }));
    const facet = c.structureFacets.find((f) => f.p);
    assert.equal(facet.structureKind, 'ufo_door');
    assert.equal(facet.doorState, 'closed');
  });

  it('distinguishes conventional building door from UFO door', () => {
    const ufo = collectStructureFacets(tile([1, 1, 0], { sem: { body: 5 } }))[0];
    const building = collectStructureFacets(tile([1, 2, 0], { sem: { body: 6 } }))[0];
    assert.equal(ufo.structureKind, 'ufo_door');
    assert.equal(building.structureKind, 'building_door');
  });

  it('redacts off-screen door state while retaining structure identity', () => {
    const c = classifyDiscoveredTile(tile([4, 4, 0], {
      inLos: false,
      sem: { body: 5 },
      body: { noFloor: false, elev: 0, walkO: 12 },
      structureMeta: { inLosAtExport: false },
    }));
    assert.equal(c.visibility, VIS_DISCOVERED_OFF_LOS);
    assert.equal(c.structureFacets[0].structureKind, 'ufo_door');
    assert.equal(c.structureFacets[0].doorState, DOOR_REDACTED);
    assert.equal(c.structureFacets[0].observationStatus, OBS_REMEMBERED);
  });

  it('omits undiscovered interior cells from decoded tiles', () => {
    const tactical = baseTactical({
      terrain: {
        memoryNote: 'n',
        tiles: [
          tile([1, 1, 0], { sem: { body: 4 } }),
        ],
      },
    });
    const decoded = decodeTerrainTiles(tactical);
    assert.equal(decoded.length, 1);
    assert.ok(!decoded.some((t) => t.p[0] === 7 && t.p[1] === 7));
  });

  it('supports multi-level grav lift structure facets', () => {
    const lower = classifyDiscoveredTile(tile([2, 2, 0], { sem: { body: 8 }, body: { elev: 0, noFloor: false, walkF: 4 } }));
    const upper = classifyDiscoveredTile(tile([2, 2, 1], { sem: { body: 8 }, body: { elev: 0, noFloor: false, walkF: 4 } }));
    assert.equal(lower.structureFacets[0].structureKind, 'vertical_passage');
    assert.equal(upper.structureFacets[0].structureKind, 'vertical_passage');
  });

  it('does not infer UFO identity from impassable geometry alone', () => {
    const c = classifyDiscoveredTile(tile([2, 2, 0], {
      body: { noFloor: false, elev: 0, walkO: 255, blockSightO: true },
    }));
    assert.equal(c.structureFacets.length, 0);
  });

  it('terrain brief schema v4 includes structure observations', () => {
    const brief = buildTerrainBrief(baseTactical({
      terrain: {
        memoryNote: 'n',
        tiles: [
          tile([1, 1, 0], { sem: { west: 3 }, west: { walk: 255, blockSight: true } }),
          tile([2, 2, 0], {
            sem: { body: 5 },
            body: { elev: 0, noFloor: false, walkO: 12 },
            structureMeta: { inLosAtExport: true, doorState: { body: 'closed' } },
          }),
        ],
      },
    }));
    assert.equal(brief.schemaVersion, 4);
    assert.ok(brief.structureFacets.some((f) => f.structureKind === 'ufo_hull'));
    assert.ok(brief.structureObservations.some((line) => /UFO hull/.test(line)));
    assert.ok(brief.structureObservations.some((line) => /door.*closed/.test(line)));
  });

  it('terrain-query returns structureFacets within radius budget', () => {
    const tactical = baseTactical({
      terrain: {
        memoryNote: 'n',
        tiles: [
          tile([1, 1, 0], { sem: { body: 4 }, body: { elev: 0, noFloor: false, walkF: 4 } }),
        ],
      },
    });
    const id = computeSnapshotId(tactical);
    const res = executeTerrainQuery(tactical, {
      snapshot_id: id,
      center: { x: 1, y: 1, z: 0 },
      radius: 2,
    });
    assert.ok(res.discovered.some((cell) => cell.structureFacets?.[0]?.structureKind === 'ufo_interior_floor'));
  });

  it('accepts sparse-v2 semantics block on validation', () => {
    assert.doesNotThrow(() => decodeSparseSemanticsBase64('T1hUUwIAAAAAAAAA', 'sparse-v2', { expectedRecordCount: 0 }));
    const tactical = baseTactical({
      terrain: {
        memoryNote: 'n',
        tiles: [],
        semantics: {
          encoding: 'sparse-v2',
          recordCount: 0,
          data: 'T1hUUwIAAAAAAAAA',
        },
      },
    });
    const parsed = loadAndValidateSnapshotFromText(YAML.stringify(tactical), YAML);
    assert.equal(parsed.terrain.semantics.encoding, 'sparse-v2');
  });

  it('still accepts sparse-v1 semantics for packed compatibility', () => {
    assert.doesNotThrow(() => decodeSparseSemanticsBase64('T1hUUwEAAAAAAAAA', 'sparse-v1', { expectedRecordCount: 0 }));
    const tactical = baseTactical({
      terrain: {
        memoryNote: 'n',
        tiles: [],
        semantics: {
          encoding: 'sparse-v1',
          recordCount: 0,
          data: 'T1hUUwEAAAAAAAAA',
        },
      },
    });
    assert.doesNotThrow(() => loadAndValidateSnapshotFromText(YAML.stringify(tactical), YAML));
  });

  it('preserves WP6/WP7 optional perceptionLog when present', () => {
    const tactical = baseTactical({
      perceptionLog: {
        sessionId: 'a1b2c3d4e5f6789012345678abcdef01',
        oldestSeq: 1,
        latestSeq: 1,
        droppedCount: 0,
        events: [{
          seq: 1,
          type: 'gunfire_observed',
          turn: 1,
          perceptionChannel: 'heard',
          confidence: 'audio_only',
          positionKnown: false,
        }],
      },
      terrain: {
        memoryNote: 'n',
        tiles: [tile([1, 1, 0], { sem: { body: 1 }, body: { elev: 0, noFloor: false, walkF: 4 } })],
      },
    });
    const parsed = loadAndValidateSnapshotFromText(YAML.stringify(tactical), YAML);
    assert.equal(parsed.perceptionLog.events.length, 1);
  });
});
