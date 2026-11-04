'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createGithubQuotaTelemetryStore,
} = require('../lib/github-quota-telemetry.cjs');
const { createGithubQuotaConsoleMonitor } = require('../lib/github-quota-console.cjs');
const {
  buildGithubQuotaHudPayload,
  writeCompanionGithubQuotaHudFile,
  mergeHudQuotaFields,
  snapshotFromHudFilePayload,
  HUD_RATE_LIMIT_RESOURCE,
} = require('../lib/github-quota-hud-file.cjs');

describe('M1-30A GitHub quota HUD persistence', () => {
  it('preserves remaining when a later write has missing headers', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-persist-'));
    const snapshotPath = path.join(root, 'tactical-live.yaml');
    const hudPath = path.join(root, 'companion-github-quota.json');
    fs.writeFileSync(snapshotPath, 'schemaVersion: 5\n', 'utf8');
    fs.writeFileSync(hudPath, `${JSON.stringify({
      schema: 1,
      remaining: 4978,
      limit: 5000,
      reset_epoch_sec: 1793807277,
      observation_at_ms: 1_000_000,
      updated_at_ms: 1_000_000,
    }, null, 2)}\n`, 'utf8');

    const store = createGithubQuotaTelemetryStore({ persistPath: hudPath, now: () => 2_000_000 });
    assert.equal(store.getSnapshot().remaining, 4978);

    const payload = buildGithubQuotaHudPayload({
      store,
      hudPath,
      now: 2_000_000,
    });
    assert.equal(payload.remaining, 4978);
    assert.equal(payload.limit, 5000);
    assert.equal(payload.stale_observation, true);
  });

  it('does not infer remaining from limit-only header observations', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-limit-only-'));
    const hudPath = path.join(root, 'companion-github-quota.json');
    fs.writeFileSync(hudPath, `${JSON.stringify({
      schema: 1,
      remaining: 4800,
      limit: 5000,
      reset_epoch_sec: 1793807277,
      observation_at_ms: 1_000_000,
      updated_at_ms: 1_000_000,
    }, null, 2)}\n`, 'utf8');

    const store = createGithubQuotaTelemetryStore({ persistPath: hudPath, now: () => 1_500_000 });
    store.recordFromHeaders({ 'x-ratelimit-limit': '5000' }, { now: 1_500_000 });
    const payload = buildGithubQuotaHudPayload({ store, hudPath, now: 1_500_000 });
    assert.equal(payload.remaining, 4800);
    assert.equal(payload.limit, 5000);
  });

  it('keeps last remaining across HTTP 404 without rate-limit headers', () => {
    const store = createGithubQuotaTelemetryStore({ now: () => 1_000_000 });
    store.recordFromHeaders({
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': '4990',
      'x-ratelimit-reset': '4102444800',
      'x-ratelimit-resource': 'core',
    }, { now: 1_000_000 });
    store.recordFromGhError({ code: 'NOT_FOUND', stderr: 'HTTP/2.0 404 Not Found' }, 1_000_100);
    const snap = store.getSnapshot();
    assert.equal(snap.remaining, 4990);
  });

  it('updates remaining on consecutive successful observations', () => {
    const store = createGithubQuotaTelemetryStore({ now: () => 1_000_000 });
    store.recordFromHeaders({
      'x-ratelimit-remaining': '100',
      'x-ratelimit-limit': '5000',
      'x-ratelimit-resource': 'core',
    }, { now: 1_000_000 });
    store.recordFromHeaders({
      'x-ratelimit-remaining': '99',
      'x-ratelimit-limit': '5000',
      'x-ratelimit-resource': 'core',
    }, { now: 1_000_050 });
    assert.equal(store.getSnapshot().remaining, 99);
  });

  it('reloads persisted quota after simulated daemon restart', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-restart-'));
    const hudPath = path.join(root, 'companion-github-quota.json');
    const storeA = createGithubQuotaTelemetryStore({ now: () => 1_000_000 });
    storeA.recordFromHeaders({
      'x-ratelimit-remaining': '1234',
      'x-ratelimit-limit': '5000',
      'x-ratelimit-reset': '4102444800',
      'x-ratelimit-resource': 'core',
    }, { now: 1_000_000 });
    writeCompanionGithubQuotaHudFile({ store: storeA, hudPath, now: 1_000_000 });

    const storeB = createGithubQuotaTelemetryStore({ persistPath: hudPath, now: () => 2_000_000 });
    assert.equal(storeB.getSnapshot().remaining, 1234);
    const payload = buildGithubQuotaHudPayload({ store: storeB, hudPath, now: 2_000_000 });
    assert.equal(payload.remaining, 1234);
    assert.equal(payload.updated_at_ms, 2_000_000);
  });

  it('writes beside snapshot path instead of m0-publish root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-path-'));
    const snapshotPath = path.join(root, 'tactical-live.yaml');
    fs.writeFileSync(snapshotPath, 'schemaVersion: 5\n', 'utf8');
    const store = createGithubQuotaTelemetryStore({ now: () => 1_000_000 });
    store.recordFromHeaders({
      'x-ratelimit-remaining': '42',
      'x-ratelimit-limit': '5000',
      'x-ratelimit-resource': 'core',
    }, { now: 1_000_000 });
    const { hudPath } = writeCompanionGithubQuotaHudFile({
      store,
      snapshotPathEnv: snapshotPath,
      now: 1_000_000,
    });
    assert.equal(hudPath, path.join(root, 'companion-github-quota.json'));
    assert.equal(JSON.parse(fs.readFileSync(hudPath, 'utf8')).remaining, 42);
  });

  it('accepts legitimate hourly quota reset observations', () => {
    const merged = mergeHudQuotaFields({
      remaining: 10,
      limit: 5000,
      reset_epoch_sec: 1000,
      observation_at_ms: 1_000_000,
    }, {
      remaining: 5000,
      limit: 5000,
      reset_epoch_sec: 4600,
      observation_at_ms: 4_000_000,
    });
    assert.equal(merged.remaining, 5000);
    assert.equal(merged.reset_epoch_sec, 4600);
  });

  it('ignores non-core rate-limit pools for primary HUD telemetry', () => {
    const store = createGithubQuotaTelemetryStore({ now: () => 1_000_000 });
    store.recordFromHeaders({
      'x-ratelimit-remaining': '100',
      'x-ratelimit-limit': '5000',
      'x-ratelimit-resource': 'core',
    }, { now: 1_000_000 });
    store.recordFromHeaders({
      'x-ratelimit-remaining': '9999',
      'x-ratelimit-limit': '10000',
      'x-ratelimit-resource': 'search',
    }, { now: 1_000_010 });
    assert.equal(store.getSnapshot().remaining, 100);
    assert.equal(store.getSnapshot().resource, HUD_RATE_LIMIT_RESOURCE);
  });

  it('console monitor tick preserves file counts without new API calls', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-monitor-'));
    const snapshotPath = path.join(root, 'tactical-live.yaml');
    const hudPath = path.join(root, 'companion-github-quota.json');
    fs.writeFileSync(snapshotPath, 'schemaVersion: 5\n', 'utf8');
    fs.writeFileSync(hudPath, `${JSON.stringify({
      schema: 1,
      remaining: 4964,
      limit: 5000,
      reset_epoch_sec: 1793807277,
      observation_at_ms: 1_000_000,
      updated_at_ms: 1_000_000,
    }, null, 2)}\n`, 'utf8');
    const store = createGithubQuotaTelemetryStore({ persistPath: hudPath, now: () => 2_000_000 });
    const monitor = createGithubQuotaConsoleMonitor({
      store,
      log: () => {},
      now: () => 2_000_000,
      hudPath,
      snapshotPathEnv: snapshotPath,
    });
    monitor.tick();
    const payload = JSON.parse(fs.readFileSync(hudPath, 'utf8'));
    assert.equal(payload.remaining, 4964);
    assert.equal(payload.observation_at_ms, 1_000_000);
    assert.equal(payload.updated_at_ms, 2_000_000);
    assert.equal(payload.relay_heartbeat_at_ms, 2_000_000);
  });

  it('throttles unchanged idle heartbeat HUD writes to about 30 seconds', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-heartbeat-throttle-'));
    const hudPath = path.join(root, 'companion-github-quota.json');
    const store = createGithubQuotaTelemetryStore({ now: () => 1_000_000 });
    store.recordFromHeaders({
      'x-ratelimit-remaining': '100',
      'x-ratelimit-limit': '5000',
      'x-ratelimit-resource': 'core',
    }, { now: 1_000_000 });

    const first = writeCompanionGithubQuotaHudFile({ store, hudPath, now: 1_000_000 });
    assert.equal(first.written, true);
    assert.equal(first.payload.observation_at_ms, 1_000_000);

    const second = writeCompanionGithubQuotaHudFile({ store, hudPath, now: 1_000_500 });
    assert.equal(second.written, false);
    const onDisk = JSON.parse(fs.readFileSync(hudPath, 'utf8'));
    assert.equal(onDisk.updated_at_ms, 1_000_000);
    assert.equal(onDisk.observation_at_ms, 1_000_000);

    const third = writeCompanionGithubQuotaHudFile({ store, hudPath, now: 1_000_000 + 30_000 });
    assert.equal(third.written, true);
    assert.equal(third.payload.observation_at_ms, 1_000_000);
    assert.equal(third.payload.relay_heartbeat_at_ms, 1_030_000);
  });

  it('writes immediately when GitHub quota observation changes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-immediate-write-'));
    const hudPath = path.join(root, 'companion-github-quota.json');
    const store = createGithubQuotaTelemetryStore({ now: () => 1_000_000 });
    store.recordFromHeaders({
      'x-ratelimit-remaining': '100',
      'x-ratelimit-limit': '5000',
      'x-ratelimit-resource': 'core',
    }, { now: 1_000_000 });
    writeCompanionGithubQuotaHudFile({ store, hudPath, now: 1_000_000 });

    store.recordFromHeaders({
      'x-ratelimit-remaining': '99',
      'x-ratelimit-limit': '5000',
      'x-ratelimit-resource': 'core',
    }, { now: 1_000_100 });
    const result = writeCompanionGithubQuotaHudFile({ store, hudPath, now: 1_000_100 });
    assert.equal(result.written, true);
    assert.equal(result.payload.remaining, 99);
    assert.equal(result.payload.observation_at_ms, 1_000_100);
  });

  it('throttles redundant console logging on unchanged idle ticks', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-console-throttle-'));
    const snapshotPath = path.join(root, 'tactical-live.yaml');
    const hudPath = path.join(root, 'companion-github-quota.json');
    fs.writeFileSync(snapshotPath, 'schemaVersion: 5\n', 'utf8');
    let simulatedNow = 1_000_000;
    const store = createGithubQuotaTelemetryStore({ now: () => simulatedNow });
    store.recordFromHeaders({
      'x-ratelimit-remaining': '50',
      'x-ratelimit-limit': '5000',
      'x-ratelimit-resource': 'core',
    }, { now: 1_000_000 });
    const lines = [];
    const monitor = createGithubQuotaConsoleMonitor({
      store,
      log: (line) => lines.push(line),
      now: () => simulatedNow,
      hudPath,
      snapshotPathEnv: snapshotPath,
    });
    monitor.tick();
    simulatedNow = 1_000_500;
    monitor.tick();
    assert.equal(lines.length, 1);
    monitor.tick();
    assert.equal(lines.length, 1);
  });

  it('tolerates malformed persisted telemetry without crashing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-malformed-'));
    const hudPath = path.join(root, 'companion-github-quota.json');
    fs.writeFileSync(hudPath, '{not json', 'utf8');
    const loaded = snapshotFromHudFilePayload(null);
    assert.equal(loaded, null);
    const store = createGithubQuotaTelemetryStore({ persistPath: hudPath, now: () => 1_000_000 });
    assert.equal(store.getSnapshot().remaining, null);
    const payload = buildGithubQuotaHudPayload({ store, hudPath, now: 1_000_000 });
    assert.equal(payload.remaining, null);
  });
});
