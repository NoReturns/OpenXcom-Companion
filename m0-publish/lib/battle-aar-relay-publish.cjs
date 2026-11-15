'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { writeJsonAtomic } = require('./local-atomic.cjs');
const { sha256HexLower } = require('./briefing-snapshot.cjs');
const {
  checkGhAuthReadiness,
  createRelayPublisher,
  createRelayContentClient,
} = require('./github-relay.cjs');
const {
  DEFAULT_BATTLE_AAR_PATH,
  DEFAULT_BATTLE_AAR_ARCHIVE_PREFIX,
  DEFAULT_BATTLE_AAR_MAX_BYTES,
} = require('./relay-config.cjs');
const {
  projectBattleAarForRelay,
  validateCompactBattleAar,
} = require('./battle-aar-compact-project.cjs');

const BATTLE_AAR_LOCAL_FILENAME = 'companion-battle-aar.json';
const QUEUE_FILENAME = 'companion-battle-aar-pending-queue.json';
const JOURNAL_FILENAME = 'companion-battle-aar-journal.json';
const INGEST_STATE_FILENAME = 'companion-battle-aar-ingest-state.json';
const PENDING_DIRNAME = 'aar-pending';
const PRODUCED_DIRNAME = 'aar-produced';
const QUEUE_SCHEMA_VERSION = 1;
const JOURNAL_SCHEMA_VERSION = 1;
const AAR_SCHEMA_VERSION = 1;
const CAMPAIGN_ID_RE = /^[a-f0-9]{32}$/;

class BattleAarValidationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BattleAarValidationError';
    this.code = code;
    this.details = details;
  }
}

function resolveBattleAarPaths(snapshotDir) {
  const base = path.resolve(snapshotDir);
  return {
    localAarPath: path.join(base, BATTLE_AAR_LOCAL_FILENAME),
    queuePath: path.join(base, QUEUE_FILENAME),
    journalPath: path.join(base, JOURNAL_FILENAME),
    ingestStatePath: path.join(base, INGEST_STATE_FILENAME),
    pendingDir: path.join(base, PENDING_DIRNAME),
    producedDir: path.join(base, PRODUCED_DIRNAME),
  };
}

function sanitizePathSegment(value) {
  const trimmed = String(value || '').trim();
  const safe = trimmed.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
  return safe || 'unknown';
}

function producedArtifactRel(reportId) {
  return `${PRODUCED_DIRNAME}/${reportId}.json`;
}

function sortQueueByFinalizedMs(queue) {
  queue.entries.sort((a, b) => {
    const aMs = typeof a.finalized_at_ms === 'number' ? a.finalized_at_ms : 0;
    const bMs = typeof b.finalized_at_ms === 'number' ? b.finalized_at_ms : 0;
    if (aMs !== bMs) {
      return aMs - bMs;
    }
    return String(a.enqueued_at_ms ?? 0).localeCompare(String(b.enqueued_at_ms ?? 0));
  });
}

function readJsonFile(filePath, io = {}) {
  const existsSync = io.existsSync ?? fs.existsSync;
  const readFileSync = io.readFileSync ?? fs.readFileSync;
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return { parseError: true };
  }
}

function loadQueue(queuePath, io = {}) {
  const raw = readJsonFile(queuePath, io);
  if (!raw || raw.parseError) {
    return { schema_version: QUEUE_SCHEMA_VERSION, entries: [] };
  }
  if (!Array.isArray(raw.entries)) {
    return { schema_version: QUEUE_SCHEMA_VERSION, entries: [] };
  }
  return raw;
}

function saveQueue(queuePath, queue, io = {}) {
  writeJsonAtomic(
    queuePath,
    { schema_version: QUEUE_SCHEMA_VERSION, entries: queue.entries },
    io.writeFileSync ?? fs.writeFileSync,
    io.renameSync ?? fs.renameSync,
  );
}

function loadJournal(journalPath, io = {}) {
  const raw = readJsonFile(journalPath, io);
  if (!raw || raw.parseError) {
    return { schema_version: JOURNAL_SCHEMA_VERSION, published: {}, rejected: {} };
  }
  return {
    schema_version: JOURNAL_SCHEMA_VERSION,
    published: raw.published && typeof raw.published === 'object' ? raw.published : {},
    rejected: raw.rejected && typeof raw.rejected === 'object' ? raw.rejected : {},
  };
}

function saveJournal(journalPath, journal, io = {}) {
  writeJsonAtomic(
    journalPath,
    {
      schema_version: JOURNAL_SCHEMA_VERSION,
      published: journal.published,
      rejected: journal.rejected,
    },
    io.writeFileSync ?? fs.writeFileSync,
    io.renameSync ?? fs.renameSync,
  );
}

function scoreBreakdownLines(outcome) {
  if (!outcome || !Array.isArray(outcome.score_breakdown)) {
    return [];
  }
  return outcome.score_breakdown;
}

function lineQty(breakdown, lineId) {
  const row = breakdown.find((r) => r && r.line_id === lineId);
  return row && typeof row.quantity === 'number' ? row.quantity : null;
}

function assessBattleAarCoverage(doc) {
  const missing = [];
  const notes = [];

  if (!doc.outcome || typeof doc.outcome.score !== 'number') {
    missing.push('outcome.score');
  }
  if (!doc.outcome || typeof doc.outcome.rating !== 'string' || !doc.outcome.rating) {
    missing.push('outcome.rating');
  }
  const breakdown = scoreBreakdownLines(doc.outcome);
  if (breakdown.length === 0) {
    missing.push('outcome.score_breakdown');
  }

  const postDebrief = doc.post_debrief;
  if (!postDebrief || typeof postDebrief !== 'object') {
    missing.push('post_debrief');
  } else {
    if (!Array.isArray(postDebrief.lost_in_service)) {
      missing.push('post_debrief.lost_in_service');
    } else {
      for (const row of postDebrief.lost_in_service) {
        if (row && (row.kia === true || row.mia === true)) {
          if (!row.display_name) {
            missing.push('post_debrief.lost_in_service[].display_name');
          }
          if (typeof row.career_kills !== 'number') {
            missing.push('post_debrief.lost_in_service[].career_kills');
          }
        }
      }
    }
    if (!Array.isArray(postDebrief.wounded)) {
      missing.push('post_debrief.wounded');
    }
    if (!Array.isArray(postDebrief.soldiers)) {
      missing.push('post_debrief.soldiers');
    }
  }

  if (!doc.post_debrief || !Array.isArray(doc.post_debrief.promotions_applied)) {
    missing.push('post_debrief.promotions_applied');
  }
  if (!doc.post_debrief || typeof doc.post_debrief.injury_list !== 'object') {
    missing.push('post_debrief.injury_list');
  }
  if (!doc.post_debrief || !Array.isArray(doc.post_debrief.commendations_awarded_this_debrief)) {
    missing.push('post_debrief.commendations_awarded_this_debrief');
  }

  const aliensKilled = lineQty(breakdown, 'STR_ALIENS_KILLED');
  const aliensRecovered = lineQty(breakdown, 'STR_LIVE_ALIENS_RECOVERED');
  if (aliensKilled === null && aliensRecovered === null) {
    notes.push('alien_kills_captures: no STR_ALIENS_KILLED or STR_LIVE_ALIENS_RECOVERED rows (may be zero-mission)');
  }

  const civSaved = lineQty(breakdown, 'STR_CIVILIANS_SAVED');
  const civKilledXcom = lineQty(breakdown, 'STR_CIVILIANS_KILLED_BY_XCOM_OPERATIVES');
  const civKilledAlien = lineQty(breakdown, 'STR_CIVILIANS_KILLED_BY_ALIENS');
  if (civSaved === null && civKilledXcom === null && civKilledAlien === null) {
    notes.push('civilian_results: no civilian debrief rows present');
  }

  const recoveryRows = breakdown.filter((r) => r && r.recovery === true);
  if (recoveryRows.length === 0) {
    notes.push('equipment_recovery: no recovery score_breakdown rows (may be none recovered)');
  }

  return { missing, notes };
}

function validateBattleAarDocument(doc) {
  const errors = [];
  if (!doc || typeof doc !== 'object') {
    throw new BattleAarValidationError('invalid_json', 'Battle AAR must be a JSON object.');
  }
  if (doc.schema_version !== AAR_SCHEMA_VERSION) {
    errors.push(`schema_version must be ${AAR_SCHEMA_VERSION}`);
  }
  if (doc.type !== 'battle_aar') {
    errors.push('type must be battle_aar');
  }
  if (doc.status !== 'finalized') {
    throw new BattleAarValidationError('not_finalized', 'Battle AAR status must be finalized.', { status: doc.status });
  }
  if (typeof doc.report_id !== 'string' || doc.report_id.length < 32) {
    errors.push('report_id missing or invalid');
  }
  const identity = doc.identity;
  if (!identity || typeof identity !== 'object') {
    errors.push('identity object required');
  } else {
    if (!CAMPAIGN_ID_RE.test(String(identity.campaign_id || ''))) {
      errors.push('identity.campaign_id must be 32-char lowercase hex');
    }
    if (!identity.tactical_battle_id || typeof identity.tactical_battle_id !== 'string') {
      errors.push('identity.tactical_battle_id required');
    }
    if (typeof identity.mission_statistics_id !== 'number' || identity.mission_statistics_id < 0) {
      errors.push('identity.mission_statistics_id must be a non-negative number');
    }
  }
  if (errors.length > 0) {
    throw new BattleAarValidationError('schema_invalid', errors.join('; '));
  }

  const coverage = assessBattleAarCoverage(doc);
  if (coverage.missing.length > 0) {
    throw new BattleAarValidationError('incomplete_report', 'Battle AAR missing required coverage fields.', {
      missing_fields: coverage.missing,
      notes: coverage.notes,
    });
  }

  return {
    ok: true,
    reportId: doc.report_id,
    generationId: String(doc.generation_id ?? doc.finalized_at_ms ?? ''),
    campaignId: identity.campaign_id,
    tacticalBattleId: identity.tactical_battle_id,
    missionStatisticsId: identity.mission_statistics_id,
    coverage,
  };
}

function resolveExpectedCampaignId(paths, io = {}) {
  const existsSync = io.existsSync ?? fs.existsSync;
  const readFileSync = io.readFileSync ?? fs.readFileSync;
  const biPath = paths?.baseIntelligencePath;
  if (!biPath || !existsSync(biPath)) {
    return null;
  }
  try {
    const bi = JSON.parse(readFileSync(biPath, 'utf8'));
    const fromIdentity = bi?.identity?.campaign_id;
    if (fromIdentity && CAMPAIGN_ID_RE.test(fromIdentity)) {
      return fromIdentity;
    }
  } catch {
    return null;
  }
  return null;
}

function assertCampaignBinding(validation, expectedCampaignId) {
  if (!expectedCampaignId) {
    return;
  }
  if (validation.campaignId !== expectedCampaignId) {
    throw new BattleAarValidationError('campaign_mismatch', 'Battle AAR campaign_id does not match bound campaign.', {
      expected: expectedCampaignId,
      actual: validation.campaignId,
    });
  }
}

function buildBattleAarRelayEnvelope(doc, { publishedAt, contentSha256 }) {
  return {
    ...doc,
    kind: 'battle_aar_relay',
    relay_published_at: publishedAt,
    relay_content_sha256: contentSha256,
    snapshot_id: doc.report_id,
    request_id: String(doc.generation_id ?? doc.finalized_at_ms ?? contentSha256.slice(0, 16)),
    published_at: publishedAt,
  };
}

function archiveRelPath(campaignId, tacticalBattleId, missionStatisticsId) {
  const safeCampaign = CAMPAIGN_ID_RE.test(campaignId) ? campaignId : sha256HexLower(Buffer.from(String(campaignId), 'utf8'));
  const safeBattle = sanitizePathSegment(tacticalBattleId);
  return `${DEFAULT_BATTLE_AAR_ARCHIVE_PREFIX}/${safeCampaign}/${safeBattle}/${missionStatisticsId}.json`;
}

function queueHasReport(queue, reportId) {
  return queue.entries.some((e) => e && e.report_id === reportId);
}

function ensureProducedArtifact(ctx, validation, buffer, io = {}) {
  const existsSync = io.existsSync ?? fs.existsSync;
  const mkdirSync = io.mkdirSync ?? fs.mkdirSync;
  const paths = resolveBattleAarPaths(ctx.paths.snapshotDir);
  if (!existsSync(paths.producedDir)) {
    mkdirSync(paths.producedDir, { recursive: true });
  }
  const artifactRel = producedArtifactRel(validation.reportId);
  const artifactPath = path.join(ctx.paths.snapshotDir, artifactRel);
  if (!existsSync(artifactPath)) {
    writeJsonAtomic(
      artifactPath,
      JSON.parse(buffer.toString('utf8')),
      io.writeFileSync ?? fs.writeFileSync,
      io.renameSync ?? fs.renameSync,
    );
  }
  return artifactRel.replace(/\\/g, '/');
}

function enqueueValidatedReport(ctx, validation, digest, doc, artifactRel, io = {}) {
  const paths = resolveBattleAarPaths(ctx.paths.snapshotDir);
  const queue = loadQueue(paths.queuePath, io);
  if (queueHasReport(queue, validation.reportId)) {
    return { ingested: false, reason: 'already_queued', report_id: validation.reportId };
  }
  queue.entries.push({
    report_id: validation.reportId,
    generation_id: validation.generationId,
    content_sha256: digest,
    campaign_id: validation.campaignId,
    tactical_battle_id: validation.tacticalBattleId,
    mission_statistics_id: validation.missionStatisticsId,
    artifact_path: artifactRel,
    finalized_at_ms: typeof doc.finalized_at_ms === 'number' ? doc.finalized_at_ms : null,
    enqueued_at_ms: ctx.now(),
    attempts: 0,
    last_error: null,
  });
  sortQueueByFinalizedMs(queue);
  saveQueue(paths.queuePath, queue, io);
  return { ingested: true, report_id: validation.reportId, content_sha256: digest };
}

function discoverProducedAarArtifacts(ctx, io = {}) {
  const paths = resolveBattleAarPaths(ctx.paths.snapshotDir);
  const existsSync = io.existsSync ?? fs.existsSync;
  const readdirSync = io.readdirSync ?? fs.readdirSync;
  const readFileSync = io.readFileSync ?? fs.readFileSync;
  if (!existsSync(paths.producedDir)) {
    return { discovered: 0, enqueued: 0, skipped: 0 };
  }

  const journal = loadJournal(paths.journalPath, io);
  let enqueued = 0;
  let skipped = 0;
  const files = readdirSync(paths.producedDir).filter((name) => name.endsWith('.json'));
  for (const fileName of files) {
    const queue = loadQueue(paths.queuePath, io);
    const filePath = path.join(paths.producedDir, fileName);
    let buffer;
    try {
      buffer = readFileSync(filePath);
    } catch {
      skipped += 1;
      continue;
    }
    const digest = sha256HexLower(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer, 'utf8'));
    let doc;
    try {
      doc = JSON.parse(buffer.toString('utf8'));
    } catch {
      skipped += 1;
      continue;
    }
    if (doc.status !== 'finalized' || typeof doc.report_id !== 'string') {
      skipped += 1;
      continue;
    }
    if (journal.published[doc.report_id] || queueHasReport(queue, doc.report_id)) {
      skipped += 1;
      continue;
    }
    let validation;
    try {
      validation = validateBattleAarDocument(doc);
      const expectedCampaign = resolveExpectedCampaignId(ctx.paths, io);
      assertCampaignBinding(validation, expectedCampaign);
    } catch {
      skipped += 1;
      continue;
    }
    const artifactRel = producedArtifactRel(validation.reportId).replace(/\\/g, '/');
    const result = enqueueValidatedReport(ctx, validation, digest, doc, artifactRel, io);
    if (result.ingested) {
      enqueued += 1;
    } else {
      skipped += 1;
    }
  }
  return { discovered: files.length, enqueued, skipped };
}

function ingestLocalBattleAar(ctx, io = {}) {
  const paths = resolveBattleAarPaths(ctx.paths.snapshotDir);
  const existsSync = io.existsSync ?? fs.existsSync;
  const readFileSync = io.readFileSync ?? fs.readFileSync;
  if (!existsSync(paths.localAarPath)) {
    return { ingested: false, reason: 'no_local_file' };
  }

  let bytes;
  try {
    bytes = readFileSync(paths.localAarPath);
  } catch {
    return { ingested: false, reason: 'read_failed' };
  }
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8');
  const digest = sha256HexLower(buffer);

  const ingestState = readJsonFile(paths.ingestStatePath, io) || {};

  let doc;
  try {
    doc = JSON.parse(buffer.toString('utf8'));
  } catch {
    writeJsonAtomic(
      paths.ingestStatePath,
      { last_content_sha256: digest, last_parse_error: true, at_ms: ctx.now() },
      io.writeFileSync ?? fs.writeFileSync,
      io.renameSync ?? fs.renameSync,
    );
    return { ingested: false, reason: 'parse_error' };
  }

  const journalEarly = loadJournal(paths.journalPath, io);
  if (typeof doc.report_id === 'string' && journalEarly.published[doc.report_id]) {
    writeJsonAtomic(
      paths.ingestStatePath,
      { last_content_sha256: digest, report_id: doc.report_id, at_ms: ctx.now() },
      io.writeFileSync ?? fs.writeFileSync,
      io.renameSync ?? fs.renameSync,
    );
    return { ingested: false, reason: 'already_published', report_id: doc.report_id };
  }

  if (ingestState.last_content_sha256 === digest) {
    return { ingested: false, reason: 'unchanged' };
  }

  let validation;
  try {
    validation = validateBattleAarDocument(doc);
    const expectedCampaign = resolveExpectedCampaignId(ctx.paths, io);
    assertCampaignBinding(validation, expectedCampaign);
  } catch (error) {
    if (error instanceof BattleAarValidationError && error.code === 'not_finalized') {
      return { ingested: false, reason: 'not_finalized' };
    }
    if (error instanceof BattleAarValidationError) {
      const journal = loadJournal(paths.journalPath, io);
      const rejectKey = (doc && doc.report_id) || digest.slice(0, 16);
      journal.rejected[rejectKey] = {
        at_ms: ctx.now(),
        code: error.code,
        message: error.message,
        details: error.details ?? null,
      };
      saveJournal(paths.journalPath, journal, io);
    }
    writeJsonAtomic(
      paths.ingestStatePath,
      { last_content_sha256: digest, last_reject_code: error.code, at_ms: ctx.now() },
      io.writeFileSync ?? fs.writeFileSync,
      io.renameSync ?? fs.renameSync,
    );
    return { ingested: false, reason: error.code || 'validation_failed', message: error.message };
  }

  const journal = loadJournal(paths.journalPath, io);
  if (journal.published[validation.reportId]) {
    writeJsonAtomic(
      paths.ingestStatePath,
      { last_content_sha256: digest, report_id: validation.reportId, at_ms: ctx.now() },
      io.writeFileSync ?? fs.writeFileSync,
      io.renameSync ?? fs.renameSync,
    );
    return { ingested: false, reason: 'already_published', report_id: validation.reportId };
  }

  const artifactRel = ensureProducedArtifact(ctx, validation, buffer, io);
  const enqueueResult = enqueueValidatedReport(ctx, validation, digest, doc, artifactRel, io);

  writeJsonAtomic(
    paths.ingestStatePath,
    { last_content_sha256: digest, report_id: validation.reportId, enqueued_at_ms: ctx.now() },
    io.writeFileSync ?? fs.writeFileSync,
    io.renameSync ?? fs.renameSync,
  );

  return enqueueResult.ingested
    ? { ingested: true, report_id: validation.reportId, content_sha256: digest }
    : { ingested: false, reason: enqueueResult.reason, report_id: validation.reportId };
}

function remoteArchiveUnchanged(client, archivePath, contentSha256) {
  const remote = client.readFile(archivePath, DEFAULT_BATTLE_AAR_MAX_BYTES);
  if (!remote || !remote.text) {
    return false;
  }
  const remoteDigest = sha256HexLower(Buffer.from(remote.text, 'utf8'));
  return remoteDigest === contentSha256;
}

async function publishBattleAarEntry(ctx, entry, doc, io = {}) {
  if (ctx.dryRun) {
    return { ok: true, dryRun: true, report_id: entry.report_id };
  }
  if (!ctx.bypassGhAuth && !checkGhAuthReadiness()) {
    return { ok: false, code: 'AUTH_FAILED', message: 'GitHub CLI not authenticated.' };
  }

  const existsSync = io.existsSync ?? fs.existsSync;
  const readFileSync = io.readFileSync ?? fs.readFileSync;
  const artifactPath = path.join(ctx.paths.snapshotDir, entry.artifact_path);
  if (!existsSync(artifactPath)) {
    return { ok: false, code: 'ARTIFACT_MISSING', message: 'Queued artifact file missing.' };
  }
  const artifactBytes = readFileSync(artifactPath);
  const artifactBuffer = Buffer.isBuffer(artifactBytes) ? artifactBytes : Buffer.from(artifactBytes, 'utf8');
  const artifactDigest = sha256HexLower(artifactBuffer);
  if (artifactDigest !== entry.content_sha256) {
    return { ok: false, code: 'ARTIFACT_DIGEST_MISMATCH', message: 'Queued artifact does not match content_sha256.' };
  }

  const publishedAt = new Date(ctx.now()).toISOString();
  const compactDoc = projectBattleAarForRelay(doc);
  validateCompactBattleAar(compactDoc);
  const envelope = buildBattleAarRelayEnvelope(compactDoc, { publishedAt, contentSha256: artifactDigest });
  const serialized = `${JSON.stringify(envelope, null, 2)}\n`;
  const publishDigest = sha256HexLower(Buffer.from(serialized, 'utf8'));
  if (Buffer.byteLength(serialized, 'utf8') > DEFAULT_BATTLE_AAR_MAX_BYTES) {
    return { ok: false, code: 'AAR_PAYLOAD_TOO_LARGE', message: 'Battle AAR exceeds relay byte cap.' };
  }

  const publisher = ctx.publisher ?? ctx.relayPublisher ?? createRelayPublisher({ ...ctx.relayOptions });
  const contentClient = ctx.relayContentClient
    ?? createRelayContentClient({ ...ctx.relayOptions });

  const archivePath = archiveRelPath(entry.campaign_id, entry.tactical_battle_id, entry.mission_statistics_id);
  try {
    const archiveSkip = remoteArchiveUnchanged(contentClient, archivePath, publishDigest);
    if (!archiveSkip) {
      contentClient.publishFile(
        archivePath,
        serialized,
        `M1 battle AAR archive ${entry.report_id.slice(0, 12)} mission ${entry.mission_statistics_id}`,
        DEFAULT_BATTLE_AAR_MAX_BYTES,
      );
    }
  } catch (error) {
    return {
      ok: false,
      code: error.code || 'ARCHIVE_PUBLISH_FAILED',
      message: error.message || 'Archive publish failed.',
    };
  }

  try {
    const latestOutcome = await publisher.publishRelayDocument(envelope, {
      statePath: DEFAULT_BATTLE_AAR_PATH,
      maxBytes: DEFAULT_BATTLE_AAR_MAX_BYTES,
      commitMessagePrefix: 'M1 battle AAR',
    });
    return {
      ok: true,
      report_id: entry.report_id,
      archive_path: archivePath,
      latest_path: DEFAULT_BATTLE_AAR_PATH,
      skipped_latest: Boolean(latestOutcome?.skipped),
      content_sha256: publishDigest,
      artifact_sha256: artifactDigest,
      published_at: publishedAt,
    };
  } catch (error) {
    return {
      ok: false,
      code: error.code || 'LATEST_PUBLISH_FAILED',
      message: error.message || 'Latest battle AAR publish failed.',
    };
  }
}

function loadQueuedArtifact(ctx, entry, io = {}) {
  const existsSync = io.existsSync ?? fs.existsSync;
  const readFileSync = io.readFileSync ?? fs.readFileSync;
  const artifactPath = path.join(ctx.paths.snapshotDir, entry.artifact_path);
  if (!existsSync(artifactPath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(artifactPath, 'utf8'));
  } catch {
    return null;
  }
}

async function processBattleAarQueueOnce(ctx, io = {}) {
  const paths = resolveBattleAarPaths(ctx.paths.snapshotDir);
  const queue = loadQueue(paths.queuePath, io);
  if (queue.entries.length === 0) {
    return { processed: false, reason: 'queue_empty' };
  }

  const entry = queue.entries[0];
  const doc = loadQueuedArtifact(ctx, entry, io);
  if (!doc) {
    entry.attempts += 1;
    entry.last_error = 'artifact_missing';
    saveQueue(paths.queuePath, queue, io);
    return { processed: true, ok: false, code: 'ARTIFACT_MISSING', report_id: entry.report_id };
  }

  try {
    const expectedCampaign = resolveExpectedCampaignId(ctx.paths, io);
    const validation = validateBattleAarDocument(doc);
    assertCampaignBinding(validation, expectedCampaign);
  } catch (error) {
    queue.entries.shift();
    const journal = loadJournal(paths.journalPath, io);
    journal.rejected[entry.report_id] = {
      at_ms: ctx.now(),
      code: error.code || 'validation_failed',
      message: error.message,
    };
    saveJournal(paths.journalPath, journal, io);
    saveQueue(paths.queuePath, queue, io);
    return { processed: true, ok: false, code: error.code, report_id: entry.report_id };
  }

  const outcome = await publishBattleAarEntry(ctx, entry, doc, io);
  if (!outcome.ok) {
    entry.attempts += 1;
    entry.last_error = outcome.code || 'publish_failed';
    entry.last_error_message = outcome.message;
    entry.last_attempt_at_ms = ctx.now();
    saveQueue(paths.queuePath, queue, io);
    return { processed: true, ok: false, ...outcome, report_id: entry.report_id, queued_remaining: queue.entries.length };
  }

  queue.entries.shift();
  saveQueue(paths.queuePath, queue, io);

  const journal = loadJournal(paths.journalPath, io);
  journal.published[entry.report_id] = {
    published_at: outcome.published_at,
    content_sha256: outcome.content_sha256,
    artifact_sha256: outcome.artifact_sha256,
    archive_path: outcome.archive_path,
    latest_path: outcome.latest_path,
    tactical_battle_id: entry.tactical_battle_id,
    mission_statistics_id: entry.mission_statistics_id,
    campaign_id: entry.campaign_id,
    attempts: entry.attempts + 1,
  };
  saveJournal(paths.journalPath, journal, io);

  return {
    processed: true,
    ok: true,
    report_id: entry.report_id,
    queued_remaining: queue.entries.length,
    ...outcome,
  };
}

async function processBattleAarRelayTick(ctx, options = {}) {
  const io = options.io ?? {};
  const discover = discoverProducedAarArtifacts(ctx, io);
  const ingest = ingestLocalBattleAar(ctx, io);
  const publish = await processBattleAarQueueOnce(ctx, io);
  if (publish.processed && publish.ok) {
    ctx.log?.(`Battle AAR published ${publish.report_id?.slice(0, 12)} → ${DEFAULT_BATTLE_AAR_PATH}`);
  } else if (publish.processed && !publish.ok && publish.code) {
    ctx.log?.(`Battle AAR publish deferred (${publish.code}): ${publish.report_id?.slice(0, 12) ?? 'unknown'}`);
  } else if (discover.enqueued > 0) {
    ctx.log?.(`Battle AAR discovered ${discover.enqueued} produced artifact(s)`);
  } else if (ingest.ingested) {
    ctx.log?.(`Battle AAR enqueued ${ingest.report_id?.slice(0, 12)}`);
  }
  return { discover, ingest, publish };
}

module.exports = {
  BATTLE_AAR_LOCAL_FILENAME,
  QUEUE_FILENAME,
  JOURNAL_FILENAME,
  INGEST_STATE_FILENAME,
  PENDING_DIRNAME,
  PRODUCED_DIRNAME,
  AAR_SCHEMA_VERSION,
  BattleAarValidationError,
  resolveBattleAarPaths,
  validateBattleAarDocument,
  assessBattleAarCoverage,
  buildBattleAarRelayEnvelope,
  projectBattleAarForRelay,
  archiveRelPath,
  sanitizePathSegment,
  discoverProducedAarArtifacts,
  enqueueValidatedReport,
  ingestLocalBattleAar,
  processBattleAarQueueOnce,
  processBattleAarRelayTick,
  loadQueue,
  loadJournal,
};