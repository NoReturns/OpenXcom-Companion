'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  createRelayContentClient,
  createRelayPublisher,
  RELAY_CONTENT_PATHS,
  DEFAULT_COMMAND_MAX_BYTES,
  DEFAULT_RESULT_MAX_BYTES,
} = require('./github-relay.cjs');
const { assertRelayOptionsMatchContract } = require('./relay-isolation-config.cjs');
const { redactSecrets } = require('./on-demand-daemon-diagnostics.cjs');

const TRANSACTIONS_FILENAME = 'companion-on-demand-relay-transactions.jsonl';
const MAX_TRANSACTION_JSONL_LINES = 100;

function resolveRelayTransactionsPath(snapshotDir) {
  return path.join(snapshotDir, TRANSACTIONS_FILENAME);
}

function appendTransactionLine(snapshotDir, payload, io = {}) {
  if (!snapshotDir) {
    return;
  }
  const writeFileSync = io.writeFileSync ?? fs.writeFileSync;
  const readFileSync = io.readFileSync ?? fs.readFileSync;
  const existsSync = io.existsSync ?? fs.existsSync;
  const logPath = resolveRelayTransactionsPath(snapshotDir);
  const line = `${JSON.stringify(payload)}\n`;
  let prior = '';
  if (existsSync(logPath)) {
    try {
      prior = readFileSync(logPath, 'utf8');
    } catch {
      prior = '';
    }
  }
  const lines = (prior + line).split('\n').filter(Boolean);
  const trimmed = lines.length > MAX_TRANSACTION_JSONL_LINES
    ? lines.slice(-MAX_TRANSACTION_JSONL_LINES)
    : lines;
  writeFileSync(logPath, `${trimmed.join('\n')}\n`, 'utf8');
}

function snapshotQuota(store) {
  if (!store || typeof store.getSnapshot !== 'function') {
    return null;
  }
  const s = store.getSnapshot();
  return {
    core_limit: s.limit,
    core_remaining: s.remaining,
    core_used: s.used,
    core_resource: s.resource,
    captured_at_ms: s.capturedAtMs,
  };
}

function quotaUsedDelta(before, after) {
  if (!before || !after) {
    return null;
  }
  if (typeof before.core_used === 'number' && typeof after.core_used === 'number') {
    return after.core_used - before.core_used;
  }
  return null;
}

function summarizeGhApiCalls(apiCallLog) {
  if (!apiCallLog || !Array.isArray(apiCallLog.entries)) {
    return { invocation_count: 0, invocations: [] };
  }
  const invocations = apiCallLog.entries.map((entry) => ({
    method: entry.method,
    endpoint: entry.endpoint,
    at_ms: entry.at_ms,
    ...(entry.http_status != null ? { http_status: entry.http_status } : {}),
    ...(entry.outcome ? { outcome: entry.outcome } : {}),
  }));
  return {
    invocation_count: invocations.length,
    invocations,
  };
}

function createRelayTransactionTrace(options = {}) {
  const requestId = options.requestId;
  const action = options.action;
  const snapshotDir = options.snapshotDir;
  const now = options.now ?? (() => Date.now());
  const getQuotaStore = options.getQuotaStore ?? (() => null);
  const io = options.io ?? {};
  const startedAtMs = now();
  const events = [];
  const quotaAtStart = snapshotQuota(getQuotaStore());

  function record(phase, detail = {}) {
    events.push({
      phase,
      at_ms: now(),
      ...detail,
    });
  }

  function hasPhase(phase) {
    return events.some((event) => event.phase === phase);
  }

  function countPhases(phase) {
    return events.filter((event) => event.phase === phase).length;
  }

  function retrieveDiagnostics(retrieveTx) {
    if (!retrieveTx || typeof retrieveTx !== 'object') {
      return null;
    }
    const commandId = retrieveTx.deliveredCommandId
      || retrieveTx.publishedCommandId
      || null;
    const sidecarRejectCode = retrieveTx.sidecarRejectCode || null;
    if (!commandId && !sidecarRejectCode) {
      return null;
    }
    return {
      ...(commandId ? { command_id: commandId } : {}),
      ...(sidecarRejectCode ? { sidecar_reject_code: sidecarRejectCode } : {}),
    };
  }

  function finish(summary = {}) {
    const finishedAtMs = now();
    const quotaAtEnd = snapshotQuota(getQuotaStore());
    const gh = summarizeGhApiCalls(summary.apiCallLog);
    const internalPollStarts = events.filter((event) => event.phase === 'internal_poll_start').length;
    const pollEndWithRetirement = events.some(
      (event) => event.phase === 'internal_poll_end' && event.pending_retirement,
    );
    const flags = {
      internal_poll_count: internalPollStarts,
      saw_second_poll: internalPollStarts >= 2
        || events.some((event) => event.phase === 'second_poll_scheduled'
          || event.phase === 'follow_up_poll_scheduled'),
      saw_engine_wait_timeout: events.some((event) => event.phase === 'local_engine_wait_timeout'),
      saw_pending_retirement_on_poll: pollEndWithRetirement,
      ui_status_terminal_on_complete: summary.uiStatusTerminal ?? null,
      ui_may_show_completed_until_next_action: Boolean(
        summary.uiStatusTerminal
        && (summary.outcomePhase === 'completed'
          || summary.outcomePhase === 'sent'),
      ),
      ui_status_preserved: summary.uiStatusPreserved === true,
      busy_rejects_logged_as: 'relay_button_enqueue',
    };
    const retrieveDiag = retrieveDiagnostics(summary.retrieveTx);
    const payload = {
      kind: 'relay_transaction_complete',
      at_ms: finishedAtMs,
      request_id: requestId,
      action,
      started_at_ms: startedAtMs,
      duration_ms: finishedAtMs - startedAtMs,
      outcome_phase: summary.outcomePhase ?? null,
      outcome_message: summary.outcomeMessage
        ? redactSecrets(String(summary.outcomeMessage))
        : undefined,
      ui_status_terminal: summary.uiStatusTerminal ?? null,
      retrieve_tx: summary.retrieveTx ?? undefined,
      poll_snapshot: summary.pollSnapshot ?? undefined,
      ...(retrieveDiag ?? {}),
      flags,
      events,
      github_api: {
        invocation_count: gh.invocation_count,
        invocations: gh.invocations,
      },
      github_quota: {
        at_start: quotaAtStart,
        at_end: quotaAtEnd,
        core_used_delta: quotaUsedDelta(quotaAtStart, quotaAtEnd),
      },
    };
    appendTransactionLine(snapshotDir, payload, io);
    return payload;
  }

  record('transaction_open', { action });

  return {
    requestId,
    action,
    record,
    finish,
    hasPhase,
    countPhases,
  };
}

function recordButtonEnqueue(snapshotDir, payload, io = {}) {
  appendTransactionLine(snapshotDir, {
    kind: 'relay_button_enqueue',
    at_ms: Date.now(),
    ...payload,
  }, io);
}

function assertRelayScopeBinding(ctx, relayOpts, scope) {
  const contract = ctx.relayIsolationContract ?? null;
  const requireIsolation = ctx.requireRelayIsolation === true;

  if (requireIsolation && !contract) {
    const err = new Error(
      'RELAY_ISOLATION_CONTRACT_VIOLATION: requireRelayIsolation is set but relayIsolationContract is missing on context',
    );
    err.code = 'RELAY_ISOLATION_CONTRACT_VIOLATION';
    throw err;
  }

  if (scope.preserveWatcherIo) {
    if (requireIsolation && contract) {
      assertRelayOptionsMatchContract(ctx.relayOptions ?? {}, contract, 'bound context (preserveWatcherIo)');
    }
    return;
  }

  if (contract || requireIsolation) {
    if (!ctx.relayOptions || typeof ctx.relayOptions !== 'object') {
      const err = new Error(
        'RELAY_ISOLATION_CONTRACT_VIOLATION: isolated relay context missing relayOptions during client reconstruction',
      );
      err.code = 'RELAY_ISOLATION_CONTRACT_VIOLATION';
      throw err;
    }
    assertRelayOptionsMatchContract(relayOpts, contract ?? ctx.relayIsolationContract, 'transaction-scope rebind');
  }
}

function bindTransactionScopeToContext(ctx, scope) {
  const watcher = ctx.commandWatcher;
  if (scope.preserveWatcherIo) {
    assertRelayScopeBinding(ctx, ctx.relayOptions ?? {}, scope);
    const savedTrace = watcher.transactionTrace;
    watcher.transactionTrace = scope.trace;
    ctx.transactionTrace = scope.trace;
    return () => {
      watcher.transactionTrace = savedTrace;
      ctx.transactionTrace = null;
    };
  }

  const relayOpts = {
    ...(ctx.relayOptions ?? {}),
    rateLimitGate: ctx.rateLimitGate,
    quotaTelemetryStore: scope.quotaTelemetryStore,
    now: ctx.now,
    apiCallLog: scope.apiCallLog,
    transactionId: scope.requestId,
    dryRun: ctx.dryRun,
    execFileSync: scope.execFileSync,
  };
  assertRelayScopeBinding(ctx, relayOpts, scope);
  const content = createRelayContentClient(relayOpts);
  const publisher = createRelayPublisher(relayOpts);
  const paths = content.paths;

  const saved = {
    readRemoteCommand: watcher.readRemoteCommand,
    publishRemoteResult: watcher.publishRemoteResult,
    fetchRemoteResult: watcher.fetchRemoteResult,
    retireRemoteCommand: watcher.retireRemoteCommand,
    publishRemoteRelayState: watcher.publishRemoteRelayState,
    transactionTrace: watcher.transactionTrace,
    publisher: ctx.publisher,
  };

  watcher.readRemoteCommand = () => Promise.resolve(
    content.readFile(paths.tacticalCommand, DEFAULT_COMMAND_MAX_BYTES),
  );
  watcher.publishRemoteResult = async (result, commandId) => {
    await content.publishFile(
      paths.tacticalResult,
      result,
      `M1 tactical result ${commandId.slice(0, 8)} ${result.status}`,
      DEFAULT_RESULT_MAX_BYTES,
    );
  };
  watcher.fetchRemoteResult = async () => {
    const remote = content.readFile(paths.tacticalResult, DEFAULT_RESULT_MAX_BYTES);
    if (!remote) {
      return null;
    }
    return { value: JSON.parse(remote.text), sha: remote.sha };
  };
  watcher.retireRemoteCommand = async (expectedSha, commandId) => {
    await content.deleteFile(
      paths.tacticalCommand,
      expectedSha,
      `M1 retire tactical command ${commandId.slice(0, 8)}`,
    );
  };
  watcher.publishRemoteRelayState = (relay) => publisher.publishRelayState(relay);
  watcher.transactionTrace = scope.trace;
  ctx.publisher = publisher;
  ctx.transactionTrace = scope.trace;

  return () => {
    watcher.readRemoteCommand = saved.readRemoteCommand;
    watcher.publishRemoteResult = saved.publishRemoteResult;
    watcher.fetchRemoteResult = saved.fetchRemoteResult;
    watcher.retireRemoteCommand = saved.retireRemoteCommand;
    watcher.publishRemoteRelayState = saved.publishRemoteRelayState;
    watcher.transactionTrace = saved.transactionTrace;
    ctx.publisher = saved.publisher;
    ctx.transactionTrace = null;
  };
}

module.exports = {
  TRANSACTIONS_FILENAME,
  MAX_TRANSACTION_JSONL_LINES,
  resolveRelayTransactionsPath,
  createRelayTransactionTrace,
  recordButtonEnqueue,
  bindTransactionScopeToContext,
  appendTransactionLine,
  snapshotQuota,
  quotaUsedDelta,
  summarizeGhApiCalls,
};
