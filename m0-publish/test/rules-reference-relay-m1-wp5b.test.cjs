'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  publishRulesReferenceOnce,
  loadLocalRulesReferenceFromFile,
  buildRulesReferenceRelayEnvelope,
  validateRulesReferenceRelayEnvelope,
  evaluateRemoteRulesReferenceFreshness,
  readPublishMarker,
  RulesReferenceRelayError,
} = require('../lib/rules-reference-relay-publish.cjs');
const { createGhApiCallLog } = require('../lib/github-api-instrumentation.cjs');
const { buildRelayOptionsFromConfig } = require('../lib/relay-isolation-config.cjs');
const {
  fingerprintProductionCommandRelayJournal,
  assertProductionCommandRelayJournalUnchanged,
} = require('../lib/relay-test-isolation.cjs');

const campaignId = 'a'.repeat(32);
const digest = 'b'.repeat(64);

function minimalReference(overrides = {}) {
  return {
    schema_version: 1,
    artifact: 'companion-rules-reference',
    exported_at_ms: 1700000000000,
    identity: {
      campaign_id: campaignId,
      save_name: 'Relay Test',
      game_date: { year: 1999, month: 1, day: 1, hour: 0, minute: 0 },
      research_revision_sha256: digest,
      ruleset_revision_sha256: digest,
      content_revision_sha256: digest,
    },
    ruleset: { mods: ['xcom2 ver: 1.0'] },
    limitations: {},
    items: [{
      type: 'STR_RIFLE',
      battleType: 'firearm',
      weaponCategory: 'rifle',
      clipSize: 20,
      flatRate: false,
      firingModes: {
        snap: { accuracy: 55, tuRule: 33, tuUnit: 'percent' },
      },
    }],
    ...overrides,
  };
}

function isolatedRelayConfig() {
  return {
    schema_version: 1,
    repo: 'ExampleOrg/OpenXcom-Relay-WP5B-Test',
    branch: 'main',
    state_path: 'm0-e2e/state.json',
    content_paths: {
      tacticalCommand: 'm0-e2e/tactical-command.json',
      tacticalResult: 'm0-e2e/tactical-result.json',
      terrainQuery: 'm0-e2e/terrain-query.json',
      terrainQueryResult: 'm0-e2e/terrain-query-result.json',
      rulesReference: 'm0-e2e/rules-reference.json',
    },
  };
}

function createInMemoryGhApi() {
  const files = new Map();
  const apiCallLog = createGhApiCallLog();

  function contentPathFromGetApi(apiPath) {
    const marker = '/contents/';
    const idx = apiPath.indexOf(marker);
    if (idx === -1) {
      return null;
    }
    return decodeURIComponent(apiPath.slice(idx + marker.length).split('?')[0]);
  }

  function contentPathFromPutApi(apiPath) {
    const marker = '/contents/';
    const idx = apiPath.indexOf(marker);
    if (idx === -1) {
      return null;
    }
    return decodeURIComponent(apiPath.slice(idx + marker.length));
  }

  const ghApi = (method, apiPath, body) => {
    apiCallLog.record(method, apiPath);
    if (method === 'GET') {
      const contentPath = contentPathFromGetApi(apiPath);
      const entry = files.get(contentPath);
      if (!entry) {
        const err = new Error('Not Found');
        err.stderr = '404 Not Found';
        throw err;
      }
      return {
        type: 'file',
        encoding: 'base64',
        sha: entry.sha,
        content: entry.contentB64,
      };
    }
    if (method === 'PUT') {
      const contentPath = contentPathFromPutApi(apiPath);
      const sha = cryptoRandomSha();
      files.set(contentPath, {
        sha,
        contentB64: body.content,
        text: Buffer.from(body.content, 'base64').toString('utf8'),
      });
      return { content: { sha } };
    }
    throw new Error(`Unsupported mock gh api ${method} ${apiPath}`);
  };

  return { ghApi, apiCallLog, files };
}

function cryptoRandomSha() {
  return 'c'.repeat(40);
}

describe('rules-reference-relay (M1-WP5B)', () => {
  let productionJournalBefore;

  before(() => {
    productionJournalBefore = fingerprintProductionCommandRelayJournal();
  });

  after(() => {
    const productionJournalAfter = fingerprintProductionCommandRelayJournal();
    assertProductionCommandRelayJournalUnchanged(productionJournalBefore, productionJournalAfter);
  });

  it('publishes valid local artifact to isolated remote path', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp5b-publish-'));
    const localPath = path.join(root, 'companion-rules-reference.json');
    fs.writeFileSync(localPath, `${JSON.stringify(minimalReference(), null, 2)}\n`, 'utf8');
    const { ghApi, apiCallLog, files } = createInMemoryGhApi();
    const relayOptions = {
      ...buildRelayOptionsFromConfig(isolatedRelayConfig()),
      ghApi,
      requireGhAuth: false,
    };

    const outcome = await publishRulesReferenceOnce({
      localPath,
      publish: true,
      dryRun: false,
      relayOptions,
      apiCallLog,
      requireGhAuth: false,
    });

    assert.equal(outcome.ok, true);
    assert.equal(outcome.remotePath, 'm0-e2e/rules-reference.json');
    assert.equal(apiCallLog.countApiCalls(), 2);
    assert.ok(files.has('m0-e2e/rules-reference.json'));
    const remote = JSON.parse(files.get('m0-e2e/rules-reference.json').text);
    validateRulesReferenceRelayEnvelope(remote);
    const marker = readPublishMarker(path.join(root, 'companion-rules-reference-publish-marker.json'));
    assert.equal(marker.last_attempt_status, 'complete');
    assert.equal(marker.remote_content_revision_sha256, digest);
  });

  it('rejects invalid schema before any GitHub mutation', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp5b-invalid-'));
    const localPath = path.join(root, 'bad.json');
    fs.writeFileSync(localPath, JSON.stringify({ schema_version: 9 }), 'utf8');
    const { ghApi, apiCallLog } = createInMemoryGhApi();
    await assert.rejects(
      () => publishRulesReferenceOnce({
        localPath,
        publish: true,
        dryRun: false,
        relayOptions: { ...buildRelayOptionsFromConfig(isolatedRelayConfig()), ghApi },
        apiCallLog,
        requireGhAuth: false,
      }),
      (err) => err instanceof RulesReferenceRelayError || err.name === 'RulesReferenceValidationError',
    );
    assert.equal(apiCallLog.countApiCalls(), 0);
  });

  it('rejects missing local artifact', async () => {
    const { ghApi, apiCallLog } = createInMemoryGhApi();
    await assert.rejects(
      () => publishRulesReferenceOnce({
        localPath: path.join(os.tmpdir(), 'missing-rules-ref.json'),
        publish: true,
        relayOptions: { ...buildRelayOptionsFromConfig(isolatedRelayConfig()), ghApi },
        apiCallLog,
        requireGhAuth: false,
      }),
      (err) => err.code === 'missing_local_artifact',
    );
    assert.equal(apiCallLog.countApiCalls(), 0);
  });

  it('rejects campaign mismatch against --expect-campaign-id guard', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp5b-campaign-'));
    const localPath = path.join(root, 'companion-rules-reference.json');
    fs.writeFileSync(localPath, `${JSON.stringify(minimalReference(), null, 2)}\n`, 'utf8');
    const { ghApi, apiCallLog } = createInMemoryGhApi();
    await assert.rejects(
      () => publishRulesReferenceOnce({
        localPath,
        expectCampaignId: 'c'.repeat(32),
        publish: true,
        relayOptions: { ...buildRelayOptionsFromConfig(isolatedRelayConfig()), ghApi },
        apiCallLog,
        requireGhAuth: false,
      }),
      (err) => err.code === 'campaign_mismatch',
    );
    assert.equal(apiCallLog.countApiCalls(), 0);
  });

  it('detects stale remote reference when research/ruleset revisions diverge', () => {
    const envelope = buildRulesReferenceRelayEnvelope(minimalReference(), Date.now());
    const fresh = evaluateRemoteRulesReferenceFreshness(envelope, {
      campaign_id: campaignId,
      content_revision_sha256: digest,
      research_revision_sha256: digest,
      ruleset_revision_sha256: digest,
    });
    assert.equal(fresh.fresh, true);
    const staleResearch = evaluateRemoteRulesReferenceFreshness(envelope, {
      campaign_id: campaignId,
      content_revision_sha256: digest,
      research_revision_sha256: 'd'.repeat(64),
    });
    assert.equal(staleResearch.fresh, false);
    assert.equal(staleResearch.reason, 'research_revision_mismatch');
  });

  it('records failed publish without advancing remote success marker', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp5b-fail-'));
    const localPath = path.join(root, 'companion-rules-reference.json');
    fs.writeFileSync(localPath, `${JSON.stringify(minimalReference(), null, 2)}\n`, 'utf8');
    const apiCallLog = createGhApiCallLog();
    const priorSuccessMs = 1000;
    const markerPath = path.join(root, 'companion-rules-reference-publish-marker.json');
    fs.writeFileSync(markerPath, `${JSON.stringify({
      schema_version: 1,
      last_success_at_ms: priorSuccessMs,
      remote_content_revision_sha256: 'e'.repeat(64),
      last_attempt_status: 'complete',
    }, null, 2)}\n`, 'utf8');

    const ghApi = (method, apiPath) => {
      apiCallLog.record(method, apiPath);
      if (method === 'GET') {
        return null;
      }
      if (method === 'PUT') {
        const err = new Error('network down');
        err.code = 'NETWORK_FAILED';
        throw err;
      }
      throw new Error('unexpected');
    };

    await assert.rejects(
      () => publishRulesReferenceOnce({
        localPath,
        publish: true,
        relayOptions: { ...buildRelayOptionsFromConfig(isolatedRelayConfig()), ghApi },
        apiCallLog,
        requireGhAuth: false,
      }),
    );

    const marker = readPublishMarker(markerPath);
    assert.equal(marker.last_attempt_status, 'failed');
    assert.equal(marker.last_success_at_ms, priorSuccessMs);
    assert.equal(marker.remote_content_revision_sha256, 'e'.repeat(64));
  });

  it('does not mutate isolated tactical relay paths during rules publish', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp5b-tactical-'));
    const localPath = path.join(root, 'companion-rules-reference.json');
    fs.writeFileSync(localPath, `${JSON.stringify(minimalReference(), null, 2)}\n`, 'utf8');
    const { ghApi, apiCallLog, files } = createInMemoryGhApi();
    await publishRulesReferenceOnce({
      localPath,
      publish: true,
      relayOptions: { ...buildRelayOptionsFromConfig(isolatedRelayConfig()), ghApi },
      apiCallLog,
      requireGhAuth: false,
    });
    assert.ok(files.has('m0-e2e/rules-reference.json'));
    assert.equal(files.has('m0-e2e/tactical-command.json'), false);
    assert.equal(files.has('m0/state.json'), false);
    for (const entry of apiCallLog.entries) {
      assert.ok(entry.endpoint.includes('rules-reference'), 'GitHub calls must target rules reference only');
    }
  });

  it('dry-run performs zero GitHub API calls', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp5b-dry-'));
    const localPath = path.join(root, 'companion-rules-reference.json');
    fs.writeFileSync(localPath, `${JSON.stringify(minimalReference(), null, 2)}\n`, 'utf8');
    const { ghApi, apiCallLog } = createInMemoryGhApi();
    const outcome = await publishRulesReferenceOnce({
      localPath,
      dryRun: true,
      relayOptions: { ...buildRelayOptionsFromConfig(isolatedRelayConfig()), ghApi },
      apiCallLog,
    });
    assert.equal(outcome.dryRun, true);
    assert.equal(outcome.githubApiCalls, 0);
    assert.equal(apiCallLog.countApiCalls(), 0);
  });

  it('loadLocalRulesReferenceFromFile validates research-gated document shape', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp5b-load-'));
    const localPath = path.join(root, 'companion-rules-reference.json');
    fs.writeFileSync(localPath, `${JSON.stringify(minimalReference(), null, 2)}\n`, 'utf8');
    const loaded = loadLocalRulesReferenceFromFile(localPath);
    assert.equal(loaded.summary.campaignId, campaignId);
  });
});
