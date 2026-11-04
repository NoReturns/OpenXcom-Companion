'use strict';

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { ValidationError } = require('./tactical-publish.cjs');
const {
  parseMoveCommand,
  validateMoveAgainstSnapshotFile,
  buildResultEnvelope,
  isTerminalStatus,
  canAcceptNewCommand,
} = require('./tactical-command.cjs');
const {
  loadCommandJournal,
  persistCommandJournal,
  getCommandRecord,
  isTerminalRelayRecord,
  markCommandRecord,
} = require('./command-journal.cjs');
const { evaluateRemoteCommandRetirement } = require('./command-relay-retirement.cjs');
const { tryPublishPostCommandTacticalState } = require('./post-command-tactical-publish.cjs');
const { writeJsonAtomic, writeTextAtomic, removeFileIfExists } = require('./local-atomic.cjs');
const {
  RELAY_CONTENT_PATHS,
  DEFAULT_COMMAND_MAX_BYTES,
  DEFAULT_RESULT_MAX_BYTES,
} = require('./github-relay.cjs');
const {
  NOTIFICATION_CODES,
  buildNotification,
  classifySidecarReject,
  notificationFromLocalResult,
  notificationFromMoveCommand,
} = require('./companion-relay-notify.cjs');

const DEFAULT_IDLE_POLL_MS = 5000;
const DEFAULT_ACTIVE_POLL_MS = 1000;
/** @deprecated use DEFAULT_IDLE_POLL_MS */
const DEFAULT_POLL_MS = DEFAULT_IDLE_POLL_MS;

const RETIREMENT_BACKOFF_BASE_MS = 30_000;
const RETIREMENT_BACKOFF_MAX_MS = 120_000;

function localRelayPaths(snapshotPath) {
  const dir = path.dirname(snapshotPath);
  return {
    command: path.join(dir, 'tactical-command.json'),
    result: path.join(dir, 'tactical-result.json'),
  };
}

function readJsonFileIfExists(filePath, existsSync, readFileSync) {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return { __parseError: true };
  }
}

function sidecarRejectEnvelope(command, rejectCode, publicReason) {
  const baseCommand = command && typeof command === 'object'
    ? command
    : {
      command_id: 'unknown',
      command_type: 'MOVE',
      session_id: '00000000000000000000000000000000',
      turn: 1,
    };
  return buildResultEnvelope(baseCommand, 'REJECTED', {
    public_reason: publicReason || rejectCode,
    sidecar_reject_code: rejectCode,
  });
}

class CommandRelayWatcher {
  constructor(options) {
    this.snapshotPath = options.snapshotPath;
    this.stateDir = options.stateDir;
    this.dryRun = options.dryRun;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_IDLE_POLL_MS;
    this.activePollIntervalMs = options.activePollIntervalMs ?? DEFAULT_ACTIVE_POLL_MS;
    this.rateLimitGate = options.rateLimitGate ?? null;
    this.readRemoteCommand = options.readRemoteCommand;
    this.publishRemoteResult = options.publishRemoteResult;
    this.log = options.log ?? ((line) => console.log(line));
    this.now = options.now ?? (() => Date.now());
    this.readFileSync = options.readFileSync ?? fs.readFileSync;
    this.existsSync = options.existsSync ?? fs.existsSync;
    this.writeFileSync = options.writeFileSync ?? fs.writeFileSync;
    this.renameSync = options.renameSync ?? fs.renameSync;
    this.unlinkSync = options.unlinkSync ?? fs.unlinkSync;
    this.fetchRemoteResult = options.fetchRemoteResult ?? null;
    this.retireRemoteCommand = options.retireRemoteCommand ?? null;
    this.publishRemoteRelayState = options.publishRemoteRelayState ?? null;
    this.signal = options.signal;
    this.notify = options.notify;
    this._relayReachable = true;
    this._lastRemoteCommandSha = null;
    this._loggedRetirementBlocked = new Set();

    this.local = localRelayPaths(this.snapshotPath);
    this.running = false;
    this._timer = null;
    this._inFlight = false;

    if (this.signal) {
      this.signal.addEventListener('abort', () => this.stop(), { once: true });
    }
  }

  loadJournal() {
    return loadCommandJournal(this.stateDir, this.readFileSync, this.existsSync);
  }

  persistJournal(journal) {
    persistCommandJournal(this.stateDir, journal, this.writeFileSync, this.renameSync);
  }

  _retirementBackoffMs(attempts) {
    const exponent = Math.min(Math.max(attempts - 1, 0), 2);
    return Math.min(RETIREMENT_BACKOFF_MAX_MS, RETIREMENT_BACKOFF_BASE_MS * (2 ** exponent));
  }

  _computePollIntervalMs(journal) {
    if (journal && journal.active && journal.active.command_id) {
      return this.activePollIntervalMs;
    }
    const localResult = this.readLocalResult();
    if (localResult && !localResult.__parseError) {
      const status = localResult.status;
      if (status === 'EXECUTING' || status === 'ACCEPTED') {
        return this.activePollIntervalMs;
      }
    }
    return this.pollIntervalMs;
  }

  _msUntilNextPoll(journal) {
    const interval = this._computePollIntervalMs(journal);
    const gateWait = this.rateLimitGate ? this.rateLimitGate.msUntilOpen(this.now()) : 0;
    return Math.max(interval, gateWait);
  }

  readLocalResult() {
    return readJsonFileIfExists(this.local.result, this.existsSync, this.readFileSync);
  }

  _emitNotify(event) {
    if (typeof this.notify === 'function' && event) {
      this.notify(event);
    }
  }

  _markRelayDisconnected(errorMessage) {
    if (this._relayReachable) {
      this._relayReachable = false;
      this._emitNotify(buildNotification(NOTIFICATION_CODES.RELAY_DISCONNECTED, {
        channel: 'command-relay',
        message: errorMessage,
      }));
    }
  }

  _markRelayReconnected() {
    if (!this._relayReachable) {
      this._relayReachable = true;
      this._emitNotify(buildNotification(NOTIFICATION_CODES.RELAY_RECONNECTED, {
        channel: 'command-relay',
      }));
    }
  }

  _notifyObservedLocalResult(resultValue) {
    if (!resultValue || resultValue.__parseError) {
      return;
    }
    const event = notificationFromLocalResult(resultValue);
    if (event) {
      this._emitNotify(event);
    }
  }

  async publishResult(result, commandId, journal) {
    const publishPostCommand = async () => {
      const record = getCommandRecord(journal, commandId);
      const outcome = await tryPublishPostCommandTacticalState({
        snapshotPath: this.snapshotPath,
        result,
        commandId,
        journal,
        record,
        dryRun: this.dryRun,
        publishRelayState: this.publishRemoteRelayState,
        log: (line) => this.log(line),
        readFileSync: this.readFileSync,
        existsSync: this.existsSync,
        now: this.now,
      });
      if (outcome.action === 'fail_closed') {
        const detail = outcome.message ? `: ${outcome.message}` : '';
        this.log(`Post-command tactical publish blocked (${outcome.reason}${detail}).`);
      }
      if (outcome.journal) {
        this.persistJournal(outcome.journal);
      }
    };

    if (!this.dryRun && this.fetchRemoteResult) {
      try {
        const remote = await this.fetchRemoteResult();
        const published = remote && remote.value;
        if (published
          && published.command_id === commandId
          && published.status === result.status) {
          markCommandRecord(journal, commandId, {
            phase: 'published_terminal',
            status: result.status,
            skipped_publish: true,
          });
          journal.active = null;
          this.persistJournal(journal);
          this.log(`Remote result already ${result.status} for ${commandId.slice(0, 8)}; skipping publish.`);
          await publishPostCommand();
          await this._maybeRetireRemoteCommand(journal, commandId, result);
          return;
        }
      } catch (error) {
        this.log(`Remote result probe failed: ${error.message || String(error)}`);
      }
    }
    if (this.dryRun) {
      this.log(`Dry-run would publish result for ${commandId.slice(0, 8)} status ${result.status}.`);
      markCommandRecord(journal, commandId, {
        phase: 'published_terminal',
        status: result.status,
        dry_run: true,
      });
      journal.active = null;
      this.persistJournal(journal);
      await publishPostCommand();
      await this._maybeRetireRemoteCommand(journal, commandId, result);
      return;
    }
    await this.publishRemoteResult(result, commandId);
    markCommandRecord(journal, commandId, {
      phase: 'published_terminal',
      status: result.status,
      published_at: new Date(this.now()).toISOString(),
    });
    journal.active = null;
    this.persistJournal(journal);
    this.log(`Published result ${commandId.slice(0, 8)} status ${result.status}.`);
    await publishPostCommand();
    await this._maybeRetireRemoteCommand(journal, commandId, result);
  }

  _reportRetirementBlocked(journal, commandId, record, decision) {
    const logKey = `${commandId}:${decision.reason || 'blocked'}`;
    if (!this._loggedRetirementBlocked.has(logKey)) {
      this._loggedRetirementBlocked.add(logKey);
      this.log(decision.operatorMessage || `Remote command retirement blocked (${decision.reason}).`);
    }
    if (!record.retirement_blocked_reason) {
      markCommandRecord(journal, commandId, {
        retirement_blocked_reason: decision.reason,
        retirement_operator_message: decision.operatorMessage,
      });
      this.persistJournal(journal);
    }
  }

  _markRetiredRemote(journal, commandId, patch = {}) {
    markCommandRecord(journal, commandId, {
      phase: 'retired_remote',
      remote_retired_at: new Date(this.now()).toISOString(),
      ...patch,
    });
    journal.active = null;
    this.persistJournal(journal);
  }

  async _loadRemoteRetirementContext() {
    let remoteCommand = null;
    try {
      remoteCommand = await this.readRemoteCommand();
    } catch (error) {
      throw error;
    }
    let remoteCommandValue = null;
    if (remoteCommand && remoteCommand.text) {
      try {
        remoteCommandValue = JSON.parse(remoteCommand.text);
      } catch {
        remoteCommandValue = null;
      }
    }
    let remoteResultValue = null;
    if (this.fetchRemoteResult) {
      try {
        const remoteResult = await this.fetchRemoteResult();
        remoteResultValue = remoteResult && remoteResult.value ? remoteResult.value : null;
      } catch (error) {
        throw error;
      }
    }
    return { remoteCommand, remoteCommandValue, remoteResultValue };
  }

  async _maybeRetireRemoteCommand(journal, commandId, result) {
    const record = getCommandRecord(journal, commandId);
    if (!record || record.phase !== 'published_terminal') {
      return;
    }
    if (!this.retireRemoteCommand && !this.dryRun) {
      return;
    }

    let context;
    try {
      context = await this._loadRemoteRetirementContext();
    } catch (error) {
      this.log(`Remote command retirement deferred: ${error.message || String(error)}`);
      return;
    }

    const decision = evaluateRemoteCommandRetirement({
      record,
      localResult: this.readLocalResult(),
      remoteCommandMeta: context.remoteCommand,
      remoteCommandValue: context.remoteCommandValue,
      remoteResultValue: context.remoteResultValue ?? result,
    });

    if (decision.action === 'skip') {
      return;
    }

    if (decision.action === 'fail_closed') {
      this._reportRetirementBlocked(journal, commandId, record, decision);
      return;
    }

    if (this.dryRun) {
      if (decision.action === 'mark_retired') {
        this.log(`Dry-run would mark remote command absent (retired) for ${commandId.slice(0, 8)}; journal unchanged.`);
      } else if (decision.action === 'delete') {
        this.log(`Dry-run would retire remote command ${commandId.slice(0, 8)}; journal unchanged.`);
      }
      return;
    }

    if (decision.action === 'mark_retired') {
      this._markRetiredRemote(journal, commandId, { retirement_reason: decision.reason });
      this.log(`Remote command already absent; marked retired for ${commandId.slice(0, 8)}.`);
      return;
    }

    if (decision.action === 'delete') {
      if (record.retirement_next_attempt_at) {
        const nextAt = Date.parse(record.retirement_next_attempt_at);
        if (Number.isFinite(nextAt) && this.now() < nextAt) {
          return;
        }
      }
    }

    try {
      await this.retireRemoteCommand(decision.deleteSha, commandId);
      this._markRetiredRemote(journal, commandId, {
        retired_remote_sha256: decision.deleteSha,
        retirement_delete_attempts: null,
        retirement_next_attempt_at: null,
      });
      this.log(`Retired remote command ${commandId.slice(0, 8)} on GitHub.`);
    } catch (error) {
      if (decision.action === 'delete') {
        const attempts = (record.retirement_delete_attempts ?? 0) + 1;
        markCommandRecord(journal, commandId, {
          retirement_delete_attempts: attempts,
          retirement_next_attempt_at: new Date(this.now() + this._retirementBackoffMs(attempts)).toISOString(),
        });
        this.persistJournal(journal);
      }
      this.log(`Remote command retirement failed: ${error.message || String(error)}`);
    }
  }

  async _retryPendingRemoteRetirements(journal) {
    const pending = Object.values(journal.records)
      .filter((record) => record && record.phase === 'published_terminal' && record.command_id);
    for (const record of pending) {
      const localResult = this.readLocalResult();
      const resultFromLocal = localResult && !localResult.__parseError && localResult.command_id === record.command_id
        ? localResult
        : { command_id: record.command_id, status: record.status };
      await this._maybeRetireRemoteCommand(journal, record.command_id, resultFromLocal);
    }
  }

  async rejectRemote(command, rejectCode, publicReason, journal, remoteSha) {
    const envelope = sidecarRejectEnvelope(command, rejectCode, publicReason);
    const commandId = envelope.command_id;
    const staleCode = classifySidecarReject(rejectCode, publicReason);
    this._emitNotify(buildNotification(staleCode, {
      command_id: command && command.command_id ? command.command_id : commandId,
      session_id: envelope.session_id,
      turn: envelope.turn,
      state_version: command && command.state_version,
      remote_sha256: remoteSha,
      reason_code: rejectCode,
      message: publicReason,
    }));
    markCommandRecord(journal, commandId, {
      phase: 'published_terminal',
      status: 'REJECTED',
      sidecar_reject_code: rejectCode,
      remote_sha256: remoteSha,
    });
    journal.active = null;
    await this.publishResult(envelope, commandId, journal);
  }

  deliverLocal(command, remoteSha, journal) {
    removeFileIfExists(this.local.result, this.existsSync, this.unlinkSync);
    const serialized = `${JSON.stringify(command, null, 2)}\n`;
    writeTextAtomic(this.local.command, serialized, this.writeFileSync, this.renameSync);
    markCommandRecord(journal, command.command_id, {
      phase: 'delivered_local',
      remote_sha256: remoteSha,
      delivered_at: new Date(this.now()).toISOString(),
      delivered_command_snapshot_sha256: command.snapshot_sha256,
      delivered_command_state_version: command.state_version,
    });
    journal.active = {
      command_id: command.command_id,
      remote_sha256: remoteSha,
      delivered_at: new Date(this.now()).toISOString(),
    };
    this.persistJournal(journal);
    this.log(`Delivered command ${command.command_id.slice(0, 8)} to local inbox.`);
    this._emitNotify(notificationFromMoveCommand(command, {
      code: NOTIFICATION_CODES.COMMAND_DELIVERED,
      remote_sha256: remoteSha,
    }));
  }

  async _resumeActive(journal) {
    const active = journal.active;
    if (!active || !active.command_id) {
      return false;
    }
    const localResult = this.readLocalResult();
    if (!localResult || localResult.__parseError) {
      return true;
    }
    if (localResult.command_id && localResult.command_id !== active.command_id) {
      return true;
    }
    if (!localResult.status || !isTerminalStatus(localResult.status)) {
      if (localResult.status === 'EXECUTING' || localResult.status === 'ACCEPTED') {
        this._notifyObservedLocalResult(localResult);
      }
      return true;
    }
    this._notifyObservedLocalResult(localResult);
    await this.publishResult(localResult, active.command_id, journal);
    return true;
  }

  async _pollOnce() {
    if (this._inFlight) {
      return;
    }
    this._inFlight = true;
    try {
      let journal = this.loadJournal();
      if (await this._resumeActive(journal)) {
        journal = this.loadJournal();
      }
      await this._retryPendingRemoteRetirements(journal);
      journal = this.loadJournal();

      let remote;
      try {
        remote = await this.readRemoteCommand();
        this._markRelayReconnected();
      } catch (error) {
        const message = error.message || String(error);
        if (error.code === 'RATE_LIMIT') {
          this.log(`Remote command read deferred: ${message}`);
        } else {
          this.log(`Remote command read failed: ${message}`);
        }
        this._markRelayDisconnected(message);
        return;
      }
      if (!remote || !remote.text) {
        return;
      }

      let command;
      try {
        command = JSON.parse(remote.text);
      } catch {
        await this.rejectRemote(null, 'MALFORMED_JSON', 'Remote command JSON is invalid.', journal, remote.sha ?? '');
        return;
      }

      if (remote.sha && remote.sha !== this._lastRemoteCommandSha) {
        this._lastRemoteCommandSha = remote.sha;
        this._emitNotify(notificationFromMoveCommand(command, { remote_sha256: remote.sha }));
      }

      const existing = getCommandRecord(journal, command.command_id);
      if (isTerminalRelayRecord(existing)) {
        this._emitNotify(buildNotification(NOTIFICATION_CODES.COMMAND_DUPLICATE, {
          command_id: command.command_id,
          session_id: command.session_id,
          turn: command.turn,
          state_version: command.state_version,
          remote_sha256: remote.sha ?? '',
          reason_code: 'SIDECAR_TERMINAL_RECORD',
        }));
        return;
      }

      if (journal.active && journal.active.command_id !== command.command_id) {
        this.log(`Waiting for active command ${journal.active.command_id.slice(0, 8)} before accepting ${command.command_id.slice(0, 8)}.`);
        return;
      }

      const localResult = this.readLocalResult();
      const openStatus = localResult && !localResult.__parseError ? localResult.status : null;
      if (!canAcceptNewCommand(openStatus)) {
        if (localResult && localResult.command_id && isTerminalStatus(localResult.status)) {
          this._notifyObservedLocalResult(localResult);
          await this.publishResult(localResult, localResult.command_id, journal);
        } else if (localResult && (localResult.status === 'EXECUTING' || localResult.status === 'ACCEPTED')) {
          this._notifyObservedLocalResult(localResult);
        }
        return;
      }

      try {
        parseMoveCommand(command);
        validateMoveAgainstSnapshotFile(command, this.snapshotPath, YAML, this.readFileSync);
      } catch (error) {
        const message = error instanceof ValidationError ? error.message : String(error);
        await this.rejectRemote(command, 'SIDECAR_VALIDATION', message, journal, remote.sha ?? '');
        return;
      }

      if (existing && existing.remote_sha256 === remote.sha && existing.phase === 'delivered_local') {
        return;
      }

      this.deliverLocal(command, remote.sha ?? '', journal);
    } finally {
      this._inFlight = false;
    }
  }

  start() {
    if (this.running) {
      return;
    }
    this.running = true;
    this.log(`Command relay watching ${this.snapshotPath}`);
    const tick = async () => {
      if (!this.running) {
        return;
      }
      await this._pollOnce();
      if (this.running) {
        let journal;
        try {
          journal = this.loadJournal();
        } catch {
          journal = { active: null };
        }
        this._timer = setTimeout(tick, this._msUntilNextPoll(journal));
      }
    };
    this._timer = setTimeout(tick, 0);
  }

  stop() {
    this.running = false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }
}

module.exports = {
  CommandRelayWatcher,
  localRelayPaths,
  DEFAULT_POLL_MS,
  DEFAULT_IDLE_POLL_MS,
  DEFAULT_ACTIVE_POLL_MS,
  RETIREMENT_BACKOFF_BASE_MS,
  RETIREMENT_BACKOFF_MAX_MS,
  RELAY_CONTENT_PATHS,
  DEFAULT_COMMAND_MAX_BYTES,
  DEFAULT_RESULT_MAX_BYTES,
};
