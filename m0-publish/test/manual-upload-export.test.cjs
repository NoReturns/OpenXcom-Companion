'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const YAML = require('yaml');

const {
  loadAndValidateSnapshotFromText,
  buildRelayPayload,
} = require('../lib/tactical-publish.cjs');
const {
  prepareRelayPayloadForPublish,
  publishedByteLength,
  RELAY_PUBLISH_MAX_BYTES,
  RELAY_SHRINK_EXHAUSTED,
} = require('../lib/relay-payload-adaptive-shrink.cjs');
const { createRelayPublisher } = require('../lib/github-relay.cjs');
const { sha256HexLower } = require('../lib/briefing-snapshot.cjs');
const {
  buildOversizedRelayForShrinkTest,
  buildShrinkExhaustedRelay,
  FIXTURE_V5,
} = require('./helpers/oversized-relay-fixture.cjs');
const {
  MANUAL_ARTIFACT_MAX_BYTES,
  MANUAL_ARTIFACT_KIND,
  ManualUploadExportError,
  buildManualIntelligenceArtifact,
  writeManualIntelligenceArtifact,
  tryWriteManualArtifactAfterShrinkExhausted,
  captureRelayShrinkExhaustion,
} = require('../lib/manual-upload-export.cjs');
const {
  RELAY_PUBLISH_ERROR,
  classifyRelayPublishError,
  isRelayShrinkExhausted,
  shouldOfferManualUploadForPublishError,
} = require('../lib/relay-publish-error.cjs');
const {
  fingerprintProductionCommandRelayJournal,
  assertProductionCommandRelayJournalUnchanged,
} = require('../lib/relay-test-isolation.cjs');

function withTempExportDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oxc-manual-export-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function buildFixtureRelay() {
  const text = fs.readFileSync(FIXTURE_V5, 'utf8');
  const tactical = loadAndValidateSnapshotFromText(text, YAML);
  const digest = sha256HexLower(Buffer.from(text, 'utf8'));
  return buildRelayPayload(
    tactical,
    new Date(0).toISOString(),
    { request_id: 'fixture-req-01', session_id: tactical.eventLog.sessionId, turn: tactical.turn },
    { snapshotSha256: digest },
  );
}

describe('manual-upload-export (M1 P3 step 1)', () => {
  let journalBefore;

  before(() => {
    journalBefore = fingerprintProductionCommandRelayJournal();
  });

  after(() => {
    const journalAfter = fingerprintProductionCommandRelayJournal();
    assertProductionCommandRelayJournalUnchanged(journalBefore, journalAfter);
  });

  it('classifies RELAY_SHRINK_EXHAUSTED distinctly from auth and conflict errors', () => {
    const shrinkErr = new Error('too big');
    shrinkErr.code = RELAY_SHRINK_EXHAUSTED;
    assert.equal(classifyRelayPublishError(shrinkErr), RELAY_SHRINK_EXHAUSTED);
    assert.equal(shouldOfferManualUploadForPublishError(shrinkErr), true);
    assert.equal(isRelayShrinkExhausted(shrinkErr), true);

    const auth = new Error('GitHub authentication failed.');
    auth.code = RELAY_PUBLISH_ERROR.AUTH_FAILED;
    assert.equal(shouldOfferManualUploadForPublishError(auth), false);

    const conflict = new Error('SHA conflict');
    conflict.code = RELAY_PUBLISH_ERROR.SHA_CONFLICT;
    assert.equal(shouldOfferManualUploadForPublishError(conflict), false);
  });

  it('publishRelayState preserves RELAY_SHRINK_EXHAUSTED after shrink exhaustion', async () => {
    const relay = buildShrinkExhaustedRelay();
    const publisher = createRelayPublisher({
      repo: 'o/r',
      branch: 'main',
      ghApi: () => {
        throw new Error('gh should not be called');
      },
    });
    await assert.rejects(() => publisher.publishRelayState(relay), (error) => {
      assert.equal(error.code, RELAY_SHRINK_EXHAUSTED);
      assert.ok(error.finalBytes > RELAY_PUBLISH_MAX_BYTES);
      assert.ok(Array.isArray(error.steps));
      return true;
    });
  });

  it('still shrinks relays that can fit under automatic transport', () => {
    const relay = buildOversizedRelayForShrinkTest();
    assert.ok(publishedByteLength(relay) > RELAY_PUBLISH_MAX_BYTES);
    const prepared = prepareRelayPayloadForPublish(relay);
    assert.ok(prepared.bytes <= RELAY_PUBLISH_MAX_BYTES);
    assert.ok(prepared.relay.commandBinding);
  });

  it('captureRelayShrinkExhaustion rejects payloads that fit automatic transport', () => {
    const relay = buildFixtureRelay();
    assert.throws(
      () => captureRelayShrinkExhaustion(relay),
      (error) => error instanceof ManualUploadExportError && error.code === 'NOT_SIZE_FAILURE',
    );
  });

  it('buildManualIntelligenceArtifact is self-contained and strips command authority', () => {
    const relay = buildShrinkExhaustedRelay();
    const digest = relay.commandBinding.snapshot_sha256;
    const shrinkContext = captureRelayShrinkExhaustion(relay);
    const { artifact, bytes } = buildManualIntelligenceArtifact(relay, { shrinkContext });

    assert.equal(artifact.kind, MANUAL_ARTIFACT_KIND);
    assert.equal(artifact.command_authority.authoritative, false);
    assert.equal(artifact.read_only, true);
    assert.equal(artifact.source_snapshot_sha256, digest);
    assert.ok(!Object.hasOwn(artifact, 'commandBinding'));
    assert.ok(artifact.tactical);
    assert.ok(artifact.tactical.terrain);
    assert.ok(artifact.terrainMapBrief?.mapText);
    assert.ok(artifact.unitStateBrief);
    assert.ok(artifact.tactical.eventLog);
    assert.ok(artifact.tactical.perceptionLog);
    assert.equal(artifact.automatic_transport.outcome, RELAY_SHRINK_EXHAUSTED);
    assert.ok(bytes > RELAY_PUBLISH_MAX_BYTES);
    assert.ok(bytes <= MANUAL_ARTIFACT_MAX_BYTES);
    const serialized = JSON.stringify(artifact);
    assert.ok(!serialized.includes('OPENXCOM_'));
    assert.ok(!serialized.match(/[A-Za-z]:\\\\/));
  });

  it('writeManualIntelligenceArtifact writes atomically with matching digest', () => {
    withTempExportDir((exportDir) => {
      const relay = buildShrinkExhaustedRelay();
      const result = writeManualIntelligenceArtifact(exportDir, relay, { exportedAtMs: 1_700_000_000_000 });
      assert.ok(result.path.startsWith(exportDir));
      assert.ok(fs.existsSync(result.path));
      const onDisk = fs.readFileSync(result.path, 'utf8');
      const dig = crypto.createHash('sha256').update(onDisk, 'utf8').digest('hex');
      assert.equal(dig, result.sha256);
      assert.equal(Buffer.byteLength(onDisk, 'utf8'), result.bytes);
      const parsed = JSON.parse(onDisk);
      assert.equal(parsed.source_snapshot_sha256, relay.commandBinding.snapshot_sha256);
    });
  });

  it('tryWriteManualArtifactAfterShrinkExhausted skips when payload fits', () => {
    withTempExportDir((exportDir) => {
      const relay = buildFixtureRelay();
      const outcome = tryWriteManualArtifactAfterShrinkExhausted(exportDir, relay);
      assert.equal(outcome.written, false);
      assert.equal(outcome.reason, 'not_size_failure');
      assert.deepEqual(fs.readdirSync(exportDir), []);
    });
  });

  it('tryWriteManualArtifactAfterShrinkExhausted writes when shrink exhausts', () => {
    withTempExportDir((exportDir) => {
      const relay = buildShrinkExhaustedRelay();
      const outcome = tryWriteManualArtifactAfterShrinkExhausted(exportDir, relay);
      assert.equal(outcome.written, true);
      assert.ok(outcome.bytes > RELAY_PUBLISH_MAX_BYTES);
      assert.ok(fs.existsSync(outcome.path));
    });
  });

  it('propagates disk write failure without creating a complete artifact', () => {
    withTempExportDir((exportDir) => {
      const relay = buildShrinkExhaustedRelay();
      assert.throws(
        () => writeManualIntelligenceArtifact(exportDir, relay, {
          writeFileSync: () => {
            throw new Error('ENOSPC simulated');
          },
        }),
        (error) => error instanceof ManualUploadExportError
          && error.code === 'MANUAL_EXPORT_WRITE_FAILED',
      );
      assert.deepEqual(fs.readdirSync(exportDir), []);
    });
  });

  it('classifies unrelated GitHub failures without treating them as size failures', () => {
    const auth = new Error('GitHub authentication failed.');
    auth.code = RELAY_PUBLISH_ERROR.AUTH_FAILED;
    assert.equal(classifyRelayPublishError(auth), RELAY_PUBLISH_ERROR.AUTH_FAILED);
    assert.equal(shouldOfferManualUploadForPublishError(auth), false);

    const rate = new Error('rate limited');
    rate.code = RELAY_PUBLISH_ERROR.RATE_LIMIT;
    assert.equal(shouldOfferManualUploadForPublishError(rate), false);
  });
});
