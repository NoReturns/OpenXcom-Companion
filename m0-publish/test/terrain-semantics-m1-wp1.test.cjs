'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildTerrainBrief,
  classifyDiscoveredTile,
  decodeTerrainTiles,
  VIS_DISCOVERED_OFF_LOS,
} = require('../lib/terrain-brief.cjs');
const { executeTerrainQuery } = require('../lib/terrain-query.cjs');
const { computeSnapshotId, loadAndValidateSnapshotFromText } = require('../lib/tactical-publish.cjs');
const { decodeSparseV1Base64, categoryLabel } = require('../lib/terrain-semantics-sparse-v1.cjs');
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
    map: { width: 4, height: 4, depth: 1 },
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
      oldestSeq: 1,
      latestSeq: 1,
      droppedCount: 0,
      events: [{
        seq: 1,
        type: 'weapon_fired',
        turn: 1,
        actorUnitId: 1,
        weaponItemType: 'STR_RIFLE',
        actionType: 'snap',
        target: [2, 2, 0],
      }],
    },
    terrain: {
      memoryNote: 'test',
      tiles: [],
    },
    ...overrides,
  };
}

describe('M1 WP1 mission context validation', () => {
  it('accepts compact missionContext on v5 snapshots', () => {
    const tactical = loadAndValidateSnapshotFromText(YAML.stringify(baseTactical()), YAML);
    assert.equal(tactical.missionContext.missionClass, 'ufo_crash');
  });

  it('rejects deployment-only missionContext fields', () => {
    for (const extra of [
      { civilianSlots: 20 },
      { objectiveClass: 'destroy_target' },
    ]) {
      const bad = baseTactical({
        missionContext: {
          schemaVersion: 1,
          missionType: 'STR_UFO_CRASH_RECOVERY',
          missionClass: 'ufo_crash',
          ...extra,
        },
      });
      assert.throws(() => loadAndValidateSnapshotFromText(YAML.stringify(bad), YAML), /unknown field/);
    }
  });

  it('rejects hidden spoiler fields on missionContext', () => {
    const bad = baseTactical({
      missionContext: {
        schemaVersion: 1,
        missionType: 'STR_UFO_CRASH_RECOVERY',
        missionClass: 'ufo_crash',
        alienComposition: 'sectoid',
      },
    });
    assert.throws(() => loadAndValidateSnapshotFromText(YAML.stringify(bad), YAML), /unknown field/);
  });
});

describe('M1 WP1 terrain semantics', () => {
  it('labels UFO door separately from ordinary impassable object', () => {
    const c = classifyDiscoveredTile({
      p: [1, 1, 0],
      disc: 4,
      inLos: true,
      body: { noFloor: false, elev: 0, walkO: 12 },
      sem: { body: 5 },
    });
    assert.ok(c.terrainSemantics.some((s) => s.category === 'UFO_DOOR'));
  });

  it('does not infer UFO structure without semantics export', () => {
    const c = classifyDiscoveredTile({
      p: [1, 1, 0],
      disc: 4,
      inLos: true,
      body: { noFloor: false, elev: 0, walkO: 255, blockSightO: true },
    });
    assert.equal(c.terrainSemantics.length, 0);
    assert.ok(c.movementObstruction.some((m) => m.objectIdentity === 'unknown'));
  });

  it('classifies ordinary terrain when semantics say ORDINARY', () => {
    const c = classifyDiscoveredTile({
      p: [0, 0, 0],
      disc: 4,
      inLos: true,
      body: { noFloor: false, elev: 0, walkF: 4 },
      sem: { body: 1 },
    });
    assert.ok(c.terrainSemantics.some((s) => s.category === 'ORDINARY'));
  });

  it('discloses off-LOS structure facets when sparse-v2 semantics are present', () => {
    const c = classifyDiscoveredTile({
      p: [2, 2, 0],
      disc: 4,
      inLos: false,
      body: { noFloor: false, elev: 0, walkF: 4 },
      sem: { body: 3 },
    });
    assert.equal(c.visibility, VIS_DISCOVERED_OFF_LOS);
    assert.ok(c.structureFacets.some((f) => f.structureKind === 'ufo_hull'));
  });

  it('omits undiscovered cells entirely from decoded tiles', () => {
    const tactical = baseTactical({
      terrain: {
        memoryNote: 'n',
        tiles: [{ p: [0, 0, 0], disc: 4, inLos: true, body: { noFloor: false, elev: 0, walkF: 4 }, sem: { body: 1 } }],
      },
    });
    const tiles = decodeTerrainTiles(tactical);
    assert.equal(tiles.length, 1);
    const brief = buildTerrainBrief(tactical);
    assert.equal(brief.visibilityTotals.undiscoveredMapCells, 15);
  });

  it('keeps terrain-query and brief semantics aligned', () => {
    const tactical = baseTactical({
      terrain: {
        memoryNote: 'n',
        tiles: [{
          p: [1, 1, 0],
          disc: 4,
          inLos: true,
          body: { noFloor: false, elev: 0, walkF: 4 },
          sem: { body: 4 },
        }],
      },
    });
    const snapshotId = computeSnapshotId(tactical);
    const query = executeTerrainQuery(tactical, {
      snapshot_id: snapshotId,
      center: { x: 1, y: 1, z: 0 },
      radius: 0,
    });
    const brief = buildTerrainBrief(tactical);
    assert.equal(query.discovered[0].terrainSemantics[0].category, 'UFO_INTERIOR');
    assert.ok(brief.terrainSemantics.some((s) => s.category === 'UFO_INTERIOR'));
  });

  it('decodes sparse-v1 semantics sidecar roundtrip', () => {
    // One record: (1,2,0) body=5 west=3
    const blob = Buffer.from([
      0x4f, 0x58, 0x54, 0x53, 1, 0, 0, 0, 1, 0, 0, 0,
      1, 2, 0, 0x3, 5, 3,
    ]);
    const { byPos } = decodeSparseV1Base64(blob.toString('base64'), { expectedRecordCount: 1 });
    const entry = byPos.get('1,2,0');
    assert.equal(categoryLabel(entry.sem.body), 'UFO_DOOR');
    assert.equal(categoryLabel(entry.sem.west), 'UFO_STRUCTURE');
  });
});

describe('M1 WP1 terrainBrief integration', () => {
  it('includes missionContext and semanticSummary in brief schema v3', () => {
    const brief = buildTerrainBrief(baseTactical({
      terrain: {
        memoryNote: 'n',
        tiles: [
          { p: [1, 1, 0], disc: 4, inLos: true, body: { noFloor: false, elev: 0, walkF: 4 }, sem: { body: 4 } },
          { p: [2, 1, 0], disc: 4, inLos: true, body: { noFloor: false, elev: 0, walkF: 4 }, sem: { body: 3 } },
        ],
      },
    }));
    assert.equal(brief.schemaVersion, 4);
    assert.equal(brief.missionContext.missionClass, 'ufo_crash');
    assert.ok(brief.semanticSummary.UFO_INTERIOR >= 1);
    assert.ok(brief.semanticSummary.UFO_STRUCTURE >= 1);
  });
});
