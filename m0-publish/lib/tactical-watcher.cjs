'use strict';

const fs = require('node:fs');
const YAML = require('yaml');
const {
  buildRelayPayload,
  computeSnapshotId,
  loadAndValidateSnapshotFromText,
  ValidationError,
} = require('./tactical-publish.cjs');

const DEFAULT_POLL_MS = 1000;
const DEFAULT_MIN_PUBLISH_MS = 15000;
const DEFAULT_MAX_PUBLISHES = 20;

class TacticalWatcher {
  constructor(options) {
    this.inputPath = options.inputPath;
    this.dryRun = options.dryRun;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.minPublishIntervalMs = options.minPublishIntervalMs ?? DEFAULT_MIN_PUBLISH_MS;
    this.maxPublishes = options.maxPublishes ?? DEFAULT_MAX_PUBLISHES;
    this.publishRelayState = options.publishRelayState;
    this.log = options.log ?? ((line) => console.log(line));
    this.now = options.now ?? (() => Date.now());
    this.readFileSync = options.readFileSync ?? fs.readFileSync;
    this.existsSync = options.existsSync ?? fs.existsSync;

    this.baselineSnapshotId = null;
    this.lastSeenSnapshotId = null;
    this.lastPublishedSnapshotId = null;
    this.lastValidSnapshotId = null;
    this.pendingRelay = null;
    this.publishInFlight = false;
    this.publishCount = 0;
    this.lastPublishAt = 0;
    this.publishingStopped = false;
    this.running = false;
    this._timer = null;
    this._abort = options.signal;
    if (this._abort) {
      this._abort.addEventListener('abort', () => this.stop(false), { once: true });
    }
  }

  readSnapshotText() {
    if (!this.existsSync(this.inputPath)) {
      return null;
    }
    return this.readFileSync(this.inputPath, 'utf8');
  }

  parseSnapshot(text) {
    return loadAndValidateSnapshotFromText(text, YAML);
  }

  tick() {
    if (!this.running || this._abort?.aborted) {
      return;
    }

    this._tickAsync().catch((error) => {
      if (error.code === 'AUTH_FAILED' || error.code === 'SHA_CONFLICT') {
        this.log(`GitHub error: ${error.message}`);
        this.stop(true);
        return;
      }
      this.log(`GitHub error: ${error.message || String(error)}`);
    });
  }

  async _tickAsync() {
    await this._pollOnce();
    await this._maybeFlushPending(false);
  }

  async _pollOnce() {
    const text = this.readSnapshotText();
    if (text === null) {
      return;
    }

    let tactical;
    try {
      tactical = this.parseSnapshot(text);
    } catch (error) {
      const message = error instanceof ValidationError ? error.message : String(error);
      this.log(`Validation failed: ${message}`);
      return;
    }

    const snapshotId = computeSnapshotId(tactical);
    this.lastValidSnapshotId = snapshotId;

    if (this.baselineSnapshotId === null) {
      this.baselineSnapshotId = snapshotId;
      this.lastSeenSnapshotId = snapshotId;
      this.log('Baseline established; waiting for tactical changes.');
      return;
    }

    if (snapshotId === this.lastSeenSnapshotId) {
      return;
    }

    this.lastSeenSnapshotId = snapshotId;
    this.log('Snapshot change detected.');

    if (snapshotId === this.baselineSnapshotId) {
      this.log('Unchanged / skipped (returned to startup baseline).');
      return;
    }

    if (snapshotId === this.lastPublishedSnapshotId) {
      this.log('Unchanged / skipped (duplicate snapshot ID).');
      return;
    }

    this.log('Snapshot validated.');
    this.pendingRelay = buildRelayPayload(tactical, new Date(this.now()).toISOString());
    await this._maybeFlushPending(true);
  }

  async _maybeFlushPending(fromChange) {
    if (this.publishingStopped || !this.pendingRelay) {
      return;
    }
    if (this.publishInFlight) {
      return;
    }

    const elapsed = this.now() - this.lastPublishAt;
    if (this.publishCount > 0 && elapsed < this.minPublishIntervalMs) {
      return;
    }

    if (this.publishCount >= this.maxPublishes) {
      this.publishingStopped = true;
      this.log('Session limit reached (20 publications).');
      this.pendingRelay = null;
      return;
    }

    const relay = this.pendingRelay;
    this.pendingRelay = null;

    if (this.dryRun) {
      this.publishCount += 1;
      this.lastPublishAt = this.now();
      this.lastPublishedSnapshotId = relay.snapshot_id;
      this.log(`Published (dry-run) ${relay.snapshot_id.slice(0, 12)} at ${relay.published_at}`);
      if (this.publishCount >= this.maxPublishes) {
        this.publishingStopped = true;
        this.log('Session limit reached (20 publications).');
      }
      return;
    }

    this.publishInFlight = true;
    try {
      const result = await this.publishRelayState(relay);
      if (result.skipped) {
        this.log('Unchanged / skipped (remote snapshot ID matches).');
        this.lastPublishedSnapshotId = relay.snapshot_id;
      } else {
        this.publishCount += 1;
        this.lastPublishAt = this.now();
        this.lastPublishedSnapshotId = relay.snapshot_id;
        this.log(`Published ${relay.snapshot_id.slice(0, 12)} at ${relay.published_at}`);
      }
      if (this.publishCount >= this.maxPublishes) {
        this.publishingStopped = true;
        this.log('Session limit reached (20 publications).');
      }
    } catch (error) {
      if (error.code === 'AUTH_FAILED' || error.code === 'SHA_CONFLICT') {
        this.log(`GitHub error: ${error.message}`);
        this.stop(true);
      }
      throw error;
    } finally {
      this.publishInFlight = false;
      if (this.pendingRelay && !this.publishingStopped && this.running) {
        await this._maybeFlushPending(false);
      }
    }
  }

  start() {
    if (this.running) {
      return;
    }
    this.running = true;
    this.log(`Watcher started (${this.dryRun ? 'dry-run' : 'publish'}).`);
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
      this.log(failed ? 'Watcher stopped (error).' : 'Watcher stopped.');
    }
  }
}

module.exports = {
  TacticalWatcher,
  DEFAULT_POLL_MS,
  DEFAULT_MIN_PUBLISH_MS,
  DEFAULT_MAX_PUBLISHES,
};
