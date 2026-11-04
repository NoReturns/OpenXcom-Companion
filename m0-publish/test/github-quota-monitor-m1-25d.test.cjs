'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  parseGhApiIncludeStdout,
  parseRateLimitHeadersFromText,
  createGithubQuotaTelemetryStore,
  formatDurationHms,
  buildQuotaConsoleView,
  classifyGhErrorKind,
  msUntilResetEpoch,
} = require('../lib/github-quota-telemetry.cjs');
const { createGithubQuotaConsoleMonitor } = require('../lib/github-quota-console.cjs');
const { writeCompanionGithubQuotaHudFile, resolveCompanionGithubQuotaHudPath } = require('../lib/github-quota-hud-file.cjs');
const { createGhApiExec } = require('../lib/github-relay.cjs');
const { createRelayRateLimitGate } = require('../lib/relay-rate-limit-gate.cjs');

describe('M1-25D GitHub quota telemetry', () => {
  it('parses gh api --include stdout into headers and JSON body', () => {
    const stdout = [
      'HTTP/2.0 200 OK',
      'X-Ratelimit-Limit: 5000',
      'X-Ratelimit-Remaining: 42',
      'X-Ratelimit-Used: 4958',
      'X-Ratelimit-Reset: 4102444800',
      'X-Ratelimit-Resource: core',
      '',
      '{"ok":true}',
    ].join('\n');
    const parsed = parseGhApiIncludeStdout(stdout);
    assert.equal(parsed.body, '{"ok":true}');
    assert.equal(parsed.headers['x-ratelimit-remaining'], '42');
    assert.equal(parsed.headers['x-ratelimit-limit'], '5000');
  });

  it('records success headers without inventing missing values', () => {
    const store = createGithubQuotaTelemetryStore({ now: () => 1_000_000 });
    store.recordFromHeaders({
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': '500',
    }, { now: 1_000_000 });
    const snap = store.getSnapshot();
    assert.equal(snap.limit, 5000);
    assert.equal(snap.remaining, 500);
    assert.equal(snap.used, null);
    assert.equal(snap.resetEpochSec, null);
  });

  it('classifies primary, secondary, and auth errors from gh blobs', () => {
    assert.equal(classifyGhErrorKind({ code: 'AUTH_FAILED', stderr: '401' }), 'AUTH_FAILED');
    assert.equal(
      classifyGhErrorKind({ code: 'RATE_LIMIT', stderr: 'secondary rate limit' }),
      'SECONDARY_RATE_LIMIT',
    );
    assert.equal(
      classifyGhErrorKind({ code: 'RATE_LIMIT', stderr: 'API rate limit exceeded' }),
      'PRIMARY_RATE_LIMIT',
    );
  });

  it('warns at 10% remaining by default', () => {
    const now = 1_700_000_000_000;
    const resetEpochSec = Math.floor(now / 1000) + 3600;
    const view = buildQuotaConsoleView({
      now,
      snapshot: {
        limit: 5000,
        remaining: 400,
        used: 4600,
        resetEpochSec,
        resource: 'core',
        lastErrorKind: null,
      },
    });
    assert.equal(view.health, 'LOW');
    assert.match(view.message, /WARN/);
  });

  it('shows UNKNOWN telemetry until headers are captured', () => {
    const view = buildQuotaConsoleView({
      snapshot: createGithubQuotaTelemetryStore().getSnapshot(),
      now: Date.now(),
    });
    assert.equal(view.health, 'UNKNOWN');
    assert.match(view.message, /UNKNOWN/);
  });

  it('formats reset countdown locally from captured reset epoch', () => {
    const now = 1_000_000_000_000;
    const resetEpochSec = Math.floor(now / 1000) + 3661;
    assert.equal(formatDurationHms(msUntilResetEpoch(resetEpochSec, now)), '01:01:01');
  });

  it('createGhApiExec updates telemetry store on success and error', () => {
    const store = createGithubQuotaTelemetryStore();
    const successStdout = [
      'HTTP/2.0 200 OK',
      'X-Ratelimit-Limit: 100',
      'X-Ratelimit-Remaining: 99',
      'X-Ratelimit-Used: 1',
      'X-Ratelimit-Reset: 4102444800',
      '',
      '{"resources":{}}',
    ].join('\n');
    const ghApi = createGhApiExec({
      quotaTelemetryStore: store,
      execFileSync: (_cmd, args) => {
        if (args.includes('--include')) {
          return successStdout;
        }
        throw new Error('expected --include');
      },
    });
    ghApi('GET', 'rate_limit');
    assert.equal(store.getSnapshot().remaining, 99);

    const ghApiErr = createGhApiExec({
      quotaTelemetryStore: store,
      execFileSync: () => {
        const error = new Error('fail');
        error.stderr = 'x-ratelimit-remaining: 0\nx-ratelimit-limit: 5000\nAPI rate limit exceeded';
        throw error;
      },
    });
    assert.throws(() => ghApiErr('GET', 'repos/o/r/contents/x'), (err) => err.code === 'RATE_LIMIT');
    assert.equal(store.getSnapshot().remaining, 0);
    assert.equal(store.getSnapshot().lastErrorKind, 'PRIMARY_RATE_LIMIT');
  });

  it('console monitor logs gate cooldown without extra API polling', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-gate-'));
    const gatePath = path.join(root, 'gate.json');
    let now = 2_000_000;
    const gate = createRelayRateLimitGate({ gatePath, now: () => now });
    gate.mergeCooldownUntil(now + 90_000);
    const store = createGithubQuotaTelemetryStore({ now: () => now });
    const lines = [];
    const monitor = createGithubQuotaConsoleMonitor({
      store,
      rateLimitGate: gate,
      log: (line) => lines.push(line),
      now: () => now,
    });
    monitor.tick();
    assert.match(lines[0], /COOLDOWN/);
    assert.match(lines[0], /00:01:30/);
    now += 30_000;
    monitor.tick();
    assert.match(lines[1], /00:01:00/);
  });

  it('writes companion-github-quota.json beside snapshot for HUD overlay', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-hud-'));
    const snapshotPath = path.join(root, 'tactical-live.yaml');
    fs.writeFileSync(snapshotPath, 'companion: test\n', 'utf8');
    const store = createGithubQuotaTelemetryStore();
    store.recordFromHeaders({
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': '1234',
      'x-ratelimit-reset': '4102444800',
    }, { now: 1_000_000 });
    const { hudPath, payload } = writeCompanionGithubQuotaHudFile({
      store,
      now: 1_000_000,
      snapshotPathEnv: snapshotPath,
    });
    assert.equal(hudPath, path.join(root, 'companion-github-quota.json'));
    assert.equal(payload.remaining, 1234);
    assert.equal(payload.limit, 5000);
    assert.equal(payload.updated_at_ms, 1_000_000);
    assert.equal(resolveCompanionGithubQuotaHudPath({ snapshotPathEnv: snapshotPath }), hudPath);
  });

  it('removes HUD file when relay sidecar stops publishing telemetry', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-hud-rm-'));
    const snapshotPath = path.join(root, 'tactical-live.yaml');
    fs.writeFileSync(snapshotPath, 'companion: test\n', 'utf8');
    const { writeCompanionGithubQuotaHudFile, removeCompanionGithubQuotaHudFile } = require('../lib/github-quota-hud-file.cjs');
    const hudPath = writeCompanionGithubQuotaHudFile({ snapshotPathEnv: snapshotPath }).hudPath;
    assert.ok(fs.existsSync(hudPath));
    removeCompanionGithubQuotaHudFile({ snapshotPathEnv: snapshotPath });
    assert.ok(!fs.existsSync(hudPath));
  });
});
