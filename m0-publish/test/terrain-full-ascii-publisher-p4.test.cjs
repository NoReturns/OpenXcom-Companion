'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const {
  loadAndValidateSnapshotFromText,
  buildRelayPayload,
  computeSnapshotId,
  canonicalTacticalJson,
  parseAndValidate,
} = require('../lib/tactical-publish.cjs');
const { parseCommandBinding } = require('../lib/command-binding.cjs');
const {
  RELAY_PUBLISH_MAX_BYTES,
  RELAY_PUBLISH_TARGET_BYTES,
  publishedByteLength,
} = require('../lib/relay-payload-adaptive-shrink.cjs');
const { createRelayPublisher } = require('../lib/github-relay.cjs');
const { sha256HexLower } = require('../lib/briefing-snapshot.cjs');
const { DOOR_STATE_UNKNOWN_OFF_LOS } = require('../lib/terrain-tactical-map.cjs');

const FIXTURE_V5 = path.join(__dirname, 'fixtures', 'valid-v5.yaml');
const LIVE_SNAPSHOT = path.join(__dirname, '..', '..', '..', 'local', 'm0', 'tactical-live.yaml');
const CAPTURE_DIR = path.join(__dirname, '..', '..', '..', 'local', 'disposable-p4-step4');

function notFoundGhApi(method) {
  if (method === 'GET') {
    const error = new Error('Not Found');
    error.stderr = 'gh: Not Found (HTTP 404)';
    throw error;
  }
  throw new Error(`unexpected ${method}`);
}

async function capturePublishRelayState(relay, publisherOptions = {}) {
  let putBody = null;
  const publisher = createRelayPublisher({
    repo: 'OpenXcom-Companion-Test/Relay-Isolated',
    branch: 'main',
    isolationEnforced: true,
    ghApi: (method, _path, body) => {
      if (method === 'GET') {
        return notFoundGhApi(method);
      }
      if (method === 'PUT') {
        putBody = body;
        return {};
      }
      throw new Error(`unexpected ${method}`);
    },
    ...publisherOptions,
  });
  const result = await publisher.publishRelayState(relay);
  assert.ok(putBody, 'expected mocked GitHub PUT body');
  const serialized = Buffer.from(putBody.content, 'base64').toString('utf8');
  const outbound = JSON.parse(serialized);
  return {
    result,
    outbound,
    serialized,
    bytes: Buffer.byteLength(serialized, 'utf8'),
    putBody,
  };
}

function buildRelayFromYaml(text, extra = {}) {
  const tactical = loadAndValidateSnapshotFromText(text, YAML);
  const digest = sha256HexLower(Buffer.from(text, 'utf8'));
  return {
    tactical,
    relay: buildRelayPayload(tactical, new Date(0).toISOString(), null, {
      snapshotSha256: digest,
      ...extra,
    }),
    digest,
  };
}

function tile(p, opts = {}) {
  return {
    p,
    disc: opts.disc ?? 7,
    inLos: opts.inLos ?? true,
    ...(opts.body ? { body: opts.body } : { body: { noFloor: false, elev: 0, walkF: 4 } }),
    ...(opts.north ? { north: opts.north } : {}),
    ...(opts.sem ? { sem: opts.sem } : {}),
    ...(opts.structureMeta ? { structureMeta: opts.structureMeta } : {}),
  };
}

function friendlyUnit(id, position) {
  return {
    id,
    faction: 0,
    originalFaction: 0,
    position,
    name: `Soldier ${id}`,
    health: 45,
    timeUnits: 50,
    kneeled: false,
    activeHand: 'STR_RIGHT_HAND',
    hands: {
      right: {
        itemType: 'STR_RIFLE',
        battleType: 1,
        loaded: { ammoType: 'STR_RIFLE_CLIP', rounds: 25 },
      },
      left: null,
    },
    inventory: [],
  };
}

function syntheticTactical(w, h, d) {
  const tiles = [];
  for (let z = 0; z < d; z += 1) {
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        if (x === 0 && y === 0 && z === 0) continue;
        const offLosDoor = x === 3 && y === 4 && z === 0;
        if (offLosDoor) {
          tiles.push(tile([x, y, z], {
            inLos: false,
            north: { walk: 4, blockSight: false },
            sem: { north: 6 },
          }));
          continue;
        }
        tiles.push(tile([x, y, z], { inLos: x + y < Math.floor(w / 2) }));
      }
    }
  }
  return {
    schemaVersion: 5,
    turn: 2,
    side: 0,
    selectedUnitId: 1,
    map: { width: w, height: h, depth: d },
    units: [friendlyUnit(1, [2, 2, 0])],
    eventLog: {
      sessionId: '0123456789abcdef0123456789abcdef',
      oldestSeq: 0,
      latestSeq: 0,
      droppedCount: 0,
      events: [],
    },
    terrain: { memoryNote: 'p4 synthetic', tiles },
  };
}

function buildRelayFromTactical(tacticalIn) {
  const tactical = parseAndValidate(tacticalIn);
  const digest = sha256HexLower(Buffer.from(canonicalTacticalJson(tactical), 'utf8'));
  return {
    tactical,
    relay: buildRelayPayload(tactical, new Date(0).toISOString(), null, { snapshotSha256: digest }),
  };
}

describe('M1 P4 Step 4 publisher integration (isolated dry run)', () => {
  let savedAsciiEnv;

  before(() => {
    savedAsciiEnv = process.env.OPENXCOM_COMPANION_RELAY_TERRAIN_FULL_ASCII;
    delete process.env.OPENXCOM_COMPANION_RELAY_TERRAIN_FULL_ASCII;
  });

  after(() => {
    if (savedAsciiEnv === undefined) {
      delete process.env.OPENXCOM_COMPANION_RELAY_TERRAIN_FULL_ASCII;
    } else {
      process.env.OPENXCOM_COMPANION_RELAY_TERRAIN_FULL_ASCII = savedAsciiEnv;
    }
  });

  it('default publisher path does not attach full ASCII', async () => {
    const text = fs.readFileSync(FIXTURE_V5, 'utf8');
    const { relay } = buildRelayFromYaml(text);
    const { outbound, bytes } = await capturePublishRelayState(relay);
    assert.equal(outbound.terrainFullAsciiBattlefield, undefined);
    assert.ok(outbound.terrainMapBrief);
    assert.ok(bytes <= RELAY_PUBLISH_MAX_BYTES);
  });

  it('full chain v5: validate → build → shrink → attach → publish capture', async () => {
    const text = fs.readFileSync(FIXTURE_V5, 'utf8');
    const { tactical, relay } = buildRelayFromYaml(text);
    const started = Date.now();
    const { outbound, bytes } = await capturePublishRelayState(relay, {
      includeTerrainFullAsciiBattlefield: true,
    });
    const elapsedMs = Date.now() - started;
    assert.ok(elapsedMs < 5000, `prepare+serialize took ${elapsedMs}ms`);
    assert.ok(outbound.terrainFullAsciiBattlefield);
    parseCommandBinding(outbound.commandBinding);
    assert.equal(outbound.snapshot_id, computeSnapshotId(tactical));
    const ascii = outbound.terrainFullAsciiBattlefield;
    assert.equal(ascii.wireFormat, 'joined_rows_v1');
    assert.ok(bytes <= RELAY_PUBLISH_MAX_BYTES);
    if (ascii.map) {
      const rows = ascii.levels[0].channels.visibility.split('\n');
      assert.equal(rows.length, ascii.map.height);
      assert.equal(rows[0].length, ascii.map.width);
    }
    assert.ok(outbound.terrainMapBrief.window.width <= 20);
    assert.ok(ascii.map.width >= outbound.terrainMapBrief.window.width);
  });

  it('60×60×4 synthetic fits or omits with metadata under relay caps', async () => {
    const { relay } = buildRelayFromTactical(syntheticTactical(60, 60, 4));
    const { outbound, bytes } = await capturePublishRelayState(relay, {
      includeTerrainFullAsciiBattlefield: true,
    });
    assert.ok(bytes <= RELAY_PUBLISH_MAX_BYTES);
    if (outbound.terrainFullAsciiBattlefield) {
      const vis = outbound.terrainFullAsciiBattlefield.levels[0].channels.visibility;
      const firstRow = vis.split('\n')[0];
      assert.equal(firstRow.length, 60);
      assert.equal(vis.split('\n').length, 60);
      assert.ok(outbound.terrainFullAsciiBattlefieldMeta?.included);
    } else {
      assert.ok(outbound.terrainFullAsciiBattlefieldOmitted);
    }
  });

  it('budget-driven omission via publisher target bytes', async () => {
    const { relay } = buildRelayFromTactical(syntheticTactical(30, 30, 2));
    const { outbound } = await capturePublishRelayState(relay, {
      includeTerrainFullAsciiBattlefield: true,
      relayPublishTargetBytes: 10 * 1024,
    });
    assert.equal(outbound.terrainFullAsciiBattlefield, undefined);
    assert.equal(outbound.terrainFullAsciiBattlefieldOmitted?.reason, 'exceeds_relay_target_bytes');
    assert.ok(outbound.terrainBrief);
    assert.ok(outbound.commandBinding);
  });

  it('v4 without terrain never attaches ASCII', async () => {
    const relay = buildRelayPayload({
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
    }, new Date(0).toISOString());
    const { outbound } = await capturePublishRelayState(relay, {
      includeTerrainFullAsciiBattlefield: true,
    });
    assert.equal(outbound.terrainFullAsciiBattlefield, undefined);
    assert.equal(outbound.terrainFullAsciiBattlefieldOmitted?.reason, 'no_v5_terrain');
  });

  it('strips stale ASCII when flag disabled', async () => {
    const text = fs.readFileSync(FIXTURE_V5, 'utf8');
    const { relay } = buildRelayFromYaml(text);
    relay.terrainFullAsciiBattlefield = { stale: true };
    relay.terrainFullAsciiBattlefieldMeta = { stale: true };
    const { outbound } = await capturePublishRelayState(relay, {
      includeTerrainFullAsciiBattlefield: false,
    });
    assert.equal(outbound.terrainFullAsciiBattlefield, undefined);
    assert.equal(outbound.terrainFullAsciiBattlefieldMeta, undefined);
  });

  it('repeated publication uses new snapshot map, not stale dimensions', async () => {
    const { relay: relayA } = buildRelayFromTactical(syntheticTactical(12, 12, 1));
    const { relay: relayB, tactical: tacticalB } = buildRelayFromTactical(syntheticTactical(20, 20, 1));
    assert.notEqual(relayA.snapshot_id, relayB.snapshot_id);
    const capA = await capturePublishRelayState(relayA, { includeTerrainFullAsciiBattlefield: true });
    const capB = await capturePublishRelayState(relayB, { includeTerrainFullAsciiBattlefield: true });
    const visA = capA.outbound.terrainFullAsciiBattlefield?.levels[0].channels.visibility;
    const visB = capB.outbound.terrainFullAsciiBattlefield?.levels[0].channels.visibility;
    assert.ok(visA && visB);
    assert.equal(visA.split('\n')[0].length, 12);
    assert.equal(visB.split('\n')[0].length, 20);
    assert.equal(capB.outbound.snapshot_id, computeSnapshotId(tacticalB));
  });

  it('fairness: off-LOS door U and no unit glyphs in ASCII channels', async () => {
    const { relay } = buildRelayFromTactical(syntheticTactical(8, 8, 1));
    const { outbound } = await capturePublishRelayState(relay, {
      includeTerrainFullAsciiBattlefield: true,
    });
    const north = outbound.terrainFullAsciiBattlefield?.levels[0].channels.edgeNorth;
    assert.ok(north);
    assert.ok(north.includes(DOOR_STATE_UNKNOWN_OFF_LOS));
    const floor = outbound.terrainFullAsciiBattlefield.levels[0].channels.floor;
    assert.doesNotMatch(floor, /@|H/);
  });

  const liveIt = fs.existsSync(LIVE_SNAPSHOT) ? it : it.skip;

  liveIt('captures disposable outbound JSON from live snapshot dry run', async () => {
    const text = fs.readFileSync(LIVE_SNAPSHOT, 'utf8');
    const { relay } = buildRelayFromYaml(text);
    const off = await capturePublishRelayState(relay, { includeTerrainFullAsciiBattlefield: false });
    const on = await capturePublishRelayState(relay, { includeTerrainFullAsciiBattlefield: true });
    fs.mkdirSync(CAPTURE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CAPTURE_DIR, 'outbound-off.json'), off.serialized, 'utf8');
    fs.writeFileSync(path.join(CAPTURE_DIR, 'outbound-on.json'), on.serialized, 'utf8');
    fs.writeFileSync(path.join(CAPTURE_DIR, 'capture-metrics.json'), `${JSON.stringify({
      offBytes: off.bytes,
      onBytes: on.bytes,
      incremental: on.bytes - off.bytes,
      asciiIncluded: Boolean(on.outbound.terrainFullAsciiBattlefield),
      omittedReason: on.outbound.terrainFullAsciiBattlefieldOmitted?.reason ?? null,
      relayTargetBytes: RELAY_PUBLISH_TARGET_BYTES,
      relayMaxBytes: RELAY_PUBLISH_MAX_BYTES,
    }, null, 2)}\n`, 'utf8');
    assert.ok(off.bytes <= RELAY_PUBLISH_MAX_BYTES);
    assert.ok(on.bytes <= RELAY_PUBLISH_MAX_BYTES);
    if (on.outbound.terrainFullAsciiBattlefield) {
      const { map } = on.outbound.terrainFullAsciiBattlefield;
      const rows = on.outbound.terrainFullAsciiBattlefield.levels[0].channels.visibility.split('\n');
      assert.equal(rows.length, map.height);
      assert.equal(rows[0].length, map.width);
    }
  });

  it('env OPENXCOM_COMPANION_RELAY_TERRAIN_FULL_ASCII=1 enables attach without explicit option', async () => {
    process.env.OPENXCOM_COMPANION_RELAY_TERRAIN_FULL_ASCII = '1';
    try {
      const text = fs.readFileSync(FIXTURE_V5, 'utf8');
      const { relay } = buildRelayFromYaml(text);
      const { outbound } = await capturePublishRelayState(relay, {});
      assert.ok(outbound.terrainFullAsciiBattlefield || outbound.terrainFullAsciiBattlefieldOmitted);
    } finally {
      delete process.env.OPENXCOM_COMPANION_RELAY_TERRAIN_FULL_ASCII;
    }
  });
});
