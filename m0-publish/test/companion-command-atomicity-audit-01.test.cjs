'use strict';

/**
 * ASTER-M1-COMMAND-ATOMICITY-AUDIT-01 — bounded simulations (test-only).
 * Simulates AUTO RETRIEVE (CommandRelayWatcher poll) during publication windows.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const YAML = require('yaml');
const { CommandRelayWatcher, localRelayPaths } = require('../lib/command-relay-watcher.cjs');
const { loadAndValidateSnapshotFromText } = require('../lib/tactical-publish.cjs');
const { publishTacticalCommandOnce } = require('../lib/relay-tactical-command-publish.cjs');
const { createGhApiCallLog } = require('../lib/github-api-instrumentation.cjs');
const { buildRelayOptionsFromConfig } = require('../lib/relay-isolation-config.cjs');
const { uniqueAtomicTempPath } = require('../lib/local-atomic.cjs');

function isolatedRelayConfig() {
  return {
    schema_version: 1,
    repo: 'ExampleOrg/OpenXcom-Command-Publish-Test',
    branch: 'main',
    state_path: 'm0-e2e/state.json',
    content_paths: {
      tacticalCommand: 'm0-e2e/tactical-command.json',
      tacticalResult: 'm0-e2e/tactical-result.json',
      terrainQuery: 'm0-e2e/terrain-query.json',
      terrainQueryResult: 'm0-e2e/terrain-query-result.json',
      rulesReference: 'm0-e2e/rules-reference.json',
    },
  };
}

const FIXTURE_V5 = path.join(__dirname, 'fixtures', 'valid-v5.yaml');

function sha256HexLower(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function makeMoveCommand(tactical, digest, overrides = {}) {
  return {
    schema_version: 1,
    command_id: overrides.command_id ?? 'move-atomic-audit-1',
    command_type: 'MOVE',
    actor_unit_id: 1,
    destination: overrides.destination ?? { x: 2, y: 2, z: 0 },
    snapshot_sha256: digest,
    session_id: tactical.eventLog.sessionId,
    turn: tactical.turn,
    state_version: tactical.eventLog.latestSeq,
    ...overrides,
  };
}

function makeHarness(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-atomic-audit-'));
  const fixtureText = fs.readFileSync(FIXTURE_V5, 'utf8');
  const snapshotPath = path.join(root, 'tactical-live.yaml');
  fs.writeFileSync(snapshotPath, fixtureText, 'utf8');
  const tactical = loadAndValidateSnapshotFromText(fixtureText, YAML);
  const digest = sha256HexLower(Buffer.from(fixtureText, 'utf8'));
  const local = localRelayPaths(snapshotPath);
  const publishes = [];

  const watcher = new CommandRelayWatcher({
    snapshotPath,
    stateDir: path.join(root, 'state'),
    dryRun: options.dryRun ?? true,
    pollIntervalMs: 5,
    log: () => {},
    readRemoteCommand: options.readRemoteCommand ?? (async () => null),
    publishRemoteResult: async (result) => {
      publishes.push(result);
    },
    readFileSync: fs.readFileSync,
    existsSync: fs.existsSync,
    writeFileSync: fs.writeFileSync,
    renameSync: fs.renameSync,
    unlinkSync: fs.unlinkSync,
  });

  return {
    root,
    tactical,
    digest,
    local,
    publishes,
    watcher,
    remoteFrom(command) {
      return {
        text: `${JSON.stringify(command, null, 2)}\n`,
        sha: crypto.createHash('sha256').update(JSON.stringify(command)).digest('hex'),
      };
    },
  };
}

describe('ASTER-M1-COMMAND-ATOMICITY-AUDIT-01 simulations', () => {
  it('AUTO RETRIEVE poll during publication: no local inbox until remote blob is complete', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-atomic-pub-window-'));
    const fixtureText = fs.readFileSync(FIXTURE_V5, 'utf8');
    const snapshotPath = path.join(root, 'tactical-live.yaml');
    fs.writeFileSync(snapshotPath, fixtureText, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(fixtureText, YAML);
    const digest = sha256HexLower(Buffer.from(fixtureText, 'utf8'));
    const cmd = makeMoveCommand(tactical, digest, { command_id: 'pub-window-1' });
    const local = localRelayPaths(snapshotPath);
    let remoteVisible = false;

    const watcher = new CommandRelayWatcher({
      snapshotPath,
      stateDir: path.join(root, 'state'),
      dryRun: true,
      log: () => {},
      readRemoteCommand: async () => (remoteVisible
        ? {
          text: `${JSON.stringify(cmd, null, 2)}\n`,
          sha: 'remote-sha-1',
        }
        : null),
      readFileSync: fs.readFileSync,
      existsSync: fs.existsSync,
      writeFileSync: fs.writeFileSync,
      renameSync: fs.renameSync,
      unlinkSync: fs.unlinkSync,
    });

    await watcher._pollOnce();
    assert.ok(!fs.existsSync(local.command), 'in-flight publication must not produce local inbox');

    remoteVisible = true;
    await watcher._pollOnce();
    assert.ok(fs.existsSync(local.command), 'complete remote blob delivers exactly once');
    const localCmd = JSON.parse(fs.readFileSync(local.command, 'utf8'));
    assert.equal(localCmd.command_id, 'pub-window-1');

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('failed GitHub publication: polls never create local tactical-command.json', async () => {
    const h = makeHarness({
      readRemoteCommand: async () => null,
    });
    await h.watcher._pollOnce();
    await h.watcher._pollOnce();
    assert.ok(!fs.existsSync(h.local.command));
    fs.rmSync(h.root, { recursive: true, force: true });
  });

  it('truncated remote JSON is rejected before deliverLocal', async () => {
    const h = makeHarness({ dryRun: false });
    h.watcher.readRemoteCommand = async () => ({
      text: '{ "command_id": "truncated", "command_type": "MOVE"',
      sha: 'bad-sha',
    });
    await h.watcher._pollOnce();
    assert.ok(!fs.existsSync(h.local.command));
    assert.equal(h.publishes.length, 1);
    assert.equal(h.publishes[0].status, 'REJECTED');
    fs.rmSync(h.root, { recursive: true, force: true });
  });

  it('concurrent _pollOnce calls do not double-deliver (_inFlight)', async () => {
    const h = makeHarness();
    const cmd = makeMoveCommand(h.tactical, h.digest, { command_id: 'concurrent-poll-1' });
    const remote = h.remoteFrom(cmd);
    let readCount = 0;
    h.watcher.readRemoteCommand = async () => {
      readCount += 1;
      await new Promise((r) => setTimeout(r, 15));
      return remote;
    };
    await Promise.all([h.watcher._pollOnce(), h.watcher._pollOnce()]);
    assert.ok(fs.existsSync(h.local.command));
    const body = fs.readFileSync(h.local.command, 'utf8');
    assert.equal(JSON.parse(body).command_id, 'concurrent-poll-1');
    fs.rmSync(h.root, { recursive: true, force: true });
  });

  it('journal.active blocks accepting a different remote command_id', async () => {
    const h = makeHarness();
    const first = makeMoveCommand(h.tactical, h.digest, { command_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    const second = makeMoveCommand(h.tactical, h.digest, { command_id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' });
    h.watcher.readRemoteCommand = async () => h.remoteFrom(first);
    await h.watcher._pollOnce();
    assert.ok(fs.existsSync(h.local.command));

    h.watcher.readRemoteCommand = async () => h.remoteFrom(second);
    const journal = h.watcher.loadJournal();
    assert.equal(journal.active.command_id, first.command_id);
    await h.watcher._pollOnce();
    const still = JSON.parse(fs.readFileSync(h.local.command, 'utf8'));
    assert.equal(still.command_id, first.command_id);
    fs.rmSync(h.root, { recursive: true, force: true });
  });

  it('ambiguous failed GitHub publication leaves remote empty (no executable inbox)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-atomic-failed-put-'));
    const cmd = makeMoveCommand(
      loadAndValidateSnapshotFromText(fs.readFileSync(FIXTURE_V5, 'utf8'), YAML),
      sha256HexLower(Buffer.from(fs.readFileSync(FIXTURE_V5, 'utf8'), 'utf8')),
      { command_id: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' },
    );
    const localPath = path.join(root, 'draft.json');
    fs.writeFileSync(localPath, `${JSON.stringify(cmd, null, 2)}\n`, 'utf8');
    const contentPath = 'm0-e2e/tactical-command.json';
    const apiCallLog = createGhApiCallLog();
    const ghApi = (method, apiPath) => {
      if (method === 'GET') {
        apiCallLog.record(method, apiPath, { http_status: 404, outcome: 'response' });
        const err = new Error('Not Found');
        err.stderr = 'HTTP/2.0 404 Not Found';
        throw err;
      }
      if (method === 'PUT') {
        apiCallLog.record(method, apiPath, { http_status: 503, outcome: 'error' });
        const err = new Error('network');
        err.code = 'NETWORK_FAILED';
        err.stderr = 'HTTP/2.0 503 Service Unavailable';
        throw err;
      }
      throw new Error('unsupported');
    };
    await assert.rejects(
      () => publishTacticalCommandOnce({
        localPath,
        publish: true,
        relayOptions: { ...buildRelayOptionsFromConfig(isolatedRelayConfig()), ghApi },
        apiCallLog,
        requireGhAuth: false,
      }),
    );
    const puts = apiCallLog.entries.filter((e) => e.method === 'PUT');
    assert.ok(puts.length >= 1);
    assert.equal(puts.every((e) => e.http_status === 503), true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('deliverLocal uses tmp sibling; inbox path absent while only tmp exists', async () => {
    const h = makeHarness();
    const cmd = makeMoveCommand(h.tactical, h.digest);
    const serialized = `${JSON.stringify(cmd, null, 2)}\n`;
    const tmp = uniqueAtomicTempPath(h.local.command);
    fs.mkdirSync(path.dirname(h.local.command), { recursive: true });
    fs.writeFileSync(tmp, serialized.slice(0, 40), 'utf8');
    assert.ok(!fs.existsSync(h.local.command));
    h.watcher.readRemoteCommand = async () => h.remoteFrom(cmd);
    await h.watcher._pollOnce();
    assert.ok(fs.existsSync(h.local.command));
    assert.equal(JSON.parse(fs.readFileSync(h.local.command, 'utf8')).command_id, cmd.command_id);
    fs.rmSync(h.root, { recursive: true, force: true });
  });
});