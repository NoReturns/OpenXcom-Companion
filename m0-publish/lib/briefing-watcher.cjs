'use strict';

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { parseBriefingRequestJson, BriefingRequestError } = require('./briefing-request.cjs');
const { verifyBriefingSnapshot, BriefingSnapshotError } = require('./briefing-snapshot.cjs');
const { buildRelayPayload } = require('./tactical-publish.cjs');
const { tryAttachDropOutcomeBriefToRelayOptions } = require('./drop-result-ground-placement.cjs');
const {
  loadJournal,
  persistJournal,
  getRecord,
  isTerminalRecord,
  markRecord,
} = require('./briefing-journal.cjs');
const { writeBriefingAckAtomic } = require('./briefing-ack.cjs');
const { writeTacticalPublicationConfirmAtomic } = require('./tactical-publication-confirm.cjs');
const {
  NOTIFICATION_CODES,
  buildNotification,
} = require('./companion-relay-notify.cjs');
const {
  publishRelayWithManualFallback,
  BRIEFING_ACK_STATUS_MANUAL_UPLOAD_REQUIRED,
  BRIEFING_ACK_STATUS_DEFERRED,
  JOURNAL_STATUS_MANUAL_UPLOAD_REQUIRED,
  manualUploadRequiredAckMessage,
  writeDeferredBriefingAck,
} = require('./briefing-relay-publish.cjs');
const { basenameArtifact } = require('./companion-briefing-diagnostics.cjs');

const DEFAULT_POLL_MS = 1000;

class BriefingWatcher {
  constructor(options) {
    this.requestPath = options.requestPath;
    this.snapshotPath = options.snapshotPath;
    this.stateDir = options.stateDir;
    this.ackDir = options.ackDir ?? path.dirname(options.requestPath);
    this.dryRun = options.dryRun;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.publishRelayState = options.publishRelayState;
    this.log = options.log ?? ((line) => console.log(line));
    this.now = options.now ?? (() => Date.now());
    this.readFileSync = options.readFileSync ?? fs.readFileSync;
    this.existsSync = options.existsSync ?? fs.existsSync;
    this.signal = options.signal;
    this.notify = options.notify;
    this.rateLimitGate = options.rateLimitGate ?? null;
    this.githubQuotaMonitor = options.githubQuotaMonitor ?? null;
    this.manualUploadIo = options.manualUploadIo ?? null;
    this.briefingDiagnostics = options.briefingDiagnostics ?? null;

    this.running = false;
    this.publishInFlight = false;
    this.pendingRequestId = null;
    this._timer = null;
    this._loggedTerminal = new Set();

    if (this.signal) {
      this.signal.addEventListener('abort', () => this.stop(), { once: true });
    }
  }

  readRequestText() {
    if (!this.existsSync(this.requestPath)) {
      return null;
    }
    return this.readFileSync(this.requestPath, 'utf8');
  }

  readRequest() {
    const text = this.readRequestText();
    if (text === null) {
      return null;
    }
    return parseBriefingRequestJson(text);
  }

  writeAck(ack) {
    writeBriefingAckAtomic(this.ackDir, {
      ...ack,
      acked_at: new Date(this.now()).toISOString(),
    });
  }

  _emitBriefingPublished(request, relay, verifiedDigest, skippedRemote) {
    if (typeof this.notify !== 'function') {
      return;
    }
    const binding = relay.commandBinding || {};
    this.notify(buildNotification(NOTIFICATION_CODES.BRIEFING_PUBLISHED, {
      request_id: request.request_id,
      session_id: request.session_id,
      turn: request.turn,
      state_version: binding.state_version,
      remote_sha256: verifiedDigest,
      message: skippedRemote ? 'skipped_unchanged' : (this.dryRun ? 'dry_run' : 'published'),
    }));
  }

  async _pollOnce() {
    let request;
    try {
      request = this.readRequest();
    } catch (error) {
      if (error instanceof BriefingRequestError) {
        this.log(`Briefing request rejected: ${error.message}`);
      } else {
        this.log(`Briefing request read error: ${error.message || String(error)}`);
      }
      return;
    }
    if (!request) {
      return;
    }

    let journal;
    try {
      journal = loadJournal(this.stateDir, this.readFileSync, this.existsSync);
    } catch (error) {
      this.log(`Journal error: ${error.message || String(error)}`);
      return;
    }

    const existing = getRecord(journal, request.request_id);
    if (isTerminalRecord(existing)) {
      if (!this._loggedTerminal.has(request.request_id)) {
        this.log(`Request ${request.request_id.slice(0, 8)} already terminal (${existing.status}); skipping.`);
        this._loggedTerminal.add(request.request_id);
      }
      return;
    }

    if (this.publishInFlight) {
      if (this.pendingRequestId !== request.request_id) {
        this.log(`Latest request ${request.request_id.slice(0, 8)} waiting (in flight for ${String(this.pendingRequestId).slice(0, 8)}).`);
      }
      return;
    }

    this.publishInFlight = true;
    this.pendingRequestId = request.request_id;
    const capturedRequestId = request.request_id;

    try {
      await this._processRequest(request, journal, capturedRequestId);
    } finally {
      this.publishInFlight = false;
      this.pendingRequestId = null;
    }
  }

  async _processRequest(request, journal, capturedRequestId) {
    this.briefingDiagnostics?.emit({
      outcome: 'received',
      request_id: request.request_id,
      turn: request.turn,
    });

    let snapshotBytes;
    try {
      snapshotBytes = this.readFileSync(this.snapshotPath);
      if (!Buffer.isBuffer(snapshotBytes)) {
        snapshotBytes = Buffer.from(snapshotBytes, 'utf8');
      } else {
        snapshotBytes = Buffer.from(snapshotBytes);
      }
    } catch (error) {
      this.log(`Snapshot read failed: ${error.message || String(error)}`);
      return;
    }

    let verified;
    try {
      verified = verifyBriefingSnapshot({ request, snapshotBytes, yaml: YAML });
    } catch (error) {
      const code = error instanceof BriefingSnapshotError ? error.code : 'SNAPSHOT_ERROR';
      const message = error.message || String(error);
      this.log(`Briefing verification failed (${code}): ${message}`);
      markRecord(journal, request.request_id, {
        status: 'failed',
        terminal: true,
        error_code: code,
        message,
      });
      persistJournal(this.stateDir, journal);
      this.writeAck({
        request_id: request.request_id,
        status: 'error',
        snapshot_id: null,
        error_code: code,
        message,
      });
      this.briefingDiagnostics?.emit({
        outcome: 'failed',
        request_id: request.request_id,
        error_code: code,
        reason: message,
        turn: request.turn,
      });
      return;
    }

    const current = this.readRequest();
    if (!current || current.request_id !== capturedRequestId) {
      this.log(`Request ${capturedRequestId.slice(0, 8)} superseded before publish; aborting without publish.`);
      return;
    }
    if (current.snapshot_sha256 !== request.snapshot_sha256) {
      this.log(`Request ${capturedRequestId.slice(0, 8)} changed during processing; aborting without publish.`);
      return;
    }

    const publishedAt = new Date(this.now()).toISOString();
    const relayOptions = { snapshotSha256: verified.digest, snapshotPath: this.snapshotPath };
    tryAttachDropOutcomeBriefToRelayOptions(relayOptions, {
      snapshotPath: this.snapshotPath,
      tactical: verified.tactical,
      digest: verified.digest,
      existsSync: this.existsSync,
      readFileSync: this.readFileSync,
    });
    const relay = buildRelayPayload(verified.tactical, publishedAt, {
      request_id: request.request_id,
      session_id: request.session_id,
      turn: request.turn,
    }, relayOptions);

    if (this.dryRun) {
      this.log(`Dry-run publish ${relay.snapshot_id.slice(0, 12)} for request ${request.request_id.slice(0, 8)}.`);
      this.writeAck({
        request_id: request.request_id,
        status: 'dry_run',
        snapshot_id: relay.snapshot_id,
        snapshot_sha256: verified.digest,
        message: 'Validated; GitHub publish not attempted (dry-run).',
      });
      this._emitBriefingPublished(request, relay, verified.digest, false);
      return;
    }

    if (this.rateLimitGate) {
      try {
        this.rateLimitGate.assertOpenOrThrow(this.now());
      } catch (error) {
        if (error.code === 'RATE_LIMIT') {
          const deferMessage = error.message || 'GitHub rate limit cooldown';
          writeDeferredBriefingAck((ack) => this.writeAck(ack), request, deferMessage, error.code);
          this.briefingDiagnostics?.emit({
            outcome: 'deferred',
            request_id: request.request_id,
            error_code: error.code,
            reason: deferMessage,
            turn: request.turn,
          });
          this.log(`Briefing publish deferred: ${deferMessage}.`);
          return;
        }
        throw error;
      }
    }

    this.briefingDiagnostics?.emit({
      outcome: 'sending',
      request_id: request.request_id,
      turn: request.turn,
    });

    const publishOutcome = await publishRelayWithManualFallback({
      relay,
      publishRelayState: (payload) => this.publishRelayState(payload),
      snapshotDir: this.ackDir,
      requestId: request.request_id,
      sessionId: request.session_id,
      turn: request.turn,
      snapshotSha256: verified.digest,
      now: this.now,
      log: (line) => this.log(line),
      notify: this.notify,
      manualUploadIo: this.manualUploadIo ?? undefined,
      briefingDiagnostics: this.briefingDiagnostics,
      writeDeferredAck: (message, code) => writeDeferredBriefingAck(
        (ack) => this.writeAck(ack),
        request,
        message,
        code,
      ),
    });

    if (publishOutcome.kind === 'defer') {
      this.log(`Briefing publish deferred: ${publishOutcome.error.message || 'GitHub rate limit cooldown'}.`);
      return;
    }

    if (publishOutcome.kind === 'hard_error') {
      const code = publishOutcome.code;
      markRecord(journal, request.request_id, {
        status: 'failed',
        terminal: false,
        error_code: code,
        message: publishOutcome.error.message,
      });
      persistJournal(this.stateDir, journal);
      this.writeAck({
        request_id: request.request_id,
        status: 'error',
        snapshot_id: relay.snapshot_id,
        error_code: code,
        message: publishOutcome.error.message,
      });
      this.briefingDiagnostics?.emit({
        outcome: 'failed',
        request_id: request.request_id,
        error_code: code,
        reason: publishOutcome.error.message,
        turn: request.turn,
      });
      this.log(`GitHub error (${code}): ${publishOutcome.error.message}`);
      if (typeof this.notify === 'function') {
        this.notify(buildNotification(NOTIFICATION_CODES.RELAY_DISCONNECTED, {
          channel: 'briefing',
          reason_code: code,
          message: publishOutcome.error.message,
        }));
      }
      this.stop(true);
      return;
    }

    if (publishOutcome.kind === 'retryable') {
      this.log(`Publish failed (retryable): ${publishOutcome.error.message || String(publishOutcome.error)}`);
      return;
    }

    if (publishOutcome.kind === 'manual_export_failed') {
      const code = publishOutcome.errorCode ?? 'MANUAL_EXPORT_WRITE_FAILED';
      markRecord(journal, request.request_id, {
        status: 'failed',
        terminal: true,
        error_code: code,
        message: publishOutcome.writeError?.message || 'Manual artifact write failed.',
      });
      persistJournal(this.stateDir, journal);
      this.writeAck({
        request_id: request.request_id,
        status: 'error',
        snapshot_id: relay.snapshot_id,
        error_code: code,
        message: publishOutcome.writeError?.message || 'Manual artifact write failed.',
      });
      this.briefingDiagnostics?.emit({
        outcome: 'failed',
        request_id: request.request_id,
        error_code: code,
        reason: publishOutcome.writeError?.message || 'Manual artifact write failed.',
        turn: request.turn,
      });
      return;
    }

    if (publishOutcome.kind === 'manual_upload_required') {
      markRecord(journal, request.request_id, {
        status: JOURNAL_STATUS_MANUAL_UPLOAD_REQUIRED,
        terminal: true,
        snapshot_id: relay.snapshot_id,
        snapshot_sha256: verified.digest,
        manual_artifact_sha256: publishOutcome.exportResult.sha256,
      });
      persistJournal(this.stateDir, journal);
      const artifactPath = publishOutcome.exportResult.path;
      this.writeAck({
        request_id: request.request_id,
        status: BRIEFING_ACK_STATUS_MANUAL_UPLOAD_REQUIRED,
        snapshot_id: relay.snapshot_id,
        snapshot_sha256: verified.digest,
        error_code: 'RELAY_SHRINK_EXHAUSTED',
        artifact_path: artifactPath,
        artifact_sha256: publishOutcome.exportResult.sha256,
        message: manualUploadRequiredAckMessage(artifactPath),
      });
      this.briefingDiagnostics?.emit({
        outcome: 'manual_upload_required',
        request_id: request.request_id,
        error_code: 'RELAY_SHRINK_EXHAUSTED',
        artifact_filename: basenameArtifact(artifactPath),
        turn: request.turn,
      });
      return;
    }

    const after = this.readRequest();
    if (!after || after.request_id !== capturedRequestId) {
      this.log(`Request ${capturedRequestId.slice(0, 8)} superseded after GitHub response; journal not updated.`);
      return;
    }

    const result = publishOutcome.result;
    if (publishOutcome.kind === 'skipped') {
      markRecord(journal, request.request_id, {
        status: 'published',
        terminal: true,
        snapshot_id: relay.snapshot_id,
        snapshot_sha256: verified.digest,
        skipped_remote: true,
      });
      persistJournal(this.stateDir, journal);
      this.writeAck({
        request_id: request.request_id,
        status: 'skipped_unchanged',
        snapshot_id: relay.snapshot_id,
        snapshot_sha256: verified.digest,
        message: 'Remote state already reflects this request_id and snapshot_id.',
      });
      writeTacticalPublicationConfirmAtomic(this.ackDir, {
        session_id: request.session_id,
        turn: request.turn,
        state_version: verified.tactical?.eventLog?.latestSeq ?? 0,
        snapshot_sha256: verified.digest,
        source: 'manual_send',
        status: 'skipped_unchanged',
      });
      this.log(`Published skipped (remote unchanged) for request ${request.request_id.slice(0, 8)}.`);
      this.briefingDiagnostics?.emit({
        outcome: 'skipped_unchanged',
        request_id: request.request_id,
        turn: request.turn,
      });
      this._emitBriefingPublished(request, relay, verified.digest, true);
      return;
    }

    markRecord(journal, request.request_id, {
      status: 'published',
      terminal: true,
      snapshot_id: relay.snapshot_id,
      snapshot_sha256: verified.digest,
    });
    persistJournal(this.stateDir, journal);
    this.writeAck({
      request_id: request.request_id,
      status: 'published',
      snapshot_id: relay.snapshot_id,
      snapshot_sha256: verified.digest,
      message: 'GitHub state.json updated.',
    });
    writeTacticalPublicationConfirmAtomic(this.ackDir, {
      session_id: request.session_id,
      turn: request.turn,
      state_version: verified.tactical?.eventLog?.latestSeq ?? 0,
      snapshot_sha256: verified.digest,
      source: 'manual_send',
      status: 'published',
    });
    this.log(`Published ${relay.snapshot_id.slice(0, 12)} for request ${request.request_id.slice(0, 8)}.`);
    this.briefingDiagnostics?.emit({
      outcome: 'published',
      request_id: request.request_id,
      turn: request.turn,
    });
    this._emitBriefingPublished(request, relay, verified.digest, false);
  }

  tick() {
    if (!this.running || this.signal?.aborted) {
      return;
    }
    this._pollOnce()
      .catch((error) => {
        this.log(`Briefing watcher error: ${error.message || String(error)}`);
      })
      .finally(() => {
        if (this.githubQuotaMonitor && typeof this.githubQuotaMonitor.tick === 'function') {
          this.githubQuotaMonitor.tick();
        }
      });
  }

  start() {
    if (this.running) {
      return;
    }
    this.running = true;
    this.log(`Briefing watcher started (${this.dryRun ? 'dry-run' : 'publish'}).`);
    this.tick();
    this._timer = setInterval(() => this.tick(), this.pollIntervalMs);
  }

  stop(failed = false) {
    const wasRunning = this.running;
    this.running = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (wasRunning || failed) {
      this.log(failed ? 'Briefing watcher stopped (error).' : 'Briefing watcher stopped.');
    }
  }
}

module.exports = {
  BriefingWatcher,
  DEFAULT_POLL_MS,
};
