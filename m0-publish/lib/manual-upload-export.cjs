'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  cloneRelayPayload,
  prepareRelayPayloadForPublish,
  publishedByteLength,
  RELAY_PUBLISH_MAX_BYTES,
  RELAY_SHRINK_EXHAUSTED,
  serializeRelayPayloadPretty,
} = require('./relay-payload-adaptive-shrink.cjs');
const { writeTextAtomic } = require('./local-atomic.cjs');
const {
  isRelayShrinkExhausted,
  shouldOfferManualUploadForPublishError,
} = require('./relay-publish-error.cjs');

const MANUAL_ARTIFACT_SCHEMA_VERSION = 1;
const MANUAL_ARTIFACT_KIND = 'companion_manual_intelligence';

/** Self-contained manual uploads may exceed automatic GitHub transport (256 KiB). */
const MANUAL_ARTIFACT_MAX_BYTES = 4 * 1024 * 1024;

const DEFAULT_FILENAME_PREFIX = 'relay-manual';

class ManualUploadExportError extends Error {
  constructor(message, code, details = undefined) {
    super(message);
    this.name = 'ManualUploadExportError';
    this.code = code ?? 'MANUAL_UPLOAD_ERROR';
    if (details !== undefined) {
      this.details = details;
    }
  }
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ManualUploadExportError(`${label} must be a plain object`, 'INVALID_RELAY');
  }
}

function snapshotIdentityFromRelay(relay) {
  return {
    snapshot_id: relay.snapshot_id ?? null,
    session_id: relay.session_id ?? relay.tactical?.eventLog?.sessionId ?? null,
    turn: relay.turn ?? relay.tactical?.turn ?? relay.source?.turn ?? null,
    request_id: relay.request_id ?? null,
  };
}

function extractSourceSnapshotSha256(relay) {
  const binding = relay.commandBinding;
  if (binding && typeof binding.snapshot_sha256 === 'string') {
    return binding.snapshot_sha256;
  }
  return null;
}

/**
 * Build a portable, self-contained manual intelligence artifact (no local path refs).
 * commandBinding is removed; authority is explicitly non-authoritative.
 */
function buildManualIntelligenceArtifact(relay, options = {}) {
  assertPlainObject(relay, 'relay');
  const reasonCode = options.reasonCode ?? RELAY_SHRINK_EXHAUSTED;
  const createdAt = options.createdAt ?? new Date().toISOString();
  const shrinkContext = options.shrinkContext ?? null;
  const sourceSnapshotSha256 = options.sourceSnapshotSha256
    ?? extractSourceSnapshotSha256(relay);

  const full = cloneRelayPayload(relay);
  delete full.commandBinding;
  delete full.relay_export_shrink;
  delete full.terrainMapBriefOmitted;

  const identity = snapshotIdentityFromRelay(full);

  const artifact = {
    schema_version: MANUAL_ARTIFACT_SCHEMA_VERSION,
    kind: MANUAL_ARTIFACT_KIND,
    created_at: createdAt,
    read_only: true,
    command_authority: {
      schema_version: 1,
      authoritative: false,
      note: 'Manual upload is read-only battlefield intelligence. It does not authorize tactical commands.',
    },
    reason_code: reasonCode,
    snapshot_id: identity.snapshot_id,
    session_id: identity.session_id,
    turn: identity.turn,
    request_id: identity.request_id,
    source_snapshot_sha256: sourceSnapshotSha256,
    automatic_transport: {
      schema_version: 1,
      max_bytes: RELAY_PUBLISH_MAX_BYTES,
      outcome: reasonCode,
    },
    ...full,
  };

  if (shrinkContext) {
    artifact.automatic_transport = {
      ...artifact.automatic_transport,
      initial_published_bytes: shrinkContext.initialBytes ?? null,
      final_after_shrink_bytes: shrinkContext.finalBytes ?? null,
      shrink_steps_attempted: shrinkContext.steps ?? [],
    };
  }

  const serialized = serializeManualArtifact(artifact);
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > MANUAL_ARTIFACT_MAX_BYTES) {
    throw new ManualUploadExportError(
      `Manual artifact exceeds ${MANUAL_ARTIFACT_MAX_BYTES} byte cap (${bytes} bytes).`,
      'MANUAL_ARTIFACT_TOO_LARGE',
      { bytes, maxBytes: MANUAL_ARTIFACT_MAX_BYTES },
    );
  }

  return { artifact, serialized, bytes };
}

function serializeManualArtifact(artifact) {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

function formatManualArtifactFilename(relay, options = {}) {
  const identity = snapshotIdentityFromRelay(relay);
  const session8 = typeof identity.session_id === 'string'
    ? identity.session_id.slice(0, 8)
    : 'unknown';
  const turn = Number.isFinite(identity.turn) ? identity.turn : 'x';
  const exportedAtMs = options.exportedAtMs ?? Date.now();
  const snapshot12 = typeof identity.snapshot_id === 'string'
    ? identity.snapshot_id.slice(0, 12)
    : crypto.randomBytes(6).toString('hex');
  const prefix = options.filenamePrefix ?? DEFAULT_FILENAME_PREFIX;
  return `${prefix}_${session8}_t${turn}_${exportedAtMs}_${snapshot12}.json`;
}

function captureRelayShrinkExhaustion(relay, options = {}) {
  const maxBytes = options.maxBytes ?? RELAY_PUBLISH_MAX_BYTES;
  try {
    const prepared = prepareRelayPayloadForPublish(relay, { maxBytes });
    throw new ManualUploadExportError(
      'Relay payload fits automatic transport; manual artifact not required.',
      'NOT_SIZE_FAILURE',
      { publishedBytes: prepared.bytes, maxBytes },
    );
  } catch (error) {
    if (!isRelayShrinkExhausted(error)) {
      throw error;
    }
    return {
      initialBytes: error.initialBytes,
      finalBytes: error.finalBytes,
      steps: error.steps ?? [],
      maxBytes,
    };
  }
}

function writeManualIntelligenceArtifact(exportDir, relay, options = {}) {
  if (typeof exportDir !== 'string' || exportDir.length === 0) {
    throw new ManualUploadExportError('exportDir required', 'INVALID_EXPORT_DIR');
  }

  let shrinkContext = options.shrinkContext ?? null;
  if (options.requireShrinkExhausted !== false) {
    shrinkContext = captureRelayShrinkExhaustion(relay, options);
  }

  const built = buildManualIntelligenceArtifact(relay, {
    ...options,
    shrinkContext,
  });

  const filename = formatManualArtifactFilename(relay, options);
  const destPath = path.join(exportDir, filename);
  const writeFileSync = options.writeFileSync ?? fs.writeFileSync;
  const renameSync = options.renameSync ?? fs.renameSync;
  const mkdirSync = options.mkdirSync ?? fs.mkdirSync;

  mkdirSync(exportDir, { recursive: true });
  try {
    writeTextAtomic(destPath, built.serialized, writeFileSync, renameSync);
  } catch (error) {
    throw new ManualUploadExportError(
      `Manual artifact write failed: ${error.message || String(error)}`,
      'MANUAL_EXPORT_WRITE_FAILED',
      { destPath },
    );
  }

  const sha256 = crypto.createHash('sha256').update(built.serialized, 'utf8').digest('hex');
  return {
    path: destPath,
    filename,
    sha256,
    bytes: built.bytes,
    artifact: built.artifact,
    shrinkContext,
  };
}

/**
 * Try automatic prepare; on shrink exhaustion only, write a self-contained manual artifact.
 */
function tryWriteManualArtifactAfterShrinkExhausted(exportDir, relay, options = {}) {
  try {
    const shrinkContext = captureRelayShrinkExhaustion(relay, options);
    const result = writeManualIntelligenceArtifact(exportDir, relay, {
      ...options,
      requireShrinkExhausted: false,
      shrinkContext,
    });
    return { written: true, ...result };
  } catch (error) {
    if (error instanceof ManualUploadExportError && error.code === 'NOT_SIZE_FAILURE') {
      return { written: false, reason: 'not_size_failure' };
    }
    if (!shouldOfferManualUploadForPublishError(error)) {
      return { written: false, reason: 'not_size_failure', error };
    }
    throw error;
  }
}

module.exports = {
  MANUAL_ARTIFACT_SCHEMA_VERSION,
  MANUAL_ARTIFACT_KIND,
  MANUAL_ARTIFACT_MAX_BYTES,
  DEFAULT_FILENAME_PREFIX,
  ManualUploadExportError,
  buildManualIntelligenceArtifact,
  serializeManualArtifact,
  formatManualArtifactFilename,
  captureRelayShrinkExhaustion,
  writeManualIntelligenceArtifact,
  tryWriteManualArtifactAfterShrinkExhausted,
};
