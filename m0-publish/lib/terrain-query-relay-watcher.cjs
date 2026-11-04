'use strict';

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { ValidationError, loadAndValidateSnapshotFromText, computeSnapshotId } = require('./tactical-publish.cjs');
const { readSnapshotByteBuffer } = require('./briefing-snapshot.cjs');
const { executeTerrainQuery } = require('./terrain-query.cjs');
const {
  loadQueryJournal,
  persistQueryJournal,
  queryKeyFromDigest,
  isTerminalQueryRecord,
} = require('./terrain-query-journal.cjs');
const {
  RELAY_CONTENT_PATHS,
  DEFAULT_TERRAIN_QUERY_MAX_BYTES,
  DEFAULT_TERRAIN_QUERY_RESULT_MAX_BYTES,
} = require('./github-relay.cjs');

const DEFAULT_IDLE_POLL_MS = 15_000;
/** @deprecated use DEFAULT_IDLE_POLL_MS */
const DEFAULT_POLL_MS = DEFAULT_IDLE_POLL_MS;

class TerrainQueryRelayWatcher {
  constructor(options) {
    this.snapshotPath = options.snapshotPath;
    this.stateDir = options.stateDir;
    this.dryRun = options.dryRun;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_IDLE_POLL_MS;
    this.rateLimitGate = options.rateLimitGate ?? null;
    this.githubQuotaMonitor = options.githubQuotaMonitor ?? null;
    this.readRemoteQuery = options.readRemoteQuery;
    this.publishRemoteQueryResult = options.publishRemoteQueryResult;
    this.log = options.log ?? ((line) => console.log(line));
    this.now = options.now ?? (() => Date.now());
    this.readFileSync = options.readFileSync ?? fs.readFileSync;
    this.existsSync = options.existsSync ?? fs.existsSync;
    this.writeFileSync = options.writeFileSync ?? fs.writeFileSync;
    this.renameSync = options.renameSync ?? fs.renameSync;
    this.signal = options.signal;

    this.running = false;
    this._timer = null;
    this._inFlight = false;

    if (this.signal) {
      this.signal.addEventListener('abort', () => this.stop(), { once: true });
    }
  }

  loadTactical() {
    const bytes = readSnapshotByteBuffer(this.readFileSync, this.snapshotPath);
    return loadAndValidateSnapshotFromText(bytes.toString('utf8'), YAML);
  }

  loadJournal() {
    return loadQueryJournal(this.stateDir, this.readFileSync, this.existsSync);
  }

  persistJournal(journal) {
    persistQueryJournal(this.stateDir, journal, this.writeFileSync, this.renameSync);
  }

  _msUntilNextPoll() {
    const gateWait = this.rateLimitGate ? this.rateLimitGate.msUntilOpen(this.now()) : 0;
    return Math.max(this.pollIntervalMs, gateWait);
  }

  async _pollOnce() {
    if (this._inFlight) {
      return;
    }
    this._inFlight = true;
    try {
      let remote;
      try {
        remote = await this.readRemoteQuery();
      } catch (error) {
        const message = error.message || String(error);
        if (error.code === 'RATE_LIMIT') {
          this.log(`Remote terrain query read deferred: ${message}`);
        } else {
          this.log(`Remote terrain query read failed: ${message}`);
        }
        return;
      }
      if (!remote || !remote.text) {
        return;
      }

      const journal = this.loadJournal();
      const key = queryKeyFromDigest(remote.sha ?? remote.text, 'pending');
      let request;
      try {
        request = JSON.parse(remote.text);
      } catch {
        this.log('Remote terrain query JSON invalid; skipping.');
        return;
      }

      const snapshotId = typeof request.snapshot_id === 'string' ? request.snapshot_id : '';
      const recordKey = queryKeyFromDigest(remote.sha ?? '', snapshotId || 'unknown');
      const existing = journal.records[recordKey];
      if (isTerminalQueryRecord(existing)) {
        return;
      }

      let tactical;
      try {
        tactical = this.loadTactical();
      } catch (error) {
        const message = error instanceof ValidationError ? error.message : String(error);
        this.log(`Local snapshot invalid for terrain query: ${message}`);
        return;
      }

      const expectedId = computeSnapshotId(tactical);
      if (snapshotId !== expectedId) {
        this.log('Terrain query snapshot_id does not match local snapshot; skipping publish.');
        return;
      }

      let response;
      try {
        response = executeTerrainQuery(tactical, request);
      } catch (error) {
        const message = error instanceof ValidationError ? error.message : String(error);
        this.log(`Terrain query rejected: ${message}`);
        return;
      }

      if (this.dryRun) {
        this.log(`Dry-run terrain query for snapshot ${expectedId.slice(0, 12)} (${response.discovered.length} cells).`);
        journal.records[recordKey] = {
          phase: 'published',
          dry_run: true,
          updated_at: new Date(this.now()).toISOString(),
        };
        this.persistJournal(journal);
        return;
      }

      await this.publishRemoteQueryResult(response, recordKey);
      journal.records[recordKey] = {
        phase: 'published',
        snapshot_id: expectedId,
        remote_sha256: remote.sha,
        updated_at: new Date(this.now()).toISOString(),
      };
      this.persistJournal(journal);
      this.log(`Published terrain query result (${response.discovered.length} discovered cells).`);
      void key;
    } finally {
      this._inFlight = false;
    }
  }

  start() {
    if (this.running) {
      return;
    }
    this.running = true;
    this.log(`Terrain query relay watching ${this.snapshotPath}`);
    const tick = async () => {
      if (!this.running) {
        return;
      }
      await this._pollOnce();
      if (this.githubQuotaMonitor && typeof this.githubQuotaMonitor.tick === 'function') {
        this.githubQuotaMonitor.tick();
      }
      if (this.running) {
        this._timer = setTimeout(tick, this._msUntilNextPoll());
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
  TerrainQueryRelayWatcher,
  DEFAULT_POLL_MS,
  DEFAULT_IDLE_POLL_MS,
  RELAY_CONTENT_PATHS,
  DEFAULT_TERRAIN_QUERY_MAX_BYTES,
  DEFAULT_TERRAIN_QUERY_RESULT_MAX_BYTES,
};
