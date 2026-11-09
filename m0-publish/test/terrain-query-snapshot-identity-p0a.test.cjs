'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const {
  loadAndValidateSnapshotFromText,
  buildRelayPayload,
  computeSnapshotId,
} = require('../lib/tactical-publish.cjs');
const { sha256HexLower } = require('../lib/briefing-snapshot.cjs');
const {
  cloneRelayPayload,
  prepareRelayPayloadForPublish,
} = require('../lib/relay-payload-adaptive-shrink.cjs');
const { parseCommandBinding, buildCommandBinding } = require('../lib/command-binding.cjs');
const { executeTerrainQuery, MAX_RESPONSE_BYTES } = require('../lib/terrain-query.cjs');
const {
  verifyTerrainQuerySnapshotBinding,
  canonicalTerrainQuerySnapshotId,
} = require('../lib/terrain-query-snapshot-identity.cjs');
const { buildOversizedRelayForShrinkTest } = require('./helpers/oversized-relay-fixture.cjs');
const { VIS_DISCOVERED_OFF_LOS } = require('../lib/terrain-brief.cjs');

const FIXTURE_V5 = path.join(__dirname, 'fixtures', 'valid-v5.yaml');

function loadFixtureTactical() {
  const text = fs.readFileSync(FIXTURE_V5, 'utf8');
  const tactical = loadAndValidateSnapshotFromText(text, YAML);
  const yamlSha256 = sha256HexLower(Buffer.from(text, 'utf8'));
  return { tactical, text, yamlSha256 };
}

function baseQuery(snapshotId, tactical, overrides = {}) {
  return {
    snapshot_id: snapshotId,
    center: { x: 1, y: 2, z: 0 },
    radius: 2,
    ...overrides,
  };
}

function buildTrimmedRelayFixture() {
  const { tactical, yamlSha256 } = loadFixtureTactical();
  const relay = buildRelayPayload(tactical, '2026-11-09T12:00:00.000Z', null, {
    snapshotSha256: yamlSha256,
  });
  const envelopeSnapshotId = relay.snapshot_id;
  const trimmed = cloneRelayPayload(relay);
  trimmed.tactical.units = trimmed.tactical.units.slice(0, 1);
  trimmed.tactical.eventLog.events = [];
  trimmed.relay_export_shrink = {
    schema_version: 1,
    initialBytes: 300_000,
    finalBytes: 200_000,
    note: 'synthetic trim for P0A identity tests',
  };
  assert.notEqual(computeSnapshotId(trimmed.tactical), envelopeSnapshotId);
  assert.equal(trimmed.snapshot_id, envelopeSnapshotId);
  return { tactical, yamlSha256, relay: trimmed, envelopeSnapshotId, commandBinding: relay.commandBinding };
}

describe('terrain query snapshot identity (M1 P0A)', () => {
  it('1. untrimmed snapshot identity accepts envelope snapshot_id', () => {
    const { tactical, yamlSha256 } = loadFixtureTactical();
    const snapshotId = canonicalTerrainQuerySnapshotId(tactical);
    const result = executeTerrainQuery(tactical, baseQuery(snapshotId, tactical), {
      canonicalTactical: tactical,
      yamlSha256,
    });
    assert.equal(result.snapshot_id, snapshotId);
  });

  it('2. trimmed relay tactical rejects snapshot_id without canonical binding', () => {
    const { relay, envelopeSnapshotId } = buildTrimmedRelayFixture();
    assert.throws(
      () => executeTerrainQuery(relay.tactical, baseQuery(envelopeSnapshotId, relay.tactical)),
      /canonical tactical snapshot|verified YAML digest or commandBinding/,
    );
  });

  it('3. valid query using envelope snapshot_id with canonical YAML + binding', () => {
    const { tactical, yamlSha256, relay, envelopeSnapshotId, commandBinding } = buildTrimmedRelayFixture();
    const result = executeTerrainQuery(relay.tactical, baseQuery(envelopeSnapshotId, tactical), {
      canonicalTactical: tactical,
      yamlSha256,
      commandBinding,
      relayEnvelope: relay,
    });
    assert.equal(result.snapshot_id, envelopeSnapshotId);
    assert.equal(result.snapshot_id, canonicalTerrainQuerySnapshotId(tactical));
    assert.ok(result.discovered.length >= 1);
  });

  it('4. stale snapshot_id rejected', () => {
    const { tactical, yamlSha256 } = loadFixtureTactical();
    assert.throws(
      () => executeTerrainQuery(tactical, baseQuery('a'.repeat(64), tactical), {
        canonicalTactical: tactical,
        yamlSha256,
      }),
      /snapshot_id does not match canonical tactical snapshot/,
    );
  });

  it('5. wrong session_id rejected when commandBinding supplied', () => {
    const { tactical, yamlSha256, relay, envelopeSnapshotId, commandBinding } = buildTrimmedRelayFixture();
    assert.throws(
      () => executeTerrainQuery(relay.tactical, {
        ...baseQuery(envelopeSnapshotId, tactical),
        session_id: 'b'.repeat(32),
      }, {
        canonicalTactical: tactical,
        yamlSha256,
        commandBinding,
      }),
      /session_id does not match commandBinding/,
    );
  });

  it('6. forged relay envelope snapshot_id rejected', () => {
    const { tactical, yamlSha256, relay, envelopeSnapshotId, commandBinding } = buildTrimmedRelayFixture();
    const forged = { ...relay, snapshot_id: 'f'.repeat(64) };
    assert.throws(
      () => verifyTerrainQuerySnapshotBinding({
        request: baseQuery(envelopeSnapshotId, tactical),
        canonicalTactical: tactical,
        yamlSha256,
        commandBinding,
        relayEnvelope: forged,
      }),
      /relay envelope snapshot_id does not match/,
    );
  });

  it('7. modified tactical data rejected via yaml/commandBinding pin', () => {
    const { tactical, yamlSha256, relay, envelopeSnapshotId } = buildTrimmedRelayFixture();
    assert.throws(
      () => executeTerrainQuery(relay.tactical, baseQuery(envelopeSnapshotId, tactical), {
        canonicalTactical: tactical,
        yamlSha256: 'c'.repeat(64),
        commandBinding: relay.commandBinding,
      }),
      /snapshot_sha256 does not match verified YAML digest/,
    );
  });

  it('8. commandBinding parse/build unchanged by terrain query path', () => {
    const { tactical, yamlSha256 } = loadFixtureTactical();
    const binding = buildCommandBinding(tactical, yamlSha256);
    const parsed = parseCommandBinding(binding);
    assert.equal(parsed.snapshot_sha256, yamlSha256);
    assert.equal(parsed.session_id, tactical.eventLog.sessionId);
  });

  it('9. query result snapshot_id matches authorized canonical id', () => {
    const { tactical, yamlSha256, relay, envelopeSnapshotId, commandBinding } = buildTrimmedRelayFixture();
    const res = executeTerrainQuery(relay.tactical, baseQuery(envelopeSnapshotId, tactical), {
      canonicalTactical: tactical,
      yamlSha256,
      commandBinding,
    });
    assert.equal(res.snapshot_id, envelopeSnapshotId);
    assert.ok(Buffer.byteLength(JSON.stringify(res), 'utf8') <= MAX_RESPONSE_BYTES);
  });

  it('10. off-LOS observation restrictions remain in query cells', () => {
    const { tactical, yamlSha256 } = loadFixtureTactical();
    const snapshotId = computeSnapshotId(tactical);
    const res = executeTerrainQuery(tactical, {
      snapshot_id: snapshotId,
      center: { x: 5, y: 5, z: 0 },
      radius: 1,
      profile: 'verbose',
    }, {
      canonicalTactical: tactical,
      yamlSha256,
    });
    const offLos = res.discovered.find((c) => c.p[0] === 5 && c.p[1] === 5);
    assert.ok(offLos);
    assert.equal(offLos.visibility, VIS_DISCOVERED_OFF_LOS);
    if (offLos.observationNote) {
      assert.match(offLos.observationNote, /off_los|redacted/);
    }
  });

  it('adaptive-shrink relay fixture: envelope id authorizes query against canonical YAML', () => {
    const oversized = buildOversizedRelayForShrinkTest();
    const prepared = prepareRelayPayloadForPublish(oversized);
    const envelopeId = prepared.relay.snapshot_id;
    const text = fs.readFileSync(FIXTURE_V5, 'utf8');
    const canonical = loadAndValidateSnapshotFromText(text, YAML);
    const yamlSha256 = sha256HexLower(Buffer.from(text, 'utf8'));
    assert.notEqual(computeSnapshotId(prepared.relay.tactical), envelopeId);
    const query = baseQuery(envelopeId, canonical);
    const opts = {
      canonicalTactical: canonical,
      yamlSha256,
      commandBinding: prepared.relay.commandBinding,
      relayEnvelope: prepared.relay,
    };
    try {
      const res = executeTerrainQuery(prepared.relay.tactical, query, opts);
      assert.equal(res.snapshot_id, envelopeId);
    } catch (error) {
      assert.match(error.message, /exceeds max size|canonical tactical snapshot/);
      verifyTerrainQuerySnapshotBinding({
        request: query,
        canonicalTactical: canonical,
        yamlSha256,
        commandBinding: prepared.relay.commandBinding,
        relayEnvelope: prepared.relay,
        executionTactical: prepared.relay.tactical,
      });
    }
  });
});
