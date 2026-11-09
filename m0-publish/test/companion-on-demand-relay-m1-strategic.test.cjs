'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  runSendOnce,
  createOnDemandRelayContext,
  SEND_PHASE,
  resolveOnDemandPaths,
  processPendingRequest,
} = require('../lib/companion-on-demand-relay.cjs');
const { assessStrategicSendReadiness, publishStrategicBaseState } = require('../lib/strategic-publish.cjs');
const { writeJsonAtomic } = require('../lib/local-atomic.cjs');
const { isolatedCommandRelayStateDir } = require('../lib/relay-test-isolation.cjs');
const { sha256HexLower } = require('../lib/briefing-snapshot.cjs');
const { DEFAULT_BASE_STATE_PATH } = require('../lib/relay-config.cjs');

const BI_FIXTURE = path.join(__dirname, 'fixtures', 'minimal-base-intelligence-v2.json');

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'm1-strategic-'));
}

function writeBiAndMarker(paths, requestId) {
  const biText = fs.readFileSync(BI_FIXTURE, 'utf8');
  fs.writeFileSync(paths.baseIntelligenceSendPath, biText, 'utf8');
  const digest = sha256HexLower(Buffer.from(biText, 'utf8'));
  writeJsonAtomic(paths.strategicSendMarkerPath, {
    schema_version: 1,
    on_demand_request_id: requestId,
    content_sha256: digest,
    campaign_id: 'test-campaign',
    exported_at_ms: Date.now(),
  });
  return digest;
}

describe('companion on-demand relay M1 strategic send', () => {
  let root;
  let snapshotPath;
  let relayStateDir;
  let paths;

  beforeEach(() => {
    root = makeRoot();
    snapshotPath = path.join(root, 'tactical-live.yaml');
    fs.writeFileSync(snapshotPath, 'tactical: {}\n', 'utf8');
    relayStateDir = isolatedCommandRelayStateDir(root, 'relay-state');
    paths = resolveOnDemandPaths(snapshotPath);
  });

  it('strategic send without staged snapshot is not_ready (no tactical YAML gate)', async () => {
    const readiness = assessStrategicSendReadiness(paths, 'a'.repeat(32));
    assert.equal(readiness.ok, false);
    assert.match(readiness.message, /strategic send snapshot/i);
    const ctx = createOnDemandRelayContext({ snapshotPath, commandRelayStateDir: relayStateDir, dryRun: true });
    const outcome = await runSendOnce(ctx, {
      request_id: 'a'.repeat(32),
      send_scope: 'strategic',
    });
    assert.equal(outcome.phase, SEND_PHASE.NOT_READY);
  });

  it('publishes BI to m0/base-state.json without tactical state publish', async () => {
    const requestId = 'b'.repeat(32);
    writeBiAndMarker(paths, requestId);
    const statePutPaths = [];
    const tacticalPutPaths = [];
    const ctx = createOnDemandRelayContext({
      snapshotPath,
      commandRelayStateDir: relayStateDir,
      dryRun: false,
      relayPublisher: {
        publishRelayState: async () => {
          tacticalPutPaths.push('m0/state.json');
          return { skipped: false };
        },
        publishRelayDocument: async (relay, options = {}) => {
          statePutPaths.push(options.statePath);
          assert.equal(relay.kind, 'strategic_base_snapshot');
          assert.equal(relay.schema_version, 2);
          assert.equal(relay.identity.campaign_id, 'test-campaign');
          assert.equal(relay.request_id, requestId);
          return { skipped: false };
        },
      },
    });
    const outcome = await runSendOnce(ctx, {
      request_id: requestId,
      send_scope: 'strategic',
    });
    assert.equal(outcome.phase, SEND_PHASE.SENT);
    assert.deepEqual(tacticalPutPaths, []);
    assert.deepEqual(statePutPaths, [DEFAULT_BASE_STATE_PATH]);
  });

  it('rejects stale marker vs current request id', async () => {
    writeBiAndMarker(paths, 'c'.repeat(32));
    const readiness = assessStrategicSendReadiness(paths, 'd'.repeat(32));
    assert.equal(readiness.ok, false);
    assert.equal(readiness.error_code, 'STRATEGIC_MARKER_STALE');
  });

  it('rejects malformed staged send JSON', async () => {
    const requestId = 'e'.repeat(32);
    writeJsonAtomic(paths.strategicSendMarkerPath, {
      schema_version: 1,
      on_demand_request_id: requestId,
      content_sha256: '0'.repeat(64),
      campaign_id: 'test-campaign',
      exported_at_ms: Date.now(),
    });
    fs.writeFileSync(paths.baseIntelligenceSendPath, '{not json', 'utf8');
    const readiness = assessStrategicSendReadiness(paths, requestId);
    assert.equal(readiness.ok, false);
    assert.equal(readiness.error_code, 'STRATEGIC_INVALID_JSON');
  });

  it('F8 canonical overwrite during pending SEND does not affect staged snapshot publishability', async () => {
    const requestId = '5'.repeat(32);
    const stagedText = fs.readFileSync(BI_FIXTURE, 'utf8');
    fs.writeFileSync(paths.baseIntelligenceSendPath, stagedText, 'utf8');
    const digest = sha256HexLower(Buffer.from(stagedText, 'utf8'));
    writeJsonAtomic(paths.strategicSendMarkerPath, {
      schema_version: 1,
      on_demand_request_id: requestId,
      content_sha256: digest,
      campaign_id: 'test-campaign',
      exported_at_ms: Date.now(),
    });
    fs.writeFileSync(paths.baseIntelligencePath, '{"schema_version":2,"f8":"manual"}\n', 'utf8');
    const readiness = assessStrategicSendReadiness(paths, requestId);
    assert.equal(readiness.ok, true);
    assert.equal(readiness.digest, digest);
  });

  it('rejects publication when staged send snapshot missing', async () => {
    const requestId = '6'.repeat(32);
    writeJsonAtomic(paths.strategicSendMarkerPath, {
      schema_version: 1,
      on_demand_request_id: requestId,
      content_sha256: 'f'.repeat(64),
      campaign_id: 'test-campaign',
      exported_at_ms: Date.now(),
    });
    assert.equal(fs.existsSync(paths.baseIntelligenceSendPath), false);
    const readiness = assessStrategicSendReadiness(paths, requestId);
    assert.equal(readiness.ok, false);
    assert.equal(readiness.error_code, 'NOT_READY');
  });

  it('rejects corrupted staged send snapshot vs marker digest', async () => {
    const requestId = '7'.repeat(32);
    const stagedText = fs.readFileSync(BI_FIXTURE, 'utf8');
    fs.writeFileSync(paths.baseIntelligenceSendPath, stagedText, 'utf8');
    writeJsonAtomic(paths.strategicSendMarkerPath, {
      schema_version: 1,
      on_demand_request_id: requestId,
      content_sha256: '0'.repeat(64),
      campaign_id: 'test-campaign',
      exported_at_ms: Date.now(),
    });
    const readiness = assessStrategicSendReadiness(paths, requestId);
    assert.equal(readiness.ok, false);
    assert.equal(readiness.error_code, 'STRATEGIC_DIGEST_MISMATCH');
  });

  it('strategic send does not require tactical send marker', async () => {
    assert.equal(fs.existsSync(paths.tacticalSendMarkerPath), false);
    const requestId = 'f'.repeat(32);
    writeBiAndMarker(paths, requestId);
    const readiness = assessStrategicSendReadiness(paths, requestId);
    assert.equal(readiness.ok, true);
  });

  it('strategic runSendOnce never calls tactical publishSnapshot path', async () => {
    const requestId = '1'.repeat(32);
    writeBiAndMarker(paths, requestId);
    let tacticalPublishCalls = 0;
    const ctx = createOnDemandRelayContext({
      snapshotPath,
      commandRelayStateDir: relayStateDir,
      dryRun: false,
      relayPublisher: {
        publishRelayState: async () => {
          tacticalPublishCalls += 1;
          return { skipped: false };
        },
        publishRelayDocument: async () => ({ skipped: false }),
      },
    });
    await runSendOnce(ctx, { request_id: requestId, send_scope: 'strategic' });
    assert.equal(tacticalPublishCalls, 0);
  });

  it('idle daemon tick still avoids GitHub when no pending request', async () => {
    const apiCalls = [];
    const ctx = createOnDemandRelayContext({
      snapshotPath,
      commandRelayStateDir: relayStateDir,
      dryRun: true,
      relayPublisher: {
        publishRelayState: async () => {
          apiCalls.push('tactical');
          return { skipped: false };
        },
        publishRelayDocument: async () => {
          apiCalls.push('strategic');
          return { skipped: false };
        },
      },
    });
    const result = await processPendingRequest(ctx);
    assert.equal(result.processed, false);
    assert.deepEqual(apiCalls, []);
  });

  it('immediate daemon pickup after marker then request file', async () => {
    const requestId = '3'.repeat(32);
    writeBiAndMarker(paths, requestId);
    writeJsonAtomic(paths.requestPath, {
      request_id: requestId,
      action: 'send',
      status: 'pending',
      send_scope: 'strategic',
      created_at_ms: Date.now(),
    });
    let strategicPublishes = 0;
    const ctx = createOnDemandRelayContext({
      snapshotPath,
      commandRelayStateDir: relayStateDir,
      dryRun: false,
      relayPublisher: {
        publishRelayState: async () => ({ skipped: false }),
        publishRelayDocument: async (relay, options = {}) => {
          strategicPublishes += 1;
          assert.equal(options.statePath, DEFAULT_BASE_STATE_PATH);
          assert.equal(relay.request_id, requestId);
          return { skipped: false };
        },
      },
    });
    const { processed, outcome } = await processPendingRequest(ctx);
    assert.equal(processed, true);
    assert.equal(outcome.phase, SEND_PHASE.SENT);
    assert.equal(strategicPublishes, 1);
  });

  it('pending request without strategic marker is not_ready', async () => {
    const requestId = '4'.repeat(32);
    fs.writeFileSync(paths.baseIntelligenceSendPath, fs.readFileSync(BI_FIXTURE, 'utf8'), 'utf8');
    writeJsonAtomic(paths.requestPath, {
      request_id: requestId,
      action: 'send',
      status: 'pending',
      send_scope: 'strategic',
      created_at_ms: Date.now(),
    });
    const ctx = createOnDemandRelayContext({ snapshotPath, commandRelayStateDir: relayStateDir, dryRun: true });
    const outcome = await runSendOnce(ctx, { request_id: requestId, send_scope: 'strategic' });
    assert.equal(outcome.phase, SEND_PHASE.NOT_READY);
  });

  it('publishStrategicBaseState dry-run validates without network', async () => {
    const requestId = '2'.repeat(32);
    writeBiAndMarker(paths, requestId);
    const ctx = createOnDemandRelayContext({
      snapshotPath,
      commandRelayStateDir: relayStateDir,
      dryRun: true,
    });
    const direct = await publishStrategicBaseState(ctx, { request_id: requestId });
    assert.equal(direct.ok, true);
    assert.equal(direct.dryRun, true);
  });
});
