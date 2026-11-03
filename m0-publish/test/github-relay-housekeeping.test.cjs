'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');
const {
  readRemoteContentMeta,
  readRemoteContentFile,
  deleteRemoteContentFile,
  normalizeGhApiExecError,
  createGhApiExec,
} = require('../lib/github-relay.cjs');
const {
  evaluateRemoteCommandRetirement,
  remoteResultMatchesCommand,
} = require('../lib/command-relay-retirement.cjs');
const { CommandRelayWatcher, localRelayPaths } = require('../lib/command-relay-watcher.cjs');
const { loadCommandJournal } = require('../lib/command-journal.cjs');
const { assessInboundDeliverySafety } = require('../lib/companion-relay-launcher.cjs');
const { loadAndValidateSnapshotFromText } = require('../lib/tactical-publish.cjs');
const { TerrainQueryRelayWatcher } = require('../lib/terrain-query-relay-watcher.cjs');

const FIXTURE_V5 = path.join(__dirname, 'fixtures', 'valid-v5.yaml');

describe('github relay idle reads (M1-22C)', () => {
  it('returns null for missing remote content without surfacing NOT_FOUND as operational failure', () => {
    const ghApi = (method) => {
      if (method === 'GET') {
        const error = new Error('Command failed');
        error.stderr = 'gh: Not Found (HTTP 404)';
        throw error;
      }
      throw new Error(`unexpected ${method}`);
    };
    const deps = { ghApi, repo: 'o/r', branch: 'main' };
    assert.equal(readRemoteContentMeta(deps, 'm0/tactical-command.json'), null);
    assert.equal(readRemoteContentFile(deps, 'm0/terrain-query.json', 4096), null);
  });

  it('propagates authentication failures from GitHub reads', () => {
    const ghApi = () => {
      const error = new Error('Command failed');
      error.stderr = 'gh: Bad credentials (HTTP 401)';
      throw error;
    };
    const deps = { ghApi, repo: 'o/r', branch: 'main' };
    assert.throws(
      () => readRemoteContentMeta(deps, 'm0/tactical-command.json'),
      (error) => error.code === 'AUTH_FAILED',
    );
  });

  it('classifies unexpected GitHub exec failures with stderr preserved', () => {
    const raw = new Error('Command failed');
    raw.stderr = 'gh: something broke (HTTP 500)';
    const normalized = normalizeGhApiExecError(raw);
    assert.equal(normalized, raw);
    assert.match(String(normalized.stderr), /500/);
  });

  it('pipes gh stderr so expected 404 does not inherit to process stderr', () => {
    let stderrWrites = 0;
    const execFileSyncImpl = () => {
      const error = new Error('Command failed');
      error.stderr = 'gh: Not Found (HTTP 404)';
      throw error;
    };
    const ghApi = createGhApiExec({ execFileSync: execFileSyncImpl });
    const originalWrite = process.stderr.write;
    process.stderr.write = () => {
      stderrWrites += 1;
      return true;
    };
    try {
      assert.throws(
        () => ghApi('GET', 'repos/o/r/contents/m0/tactical-command.json'),
        (error) => error.code === 'NOT_FOUND',
      );
      assert.equal(stderrWrites, 0);
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  it('treats repeated missing inbox polls as silent idle for command and terrain watchers', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-poll-'));
    const fixtureText = fs.readFileSync(FIXTURE_V5, 'utf8');
    const snapshotPath = path.join(root, 'tactical-live.yaml');
    fs.writeFileSync(snapshotPath, fixtureText, 'utf8');
    const logs = [];
    const commandWatcher = new CommandRelayWatcher({
      snapshotPath,
      stateDir: path.join(root, 'state'),
      dryRun: true,
      log: (line) => logs.push(line),
      readRemoteCommand: async () => null,
    });
    const terrainWatcher = new TerrainQueryRelayWatcher({
      snapshotPath,
      stateDir: path.join(root, 'state-q'),
      dryRun: true,
      log: (line) => logs.push(line),
      readRemoteQuery: async () => null,
    });
    for (let i = 0; i < 25; i += 1) {
      await commandWatcher._pollOnce();
      await terrainWatcher._pollOnce();
    }
    assert.ok(!logs.some((line) => /404|Not Found/i.test(line)));
    assert.ok(!logs.some((line) => /read failed/i.test(line)));
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('remote command retirement (M1-22C)', () => {
  it('requires matching command and terminal result identity', () => {
    const match = remoteResultMatchesCommand(
      { command_id: 'abc', status: 'COMPLETED' },
      'abc',
      'COMPLETED',
    );
    assert.equal(match.ok, true);
    const mismatch = remoteResultMatchesCommand(
      { command_id: 'abc', status: 'COMPLETED' },
      'abc',
      'FAILED',
    );
    assert.equal(mismatch.ok, false);
  });

  it('refuses automatic delete when journaled remote_sha256 is missing', () => {
    const record = {
      command_id: 'move-no-sha',
      phase: 'published_terminal',
      status: 'REJECTED',
    };
    const decision = evaluateRemoteCommandRetirement({
      record,
      localResult: null,
      remoteCommandMeta: { text: '{}', sha: 'live-sha' },
      remoteCommandValue: { command_id: 'move-no-sha' },
      remoteResultValue: { command_id: 'move-no-sha', status: 'REJECTED' },
    });
    assert.equal(decision.action, 'fail_closed');
    assert.equal(decision.reason, 'missing_journaled_remote_sha');
    assert.match(decision.operatorMessage, /Manually remove m0\/tactical-command.json/);
  });

  it('dry-run logs intended retirement without persisting retired_remote', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retire-dryrun-'));
    const fixtureText = fs.readFileSync(FIXTURE_V5, 'utf8');
    const snapshotPath = path.join(root, 'tactical-live.yaml');
    fs.writeFileSync(snapshotPath, fixtureText, 'utf8');
    const stateDir = path.join(root, 'state');
    const logs = [];
    const watcher = new CommandRelayWatcher({
      snapshotPath,
      stateDir,
      dryRun: true,
      log: (line) => logs.push(line),
      readRemoteCommand: async () => ({ text: '{"command_id":"move-dry"}\n', sha: 'sha-dry' }),
      fetchRemoteResult: async () => ({ value: { command_id: 'move-dry', status: 'COMPLETED' } }),
      retireRemoteCommand: async () => {
        throw new Error('dry-run must not call retireRemoteCommand');
      },
    });
    const journal = loadCommandJournal(stateDir);
    markPublished(journal, 'move-dry', 'sha-dry');
    persist(root, stateDir, journal);

    await watcher._maybeRetireRemoteCommand(loadCommandJournal(stateDir), 'move-dry', {
      command_id: 'move-dry',
      status: 'COMPLETED',
    });
    await watcher._maybeRetireRemoteCommand(loadCommandJournal(stateDir), 'move-dry', {
      command_id: 'move-dry',
      status: 'COMPLETED',
    });
    const after = loadCommandJournal(stateDir);
    assert.equal(after.records['move-dry'].phase, 'published_terminal');
    assert.equal(after.records['move-dry'].remote_sha256, 'sha-dry');
    assert.ok(logs.some((line) => line.includes('Dry-run would retire')));
    assert.equal(logs.filter((line) => line.includes('Dry-run would retire')).length, 2);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('fail-closed missing SHA logs once and keeps published_terminal across polls', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retire-nosha-'));
    const fixtureText = fs.readFileSync(FIXTURE_V5, 'utf8');
    const snapshotPath = path.join(root, 'tactical-live.yaml');
    fs.writeFileSync(snapshotPath, fixtureText, 'utf8');
    const stateDir = path.join(root, 'state');
    const logs = [];
    let deleteCalls = 0;
    const watcher = new CommandRelayWatcher({
      snapshotPath,
      stateDir,
      dryRun: false,
      log: (line) => logs.push(line),
      readRemoteCommand: async () => ({ text: '{"command_id":"move-nosha"}\n', sha: 'sha-live' }),
      fetchRemoteResult: async () => ({ value: { command_id: 'move-nosha', status: 'REJECTED' } }),
      retireRemoteCommand: async () => {
        deleteCalls += 1;
      },
    });
    const journal = loadCommandJournal(stateDir);
    journal.records['move-nosha'] = {
      command_id: 'move-nosha',
      phase: 'published_terminal',
      status: 'REJECTED',
      published_at: new Date().toISOString(),
    };
    persist(root, stateDir, journal);

    await watcher._pollOnce();
    await watcher._pollOnce();
    const after = loadCommandJournal(stateDir);
    assert.equal(deleteCalls, 0);
    assert.equal(after.records['move-nosha'].phase, 'published_terminal');
    assert.equal(after.records['move-nosha'].retirement_blocked_reason, 'missing_journaled_remote_sha');
    assert.equal(logs.filter((line) => line.includes('Automatic remote command retirement blocked')).length, 1);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('refuses retirement when remote command id or sha was replaced', () => {
    const record = {
      command_id: 'move-1',
      phase: 'published_terminal',
      status: 'COMPLETED',
      remote_sha256: 'sha-old',
    };
    const replacedId = evaluateRemoteCommandRetirement({
      record,
      localResult: null,
      remoteCommandMeta: { text: '{}', sha: 'sha-old' },
      remoteCommandValue: { command_id: 'move-2' },
      remoteResultValue: { command_id: 'move-1', status: 'COMPLETED' },
    });
    assert.equal(replacedId.action, 'skip');
    assert.equal(replacedId.reason, 'replacement_command_id');

    const replacedSha = evaluateRemoteCommandRetirement({
      record,
      localResult: null,
      remoteCommandMeta: { text: '{}', sha: 'sha-new' },
      remoteCommandValue: { command_id: 'move-1' },
      remoteResultValue: { command_id: 'move-1', status: 'COMPLETED' },
    });
    assert.equal(replacedSha.action, 'skip');
    assert.equal(replacedSha.reason, 'replacement_command_sha');
  });

  it('retires remote command after terminal publication and preserves result evidence', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retire-'));
    const fixtureText = fs.readFileSync(FIXTURE_V5, 'utf8');
    const snapshotPath = path.join(root, 'tactical-live.yaml');
    fs.writeFileSync(snapshotPath, fixtureText, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(fixtureText, YAML);
    const local = localRelayPaths(snapshotPath);
    const stateDir = path.join(root, 'state');
    const deletes = [];
    let remoteCommand = {
      text: `${JSON.stringify({
        schema_version: 1,
        command_id: 'move-retire',
        command_type: 'MOVE',
        actor_unit_id: 1,
        destination: { x: 2, y: 2, z: 0 },
        snapshot_sha256: 'a'.repeat(64),
        session_id: tactical.eventLog.sessionId,
        turn: tactical.turn,
        state_version: tactical.eventLog.latestSeq,
      }, null, 2)}\n`,
      sha: 'cmd-sha-1',
    };
    let remoteResult = null;
    const terminal = {
      schema_version: 1,
      command_id: 'move-retire',
      command_type: 'MOVE',
      status: 'COMPLETED',
      session_id: tactical.eventLog.sessionId,
      turn: tactical.turn,
      destination_reached: true,
    };

    const watcher = new CommandRelayWatcher({
      snapshotPath,
      stateDir,
      dryRun: false,
      log: () => {},
      readRemoteCommand: async () => remoteCommand,
      publishRemoteResult: async (result) => {
        remoteResult = { value: result, sha: 'result-sha' };
      },
      fetchRemoteResult: async () => remoteResult,
      retireRemoteCommand: async (sha, commandId) => {
        deletes.push({ sha, commandId });
        remoteCommand = null;
      },
    });

    fs.writeFileSync(local.result, `${JSON.stringify(terminal, null, 2)}\n`, 'utf8');
    const journal = loadCommandJournal(stateDir);
    markPublished(journal, 'move-retire', 'cmd-sha-1');
    persist(root, stateDir, journal);
    remoteResult = { value: terminal, sha: 'result-sha' };

    await watcher._maybeRetireRemoteCommand(loadCommandJournal(stateDir), 'move-retire', terminal);
    const after = loadCommandJournal(stateDir);
    assert.equal(deletes.length, 1);
    assert.equal(deletes[0].sha, 'cmd-sha-1');
    assert.equal(after.records['move-retire'].phase, 'retired_remote');
    assert.equal(remoteResult.value.status, 'COMPLETED');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('retries GitHub deletion failure without losing published_terminal evidence', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retire-retry-'));
    const fixtureText = fs.readFileSync(FIXTURE_V5, 'utf8');
    const snapshotPath = path.join(root, 'tactical-live.yaml');
    fs.writeFileSync(snapshotPath, fixtureText, 'utf8');
    const stateDir = path.join(root, 'state');
    const remoteCommand = { text: '{"command_id":"move-retry","command_type":"MOVE"}\n', sha: 'sha-retry' };
    let attempts = 0;
    const watcher = new CommandRelayWatcher({
      snapshotPath,
      stateDir,
      dryRun: false,
      log: () => {},
      readRemoteCommand: async () => remoteCommand,
      fetchRemoteResult: async () => ({
        value: { command_id: 'move-retry', status: 'FAILED' },
      }),
      retireRemoteCommand: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('delete failed');
        }
      },
    });
    const journal = loadCommandJournal(stateDir);
    markPublished(journal, 'move-retry', 'sha-retry', 'FAILED');
    persist(root, stateDir, journal);

    await watcher._maybeRetireRemoteCommand(journal, 'move-retry', { command_id: 'move-retry', status: 'FAILED' });
    let after = loadCommandJournal(stateDir);
    assert.equal(after.records['move-retry'].phase, 'published_terminal');

    await watcher._maybeRetireRemoteCommand(after, 'move-retry', { command_id: 'move-retry', status: 'FAILED' });
    after = loadCommandJournal(stateDir);
    assert.equal(attempts, 2);
    assert.equal(after.records['move-retry'].phase, 'retired_remote');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('does not retire on delivered_local phase alone', () => {
    const decision = evaluateRemoteCommandRetirement({
      record: {
        command_id: 'move-live',
        phase: 'delivered_local',
        remote_sha256: 'sha-live',
      },
      localResult: null,
      remoteCommandMeta: { text: '{}', sha: 'sha-live' },
      remoteCommandValue: { command_id: 'move-live' },
      remoteResultValue: { command_id: 'move-live', status: 'EXECUTING' },
    });
    assert.equal(decision.action, 'skip');
    assert.equal(decision.reason, 'not_published_terminal');
  });

  it('deleteRemoteContentFile treats NOT_FOUND as idempotent absence', () => {
    const ghApi = () => {
      const error = new Error('missing');
      error.code = 'NOT_FOUND';
      throw error;
    };
    const out = deleteRemoteContentFile(
      { ghApi, repo: 'o/r', branch: 'main' },
      'm0/tactical-command.json',
      'sha',
      'retire',
    );
    assert.equal(out.alreadyAbsent, true);
  });

  it('retries pending retirement after restart via poll hook', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retire-restart-'));
    const fixtureText = fs.readFileSync(FIXTURE_V5, 'utf8');
    const snapshotPath = path.join(root, 'tactical-live.yaml');
    fs.writeFileSync(snapshotPath, fixtureText, 'utf8');
    const stateDir = path.join(root, 'state');
    let remoteCommand = { text: '{"command_id":"move-restart"}\n', sha: 'sha-restart' };
    const deletes = [];
    const watcher = new CommandRelayWatcher({
      snapshotPath,
      stateDir,
      dryRun: false,
      log: () => {},
      readRemoteCommand: async () => remoteCommand,
      fetchRemoteResult: async () => ({ value: { command_id: 'move-restart', status: 'INTERRUPTED' } }),
      retireRemoteCommand: async (sha) => {
        deletes.push(sha);
        remoteCommand = null;
      },
    });
    const journal = loadCommandJournal(stateDir);
    markPublished(journal, 'move-restart', 'sha-restart', 'INTERRUPTED');
    persist(root, stateDir, journal);

    await watcher._pollOnce();
    const after = loadCommandJournal(stateDir);
    assert.equal(deletes.length, 1);
    assert.equal(after.records['move-restart'].phase, 'retired_remote');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reports safe inbound after successful remote retirement', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-retire-'));
    const snapshotPath = path.join(root, 'tactical-live.yaml');
    fs.copyFileSync(FIXTURE_V5, snapshotPath);
    const inbound = assessInboundDeliverySafety(
      {
        canAcceptNewLocalCommand: true,
        openLocalStatus: null,
        sidecarJournal: {
          value: {
            version: 1,
            active: null,
            records: {
              'move-done': {
                command_id: 'move-done',
                phase: 'retired_remote',
                status: 'COMPLETED',
              },
            },
          },
          active: null,
        },
        command: { exists: false, value: null, parseError: false },
        result: { exists: false, value: null, parseError: false },
      },
      {
        readErrors: [],
        remoteCommand: null,
        parsedCommand: null,
        parsedResult: { command_id: 'move-done', status: 'COMPLETED' },
        remoteResult: { text: '{}', sha: 'result' },
      },
      { snapshotPath },
    );
    assert.equal(inbound.safe, true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

function markPublished(journal, commandId, remoteSha, status = 'COMPLETED') {
  journal.records[commandId] = {
    command_id: commandId,
    phase: 'published_terminal',
    status,
    remote_sha256: remoteSha,
    published_at: new Date().toISOString(),
  };
}

function persist(root, stateDir, journal) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'command-relay-journal.json'),
    `${JSON.stringify(journal)}\n`,
    'utf8',
  );
  void root;
}
