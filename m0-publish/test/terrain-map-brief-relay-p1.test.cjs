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
const {
  buildTerrainMapBrief,
  MAX_TERRAIN_MAP_BRIEF_BYTES,
  PROVENANCE_LIVE_EXPORT,
} = require('../lib/terrain-map-brief.cjs');
const {
  prepareRelayPayloadForPublish,
  publishedByteLength,
  RELAY_PUBLISH_TARGET_BYTES,
} = require('../lib/relay-payload-adaptive-shrink.cjs');
const { parseCommandBinding } = require('../lib/command-binding.cjs');
const { sha256HexLower } = require('../lib/briefing-snapshot.cjs');

const LIVE_SNAPSHOT = path.join(__dirname, '..', '..', '..', 'local', 'm0', 'tactical-live.yaml');

describe('terrainMapBrief P1 relay', () => {
  const liveIt = fs.existsSync(LIVE_SNAPSHOT) ? it : it.skip;

  liveIt('Novosibirsk relay includes edge-interleaved map with Oso and wall belt', () => {
    const text = fs.readFileSync(LIVE_SNAPSHOT, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(text, YAML);
    const digest = sha256HexLower(Buffer.from(text, 'utf8'));
    const snapshotId = computeSnapshotId(tactical);
    const relay = buildRelayPayload(
      tactical,
      new Date().toISOString(),
      {
        request_id: crypto.randomBytes(16).toString('hex'),
        session_id: tactical.eventLog.sessionId,
        turn: tactical.turn,
      },
      { snapshotSha256: digest },
    );
    assert.equal(relay.snapshot_id, snapshotId);
    assert.ok(relay.terrainMapBrief);
    assert.equal(relay.terrainMapBrief.schemaVersion, 1);
    assert.equal(relay.terrainMapBrief.presentation, 'edge_interleaved');
    assert.equal(relay.terrainMapBrief.provenance, PROVENANCE_LIVE_EXPORT);
    assert.ok(relay.terrainMapBrief.byteLength <= MAX_TERRAIN_MAP_BRIEF_BYTES);
    assert.ok(relay.terrainMapBrief.mapText.includes('@'));
    assert.ok(relay.terrainMapBrief.mapText.includes('---'));
    assert.ok(!relay.terrainMapBrief.mapText.includes('wwwwowwooo'), 'composite wall tiles must not appear');
    parseCommandBinding(relay.commandBinding);
  });

  liveIt('terrainMapBrief survives adaptive shrink on Novosibirsk live payload', () => {
    const text = fs.readFileSync(LIVE_SNAPSHOT, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(text, YAML);
    const digest = sha256HexLower(Buffer.from(text, 'utf8'));
    const snapshotId = computeSnapshotId(tactical);
    const relay = buildRelayPayload(
      tactical,
      new Date().toISOString(),
      {
        request_id: crypto.randomBytes(16).toString('hex'),
        session_id: tactical.eventLog.sessionId,
        turn: tactical.turn,
      },
      { snapshotSha256: digest },
    );
    const prepared = prepareRelayPayloadForPublish(relay);
    assert.equal(prepared.relay.snapshot_id, snapshotId);
    assert.ok(prepared.bytes <= RELAY_PUBLISH_TARGET_BYTES);
    if (prepared.relay.terrainMapBrief) {
      assert.ok(prepared.relay.terrainMapBrief.mapText.includes('@'));
      assert.ok(!prepared.relay.terrainMapBriefOmitted);
    } else {
      assert.ok(prepared.relay.terrainMapBriefOmitted);
    }
    assert.ok(!prepared.steps.some((s) => s.step === 'terrain_map_brief_omit_last_resort'));
    parseCommandBinding(prepared.relay.commandBinding);
  });

  it('crop continuation markers do not fake walls at clip edge', () => {
    const tactical = {
      schemaVersion: 5,
      turn: 1,
      side: 0,
      selectedUnitId: 1,
      map: { width: 30, height: 30, depth: 1 },
      units: [{
        id: 1,
        faction: 0,
        originalFaction: 0,
        position: [15, 15, 0],
        name: 'S',
      }],
      eventLog: {
        sessionId: '0123456789abcdef0123456789abcdef',
        oldestSeq: 0,
        latestSeq: 0,
        droppedCount: 0,
        events: [],
      },
      terrain: {
        memoryNote: 'n',
        tiles: [{
          p: [15, 15, 0],
          disc: 4,
          inLos: true,
          body: { noFloor: false, elev: 0, walkF: 4 },
        }],
      },
    };
    const brief = buildTerrainMapBrief(tactical);
    assert.ok(brief.mapText);
    assert.ok(brief.window.mapContinues.west);
    assert.match(brief.mapText, />|\?\?\?/);
  });
});
