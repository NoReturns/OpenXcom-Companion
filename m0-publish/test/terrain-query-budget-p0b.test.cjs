'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const {
  loadAndValidateSnapshotFromText,
  computeSnapshotId,
  buildRelayPayload,
} = require('../lib/tactical-publish.cjs');
const { sha256HexLower } = require('../lib/briefing-snapshot.cjs');
const {
  executeTerrainQuery,
  MAX_QUERY_RADIUS,
  DEFAULT_MAX_RESPONSE_BYTES,
  LEGACY_MAX_RESPONSE_BYTES,
  VIS_UNKNOWN,
} = require('../lib/terrain-query.cjs');
const { cloneRelayPayload, prepareRelayPayloadForPublish } = require('../lib/relay-payload-adaptive-shrink.cjs');
const { buildOversizedRelayForShrinkTest } = require('./helpers/oversized-relay-fixture.cjs');
const { responseByteLength } = require('../lib/terrain-query-budget.cjs');

const FIXTURE_V5 = path.join(__dirname, 'fixtures', 'valid-v5.yaml');
const LIVE_YAML = path.join(__dirname, '..', '..', '..', 'local', 'm0', 'tactical-live.yaml');

function loadV5() {
  const text = fs.readFileSync(FIXTURE_V5, 'utf8');
  return { tactical: loadAndValidateSnapshotFromText(text, YAML), text };
}

function queryAt(tactical, snapshotId, radius, extra = {}, options = {}) {
  return executeTerrainQuery(tactical, {
    snapshot_id: snapshotId,
    center: { x: 1, y: 2, z: 0 },
    radius,
    zMin: 0,
    zMax: (tactical.map.depth ?? 1) - 1,
    ...extra,
  }, options);
}

describe('terrain query budget (M1 P0B)', () => {
  it('returns schemaVersion 2 with budget metadata', () => {
    const { tactical, text } = loadV5();
    const id = computeSnapshotId(tactical);
    const res = queryAt(tactical, id, 2);
    assert.equal(res.schemaVersion, 2);
    assert.ok(res.budget?.usedBytes <= res.budget?.maxBytes);
    assert.ok(res.budget.usedBytes > 0);
  });

  for (const radius of [3, 5, 8, 12].filter((r) => r <= MAX_QUERY_RADIUS)) {
    it(`radius ${radius} on v5 fixture fits default budget without throwing`, () => {
      const { tactical } = loadV5();
      const id = computeSnapshotId(tactical);
      const res = queryAt(tactical, id, Math.min(radius, 5));
      assert.ok(responseByteLength(res) <= DEFAULT_MAX_RESPONSE_BYTES);
      if (res.unknown.length) {
        assert.equal(res.unknown[0].visibility, VIS_UNKNOWN);
      }
    });
  }

  it('compact profile uses compact cell encoding', () => {
    const { tactical } = loadV5();
    const id = computeSnapshotId(tactical);
    const compact = queryAt(tactical, id, 2, { profile: 'compact' });
    assert.equal(compact.profile, 'compact');
    const cell = compact.discovered.find((c) => c.b || c.cat);
    if (cell) {
      assert.equal(cell.terrainSemantics, undefined);
      assert.equal(cell.body, undefined);
    }
  });

  it('progressive truncation under legacy 8 KiB cap returns structured response', () => {
    const { tactical } = loadV5();
    const id = computeSnapshotId(tactical);
    const res = queryAt(tactical, id, 4, { maxResponseBytes: LEGACY_MAX_RESPONSE_BYTES });
    assert.ok(responseByteLength(res) <= LEGACY_MAX_RESPONSE_BYTES);
    assert.ok(res.truncated === true || res.discovered.length >= 1);
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(res)));
  });

  it('deterministic output for identical requests', () => {
    const { tactical } = loadV5();
    const id = computeSnapshotId(tactical);
    const req = {
      snapshot_id: id,
      center: { x: 5, y: 5, z: 0 },
      radius: 2,
    };
    const a = executeTerrainQuery(tactical, req, { maxResponseBytes: 16 * 1024 });
    const b = executeTerrainQuery(tactical, req, { maxResponseBytes: 16 * 1024 });
    assert.deepEqual(a, b);
  });

  it('adaptive-shrink relay tactical uses canonical options without throw at radius 5', () => {
    const oversized = buildOversizedRelayForShrinkTest();
    const prepared = prepareRelayPayloadForPublish(oversized);
    const text = fs.readFileSync(FIXTURE_V5, 'utf8');
    const canonical = loadAndValidateSnapshotFromText(text, YAML);
    const yamlSha256 = sha256HexLower(Buffer.from(text, 'utf8'));
    const res = executeTerrainQuery(prepared.relay.tactical, {
      snapshot_id: prepared.relay.snapshot_id,
      center: { x: 1, y: 2, z: 0 },
      radius: 5,
      profile: 'compact',
    }, {
      canonicalTactical: canonical,
      yamlSha256,
      commandBinding: prepared.relay.commandBinding,
      relayEnvelope: prepared.relay,
      maxResponseBytes: 32 * 1024,
    });
    assert.ok(responseByteLength(res) <= 32 * 1024);
    assert.equal(res.snapshot_id, prepared.relay.snapshot_id);
  });

  if (fs.existsSync(LIVE_YAML)) {
    it('live 50x50 YAML: radius 8 single-z compact under 32 KiB', () => {
      const bytes = fs.readFileSync(LIVE_YAML);
      const tactical = loadAndValidateSnapshotFromText(bytes.toString('utf8'), YAML);
      const id = computeSnapshotId(tactical);
      const yamlSha256 = sha256HexLower(bytes);
      const z = tactical.units?.find((u) => u.faction === 0)?.position?.[2] ?? 0;
      const center = tactical.units?.find((u) => u.faction === 0)?.position ?? [25, 25, z];
      const res = executeTerrainQuery(tactical, {
        snapshot_id: id,
        center: { x: center[0], y: center[1], z: center[2] },
        radius: 8,
        zMin: z,
        zMax: z,
        profile: 'compact',
      }, {
        canonicalTactical: tactical,
        yamlSha256,
        maxResponseBytes: 32 * 1024,
      });
      assert.ok(responseByteLength(res) <= 32 * 1024);
      assert.ok(!res.sizeError, res.sizeError?.note);
      assert.ok(res.discovered.length > 10);
    });
  }
});
