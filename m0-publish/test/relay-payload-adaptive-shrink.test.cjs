'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');
const YAML = require('yaml');

const {
  loadAndValidateSnapshotFromText,
  buildRelayPayload,
  computeSnapshotId,
} = require('../lib/tactical-publish.cjs');
const { parseCommandBinding } = require('../lib/command-binding.cjs');
const {
  RELAY_PUBLISH_MAX_BYTES,
  RELAY_PUBLISH_TARGET_BYTES,
  measureRelayPayloadContributions,
  prepareRelayPayloadForPublish,
  publishedByteLength,
} = require('../lib/relay-payload-adaptive-shrink.cjs');
const { createRelayPublisher } = require('../lib/github-relay.cjs');
const { sha256HexLower } = require('../lib/briefing-snapshot.cjs');
const { buildOversizedRelayForShrinkTest } = require('./helpers/oversized-relay-fixture.cjs');

const FIXTURE_V5 = path.join(__dirname, 'fixtures', 'valid-v5.yaml');
const LIVE_SNAPSHOT = path.join(__dirname, '..', '..', '..', 'local', 'm0', 'tactical-live.yaml');

function buildFixtureRelay() {
  const text = fs.readFileSync(FIXTURE_V5, 'utf8');
  const tactical = loadAndValidateSnapshotFromText(text, YAML);
  const digest = sha256HexLower(Buffer.from(text, 'utf8'));
  return buildRelayPayload(tactical, new Date(0).toISOString(), null, { snapshotSha256: digest });
}

describe('relay payload adaptive shrink', () => {
  it('leaves small v5 fixture unchanged under target', () => {
    const relay = buildFixtureRelay();
    const prepared = prepareRelayPayloadForPublish(relay);
    assert.equal(prepared.shrunk, false);
    assert.ok(prepared.bytes <= RELAY_PUBLISH_TARGET_BYTES);
    assert.equal(prepared.relay.snapshot_id, relay.snapshot_id);
  });

  it('preserves commandBinding and snapshot_id when shrinking an over-cap relay', () => {
    const relay = buildOversizedRelayForShrinkTest();
    const binding = { ...relay.commandBinding };
    const snapshotId = relay.snapshot_id;
    assert.ok(publishedByteLength(relay) > RELAY_PUBLISH_MAX_BYTES);

    const prepared = prepareRelayPayloadForPublish(relay);
    assert.equal(prepared.relay.snapshot_id, snapshotId);
    assert.deepEqual(prepared.relay.commandBinding, binding);
    assert.ok(prepared.bytes <= RELAY_PUBLISH_TARGET_BYTES);
    assert.ok(prepared.relay.relay_export_shrink);
    parseCommandBinding(prepared.relay.commandBinding);
    assert.ok(prepared.relay.terrainMapBrief);
    assert.ok(prepared.relay.terrainMapBrief.mapText.includes('@'));
    assert.ok(!prepared.steps.some((s) => s.step === 'terrain_map_brief_omit_last_resort'));
  });

  it('publishRelayState applies shrink before size gate', async () => {
    const relay = buildOversizedRelayForShrinkTest();
    assert.ok(publishedByteLength(relay) > RELAY_PUBLISH_MAX_BYTES);

    let putBody = null;
    const publisher = createRelayPublisher({
      repo: 'o/r',
      branch: 'main',
      ghApi: (method, _path, body) => {
        if (method === 'GET') {
          const error = new Error('Not Found');
          error.stderr = 'gh: Not Found (HTTP 404)';
          throw error;
        }
        if (method === 'PUT') {
          putBody = body;
          return {};
        }
        throw new Error(`unexpected ${method}`);
      },
    });
    await publisher.publishRelayState(relay);
    assert.ok(putBody);
    const decoded = Buffer.from(putBody.content, 'base64').toString('utf8');
    assert.ok(Buffer.byteLength(decoded, 'utf8') <= RELAY_PUBLISH_MAX_BYTES);
    const parsed = JSON.parse(decoded.trim());
    assert.ok(parsed.relay_export_shrink);
    assert.ok(publishedByteLength(relay) > RELAY_PUBLISH_MAX_BYTES);
    assert.ok(parsed.terrainMapBrief);
  });

  it('fits oversized fixture under target with documented shrink steps', () => {
    const text = fs.readFileSync(FIXTURE_V5, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(text, YAML);
    const relay = buildOversizedRelayForShrinkTest();
    const before = measureRelayPayloadContributions(relay);
    assert.ok(before.publishedBytes > RELAY_PUBLISH_MAX_BYTES);

    const prepared = prepareRelayPayloadForPublish(relay);
    assert.ok(prepared.bytes <= RELAY_PUBLISH_TARGET_BYTES);
    assert.ok(prepared.shrunk);
    assert.equal(prepared.relay.snapshot_id, computeSnapshotId(tactical));
    parseCommandBinding(prepared.relay.commandBinding);

    const hostileWithFacing = (prepared.relay.tactical.units ?? []).filter((u) => u.facing);
    assert.ok(hostileWithFacing.length >= 1, 'visible hostiles with facing preserved');
    assert.ok(prepared.relay.unitStateBrief);
    assert.ok(prepared.relay.terrainBrief);
    assert.ok(prepared.relay.terrainMapBrief?.mapText?.includes('@'));
    assert.ok(!prepared.steps.some((s) => s.step === 'terrain_map_brief_omit_last_resort'));
    assert.ok(prepared.steps.some((s) => s.step === 'perception_log_prior_turns'));
    assert.ok(prepared.steps.some((s) => s.step === 'terrain_blob_omit_for_terrain_brief')
      || prepared.steps.some((s) => s.step === 'event_log_tail_cap_48'));
    const currentTurnPerception = prepared.relay.tactical.perceptionLog.events.every(
      (ev) => ev.turn === tactical.turn,
    );
    assert.equal(currentTurnPerception, true);
  });

  const liveIt = fs.existsSync(LIVE_SNAPSHOT) ? it : it.skip;
  liveIt('live alien-base snapshot still shrinks or passes without fixture padding', () => {
    const text = fs.readFileSync(LIVE_SNAPSHOT, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(text, YAML);
    const digest = sha256HexLower(Buffer.from(text, 'utf8'));
    const relay = buildRelayPayload(
      tactical,
      new Date().toISOString(),
      {
        request_id: 'live-shrink-smoke',
        session_id: tactical.eventLog.sessionId,
        turn: tactical.turn,
      },
      { snapshotSha256: digest },
    );
    const before = publishedByteLength(relay);
    const prepared = prepareRelayPayloadForPublish(relay);
    assert.equal(prepared.relay.snapshot_id, relay.snapshot_id);
    assert.ok(prepared.bytes <= RELAY_PUBLISH_MAX_BYTES);
    if (before > RELAY_PUBLISH_TARGET_BYTES) {
      assert.ok(prepared.shrunk);
      assert.ok(prepared.relay.relay_export_shrink);
    }
    assert.ok(prepared.relay.terrainMapBrief?.mapText || prepared.relay.terrainMapBriefOmitted);
  });
});
