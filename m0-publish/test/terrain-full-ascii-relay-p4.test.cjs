'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const crypto = require('node:crypto');
const {
  buildRelayPayload,
  computeSnapshotId,
  loadAndValidateSnapshotFromText,
  canonicalTacticalJson,
} = require('../lib/tactical-publish.cjs');
const {
  prepareRelayPayloadForPublish,
  RELAY_PUBLISH_TARGET_BYTES,
  RELAY_PUBLISH_MAX_BYTES,
  publishedByteLength,
} = require('../lib/relay-payload-adaptive-shrink.cjs');
const {
  DOOR_STATE_UNKNOWN_OFF_LOS,
} = require('../lib/terrain-tactical-map.cjs');
const { buildFullAsciiBattlefieldMap } = require('../lib/terrain-full-ascii-battlefield.cjs');
const {
  resolveFullAsciiRelayEnabled,
  buildFullAsciiBattlefieldRelayAttachment,
  applyExperimentalTerrainFullAsciiRelay,
} = require('../lib/terrain-full-ascii-relay.cjs');

const LIVE_SNAPSHOT = path.join(__dirname, '..', '..', '..', 'local', 'm0', 'tactical-live.yaml');

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

function syntheticDiscoveredMap(width, height, depth) {
  const tiles = [];
  for (let z = 0; z < depth; z += 1) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        tiles.push(tile([x, y, z], { inLos: (x + y + z) % 3 === 0 }));
      }
    }
  }
  return baseTactical({ map: { width, height, depth }, terrain: { memoryNote: 'n', tiles } });
}

function relayWithDigest(tactical) {
  const text = canonicalTacticalJson(tactical);
  const digest = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
  return buildRelayPayload(tactical, '2026-01-01T00:00:00.000Z', null, { snapshotSha256: digest });
}

describe('M1 P4 Step 3 experimental full ASCII relay', () => {
  it('flag is disabled by default', () => {
    assert.equal(resolveFullAsciiRelayEnabled({}), false);
    assert.equal(resolveFullAsciiRelayEnabled({ includeTerrainFullAsciiBattlefield: false }), false);
    assert.equal(resolveFullAsciiRelayEnabled({ includeTerrainFullAsciiBattlefield: true }), true);
  });

  it('default prepareRelayPayload does not attach terrainFullAsciiBattlefield', () => {
    const tactical = syntheticDiscoveredMap(20, 20, 2);
    const prepared = prepareRelayPayloadForPublish(relayWithDigest(tactical));
    assert.equal(prepared.relay.terrainFullAsciiBattlefield, undefined);
    assert.equal(prepared.relay.terrainFullAsciiBattlefieldOmitted, undefined);
  });

  it('preserves snapshot_id and commandBinding with flag on vs off', () => {
    const tactical = syntheticDiscoveredMap(12, 12, 2);
    const relay = relayWithDigest(tactical);
    const id = computeSnapshotId(tactical);
    const off = prepareRelayPayloadForPublish(relay, { includeTerrainFullAsciiBattlefield: false });
    const on = prepareRelayPayloadForPublish(relay, { includeTerrainFullAsciiBattlefield: true });
    assert.equal(off.relay.snapshot_id, id);
    assert.equal(on.relay.snapshot_id, id);
    assert.deepEqual(off.relay.commandBinding, on.relay.commandBinding);
  });

  it('v4 without terrain records omission, not generated map', () => {
    const tactical = {
      schemaVersion: 4,
      turn: 1,
      side: 0,
      map: { width: 10, height: 10, depth: 1 },
      units: [],
      eventLog: {
        sessionId: '0123456789abcdef0123456789abcdef',
        oldestSeq: 0,
        latestSeq: 0,
        droppedCount: 0,
        events: [],
      },
    };
    const relay = buildRelayPayload(tactical, '2026-01-01T00:00:00.000Z');
    const result = applyExperimentalTerrainFullAsciiRelay(relay, { includeTerrainFullAsciiBattlefield: true });
    assert.equal(result.applied, false);
    assert.equal(result.relay.terrainFullAsciiBattlefieldOmitted?.reason, 'no_v5_terrain');
  });

  it('door semantics: U off-LOS vs D/d in LOS on relay attachment', () => {
    const tactical = baseTactical({
      terrain: {
        memoryNote: 'n',
        tiles: [
          tile([1, 1, 0], {
            inLos: true,
            north: { walk: 4, blockSight: false },
            sem: { north: 6 },
            structureMeta: { doorState: { north: 'closed' } },
          }),
          tile([2, 1, 0], {
            inLos: false,
            north: { walk: 4, blockSight: false },
            sem: { north: 6 },
            structureMeta: { doorState: { north: 'open' } },
          }),
        ],
      },
    });
    const attachment = buildFullAsciiBattlefieldRelayAttachment(tactical);
    const channels = attachment.levels[0].channels;
    assert.match(channels.edgeNorth, /D/);
    assert.match(channels.edgeNorth, /U/);
    assert.doesNotMatch(channels.edgeWest, /d/);
  });

  it('joined_rows_v1 relay wire has smaller incremental cost than raw row arrays', () => {
    const tactical = syntheticDiscoveredMap(50, 50, 4);
    const relay = relayWithDigest(tactical);
    const shrunk = prepareRelayPayloadForPublish(relay, { includeTerrainFullAsciiBattlefield: false });
    const full = buildFullAsciiBattlefieldMap(tactical);
    const probeArray = JSON.parse(JSON.stringify(shrunk.relay));
    probeArray.terrainFullAsciiBattlefield = full;
    const attachment = buildFullAsciiBattlefieldRelayAttachment(tactical);
    const probeJoined = JSON.parse(JSON.stringify(shrunk.relay));
    probeJoined.terrainFullAsciiBattlefield = attachment;
    const arrayBytes = publishedByteLength(probeArray);
    const joinedBytes = publishedByteLength(probeJoined);
    assert.ok(joinedBytes < arrayBytes, `joined ${joinedBytes} should beat array rows ${arrayBytes}`);
  });

  it('fits within relay target for 50×50×4 when enabled after shrink', () => {
    const tactical = syntheticDiscoveredMap(50, 50, 4);
    const prepared = prepareRelayPayloadForPublish(relayWithDigest(tactical), {
      includeTerrainFullAsciiBattlefield: true,
      targetBytes: RELAY_PUBLISH_TARGET_BYTES,
      maxBytes: RELAY_PUBLISH_MAX_BYTES,
    });
    if (prepared.relay.terrainFullAsciiBattlefield) {
      assert.ok(prepared.bytes <= RELAY_PUBLISH_TARGET_BYTES);
    } else {
      assert.equal(prepared.relay.terrainFullAsciiBattlefieldOmitted?.reason, 'exceeds_relay_target_bytes');
    }
  });

  it('omits gracefully when target budget is artificially tight', () => {
    const tactical = syntheticDiscoveredMap(30, 30, 2);
    const prepared = prepareRelayPayloadForPublish(relayWithDigest(tactical), {
      includeTerrainFullAsciiBattlefield: true,
      targetBytes: 12 * 1024,
      maxBytes: RELAY_PUBLISH_MAX_BYTES,
    });
    assert.equal(prepared.relay.terrainFullAsciiBattlefield, undefined);
    assert.equal(prepared.relay.terrainFullAsciiBattlefieldOmitted?.reason, 'exceeds_relay_target_bytes');
    assert.ok(prepared.bytes <= 12 * 1024);
    assert.ok(prepared.relay.terrainBrief);
  });

  it('undiscovered cells stay ? in attached map', () => {
    const tactical = baseTactical({
      map: { width: 4, height: 4, depth: 1 },
      terrain: {
        memoryNote: 'n',
        tiles: [tile([1, 1, 0])],
      },
    });
    const prepared = prepareRelayPayloadForPublish(relayWithDigest(tactical), {
      includeTerrainFullAsciiBattlefield: true,
      maxBytes: RELAY_PUBLISH_MAX_BYTES,
    });
    const vis = prepared.relay.terrainFullAsciiBattlefield?.levels[0].channels.visibility;
    assert.ok(vis.includes('?'));
    assert.equal(vis.split('\n')[0][0], '?');
  });

  it('does not embed hidden units in terrain channels', () => {
    const tactical = baseTactical({
      units: [
        { id: 1, faction: 0, originalFaction: 0, position: [1, 1, 0] },
        { id: 99, faction: 1, originalFaction: 1, position: [2, 1, 0] },
      ],
      terrain: { memoryNote: 'n', tiles: [tile([1, 1, 0]), tile([2, 1, 0])] },
    });
    const prepared = prepareRelayPayloadForPublish(relayWithDigest(tactical), {
      includeTerrainFullAsciiBattlefield: true,
      maxBytes: RELAY_PUBLISH_MAX_BYTES,
    });
    const floor = prepared.relay.terrainFullAsciiBattlefield?.levels[0].channels.floor;
    assert.ok(floor);
    assert.doesNotMatch(floor, /H/);
    assert.doesNotMatch(floor, /@/);
  });

  const liveIt = fs.existsSync(LIVE_SNAPSHOT) ? it : it.skip;

  liveIt('reconciles compact standalone vs pretty relay incremental bytes', () => {
    const text = fs.readFileSync(LIVE_SNAPSHOT, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(text, YAML);
    const relay = relayWithDigest(tactical);
    const off = prepareRelayPayloadForPublish(relay, { includeTerrainFullAsciiBattlefield: false });
    const on = prepareRelayPayloadForPublish(relay, {
      includeTerrainFullAsciiBattlefield: true,
      targetBytes: RELAY_PUBLISH_TARGET_BYTES,
      maxBytes: RELAY_PUBLISH_MAX_BYTES,
    });
    const compact = buildFullAsciiBattlefieldMap(tactical);
    const compactBytes = Buffer.byteLength(JSON.stringify(compact), 'utf8');
    const incremental = on.bytes - off.bytes;
    const accounting = on.relay.terrainFullAsciiBattlefieldMeta
      ?? on.relay.terrainFullAsciiBattlefieldOmitted?.sizeAccounting;
    assert.ok(accounting);
    const prettyOverhead = incremental - compactBytes;
    assert.ok(prettyOverhead >= 0, `pretty relay overhead vs compact standalone: ${prettyOverhead}`);
    if (accounting.overheadVersusCompactStandalone !== undefined) {
      assert.ok(accounting.overheadVersusCompactStandalone >= 0);
    }
    if (on.relay.terrainFullAsciiBattlefield) {
      assert.ok(incremental > compactBytes * 0.5);
      assert.ok(on.bytes <= RELAY_PUBLISH_MAX_BYTES);
      assert.ok(on.bytes <= RELAY_PUBLISH_TARGET_BYTES);
    } else {
      assert.ok(on.relay.terrainFullAsciiBattlefieldOmitted);
    }
  });
});
