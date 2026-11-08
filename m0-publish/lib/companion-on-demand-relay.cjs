'use strict';

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { BriefingWatcher } = require('./briefing-watcher.cjs');
const { createTacticalRelaySidecar } = require('./tactical-relay-sidecar.cjs');
const { assertCommandDeliveryAllowed } = require('./on-demand-game-session.cjs');
const { resolvePaths } = require('./companion-relay-launcher.cjs');
const {
  buildRelayPayload,
  loadAndValidateSnapshotFromText,
  ValidationError,
} = require('./tactical-publish.cjs');
const {
  checkGhAuthReadiness,
  createRelayPublisher,
} = require('./github-relay.cjs');
const { resolveFullAsciiRelayEnabled } = require('./terrain-full-ascii-relay.cjs');
const { createRelayRateLimitGate, resolveSharedRelayRateLimitGatePath } = require('./relay-rate-limit-gate.cjs');
const { createGithubQuotaTelemetryStore } = require('./github-quota-telemetry.cjs');
const { createGithubQuotaConsoleMonitor } = require('./github-quota-console.cjs');
const { resolveCompanionGithubQuotaHudPath } = require('./github-quota-hud-file.cjs');
const { writeJsonAtomic } = require('./local-atomic.cjs');
const { writeBriefingAckAtomic } = require('./briefing-ack.cjs');
const {
  publishRelayWithManualFallback,
  BRIEFING_ACK_STATUS_MANUAL_UPLOAD_REQUIRED,
  manualUploadRequiredAckMessage,
  writeDeferredBriefingAck,
} = require('./briefing-relay-publish.cjs');
const {
  RELAY_OUTCOME,
  buildOnDemandStatusPayload,
  writeOnDemandStatus,
  mapBriefingAckToSendFields,
  mapDirectPublishToSendFields,
} = require('./companion-on-demand-status.cjs');
const {
  createBriefingDiagnosticsEmitter,
  sanitizeBriefingReason,
  basenameArtifact,
} = require('./companion-briefing-diagnostics.cjs');
const { RELAY_SHRINK_EXHAUSTED } = require('./relay-payload-adaptive-shrink.cjs');
const { localRelayPaths } = require('./command-relay-watcher.cjs');
const { isTerminalStatus } = require('./tactical-command.cjs');
const { readSnapshotByteBuffer, sha256HexLower } = require('./briefing-snapshot.cjs');
const { createGhApiCallLog } = require('./github-api-instrumentation.cjs');
const { assertCommandRelayStateDirForTests } = require('./relay-test-isolation.cjs');
const { writeDaemonHealth, DAEMON_STATE } = require('./on-demand-daemon-health.cjs');
const {
  createRelayTransactionTrace,
  bindTransactionScopeToContext,
} = require('./relay-transaction-trace.cjs');

const M0_PUBLISH_ROOT = path.resolve(__dirname, '..');
const REQUEST_FILENAME = 'companion-on-demand-request.json';
const STATUS_FILENAME = 'companion-on-demand-status.json';
const TACTICAL_SEND_MARKER_FILENAME = 'companion-tactical-send-marker.json';
const DEFAULT_LOCAL_DAEMON_POLL_MS = 500;
const DEFAULT_RETRIEVE_LOCAL_WAIT_MS = 8000;
const DEFAULT_RETRIEVE_LOCAL_POLL_MS = 100;
const DEFAULT_RETRIEVE_FOLLOWUP_POLL_MS = 400;
const DEFAULT_RETRIEVE_MAX_FOLLOWUP_POLLS = 12;
const DEFAULT_RETRIEVE_TOTAL_BUDGET_MS = 30_000;

const SEND_PHASE = {
  SENDING: 'sending',
  SENT: 'sent',
  FAILED: 'failed',
  NOT_READY: 'not_ready',
  MANUAL_UPLOAD_REQUIRED: 'manual_upload_required',
};

const RETRIEVE_PHASE = {
  RETRIEVING: 'retrieving',
  COMPLETED: 'completed',
  NO_NEW_ORDERS: 'no_new_orders',
  FAILED: 'failed',
};

function resolveOnDemandPaths(snapshotPath) {
  const layout = resolvePaths(snapshotPath);
  const dir = path.dirname(snapshotPath);
  return {
    ...layout,
    requestPath: path.join(dir, REQUEST_FILENAME),
    statusPath: path.join(dir, STATUS_FILENAME),
    tacticalSendMarkerPath: path.join(dir, TACTICAL_SEND_MARKER_FILENAME),
    snapshotDir: dir,
    localRelay: localRelayPaths(snapshotPath),
  };
}

function loadTacticalSendMarker(markerPath, io = {}) {
  const parsed = readJsonIfExists(markerPath, io);
  if (!parsed || !parsed.value || parsed.parseError) {
    return null;
  }
  return parsed.value;
}

function assessStrategicSendReadiness(paths, io = {}) {
  const existsSync = io.existsSync ?? fs.existsSync;
  const readFileSync = io.readFileSync ?? fs.readFileSync;
  if (!existsSync(paths.snapshotPath)) {
    return { ok: false, message: 'No tactical snapshot on disk.' };
  }
  const marker = loadTacticalSendMarker(paths.tacticalSendMarkerPath, io);
  if (!marker || !marker.snapshot_sha256) {
    return { ok: false, message: 'No fresh battlescape export (send from tactical first).' };
  }
  let snapshotBytes;
  try {
    snapshotBytes = readFileSync(paths.snapshotPath);
  } catch {
    return { ok: false, message: 'Tactical snapshot unreadable.' };
  }
  const digest = sha256HexLower(Buffer.isBuffer(snapshotBytes) ? snapshotBytes : Buffer.from(snapshotBytes, 'utf8'));
  if (digest !== marker.snapshot_sha256) {
    return { ok: false, message: 'Tactical snapshot stale vs last export marker.' };
  }
  return { ok: true, marker, digest };
}

function briefingAckIndicatesSent(ack) {
  if (!ack || !ack.value || !ack.value.status) {
    return false;
  }
  return ['published', 'skipped_unchanged', 'dry_run'].includes(ack.value.status);
}

function readJsonIfExists(filePath, io = {}) {
  const existsSync = io.existsSync ?? fs.existsSync;
  const readFileSync = io.readFileSync ?? fs.readFileSync;
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    return { value: JSON.parse(readFileSync(filePath, 'utf8')) };
  } catch {
    return { value: null, parseError: true };
  }
}

function writeStatus(statusPath, payload, io = {}) {
  writeJsonAtomic(statusPath, payload, io.writeFileSync ?? fs.writeFileSync, io.renameSync ?? fs.renameSync);
}

function resolveStatusSanitize(ctx) {
  return ctx.briefingDiagnostics?.sanitizeBriefingReason ?? sanitizeBriefingReason;
}

function sendPhaseFromMappedFields(fields) {
  if (fields.outcome === RELAY_OUTCOME.DEFERRED) {
    return SEND_PHASE.SENDING;
  }
  if (fields.outcome === RELAY_OUTCOME.MANUAL_UPLOAD_REQUIRED) {
    return SEND_PHASE.MANUAL_UPLOAD_REQUIRED;
  }
  if (fields.outcome === RELAY_OUTCOME.FAILED) {
    return SEND_PHASE.FAILED;
  }
  if (fields.outcome === RELAY_OUTCOME.PUBLISHED || fields.outcome === RELAY_OUTCOME.SKIPPED_UNCHANGED) {
    return SEND_PHASE.SENT;
  }
  return SEND_PHASE.SENDING;
}

function buildSendRunOutcome(mappedFields, extra = {}) {
  const phase = sendPhaseFromMappedFields(mappedFields);
  return {
    phase,
    message: mappedFields.message ?? '',
    error_code: mappedFields.error_code,
    outcome: mappedFields.outcome,
    terminal: mappedFields.terminal !== undefined ? mappedFields.terminal : phase !== SEND_PHASE.SENDING,
    briefing_request_id: extra.briefing_request_id,
  };
}

function writeOnDemandStatusForCtx(ctx, fields, io = {}) {
  const payload = buildOnDemandStatusPayload({
    request_id: fields.request_id,
    action: fields.action,
    phase: fields.phase,
    message: fields.message,
    updated_at_ms: fields.updated_at_ms ?? ctx.now(),
    terminal: fields.terminal,
    outcome: fields.outcome,
    error_code: fields.error_code,
    briefing_request_id: fields.briefing_request_id,
    last_command_id: fields.last_command_id,
    last_command_status: fields.last_command_status,
    retrieve_outcome: fields.retrieve_outcome,
  });
  return writeOnDemandStatus(ctx.paths.statusPath, payload, io);
}

function relayOutcomeToConsoleOutcome(outcome) {
  if (!outcome) {
    return null;
  }
  if (outcome === RELAY_OUTCOME.SKIPPED_UNCHANGED) {
    return 'skipped_unchanged';
  }
  if (outcome === RELAY_OUTCOME.PUBLISHED) {
    return 'published';
  }
  if (outcome === RELAY_OUTCOME.DEFERRED) {
    return 'deferred';
  }
  if (outcome === RELAY_OUTCOME.MANUAL_UPLOAD_REQUIRED) {
    return 'manual_upload_required';
  }
  if (outcome === RELAY_OUTCOME.FAILED) {
    return 'failed';
  }
  return null;
}

function emitSendOutcomeDiagnostics(ctx, pending, outcome) {
  const consoleOutcome = relayOutcomeToConsoleOutcome(outcome.outcome);
  if (!consoleOutcome || !ctx.briefingDiagnostics) {
    return;
  }
  const briefingRequestId = pending.briefing_request_id || pending.request_id;
  const event = {
    outcome: consoleOutcome,
    request_id: briefingRequestId,
    error_code: outcome.error_code,
    reason: outcome.message,
    turn: pending.turn,
  };
  if (consoleOutcome === 'manual_upload_required' && outcome.message) {
    const match = /File:\s*(.+)$/m.exec(outcome.message);
    if (match) {
      event.artifact_filename = basenameArtifact(match[1].trim());
    }
  }
  ctx.briefingDiagnostics.emit(event);
}

function createOnDemandRelayContext(options = {}) {
  assertCommandRelayStateDirForTests(options);
  const snapshotPath = options.snapshotPath;
  const paths = resolveOnDemandPaths(snapshotPath);
  const dryRun = options.dryRun ?? false;
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? (() => {});
  const briefingDiagnostics = options.briefingDiagnostics
    ?? createBriefingDiagnosticsEmitter({ log: (line) => log(line), now });
  const gatePath = resolveSharedRelayRateLimitGatePath(M0_PUBLISH_ROOT);
  const rateLimitGate = options.rateLimitGate
    ?? createRelayRateLimitGate({ gatePath, now });
  const hudPath = resolveCompanionGithubQuotaHudPath({ snapshotPathEnv: snapshotPath });
  const quotaTelemetryStore = options.quotaTelemetryStore
    ?? createGithubQuotaTelemetryStore({ now, persistPath: hudPath });
  const quotaConsoleMonitor = options.quotaConsoleMonitor
    ?? createGithubQuotaConsoleMonitor({
      store: quotaTelemetryStore,
      rateLimitGate,
      log: (line) => log(line),
      now,
      hudPath,
      snapshotPathEnv: snapshotPath,
    });

  const relayOptions = {
    ...(options.relayOptions ?? {}),
    includeTerrainFullAsciiBattlefield: resolveFullAsciiRelayEnabled({
      includeTerrainFullAsciiBattlefield: options.includeTerrainFullAsciiBattlefield
        ?? options.relayOptions?.includeTerrainFullAsciiBattlefield,
    }),
    relayIsolationContract: options.relayIsolationContract
      ?? options.relayOptions?.relayIsolationContract
      ?? null,
    rateLimitGate,
    quotaTelemetryStore,
    now,
    dryRun,
    log: (line) => log(line),
    apiCallLog: options.apiCallLog,
    transactionId: options.transactionId,
  };

  const sessionBindings = {
    gameSessionWatchdog: options.gameSessionWatchdog ?? null,
  };
  const resolveCommandDeliveryGate = options.assertCommandDeliveryAllowed
    ?? (() => assertCommandDeliveryAllowed(snapshotPath, {
      gameSessionWatchdog: sessionBindings.gameSessionWatchdog,
      deps: options.deps ?? options.io,
      daemonPid: process.pid,
    }));

  const sidecar = createTacticalRelaySidecar({
    snapshotPath,
    stateDir: options.commandRelayStateDir ?? paths.commandRelayStateDir,
    dryRun,
    rateLimitGate,
    quotaTelemetryStore,
    quotaConsoleMonitor,
    relayOptions,
    log: (line) => log(line),
    now,
    notify: options.notify,
    contentClient: options.contentClient,
    relayPublisher: options.relayPublisher,
    assertCommandDeliveryAllowed: resolveCommandDeliveryGate,
  });

  const publisher = options.relayPublisher
    ?? createRelayPublisher(relayOptions);

  const briefingWatcher = new BriefingWatcher({
    requestPath: paths.briefingRequest,
    snapshotPath,
    stateDir: paths.briefingStateDir,
    dryRun,
    publishRelayState: (relay) => publisher.publishRelayState(relay),
    rateLimitGate,
    githubQuotaMonitor: quotaConsoleMonitor,
    log: (line) => log(line),
    now,
    readFileSync: options.readFileSync,
    existsSync: options.existsSync,
    notify: options.notify,
    briefingDiagnostics,
    manualUploadIo: options.manualUploadIo,
  });

  const ctx = {
    paths,
    dryRun,
    now,
    log,
    notify: options.notify,
    briefingDiagnostics,
    rateLimitGate,
    quotaConsoleMonitor,
    briefingWatcher,
    ownershipToken: options.ownershipToken ?? null,
    commandWatcher: sidecar.commandWatcher,
    publisher,
    relayOptions,
    relayIsolationContract: options.relayIsolationContract
      ?? relayOptions.relayIsolationContract
      ?? null,
    requireRelayIsolation: options.requireRelayIsolation === true,
    apiCallLog: options.apiCallLog ?? null,
    quotaTelemetryStore: sidecar.quotaTelemetryStore,
    assertCommandDeliveryAllowed: resolveCommandDeliveryGate,
  };
  Object.defineProperty(ctx, 'gameSessionWatchdog', {
    enumerable: true,
    get: () => sessionBindings.gameSessionWatchdog,
    set: (value) => {
      sessionBindings.gameSessionWatchdog = value;
    },
  });
  if (options.gameSessionWatchdog) {
    ctx.gameSessionWatchdog = options.gameSessionWatchdog;
  }
  return ctx;
}

async function publishSnapshotDirect(ctx, pending = null) {
  const { paths, dryRun, publisher, log } = ctx;
  const inputPath = paths.snapshotPath;
  if (!fs.existsSync(inputPath)) {
    return { ok: false, reason: 'snapshot_missing' };
  }
  const text = fs.readFileSync(inputPath, 'utf8');
  let tactical;
  try {
    tactical = loadAndValidateSnapshotFromText(text, YAML);
  } catch (error) {
    const message = error instanceof ValidationError ? error.message : String(error);
    const code = error instanceof ValidationError ? 'SNAPSHOT_VALIDATION' : 'SNAPSHOT_ERROR';
    return { ok: false, reason: message, code };
  }
  const publishedAt = new Date(ctx.now()).toISOString();
  const snapshotBytes = readSnapshotByteBuffer(fs.readFileSync, inputPath);
  const digest = sha256HexLower(snapshotBytes);
  const marker = loadTacticalSendMarker(paths.tacticalSendMarkerPath);
  const onDemandRequestId = pending && pending.request_id ? pending.request_id : null;
  const briefingRequestId = pending && pending.briefing_request_id
    ? pending.briefing_request_id
    : (marker && marker.briefing_request_id ? marker.briefing_request_id : null);
  const relayRequestId = briefingRequestId || onDemandRequestId;
  const briefingMeta = relayRequestId
    ? {
      request_id: relayRequestId,
      session_id: marker?.session_id ?? tactical.eventLog?.sessionId,
      turn: marker?.turn ?? tactical.turn,
    }
    : null;
  const relay = buildRelayPayload(tactical, publishedAt, briefingMeta, { snapshotSha256: digest });
  if (dryRun) {
    log(`Dry-run snapshot publish ${relay.snapshot_id.slice(0, 12)}.`);
    return { ok: true, dryRun: true };
  }
  if (!checkGhAuthReadiness()) {
    return { ok: false, reason: 'GitHub CLI not authenticated.', code: 'AUTH_FAILED' };
  }

  const publishOutcome = await publishRelayWithManualFallback({
    relay,
    publishRelayState: (payload) => publisher.publishRelayState(payload),
    snapshotDir: paths.snapshotDir,
    requestId: relayRequestId,
    sessionId: briefingMeta?.session_id ?? tactical.eventLog?.sessionId,
    turn: briefingMeta?.turn ?? tactical.turn,
    snapshotSha256: digest,
    now: ctx.now,
    log,
    notify: ctx.notify,
    briefingDiagnostics: ctx.briefingDiagnostics,
    writeDeferredAck: relayRequestId
      ? (message, code) => writeDeferredBriefingAck(
        (ack) => writeBriefingAckAtomic(path.dirname(paths.briefingAck), {
          ...ack,
          acked_at: new Date(ctx.now()).toISOString(),
        }),
        { request_id: relayRequestId, turn: briefingMeta?.turn ?? tactical.turn },
        message,
        code,
      )
      : undefined,
  });

  if (publishOutcome.kind === 'published' || publishOutcome.kind === 'skipped') {
    return { ok: true, skipped: publishOutcome.kind === 'skipped' };
  }
  if (publishOutcome.kind === 'defer') {
    return { ok: false, reason: publishOutcome.error.message || 'Rate limited.', code: 'RATE_LIMIT' };
  }
  if (publishOutcome.kind === 'hard_error') {
    return { ok: false, reason: publishOutcome.error.message || 'Publish failed.', code: publishOutcome.code };
  }
  if (publishOutcome.kind === 'retryable') {
    return { ok: false, reason: publishOutcome.error.message || 'Publish failed.', code: publishOutcome.code };
  }
  if (publishOutcome.kind === 'manual_export_failed') {
    return {
      ok: false,
      reason: publishOutcome.writeError?.message || 'Manual artifact write failed.',
      code: publishOutcome.errorCode ?? 'MANUAL_EXPORT_WRITE_FAILED',
    };
  }
  if (publishOutcome.kind === 'manual_upload_required') {
    const artifactPath = publishOutcome.exportResult.path;
    if (relayRequestId) {
      writeBriefingAckAtomic(path.dirname(paths.briefingAck), {
        request_id: relayRequestId,
        status: BRIEFING_ACK_STATUS_MANUAL_UPLOAD_REQUIRED,
        snapshot_id: relay.snapshot_id,
        snapshot_sha256: digest,
        error_code: RELAY_SHRINK_EXHAUSTED,
        artifact_path: artifactPath,
        artifact_sha256: publishOutcome.exportResult.sha256,
        message: manualUploadRequiredAckMessage(artifactPath),
        acked_at: new Date(ctx.now()).toISOString(),
      });
    }
    return {
      ok: false,
      code: BRIEFING_ACK_STATUS_MANUAL_UPLOAD_REQUIRED,
      error_code: RELAY_SHRINK_EXHAUSTED,
      reason: manualUploadRequiredAckMessage(artifactPath),
      artifact_path: artifactPath,
      artifact_sha256: publishOutcome.exportResult.sha256,
      manualUpload: true,
    };
  }
  return { ok: false, reason: 'Publish failed.', code: 'PUBLISH_FAILED' };
}

async function runSendOnce(ctx, pending = null) {
  const { briefingWatcher, paths, log } = ctx;
  const sanitize = resolveStatusSanitize(ctx);
  ctx.transactionTrace?.record('send_processing_started', {
    send_scope: pending && pending.send_scope ? pending.send_scope : 'tactical',
  });
  const sendScope = pending && pending.send_scope ? pending.send_scope : 'tactical';
  const expectedBriefingId = pending && pending.briefing_request_id ? pending.briefing_request_id : null;

  if (sendScope === 'strategic') {
    const readiness = assessStrategicSendReadiness(paths);
    if (!readiness.ok) {
      return {
        phase: SEND_PHASE.NOT_READY,
        message: sanitize(readiness.message),
        outcome: RELAY_OUTCOME.FAILED,
        error_code: 'NOT_READY',
        terminal: true,
      };
    }
    const direct = await publishSnapshotDirect(ctx, pending);
    if (ctx.quotaConsoleMonitor && typeof ctx.quotaConsoleMonitor.tick === 'function') {
      ctx.quotaConsoleMonitor.tick();
    }
    const mapped = mapDirectPublishToSendFields(direct, { sanitizeReason: sanitize });
    if (mapped) {
      return buildSendRunOutcome(mapped, { briefing_request_id: expectedBriefingId });
    }
    return {
      phase: SEND_PHASE.FAILED,
      message: sanitize('Publish failed.'),
      outcome: RELAY_OUTCOME.FAILED,
      error_code: 'PUBLISH_FAILED',
      terminal: true,
    };
  }

  let request;
  try {
    request = briefingWatcher.readRequest();
  } catch {
    request = null;
  }
  if (request && expectedBriefingId && request.request_id !== expectedBriefingId) {
    return {
      phase: SEND_PHASE.FAILED,
      message: sanitize('Briefing request superseded; retry SEND.'),
      outcome: RELAY_OUTCOME.FAILED,
      error_code: 'BRIEFING_SUPERSEDED',
      terminal: true,
      briefing_request_id: expectedBriefingId,
    };
  }

  if (request && (!expectedBriefingId || request.request_id === expectedBriefingId)) {
    await briefingWatcher._pollOnce();
    if (ctx.quotaConsoleMonitor && typeof ctx.quotaConsoleMonitor.tick === 'function') {
      ctx.quotaConsoleMonitor.tick();
    }
    const ack = readJsonIfExists(paths.briefingAck);
    if (expectedBriefingId && ack?.value?.request_id && ack.value.request_id !== expectedBriefingId) {
      return {
        phase: SEND_PHASE.FAILED,
        message: sanitize('Briefing acknowledgment does not match this request.'),
        outcome: RELAY_OUTCOME.FAILED,
        error_code: 'BRIEFING_ACK_STALE',
        terminal: true,
        briefing_request_id: expectedBriefingId,
      };
    }
    const ackMapped = mapBriefingAckToSendFields(ack, expectedBriefingId, { sanitizeReason: sanitize });
    if (ackMapped) {
      return buildSendRunOutcome(ackMapped, { briefing_request_id: expectedBriefingId });
    }
    if (ctx.dryRun) {
      return buildSendRunOutcome({
        outcome: RELAY_OUTCOME.PUBLISHED,
        terminal: true,
        message: sanitize('Dry-run briefing publish.'),
      }, { briefing_request_id: expectedBriefingId });
    }
  }

  const direct = await publishSnapshotDirect(ctx, pending);
  if (ctx.quotaConsoleMonitor && typeof ctx.quotaConsoleMonitor.tick === 'function') {
    ctx.quotaConsoleMonitor.tick();
  }
  const directMapped = mapDirectPublishToSendFields(direct, { sanitizeReason: sanitize });
  if (directMapped) {
    return buildSendRunOutcome(directMapped, { briefing_request_id: expectedBriefingId });
  }
  return {
    phase: SEND_PHASE.FAILED,
    message: sanitize(direct.reason || 'Publish failed.'),
    outcome: RELAY_OUTCOME.FAILED,
    error_code: direct.code || 'PUBLISH_FAILED',
    terminal: true,
    briefing_request_id: expectedBriefingId,
  };
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForLocalTerminalResult(localResultPath, options = {}) {
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_RETRIEVE_LOCAL_WAIT_MS;
  const pollMs = options.pollMs ?? DEFAULT_RETRIEVE_LOCAL_POLL_MS;
  const now = options.now ?? (() => Date.now());
  const existsSync = options.existsSync ?? fs.existsSync;
  const readFileSync = options.readFileSync ?? fs.readFileSync;
  const deadline = now() + maxWaitMs;
  while (now() <= deadline) {
    const parsed = readJsonIfExists(localResultPath, { existsSync, readFileSync });
    if (parsed && parsed.value && parsed.value.status && isTerminalStatus(parsed.value.status)) {
      return parsed.value;
    }
    await sleepMs(pollMs);
  }
  return null;
}

function openNonTerminalResultForActive(commandWatcher, paths) {
  const openResult = readJsonIfExists(paths.localRelay.result);
  if (!openResult || !openResult.value || openResult.parseError) {
    return null;
  }
  const journal = commandWatcher.loadJournal();
  const activeId = journal.active && journal.active.command_id ? journal.active.command_id : null;
  if (!activeId || openResult.value.command_id !== activeId) {
    return null;
  }
  if (isTerminalStatus(openResult.value.status)) {
    return null;
  }
  return openResult.value;
}

function resolveRetrieveCommandOutcome(commandWatcher, tx) {
  if (!tx || !commandWatcher) {
    return null;
  }
  const commandId = tx.deliveredCommandId || tx.publishedCommandId;
  if (!commandId) {
    return null;
  }
  if (tx.completionKind === 'sidecar_rejected') {
    return {
      last_command_id: commandId,
      last_command_status: 'REJECTED',
      retrieve_outcome: 'command_rejected',
    };
  }
  const local = commandWatcher.readLocalResult();
  if (local && !local.__parseError && local.command_id === commandId && local.status) {
    return {
      last_command_id: commandId,
      last_command_status: local.status,
      retrieve_outcome: isTerminalStatus(local.status) ? 'command_terminal' : 'relay_complete',
    };
  }
  const journal = commandWatcher.loadJournal();
  const record = journal.records && journal.records[commandId] ? journal.records[commandId] : null;
  if (record && record.status) {
    return {
      last_command_id: commandId,
      last_command_status: record.status,
      retrieve_outcome: 'command_terminal',
    };
  }
  return null;
}

function withRetrieveCommandOutcome(outcome, commandWatcher, tx) {
  const commandFields = resolveRetrieveCommandOutcome(commandWatcher, tx);
  if (!commandFields) {
    return outcome;
  }
  return { ...outcome, ...commandFields };
}

function isRetrieveEndToEndComplete(tx) {
  if (!tx) {
    return false;
  }
  if (tx.completionKind === 'sidecar_rejected') {
    return false;
  }
  if (tx.deliveredCommandId) {
    return Boolean(tx.publishedResult && tx.retiredRemote);
  }
  if (tx.publishedResult && tx.completionKind === 'engine_reported') {
    return Boolean(tx.retiredRemote);
  }
  return false;
}

function retrieveHasPendingRelayWork(tx, snap) {
  if (!tx) {
    return false;
  }
  if (tx.deliveredCommandId && (!tx.publishedResult || !tx.retiredRemote)) {
    return true;
  }
  if (tx.publishedResult && !tx.retiredRemote) {
    return true;
  }
  if (snap && snap.pendingRetirement) {
    return true;
  }
  if (snap && snap.needsSecondPoll) {
    return true;
  }
  return false;
}

function shouldRunEngineWaitForRetrieve(tx, commandWatcher, paths, engineWaitDoneForCommandId) {
  if (tx && tx.deliveredCommandId) {
    if (tx.publishedResult || tx.completedExecution) {
      return false;
    }
    if (engineWaitDoneForCommandId === tx.deliveredCommandId) {
      return false;
    }
    return true;
  }
  if (openNonTerminalResultForActive(commandWatcher, paths)) {
    if (engineWaitDoneForCommandId) {
      return false;
    }
    return true;
  }
  return false;
}

async function runRetrieveEngineWait(ctx, commandWatcher, paths, options, engineWaitDoneForCommandId) {
  const tx = commandWatcher.getRetrieveTransactionState();
  if (!shouldRunEngineWaitForRetrieve(tx, commandWatcher, paths, engineWaitDoneForCommandId)) {
    return { waited: false, engineWaitDoneForCommandId };
  }
  const waitTargetId = tx && tx.deliveredCommandId
    ? tx.deliveredCommandId
    : (commandWatcher.loadJournal().active?.command_id ?? 'active');
  ctx.transactionTrace?.record('local_engine_wait_start', {
    max_wait_ms: options.localWaitMs ?? DEFAULT_RETRIEVE_LOCAL_WAIT_MS,
  });
  const terminal = await waitForLocalTerminalResult(paths.localRelay.result, {
    maxWaitMs: options.localWaitMs,
    pollMs: options.localPollMs,
    now: ctx.now,
    existsSync: options.existsSync,
    readFileSync: options.readFileSync,
  });
  if (terminal && terminal.command_id) {
    commandWatcher._noteRetrieveCompletedExecution();
    ctx.transactionTrace?.record('local_engine_wait_terminal', {
      command_id: terminal.command_id,
      status: terminal.status,
    });
  } else {
    ctx.transactionTrace?.record('local_engine_wait_timeout', {
      reason: 'local_terminal_not_observed_within_wait',
    });
  }
  return { waited: true, engineWaitDoneForCommandId: waitTargetId };
}

async function runRetrieveOnce(ctx, options = {}) {
  const { commandWatcher, paths } = ctx;
  const transactionId = options.transactionId ?? options.request_id ?? null;
  commandWatcher.beginRetrieveTransaction(transactionId);

  const maxFollowUpPolls = options.maxFollowUpPolls ?? DEFAULT_RETRIEVE_MAX_FOLLOWUP_POLLS;
  const followUpPollMs = options.followUpPollMs ?? DEFAULT_RETRIEVE_FOLLOWUP_POLL_MS;
  const totalBudgetMs = options.totalBudgetMs ?? DEFAULT_RETRIEVE_TOTAL_BUDGET_MS;
  const deadline = ctx.now() + totalBudgetMs;
  let engineWaitDoneForCommandId = null;
  let pollCount = 0;

  const tickQuota = () => {
    if (ctx.quotaConsoleMonitor && typeof ctx.quotaConsoleMonitor.tick === 'function') {
      ctx.quotaConsoleMonitor.tick();
    }
  };

  await commandWatcher._pollOnce();
  pollCount += 1;
  tickQuota();

  let enginePass = await runRetrieveEngineWait(ctx, commandWatcher, paths, options, engineWaitDoneForCommandId);
  if (enginePass.waited) {
    engineWaitDoneForCommandId = enginePass.engineWaitDoneForCommandId;
  }

  while (pollCount < maxFollowUpPolls && ctx.now() <= deadline) {
    const tx = commandWatcher.getRetrieveTransactionState();
    const snap = commandWatcher.getLastRetrievePollSnapshot();
    if (isRetrieveEndToEndComplete(tx)) {
      break;
    }
    if (!retrieveHasPendingRelayWork(tx, snap)) {
      break;
    }

    ctx.transactionTrace?.record('follow_up_poll_scheduled', {
      poll_index: pollCount + 1,
      poll_snapshot: snap ?? null,
      retrieve_tx: tx ?? null,
    });
    await sleepMs(followUpPollMs);
    await commandWatcher._pollOnce();
    pollCount += 1;
    tickQuota();

    enginePass = await runRetrieveEngineWait(ctx, commandWatcher, paths, options, engineWaitDoneForCommandId);
    if (enginePass.waited) {
      engineWaitDoneForCommandId = enginePass.engineWaitDoneForCommandId;
    }

    if (isRetrieveEndToEndComplete(commandWatcher.getRetrieveTransactionState())) {
      break;
    }
  }

  const tx = commandWatcher.getRetrieveTransactionState();
  if (isRetrieveEndToEndComplete(tx)) {
    ctx.transactionTrace?.record('retrieve_disposition', { disposition: 'completed', retrieve_tx: tx });
    return withRetrieveCommandOutcome({
      phase: RETRIEVE_PHASE.COMPLETED,
      message: 'Retrieve complete.',
      terminal: true,
      outcome: RELAY_OUTCOME.RETRIEVE_COMPLETE,
    }, commandWatcher, tx);
  }

  const touched = Boolean(
    tx && (tx.deliveredCommandId || tx.publishedResult || tx.completedExecution),
  );

  if (touched && !isRetrieveEndToEndComplete(tx)) {
    const sidecarReject = tx && tx.completionKind === 'sidecar_rejected';
    const dispositionCommandId = tx
      ? (tx.deliveredCommandId || tx.publishedCommandId || null)
      : null;
    ctx.transactionTrace?.record('retrieve_disposition', {
      disposition: sidecarReject ? 'sidecar_rejected' : 'incomplete',
      retrieve_tx: tx,
      ...(dispositionCommandId ? { command_id: dispositionCommandId } : {}),
      ...(tx && tx.sidecarRejectCode ? { sidecar_reject_code: tx.sidecarRejectCode } : {}),
    });
    return withRetrieveCommandOutcome({
      phase: RETRIEVE_PHASE.FAILED,
      message: sidecarReject
        ? 'Sidecar rejected command before execution; cooperative retrieve incomplete.'
        : 'Retrieve incomplete; press RETRIEVE again to finish relay.',
      error_code: sidecarReject ? (tx.sidecarRejectCode || 'SIDECAR_REJECTED') : 'RETRIEVE_INCOMPLETE',
      terminal: true,
      outcome: RELAY_OUTCOME.FAILED,
      retryable: !sidecarReject,
    }, commandWatcher, tx);
  }

  const snap = commandWatcher.getLastRetrievePollSnapshot();
  if (!touched && snap && snap.remoteReadFailed) {
    ctx.transactionTrace?.record('retrieve_disposition', {
      disposition: 'retrieval_error',
      retrieve_tx: tx,
      poll_snapshot: snap,
      error_code: snap.remoteReadErrorCode,
    });
    return {
      phase: RETRIEVE_PHASE.FAILED,
      message: 'Remote inbox check failed.',
      error_code: snap.remoteReadErrorCode || 'RETRIEVAL_ERROR',
      terminal: true,
      outcome: RELAY_OUTCOME.FAILED,
    };
  }
  const openLocalNonTerminal =
    openNonTerminalResultForActive(commandWatcher, paths)
    || (() => {
      const localResult = commandWatcher.readLocalResult();
      if (!localResult || localResult.__parseError || !localResult.status) {
        return null;
      }
      return isTerminalStatus(localResult.status) ? null : localResult;
    })();
  if (!touched && openLocalNonTerminal) {
    ctx.transactionTrace?.record('retrieve_disposition', {
      disposition: 'incomplete',
      retrieve_tx: tx,
      poll_snapshot: snap ?? null,
      command_id: openLocalNonTerminal.command_id,
      status: openLocalNonTerminal.status,
    });
    return {
      phase: RETRIEVE_PHASE.FAILED,
      message: 'Retrieve incomplete; press RETRIEVE again to finish relay.',
      error_code: 'RETRIEVE_INCOMPLETE',
      terminal: true,
      outcome: RELAY_OUTCOME.FAILED,
      retryable: true,
    };
  }

  ctx.transactionTrace?.record('retrieve_disposition', { disposition: 'no_new_orders', retrieve_tx: tx });
  return {
    phase: RETRIEVE_PHASE.NO_NEW_ORDERS,
    message: 'No new orders.',
    terminal: true,
    outcome: RELAY_OUTCOME.NO_NEW_ORDERS,
  };
}

function isNonTerminalUiPhase(phase) {
  return phase === SEND_PHASE.SENDING
    || phase === RETRIEVE_PHASE.RETRIEVING;
}

function isNonTerminalUiOutcome(outcome) {
  if (outcome?.outcome === RELAY_OUTCOME.DEFERRED) {
    return true;
  }
  if (outcome?.terminal === false) {
    return true;
  }
  return isNonTerminalUiPhase(outcome?.phase);
}

async function processPendingRequest(ctx, io = {}) {
  if (ctx.gameSessionWatchdog && typeof ctx.gameSessionWatchdog.acceptingRequests === 'function') {
    if (!ctx.gameSessionWatchdog.acceptingRequests()) {
      return { processed: false, reason: 'game_session_closed' };
    }
  }
  const { paths } = ctx;
  const pending = readJsonIfExists(paths.requestPath, io);
  if (!pending || !pending.value || pending.value.status !== 'pending') {
    return { processed: false };
  }

  const { request_id: requestId, action } = pending.value;

  const apiCallLog = createGhApiCallLog({ transactionId: requestId });
  const trace = createRelayTransactionTrace({
    requestId,
    action,
    snapshotDir: paths.snapshotDir,
    now: ctx.now,
    getQuotaStore: () => ctx.quotaTelemetryStore,
    io,
  });
  trace.record('request_dequeued', { status: pending.value.status });
  trace.record('daemon_processing_started');

  const releaseScope = bindTransactionScopeToContext(ctx, {
    requestId,
    apiCallLog,
    trace,
    quotaTelemetryStore: ctx.quotaTelemetryStore,
    execFileSync: io.execFileSync,
    preserveWatcherIo: io.preserveWatcherIo !== false,
  });

  if (action === 'send') {
    const briefingRequestId = pending.value.briefing_request_id || requestId;
    ctx.briefingDiagnostics?.emit({
      outcome: 'received',
      request_id: briefingRequestId,
      turn: pending.value.turn,
    });
    ctx.briefingDiagnostics?.emit({
      outcome: 'sending',
      request_id: briefingRequestId,
      turn: pending.value.turn,
    });
  }

  writeOnDemandStatusForCtx(ctx, {
    request_id: requestId,
    action,
    phase: action === 'send' ? SEND_PHASE.SENDING : RETRIEVE_PHASE.RETRIEVING,
    message: action === 'send' ? 'Sending…' : 'Retrieving…',
    updated_at_ms: ctx.now(),
    terminal: false,
    outcome: action === 'send' ? RELAY_OUTCOME.SENDING : undefined,
    briefing_request_id: pending.value.briefing_request_id,
  }, io);
  trace.record('ui_status_written', { terminal: false, phase: action === 'send' ? SEND_PHASE.SENDING : RETRIEVE_PHASE.RETRIEVING });

  let outcome;
  try {
    if (action === 'send') {
      outcome = await runSendOnce(ctx, pending.value);
    } else if (action === 'retrieve') {
      outcome = await runRetrieveOnce(ctx, {
        ...io,
        transactionId: requestId,
        request_id: requestId,
      });
    } else {
      outcome = { phase: SEND_PHASE.FAILED, message: `Unknown action ${action}` };
    }
  } catch (error) {
    outcome = {
      phase: action === 'retrieve' ? RETRIEVE_PHASE.FAILED : SEND_PHASE.FAILED,
      message: error.message || String(error),
    };
  } finally {
    releaseScope();
  }

  const uiTerminal = outcome.terminal !== undefined
    ? Boolean(outcome.terminal)
    : !isNonTerminalUiOutcome(outcome);
  const statusWrite = writeOnDemandStatusForCtx(ctx, {
    request_id: requestId,
    action,
    phase: outcome.phase,
    message: outcome.message || '',
    updated_at_ms: ctx.now(),
    terminal: uiTerminal,
    outcome: outcome.outcome,
    error_code: outcome.error_code,
    briefing_request_id: pending.value.briefing_request_id ?? outcome.briefing_request_id,
    last_command_id: outcome.last_command_id,
    last_command_status: outcome.last_command_status,
    retrieve_outcome: outcome.retrieve_outcome,
  }, io);
  const uiStatusPreserved = statusWrite && statusWrite.written === false;
  if (action === 'send') {
    emitSendOutcomeDiagnostics(ctx, pending.value, outcome);
  }
  trace.record('ui_status_written', { terminal: uiTerminal, phase: outcome.phase });

  trace.finish({
    outcomePhase: outcome.phase,
    outcomeMessage: outcome.message,
    uiStatusTerminal: uiTerminal,
    uiStatusPreserved,
    apiCallLog,
    retrieveTx: action === 'retrieve' ? ctx.commandWatcher.getRetrieveTransactionState() : null,
    pollSnapshot: action === 'retrieve' ? ctx.commandWatcher.getLastRetrievePollSnapshot() : null,
  });

  const retainPendingRequest = action === 'send' && outcome.outcome === RELAY_OUTCOME.DEFERRED;
  if (!retainPendingRequest) {
    writeJsonAtomic(paths.requestPath, {
      ...pending.value,
      status: 'completed',
      completed_at_ms: ctx.now(),
    }, io.writeFileSync ?? fs.writeFileSync, io.renameSync ?? fs.renameSync);

    try {
      (io.unlinkSync ?? fs.unlinkSync)(paths.requestPath);
    } catch {
      // leave completed marker if unlink fails
    }
  }

  return { processed: true, outcome, retainPendingRequest };
}

function createOnDemandRelayDaemon(options = {}) {
  const snapshotPath = options.snapshotPath;
  const pollMs = options.pollIntervalMs ?? DEFAULT_LOCAL_DAEMON_POLL_MS;
  const ctx = createOnDemandRelayContext(options);
  let running = false;
  let timer = null;
  let inFlight = false;
  const healthIo = {
    ...(options.io ?? {}),
    ownershipToken: ctx.ownershipToken ?? undefined,
  };

  const tick = async () => {
    if (!running || inFlight) {
      return;
    }
    if (options.gameSessionWatchdog) {
      const phase = await options.gameSessionWatchdog.beforeTick();
      if (phase === 'shutdown') {
        running = false;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        return;
      }
    }
    inFlight = true;
    writeDaemonHealth(ctx.paths.snapshotDir, {
      pid: process.pid,
      state: DAEMON_STATE.BUSY,
    }, healthIo);
    try {
      await processPendingRequest(ctx, options.io);
    } catch (error) {
      ctx.log(`On-demand relay tick error: ${error.message || String(error)}`);
      throw error;
    } finally {
      inFlight = false;
      try {
        if (ctx.quotaConsoleMonitor && typeof ctx.quotaConsoleMonitor.tick === 'function') {
          ctx.quotaConsoleMonitor.tick();
        }
      } catch (monitorError) {
        ctx.log(`Quota monitor tick error: ${monitorError.message || String(monitorError)}`);
      }
      if (running) {
        writeDaemonHealth(ctx.paths.snapshotDir, {
          pid: process.pid,
          state: DAEMON_STATE.READY,
        }, healthIo);
      }
    }
  };

  return {
    ctx,
    start() {
      if (running) {
        return;
      }
      running = true;
      writeDaemonHealth(ctx.paths.snapshotDir, {
        pid: process.pid,
        state: DAEMON_STATE.READY,
      }, healthIo);
      const loop = () => {
        if (!running) {
          return;
        }
        tick().catch((error) => {
          ctx.log(`On-demand relay tick failed: ${error.message || String(error)}`);
        }).finally(() => {
          if (running) {
            timer = setTimeout(loop, pollMs);
          }
        });
      };
      timer = setTimeout(loop, 0);
    },
    stop() {
      running = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    async runTickOnce() {
      await tick();
    },
  };
}

module.exports = {
  REQUEST_FILENAME,
  STATUS_FILENAME,
  DEFAULT_LOCAL_DAEMON_POLL_MS,
  DEFAULT_RETRIEVE_LOCAL_WAIT_MS,
  DEFAULT_RETRIEVE_FOLLOWUP_POLL_MS,
  DEFAULT_RETRIEVE_MAX_FOLLOWUP_POLLS,
  DEFAULT_RETRIEVE_TOTAL_BUDGET_MS,
  SEND_PHASE,
  RETRIEVE_PHASE,
  TACTICAL_SEND_MARKER_FILENAME,
  resolveOnDemandPaths,
  loadTacticalSendMarker,
  assessStrategicSendReadiness,
  briefingAckIndicatesSent,
  createOnDemandRelayContext,
  runSendOnce,
  runRetrieveOnce,
  processPendingRequest,
  createOnDemandRelayDaemon,
  isNonTerminalUiPhase,
  isNonTerminalUiOutcome,
  writeOnDemandStatusForCtx,
  buildSendRunOutcome,
  sanitizeBriefingReason,
  isRetrieveEndToEndComplete,
  retrieveHasPendingRelayWork,
  resolveRetrieveCommandOutcome,
  createGhApiCallLog,
  createRelayTransactionTrace,
  bindTransactionScopeToContext,
};
