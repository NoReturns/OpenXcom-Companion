'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  DEFAULTS,
  DEFAULT_RULES_REFERENCE_MAX_BYTES,
  RELAY_CONTENT_PATHS,
  createRelayContentClient,
  checkGhAuthReadiness,
} = require('./github-relay.cjs');
const {
  validateRulesReferenceDocument,
  RulesReferenceValidationError,
} = require('./rules-reference-export.cjs');
const { buildRelayOptionsFromConfig } = require('./relay-isolation-config.cjs');

const PUBLISH_MARKER_FILENAME = 'companion-rules-reference-publish-marker.json';
const RELAY_ENVELOPE_SCHEMA_VERSION = 1;
const MARKER_SCHEMA_VERSION = 1;

class RulesReferenceRelayError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RulesReferenceRelayError';
    this.code = code;
  }
}

function assertTestPublishSurface(relayOptions) {
  if (process.env.NODE_TEST_CONTEXT && relayOptions.isolationEnforced !== true) {
    throw new RulesReferenceRelayError(
      'test_surface_forbidden',
      'Node tests must publish rules reference through relay isolation config (isolationEnforced).',
    );
  }
}

function loadLocalRulesReferenceFromFile(localPath) {
  const resolved = path.resolve(String(localPath));
  if (!fs.existsSync(resolved)) {
    throw new RulesReferenceRelayError('missing_local_artifact', `Local rules reference not found: ${resolved}`);
  }
  const bytes = fs.readFileSync(resolved);
  if (bytes.length > DEFAULT_RULES_REFERENCE_MAX_BYTES) {
    throw new RulesReferenceRelayError('size_cap_exceeded', 'Local rules reference exceeds 256 KiB limit.');
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new RulesReferenceRelayError('invalid_json', 'Local rules reference is not valid JSON.');
  }
  const summary = validateRulesReferenceDocument(parsed);
  return { resolved, bytes, document: parsed, summary };
}

function assertCampaignExpectation(summary, expectCampaignId) {
  if (!expectCampaignId) {
    return;
  }
  const expected = String(expectCampaignId).trim();
  if (summary.campaignId !== expected) {
    throw new RulesReferenceRelayError(
      'campaign_mismatch',
      `Local rules reference campaign_id ${summary.campaignId} does not match expected ${expected}.`,
    );
  }
}

function buildRulesReferenceRelayEnvelope(referenceDoc, publishedAtMs) {
  const summary = validateRulesReferenceDocument(referenceDoc);
  return {
    relay_envelope: {
      schema_version: RELAY_ENVELOPE_SCHEMA_VERSION,
      artifact: 'companion-rules-reference-relay',
      publish_status: 'complete',
      published_at_ms: publishedAtMs,
      campaign_id: summary.campaignId,
      content_revision_sha256: summary.contentRevisionSha256,
      research_revision_sha256: referenceDoc.identity.research_revision_sha256,
      ruleset_revision_sha256: referenceDoc.identity.ruleset_revision_sha256,
    },
    reference: referenceDoc,
  };
}

function validateRulesReferenceRelayEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new RulesReferenceRelayError('invalid_relay_envelope', 'Relay envelope must be an object.');
  }
  const relay = envelope.relay_envelope;
  if (!relay || typeof relay !== 'object') {
    throw new RulesReferenceRelayError('invalid_relay_envelope', 'relay_envelope block required.');
  }
  if (relay.schema_version !== RELAY_ENVELOPE_SCHEMA_VERSION) {
    throw new RulesReferenceRelayError('invalid_relay_envelope', 'relay_envelope.schema_version must be 1.');
  }
  if (relay.artifact !== 'companion-rules-reference-relay') {
    throw new RulesReferenceRelayError('invalid_relay_envelope', 'relay_envelope.artifact mismatch.');
  }
  if (relay.publish_status !== 'complete') {
    throw new RulesReferenceRelayError('incomplete_publish', 'Remote rules reference publish is not complete.');
  }
  const summary = validateRulesReferenceDocument(envelope.reference);
  if (relay.campaign_id !== summary.campaignId) {
    throw new RulesReferenceRelayError('envelope_campaign_mismatch', 'Envelope campaign_id does not match reference.');
  }
  if (relay.content_revision_sha256 !== summary.contentRevisionSha256) {
    throw new RulesReferenceRelayError(
      'envelope_revision_mismatch',
      'Envelope content_revision_sha256 does not match reference identity.',
    );
  }
  if (relay.research_revision_sha256 !== envelope.reference.identity.research_revision_sha256) {
    throw new RulesReferenceRelayError('envelope_research_mismatch', 'Envelope research revision mismatch.');
  }
  if (relay.ruleset_revision_sha256 !== envelope.reference.identity.ruleset_revision_sha256) {
    throw new RulesReferenceRelayError('envelope_ruleset_mismatch', 'Envelope ruleset revision mismatch.');
  }
  return { relay, summary };
}

function evaluateRemoteRulesReferenceFreshness(envelopeOrText, binding = {}) {
  try {
    const envelope = typeof envelopeOrText === 'string'
      ? JSON.parse(envelopeOrText)
      : envelopeOrText;
    const { relay, summary } = validateRulesReferenceRelayEnvelope(envelope);
    if (binding.campaign_id && summary.campaignId !== binding.campaign_id) {
      return { fresh: false, reason: 'campaign_mismatch', summary, relay };
    }
    if (binding.content_revision_sha256
      && summary.contentRevisionSha256 !== binding.content_revision_sha256) {
      return { fresh: false, reason: 'content_revision_mismatch', summary, relay };
    }
    if (binding.research_revision_sha256
      && relay.research_revision_sha256 !== binding.research_revision_sha256) {
      return { fresh: false, reason: 'research_revision_mismatch', summary, relay };
    }
    if (binding.ruleset_revision_sha256
      && relay.ruleset_revision_sha256 !== binding.ruleset_revision_sha256) {
      return { fresh: false, reason: 'ruleset_revision_mismatch', summary, relay };
    }
    return { fresh: true, reason: null, summary, relay };
  } catch (err) {
    const code = err instanceof RulesReferenceRelayError
      ? err.code
      : (err instanceof RulesReferenceValidationError ? err.code : 'invalid_remote_reference');
    return { fresh: false, reason: code, summary: null, relay: null };
  }
}

function markerPathBesideLocalArtifact(localResolvedPath) {
  const dir = path.dirname(localResolvedPath);
  return path.join(dir, PUBLISH_MARKER_FILENAME);
}

function readPublishMarker(markerPath) {
  if (!fs.existsSync(markerPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch {
    return null;
  }
}

function writePublishMarkerAtomic(markerPath, marker) {
  const tmp = `${markerPath}.companion.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, markerPath);
}

function buildMarkerBase(remotePath, summary, attemptAtMs) {
  return {
    schema_version: MARKER_SCHEMA_VERSION,
    remote_path: remotePath,
    local_content_revision_sha256: summary.contentRevisionSha256,
    local_campaign_id: summary.campaignId,
    last_attempt_at_ms: attemptAtMs,
    last_attempt_status: 'pending',
  };
}

function resolveRelayOptions(options = {}) {
  if (options.relayOptions) {
    return options.relayOptions;
  }
  if (options.relayIsolationConfig) {
    return buildRelayOptionsFromConfig(options.relayIsolationConfig);
  }
  return {
    repo: options.repo ?? DEFAULTS.repo,
    branch: options.branch ?? DEFAULTS.branch,
    contentPaths: options.contentPaths ?? { ...RELAY_CONTENT_PATHS },
    isolationEnforced: options.isolationEnforced === true,
    maxRemoteBytes: options.maxRemoteBytes ?? DEFAULT_RULES_REFERENCE_MAX_BYTES,
    ghApi: options.ghApi,
    apiCallLog: options.apiCallLog,
    rateLimitGate: options.rateLimitGate,
    quotaTelemetryStore: options.quotaTelemetryStore,
    execFileSync: options.execFileSync,
    relayIsolationContract: options.relayIsolationContract ?? null,
  };
}

function resolveRulesReferenceRemotePath(relayOptions) {
  const paths = relayOptions.contentPaths ?? RELAY_CONTENT_PATHS;
  return paths.rulesReference ?? RELAY_CONTENT_PATHS.rulesReference;
}

async function publishRulesReferenceOnce(options = {}) {
  const dryRun = options.dryRun !== false && options.publish !== true;
  const attemptAtMs = options.nowMs ?? Date.now();
  const relayOptions = resolveRelayOptions(options);
  assertTestPublishSurface(relayOptions);

  const localPath = options.localPath;
  if (!localPath) {
    throw new RulesReferenceRelayError('missing_local_path', 'localPath is required.');
  }

  const { resolved, document, summary } = loadLocalRulesReferenceFromFile(localPath);
  assertCampaignExpectation(summary, options.expectCampaignId);

  const envelope = buildRulesReferenceRelayEnvelope(document, attemptAtMs);
  validateRulesReferenceRelayEnvelope(envelope);

  const remotePath = resolveRulesReferenceRemotePath(relayOptions);
  const markerPath = markerPathBesideLocalArtifact(resolved);
  const priorMarker = readPublishMarker(markerPath);

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      remotePath,
      summary,
      envelope,
      githubApiCalls: 0,
    };
  }

  if (options.requireGhAuth !== false && !relayOptions.ghApi && !checkGhAuthReadiness()) {
    throw new RulesReferenceRelayError('auth_unavailable', 'GitHub CLI authentication is not ready.');
  }

  const client = createRelayContentClient({
    ...relayOptions,
    apiCallLog: options.apiCallLog,
    maxRemoteBytes: DEFAULT_RULES_REFERENCE_MAX_BYTES,
  });

  const pendingMarker = {
    ...buildMarkerBase(remotePath, summary, attemptAtMs),
    last_attempt_status: 'pending',
    last_success_at_ms: priorMarker && priorMarker.last_success_at_ms ? priorMarker.last_success_at_ms : null,
    remote_content_revision_sha256: priorMarker && priorMarker.remote_content_revision_sha256
      ? priorMarker.remote_content_revision_sha256
      : null,
  };
  writePublishMarkerAtomic(markerPath, pendingMarker);

  const commitMessage = `Companion rules reference ${summary.contentRevisionSha256.slice(0, 12)} `
    + `campaign ${summary.campaignId.slice(0, 8)}`;

  try {
    client.publishFile(
      remotePath,
      envelope,
      commitMessage,
      DEFAULT_RULES_REFERENCE_MAX_BYTES,
    );
  } catch (error) {
    const failedMarker = {
      ...pendingMarker,
      last_attempt_status: 'failed',
      last_error_code: error.code || 'publish_failed',
      last_error_message: String(error.message || error).slice(0, 240),
      remote_content_revision_sha256: priorMarker && priorMarker.remote_content_revision_sha256
        ? priorMarker.remote_content_revision_sha256
        : null,
    };
    writePublishMarkerAtomic(markerPath, failedMarker);
    throw error;
  }

  const successMarker = {
    ...pendingMarker,
    last_attempt_status: 'complete',
    last_success_at_ms: attemptAtMs,
    remote_content_revision_sha256: summary.contentRevisionSha256,
    remote_published_at_ms: attemptAtMs,
    publish_id: crypto.createHash('sha256').update(`${summary.contentRevisionSha256}:${attemptAtMs}`).digest('hex').slice(0, 16),
  };
  writePublishMarkerAtomic(markerPath, successMarker);

  const apiCalls = options.apiCallLog && typeof options.apiCallLog.countApiCalls === 'function'
    ? options.apiCallLog.countApiCalls()
    : null;

  return {
    ok: true,
    dryRun: false,
    remotePath,
    summary,
    envelope,
    markerPath,
    githubApiCalls: apiCalls,
  };
}

module.exports = {
  PUBLISH_MARKER_FILENAME,
  RELAY_CONTENT_PATHS,
  RulesReferenceRelayError,
  loadLocalRulesReferenceFromFile,
  buildRulesReferenceRelayEnvelope,
  validateRulesReferenceRelayEnvelope,
  evaluateRemoteRulesReferenceFreshness,
  publishRulesReferenceOnce,
  resolveRulesReferenceRemotePath,
  readPublishMarker,
};
