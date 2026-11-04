'use strict';

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { BriefingWatcher } = require('./briefing-watcher.cjs');
const { createTacticalRelaySidecar } = require('./tactical-relay-sidecar.cjs');
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
const { createRelayRateLimitGate, resolveSharedRelayRateLimitGatePath } = require('./relay-rate-limit-gate.cjs');
const { createGithubQuotaTelemetryStore } = require('./github-quota-telemetry.cjs');
const { createGithubQuotaConsoleMonitor } = require('./github-quota-console.cjs');
const { resolveCompanionGithubQuotaHudPath } = require('./github-quota-hud-file.cjs');
const { writeJsonAtomic } = require('./local-atomic.cjs');
const { localRelayPaths } = require('./command-relay-watcher.cjs');
const { isTerminalStatus } = require('./tactical-command.cjs');
const { readSnapshotByteBuffer, sha256HexLower } = require('./briefing-snapshot.cjs');
const { createGhApiCallLog } = require('./github-api-instrumentation.cjs');
const { assertCommandRelayStateDirForTests } = require('./relay-test-isolation.cjs');

const M0_PUBLISH_ROOT = path.resolve(__dirname, '..');
const REQUEST_FILENAME = 'companion-on-demand-request.json';
const STATUS_FILENAME = 'companion-on-demand-status.json';
const TACTICAL_SEND_MARKER_FILENAME = 'companion-tactical-send-marker.json';
const DEFAULT_LOCAL_DAEMON_POLL_MS = 500;
const DEFAULT_RETRIEVE_LOCAL_WAIT_MS = 8000;
const DEFAULT_RETRIEVE_LOCAL_POLL_MS = 100;

const SEND_PHASE = {
  SENDING: 'sending',
  SENT: 'sent',
  FAILED: 'failed',
  NOT_READY: 'not_ready',
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

function createOnDemandRelayContext(options = {}) {
  assertCommandRelayStateDirForTests(options);
  const snapshotPath = options.snapshotPath;
  const paths = resolveOnDemandPaths(snapshotPath);
  const dryRun = options.dryRun ?? false;
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? (() => {});
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
    rateLimitGate,
    quotaTelemetryStore,
    now,
    dryRun,
    log: (line) => log(line),
    apiCallLog: options.apiCallLog,
    transactionId: options.transactionId,
  };

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
  });

  return {
    paths,
    dryRun,
    now,
    log,
    rateLimitGate,
    quotaConsoleMonitor,
    briefingWatcher,
    commandWatcher: sidecar.commandWatcher,
    publisher,
    apiCallLog: options.apiCallLog ?? null,
  };
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
    return { ok: false, reason: message };
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
    return { ok: false, reason: 'gh_not_authenticated' };
  }
  try {
    const result = await publisher.publishRelayState(relay);
    return { ok: true, skipped: Boolean(result && result.skipped) };
  } catch (error) {
    return { ok: false, reason: error.message || String(error), code: error.code };
  }
}

async function runSendOnce(ctx, pending = null) {
  const { briefingWatcher, paths, log } = ctx;
  const sendScope = pending && pending.send_scope ? pending.send_scope : 'tactical';

  if (sendScope === 'strategic') {
    const readiness = assessStrategicSendReadiness(paths);
    if (!readiness.ok) {
      return { phase: SEND_PHASE.NOT_READY, message: readiness.message };
    }
    const direct = await publishSnapshotDirect(ctx, pending);
    if (ctx.quotaConsoleMonitor && typeof ctx.quotaConsoleMonitor.tick === 'function') {
      ctx.quotaConsoleMonitor.tick();
    }
    if (!direct.ok) {
      if (direct.code === 'RATE_LIMIT') {
        return { phase: SEND_PHASE.FAILED, message: direct.reason || 'Rate limited.' };
      }
      return { phase: SEND_PHASE.FAILED, message: direct.reason || 'Publish failed.' };
    }
    return {
      phase: SEND_PHASE.SENT,
      message: direct.skipped ? 'Published (remote matched request).' : 'Snapshot published.',
    };
  }

  let request;
  try {
    request = briefingWatcher.readRequest();
  } catch {
    request = null;
  }
  const expectedBriefingId = pending && pending.briefing_request_id ? pending.briefing_request_id : null;
  if (request && expectedBriefingId && request.request_id !== expectedBriefingId) {
    return { phase: SEND_PHASE.FAILED, message: 'Briefing request superseded; retry SEND.' };
  }

  if (request && (!expectedBriefingId || request.request_id === expectedBriefingId)) {
    await briefingWatcher._pollOnce();
    if (ctx.quotaConsoleMonitor && typeof ctx.quotaConsoleMonitor.tick === 'function') {
      ctx.quotaConsoleMonitor.tick();
    }
    const ack = readJsonIfExists(paths.briefingAck);
    if (briefingAckIndicatesSent(ack) && (!expectedBriefingId || ack.value.request_id === expectedBriefingId)) {
      return { phase: SEND_PHASE.SENT, message: ack.value.message || 'Briefing published.' };
    }
    if (ack && ack.value && ack.value.status === 'error') {
      return { phase: SEND_PHASE.FAILED, message: ack.value.message || 'Briefing publish failed.' };
    }
    if (ctx.dryRun) {
      return { phase: SEND_PHASE.SENT, message: 'Dry-run briefing publish.' };
    }
  }

  const direct = await publishSnapshotDirect(ctx, pending);
  if (ctx.quotaConsoleMonitor && typeof ctx.quotaConsoleMonitor.tick === 'function') {
    ctx.quotaConsoleMonitor.tick();
  }
  if (!direct.ok) {
    if (direct.code === 'RATE_LIMIT') {
      return { phase: SEND_PHASE.FAILED, message: direct.reason || 'Rate limited.' };
    }
    return { phase: SEND_PHASE.FAILED, message: direct.reason || 'Publish failed.' };
  }
  return {
    phase: SEND_PHASE.SENT,
    message: direct.skipped ? 'Published (remote matched request).' : 'Snapshot published.',
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

async function runRetrieveOnce(ctx, options = {}) {
  const { commandWatcher, paths } = ctx;
  const transactionId = options.transactionId ?? options.request_id ?? null;
  commandWatcher.beginRetrieveTransaction(transactionId);

  const localBefore = readJsonIfExists(paths.localRelay.command);
  const hadInbox = Boolean(localBefore && localBefore.value);

  await commandWatcher._pollOnce();
  if (ctx.quotaConsoleMonitor && typeof ctx.quotaConsoleMonitor.tick === 'function') {
    ctx.quotaConsoleMonitor.tick();
  }

  const localAfterFirst = readJsonIfExists(paths.localRelay.command);
  const deliveredNow = Boolean(
    !hadInbox
    && localAfterFirst
    && localAfterFirst.value
    && localAfterFirst.value.command_id,
  );

  const openResult = readJsonIfExists(paths.localRelay.result);
  const needsEngine = deliveredNow
    || (localAfterFirst && localAfterFirst.value && openResult && openResult.value
      && !isTerminalStatus(openResult.value.status));

  if (needsEngine) {
    const terminal = await waitForLocalTerminalResult(paths.localRelay.result, {
      maxWaitMs: options.localWaitMs,
      pollMs: options.localPollMs,
      now: ctx.now,
      existsSync: options.existsSync,
      readFileSync: options.readFileSync,
    });
    if (terminal && terminal.command_id) {
      commandWatcher._noteRetrieveCompletedExecution();
    }
  }

  const snapAfterFirst = commandWatcher.getLastRetrievePollSnapshot();
  const needsSecondPoll = Boolean(needsEngine || snapAfterFirst?.needsSecondPoll);

  if (needsSecondPoll) {
    await commandWatcher._pollOnce();
    if (ctx.quotaConsoleMonitor && typeof ctx.quotaConsoleMonitor.tick === 'function') {
      ctx.quotaConsoleMonitor.tick();
    }
  }

  const tx = commandWatcher.getRetrieveTransactionState();
  if (tx && (tx.deliveredCommandId || tx.publishedResult || tx.completedExecution)) {
    return { phase: RETRIEVE_PHASE.COMPLETED, message: 'Retrieve complete.' };
  }

  return { phase: RETRIEVE_PHASE.NO_NEW_ORDERS, message: 'No new orders.' };
}

function isNonTerminalUiPhase(phase) {
  return phase === SEND_PHASE.SENDING
    || phase === RETRIEVE_PHASE.RETRIEVING;
}

async function processPendingRequest(ctx, io = {}) {
  const { paths } = ctx;
  const pending = readJsonIfExists(paths.requestPath, io);
  if (!pending || !pending.value || pending.value.status !== 'pending') {
    return { processed: false };
  }

  const { request_id: requestId, action } = pending.value;
  const writeStatusFn = (payload) => writeStatus(paths.statusPath, payload, io);

  writeStatusFn({
    request_id: requestId,
    action,
    phase: action === 'send' ? SEND_PHASE.SENDING : RETRIEVE_PHASE.RETRIEVING,
    message: action === 'send' ? 'Sending…' : 'Retrieving…',
    updated_at_ms: ctx.now(),
    terminal: false,
  });

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
  }

  writeStatusFn({
    request_id: requestId,
    action,
    phase: outcome.phase,
    message: outcome.message || '',
    updated_at_ms: ctx.now(),
    terminal: !isNonTerminalUiPhase(outcome.phase),
  });

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

  return { processed: true, outcome };
}

function createOnDemandRelayDaemon(options = {}) {
  const snapshotPath = options.snapshotPath;
  const pollMs = options.pollIntervalMs ?? DEFAULT_LOCAL_DAEMON_POLL_MS;
  const ctx = createOnDemandRelayContext(options);
  let running = false;
  let timer = null;
  let inFlight = false;

  const tick = async () => {
    if (!running || inFlight) {
      return;
    }
    inFlight = true;
    try {
      await processPendingRequest(ctx, options.io);
    } finally {
      inFlight = false;
      if (ctx.quotaConsoleMonitor && typeof ctx.quotaConsoleMonitor.tick === 'function') {
        ctx.quotaConsoleMonitor.tick();
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
      const loop = () => {
        if (!running) {
          return;
        }
        tick().finally(() => {
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
  createGhApiCallLog,
};
