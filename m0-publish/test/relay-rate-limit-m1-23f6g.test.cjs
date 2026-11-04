'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  createRelayRateLimitGate,
  parseCooldownMsFromGhBlob,
  resolveSharedRelayRateLimitGatePath,
} = require('../lib/relay-rate-limit-gate.cjs');
const {
  acquireCommandRelaySidecarLock,
  isProcessAlive,
} = require('../lib/command-relay-process-lock.cjs');
const {
  CommandRelayWatcher,
  DEFAULT_IDLE_POLL_MS,
  DEFAULT_ACTIVE_POLL_MS,
} = require('../lib/command-relay-watcher.cjs');
const {
  TerrainQueryRelayWatcher,
  DEFAULT_IDLE_POLL_MS: TERRAIN_IDLE_POLL_MS,
} = require('../lib/terrain-query-relay-watcher.cjs');
const { normalizeGhApiExecError } = require('../lib/github-relay.cjs');
const { loadCommandJournal, markCommandRecord, persistCommandJournal } = require('../lib/command-journal.cjs');
const { BriefingWatcher } = require('../lib/briefing-watcher.cjs');
const { loadJournal, isTerminalRecord } = require('../lib/briefing-journal.cjs');
const { sha256HexLower } = require('../lib/briefing-snapshot.cjs');

const FIXTURE_V4 = fs.readFileSync(path.join(__dirname, 'fixtures', 'valid-v4.yaml'), 'utf8');
const BRIEFING_SESSION = 'a1b2c3d4e5f6789012345678abcdef01';

function makeBriefingRequest(overrides = {}) {
  const snapshot_sha256 = overrides.snapshot_sha256 ?? sha256HexLower(Buffer.from(FIXTURE_V4, 'utf8'));
  return {
    schema_version: 1,
    type: 'tactical_briefing_request',
    request_id: overrides.request_id ?? '0123456789abcdef0123456789abcdef',
    session_id: overrides.session_id ?? BRIEFING_SESSION,
    turn: overrides.turn ?? 1,
    snapshot_sha256,
    ...overrides,
  };
}

describe('M1-23F6G rate-limit classification', () => {
  it('distinguishes quota 403 from bad credentials', () => {
    const rate = normalizeGhApiExecError(Object.assign(new Error('fail'), {
      stderr: 'gh: API rate limit exceeded (HTTP 403)',
    }));
    assert.equal(rate.code, 'RATE_LIMIT');

    const auth = normalizeGhApiExecError(Object.assign(new Error('fail'), {
      stderr: 'gh: Bad credentials (HTTP 401)',
    }));
    assert.equal(auth.code, 'AUTH_FAILED');
  });

  it('parses retry-after and x-ratelimit-reset hints', () => {
    const blob = 'retry-after: 120\nx-ratelimit-reset: 4102444800\nrate limit';
    const ms = parseCooldownMsFromGhBlob(blob);
    assert.ok(ms >= 120_000);
  });
});

describe('M1-23F6G shared file-backed rate-limit gate', () => {
  it('blocks gh calls across gate instances until cooldown expires', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-gate-'));
    const gatePath = path.join(root, 'gate.json');
    let now = 1_000_000;
    const gateA = createRelayRateLimitGate({ gatePath, now: () => now });
    const gateB = createRelayRateLimitGate({ gatePath, now: () => now });
    let calls = 0;
    const ghApi = gateA.wrapGhApiExec(() => {
      calls += 1;
      return { ok: true };
    });
    const gatedB = gateB.wrapGhApiExec(() => {
      calls += 1;
      return { ok: true };
    });

    assert.deepEqual(ghApi('GET', 'x'), { ok: true });
    assert.equal(calls, 1);

    const rateErr = Object.assign(new Error('rate'), {
      code: 'RATE_LIMIT',
      stderr: 'gh: API rate limit exceeded (HTTP 403)\nretry-after: 30',
    });
    gateA.recordError(rateErr, now);

    assert.throws(() => ghApi('GET', 'y'), (error) => error.code === 'RATE_LIMIT');
    assert.throws(() => gatedB('GET', 'z'), (error) => error.code === 'RATE_LIMIT');
    assert.equal(calls, 1);

    now += 61_000;
    assert.equal(gateB.msUntilOpen(now), 0);
    assert.deepEqual(gatedB('GET', 'after'), { ok: true });
    assert.equal(calls, 2);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('never shortens an existing cooldown when a shorter retry is recorded', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-merge-'));
    const gatePath = path.join(root, 'gate.json');
    let now = 2_000_000;
    const longResetSec = Math.floor((now + 120_000) / 1000);
    const gateA = createRelayRateLimitGate({ gatePath, now: () => now });
    gateA.recordError({
      code: 'RATE_LIMIT',
      stderr: `API rate limit exceeded\nx-ratelimit-reset: ${longResetSec}`,
    }, now);
    const gateB = createRelayRateLimitGate({ gatePath, now: () => now });
    gateB.recordError({
      code: 'RATE_LIMIT',
      stderr: 'rate limit\nretry-after: 5',
    }, now);
    const state = gateB.readState();
    assert.ok(state.cooldown_until_ms >= now + 120_000);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('concurrent OS processes preserve the longest cooldown under parallel writers', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-concurrent-'));
    const gatePath = path.join(root, 'gate.json');
    const now = 8_000_000;
    const helper = path.join(__dirname, 'helpers', 'record-gate-cooldown.cjs');
    const shortUntil = now + 90_000;
    const longUntil = now + 600_000;

    const runWriter = (cooldownUntilMs) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [helper, gatePath, String(now), String(cooldownUntilMs)], {
        stdio: 'ignore',
      });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`gate writer exited ${code}`));
      });
    });

    await Promise.all([
      runWriter(shortUntil),
      runWriter(longUntil),
      runWriter(now + 180_000),
    ]);

    const gate = createRelayRateLimitGate({ gatePath, now: () => now });
    const state = gate.readState();
    assert.ok(state);
    assert.equal(state.cooldown_until_ms, longUntil);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('M1-23F6G command poll intervals', () => {
  it('uses 5s idle and 1s during EXECUTING local result', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'poll-int-'));
    const snapshotPath = path.join(root, 'tactical-live.yaml');
    fs.writeFileSync(snapshotPath, 'turn: 1\n', 'utf8');
    const resultPath = path.join(root, 'tactical-result.json');

    const watcher = new CommandRelayWatcher({
      snapshotPath,
      stateDir: path.join(root, 'state'),
      dryRun: true,
      readRemoteCommand: async () => null,
    });
    assert.equal(watcher._computePollIntervalMs({ active: null }), DEFAULT_IDLE_POLL_MS);

    fs.writeFileSync(resultPath, `${JSON.stringify({
      command_id: 'abc',
      status: 'EXECUTING',
    })}\n`, 'utf8');
    assert.equal(watcher._computePollIntervalMs({ active: null }), DEFAULT_ACTIVE_POLL_MS);
    assert.equal(watcher._computePollIntervalMs({ active: { command_id: 'abc' } }), DEFAULT_ACTIVE_POLL_MS);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('does not treat stuck remote command alone as active polling', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'poll-remote-'));
    const snapshotPath = path.join(root, 'tactical-live.yaml');
    fs.writeFileSync(snapshotPath, 'turn: 1\n', 'utf8');
    const watcher = new CommandRelayWatcher({
      snapshotPath,
      stateDir: path.join(root, 'state'),
      dryRun: true,
      readRemoteCommand: async () => ({ text: '{"command_id":"x"}\n', sha: 'sha' }),
    });
    const journal = { active: null, records: { x: { command_id: 'x', phase: 'published_terminal' } } };
    assert.equal(watcher._computePollIntervalMs(journal), DEFAULT_IDLE_POLL_MS);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('simulates lower idle GitHub read count at 5s + 15s vs 1s polling', () => {
    const hourMs = 3_600_000;
    const oldPerHour = (3600 * 2);
    const newPerHour = Math.floor(hourMs / DEFAULT_IDLE_POLL_MS) + Math.floor(hourMs / TERRAIN_IDLE_POLL_MS);
    assert.equal(newPerHour, 720 + 240);
    assert.ok(newPerHour < oldPerHour / 5);
  });
});

describe('M1-23F6G retirement backoff', () => {
  it('preserves published_terminal and backs off delete retries', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retire-backoff-'));
    const snapshotPath = path.join(root, 'tactical-live.yaml');
    fs.writeFileSync(snapshotPath, 'turn: 1\n', 'utf8');
    const stateDir = path.join(root, 'state');
    let now = 1_000_000;
    let deleteCalls = 0;
    const remoteCommand = { text: '{"command_id":"move-bo"}\n', sha: 'sha-bo' };
    const watcher = new CommandRelayWatcher({
      snapshotPath,
      stateDir,
      dryRun: false,
      now: () => now,
      log: () => {},
      readRemoteCommand: async () => remoteCommand,
      fetchRemoteResult: async () => ({ value: { command_id: 'move-bo', status: 'FAILED' } }),
      retireRemoteCommand: async () => {
        deleteCalls += 1;
        throw new Error('delete failed');
      },
    });
    const journal = loadCommandJournal(stateDir);
    markCommandRecord(journal, 'move-bo', {
      phase: 'published_terminal',
      status: 'FAILED',
      remote_sha256: 'sha-bo',
    });
    persistCommandJournal(stateDir, journal, fs.writeFileSync, fs.renameSync);

    await watcher._maybeRetireRemoteCommand(journal, 'move-bo', { command_id: 'move-bo', status: 'FAILED' });
    assert.equal(deleteCalls, 1);
    let after = loadCommandJournal(stateDir, fs.readFileSync, fs.existsSync);
    assert.equal(after.records['move-bo'].phase, 'published_terminal');
    assert.equal(after.records['move-bo'].retirement_delete_attempts, 1);
    const nextAt = Date.parse(after.records['move-bo'].retirement_next_attempt_at);
    assert.ok(nextAt > now);

    now += 10_000;
    await watcher._maybeRetireRemoteCommand(after, 'move-bo', { command_id: 'move-bo', status: 'FAILED' });
    assert.equal(deleteCalls, 1);

    now = nextAt + 1;
    await watcher._maybeRetireRemoteCommand(loadCommandJournal(stateDir, fs.readFileSync, fs.existsSync), 'move-bo', {
      command_id: 'move-bo',
      status: 'FAILED',
    });
    assert.equal(deleteCalls, 2);
    after = loadCommandJournal(stateDir, fs.readFileSync, fs.existsSync);
    assert.equal(after.records['move-bo'].phase, 'published_terminal');
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('M1-23F6G duplicate command-relay sidecar lock', () => {
  it('rejects a second live lock and reclaims stale locks', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-lock-'));
    const lockPath = path.join(root, 'sidecar.lock');
    const first = acquireCommandRelaySidecarLock({
      lockPath,
      pid: 1001,
      snapshotPath: '/snap/a',
      isProcessAlive: (pid) => pid === 1001,
    });
    assert.throws(
      () => acquireCommandRelaySidecarLock({
        lockPath,
        pid: 1002,
        snapshotPath: '/snap/b',
        isProcessAlive: (pid) => pid === 1001,
      }),
      (error) => error.code === 'DUPLICATE_SIDECAR',
    );

    first.release();
    const second = acquireCommandRelaySidecarLock({
      lockPath,
      pid: 1002,
      snapshotPath: '/snap/b',
      isProcessAlive: () => false,
    });
    second.release();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('isProcessAlive treats missing pid as stale', () => {
    assert.equal(isProcessAlive(999999999), false);
  });
});

describe('M1-23F6G terrain poll interval default', () => {
  it('defaults terrain idle poll to 15 seconds', () => {
    assert.equal(TERRAIN_IDLE_POLL_MS, 15_000);
  });
});

describe('M1-23F6H briefing shared rate-limit gate', () => {
  it('uses the same checkout gate path for briefing and command sidecars', () => {
    const publishRoot = path.resolve(__dirname, '..');
    const expected = path.join(publishRoot, '.relay-github-rate-limit-gate.json');
    assert.equal(resolveSharedRelayRateLimitGatePath(publishRoot), expected);
  });

  it('defers F6 publish during cooldown with zero publish calls and keeps request pending', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-gate-'));
    const gatePath = path.join(root, 'gate.json');
    let now = 3_000_000;
    const gate = createRelayRateLimitGate({ gatePath, now: () => now });
    gate.recordError({
      code: 'RATE_LIMIT',
      stderr: 'gh: API rate limit exceeded (HTTP 403)',
    }, now);

    const requestPath = path.join(root, 'briefing-request.json');
    const snapshotPath = path.join(root, 'tactical-live.yaml');
    const stateDir = path.join(root, 'state');
    fs.writeFileSync(snapshotPath, FIXTURE_V4, 'utf8');
    fs.writeFileSync(requestPath, `${JSON.stringify(makeBriefingRequest({
      request_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    }), null, 2)}\n`, 'utf8');

    let publishCalls = 0;
    const watcher = new BriefingWatcher({
      requestPath,
      snapshotPath,
      stateDir,
      ackDir: root,
      dryRun: false,
      now: () => now,
      rateLimitGate: gate,
      log: () => {},
      publishRelayState: async () => {
        publishCalls += 1;
        return { skipped: false };
      },
    });

    await watcher._pollOnce();
    assert.equal(publishCalls, 0);
    const journal = loadJournal(stateDir, fs.readFileSync, fs.existsSync);
    assert.equal(isTerminalRecord(journal.records.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa), false);

    now += 61_000;
    await watcher._pollOnce();
    assert.equal(publishCalls, 1);
    const journalAfter = loadJournal(stateDir, fs.readFileSync, fs.existsSync);
    assert.equal(isTerminalRecord(journalAfter.records.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa), true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('still stops on AUTH_FAILED and distinguishes it from rate limit', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-auth-'));
    const requestPath = path.join(root, 'briefing-request.json');
    const snapshotPath = path.join(root, 'tactical-live.yaml');
    const stateDir = path.join(root, 'state');
    fs.writeFileSync(snapshotPath, FIXTURE_V4, 'utf8');
    fs.writeFileSync(requestPath, `${JSON.stringify(makeBriefingRequest({
      request_id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    }), null, 2)}\n`, 'utf8');

    const watcher = new BriefingWatcher({
      requestPath,
      snapshotPath,
      stateDir,
      ackDir: root,
      dryRun: false,
      log: () => {},
      publishRelayState: async () => {
        const error = new Error('GitHub authentication failed.');
        error.code = 'AUTH_FAILED';
        throw error;
      },
    });
    watcher.start();
    await watcher._pollOnce();
    assert.equal(watcher.running, false);
    const ack = JSON.parse(fs.readFileSync(path.join(root, 'briefing-ack.json'), 'utf8'));
    assert.equal(ack.error_code, 'AUTH_FAILED');

    const rate = normalizeGhApiExecError(Object.assign(new Error('x'), {
      stderr: 'gh: API rate limit exceeded (HTTP 403)',
    }));
    assert.equal(rate.code, 'RATE_LIMIT');
    assert.notEqual(rate.code, 'AUTH_FAILED');
    fs.rmSync(root, { recursive: true, force: true });
  });
});
