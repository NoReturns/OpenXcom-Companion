'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  publishTacticalCommandOnce,
  TacticalCommandPublishError,
  loadLocalTacticalCommandFromFile,
} = require('../lib/relay-tactical-command-publish.cjs');
const { createGhApiCallLog } = require('../lib/github-api-instrumentation.cjs');
const { buildRelayOptionsFromConfig } = require('../lib/relay-isolation-config.cjs');
const {
  fingerprintProductionCommandRelayJournal,
  assertProductionCommandRelayJournalUnchanged,
} = require('../lib/relay-test-isolation.cjs');

const snapshotSha = 'a'.repeat(64);
const sessionId = 'c'.repeat(32);

function sampleMoveCommand(overrides = {}) {
  return {
    schema_version: 1,
    command_id: '97a6f6341b214b53a9d55f761e5b4c31',
    command_type: 'MOVE',
    actor_unit_id: 4,
    destination: { x: 34, y: 25, z: 0 },
    snapshot_sha256: snapshotSha,
    session_id: sessionId,
    turn: 6,
    state_version: 56,
    ...overrides,
  };
}

function sampleAutoShotCommand(overrides = {}) {
  return {
    schema_version: 1,
    command_id: 'auto-shot-p1-active-hand',
    command_type: 'AUTO_SHOT',
    actor_unit_id: 4,
    target: { x: 10, y: 10, z: 0 },
    snapshot_sha256: snapshotSha,
    session_id: sessionId,
    turn: 6,
    state_version: 56,
    ...overrides,
  };
}

const PUBLISH_CLI = path.join(__dirname, '..', 'publish-tactical-command-once.cjs');

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

function createMockGhApi(options = {}) {
  const files = options.files ?? new Map();
  const apiCallLog = createGhApiCallLog();
  const branch = options.branch ?? 'main';
  let putFailOnce = options.putFailOnce ?? null;
  let putAlwaysFail = options.putAlwaysFail ?? null;

  function contentPathFromApi(apiPath) {
    const marker = '/contents/';
    const idx = apiPath.indexOf(marker);
    if (idx === -1) {
      return null;
    }
    return decodeURIComponent(apiPath.slice(idx + marker.length).split('?')[0]);
  }

  function assertRefMain(apiPath) {
    if (apiPath.includes('/contents/') && apiPath.includes('?')) {
      assert.match(apiPath, /[?&]ref=main(?:&|$)/);
    }
  }

  const ghApi = (method, apiPath, body) => {
    assertRefMain(apiPath);
    if (method === 'GET') {
      const contentPath = contentPathFromApi(apiPath);
      const entry = files.get(contentPath);
      if (!entry) {
        const err = new Error('Not Found');
        err.stderr = 'HTTP/2.0 404 Not Found';
        apiCallLog.record(method, apiPath, { http_status: 404, outcome: 'error' });
        throw err;
      }
      apiCallLog.record(method, apiPath, { http_status: 200, outcome: 'response' });
      return {
        type: 'file',
        encoding: 'base64',
        sha: entry.sha,
        content: entry.contentB64,
      };
    }
    if (method === 'PUT') {
      const contentPath = contentPathFromApi(apiPath);
      if (putAlwaysFail) {
        apiCallLog.record(method, apiPath, { http_status: putAlwaysFail.status, outcome: 'error' });
        const err = new Error(putAlwaysFail.message || 'PUT failed');
        err.stderr = putAlwaysFail.stderr || `HTTP/2.0 ${putAlwaysFail.status}`;
        if (putAlwaysFail.code) {
          err.code = putAlwaysFail.code;
        }
        throw err;
      }
      if (putFailOnce) {
        const spec = putFailOnce;
        putFailOnce = null;
        apiCallLog.record(method, apiPath, { http_status: spec.status, outcome: 'error' });
        const err = new Error(spec.message || 'PUT failed');
        err.stderr = spec.stderr || `HTTP/2.0 ${spec.status}`;
        if (spec.code) {
          err.code = spec.code;
        }
        if (spec.writeDespiteError) {
          files.set(contentPath, {
            sha: 'd'.repeat(40),
            contentB64: body.content,
            text: Buffer.from(body.content, 'base64').toString('utf8'),
          });
        }
        throw err;
      }
      if (body.sha) {
        apiCallLog.record(method, apiPath, { http_status: 409, outcome: 'error' });
        const err = new Error('Conflict');
        err.stderr = 'HTTP/2.0 409 Conflict';
        throw err;
      }
      files.set(contentPath, {
        sha: 'e'.repeat(40),
        contentB64: body.content,
        text: Buffer.from(body.content, 'base64').toString('utf8'),
      });
      apiCallLog.record(method, apiPath, { http_status: 201, outcome: 'response' });
      return { content: { sha: 'e'.repeat(40) } };
    }
    throw new Error(`Unsupported mock ${method} ${apiPath}`);
  };

  return { ghApi, apiCallLog, files, branch };
}

function writeLocalCommand(root, command) {
  const localPath = path.join(root, 'tactical-command.json');
  fs.writeFileSync(localPath, `${JSON.stringify(command, null, 2)}\n`, 'utf8');
  return localPath;
}

describe('relay-tactical-command-publish (M1 Step 1)', () => {
  let productionJournalBefore;

  before(() => {
    productionJournalBefore = fingerprintProductionCommandRelayJournal();
  });

  after(() => {
    assertProductionCommandRelayJournalUnchanged(
      productionJournalBefore,
      fingerprintProductionCommandRelayJournal(),
    );
  });

  it('creates command on empty inbox (GET 404 then PUT 201)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-pub-empty-'));
    const localPath = writeLocalCommand(root, sampleMoveCommand());
    const { ghApi, apiCallLog, files } = createMockGhApi();
    const relayOptions = {
      ...buildRelayOptionsFromConfig(isolatedRelayConfig()),
      ghApi,
      branch: 'main',
    };

    const outcome = await publishTacticalCommandOnce({
      localPath,
      publish: true,
      dryRun: false,
      relayOptions,
      apiCallLog,
      requireGhAuth: false,
    });

    assert.equal(outcome.ok, true);
    assert.equal(outcome.skipped, false);
    assert.equal(outcome.created, true);
    assert.equal(outcome.remotePath, 'm0-e2e/tactical-command.json');
    assert.ok(files.has('m0-e2e/tactical-command.json'));
    assert.equal(apiCallLog.countApiCalls(), 2);
    assert.deepEqual(
      apiCallLog.entries.map((e) => ({ method: e.method, http_status: e.http_status })),
      [
        { method: 'GET', http_status: 404 },
        { method: 'PUT', http_status: 201 },
      ],
    );
    assert.equal(outcome.github_api_put_success, true);
  });

  it('rejects occupied inbox without PUT', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-pub-occ-'));
    const localPath = writeLocalCommand(root, sampleMoveCommand());
    const occupied = sampleMoveCommand({ command_id: 'other-command-id-000000000001' });
    const { ghApi, apiCallLog, files } = createMockGhApi({
      files: new Map([
        ['m0-e2e/tactical-command.json', {
          sha: 'f'.repeat(40),
          contentB64: Buffer.from(`${JSON.stringify(occupied, null, 2)}\n`, 'utf8').toString('base64'),
          text: `${JSON.stringify(occupied, null, 2)}\n`,
        }],
      ]),
    });
    const relayOptions = { ...buildRelayOptionsFromConfig(isolatedRelayConfig()), ghApi };

    await assert.rejects(
      () => publishTacticalCommandOnce({
        localPath,
        publish: true,
        relayOptions,
        apiCallLog,
        requireGhAuth: false,
      }),
      (err) => err instanceof TacticalCommandPublishError && err.code === 'inbox_occupied',
    );
    assert.equal(apiCallLog.countApiCalls(), 1);
    assert.equal(apiCallLog.entries[0].method, 'GET');
    assert.equal(files.get('m0-e2e/tactical-command.json').text.includes('other-command'), true);
  });

  it('skips when remote already matches command_id and body', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-pub-skip-'));
    const command = sampleMoveCommand();
    const localPath = writeLocalCommand(root, command);
    const { ghApi, apiCallLog } = createMockGhApi({
      files: new Map([
        ['m0-e2e/tactical-command.json', {
          sha: 'a'.repeat(40),
          contentB64: Buffer.from(`${JSON.stringify(command, null, 2)}\n`, 'utf8').toString('base64'),
          text: `${JSON.stringify(command, null, 2)}\n`,
        }],
      ]),
    });
    const relayOptions = { ...buildRelayOptionsFromConfig(isolatedRelayConfig()), ghApi };

    const outcome = await publishTacticalCommandOnce({
      localPath,
      publish: true,
      relayOptions,
      apiCallLog,
      requireGhAuth: false,
    });

    assert.equal(outcome.skipped, true);
    assert.equal(outcome.reason, 'remote_unchanged');
    assert.equal(apiCallLog.countApiCalls(), 1);
  });

  it('reports sha_conflict when PUT 409 races on previously empty inbox', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-pub-race-409-'));
    const localPath = writeLocalCommand(root, sampleMoveCommand());
    const other = sampleMoveCommand({ command_id: 'cccccccccccccccccccccccccccccccc' });
    const files = new Map();
    const apiCallLog = createGhApiCallLog();
    const ghApi = (method, apiPath, body) => {
      const contentPath = 'm0-e2e/tactical-command.json';
      if (method === 'GET') {
        apiCallLog.record(method, apiPath, { http_status: files.has(contentPath) ? 200 : 404, outcome: 'response' });
        if (!files.has(contentPath)) {
          const err = new Error('Not Found');
          err.stderr = 'HTTP/2.0 404 Not Found';
          throw err;
        }
        const entry = files.get(contentPath);
        return {
          type: 'file',
          encoding: 'base64',
          sha: entry.sha,
          content: entry.contentB64,
        };
      }
      if (method === 'PUT') {
        files.set(contentPath, {
          sha: '2'.repeat(40),
          contentB64: Buffer.from(`${JSON.stringify(other, null, 2)}\n`, 'utf8').toString('base64'),
          text: `${JSON.stringify(other, null, 2)}\n`,
        });
        apiCallLog.record(method, apiPath, { http_status: 409, outcome: 'error' });
        const err = new Error('Conflict');
        err.stderr = 'HTTP/2.0 409 Conflict';
        throw err;
      }
      throw new Error('unsupported');
    };
    const relayOptions = { ...buildRelayOptionsFromConfig(isolatedRelayConfig()), ghApi };

    await assert.rejects(
      () => publishTacticalCommandOnce({
        localPath,
        publish: true,
        relayOptions,
        apiCallLog,
        requireGhAuth: false,
      }),
      (err) => err.code === 'inbox_occupied' && err.remote_command_id === other.command_id,
    );
    assert.equal(apiCallLog.entries.filter((e) => e.method === 'PUT').length, 1);
  });

  it('surfaces SHA conflict without overwriting occupied inbox', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-pub-409-'));
    const localPath = writeLocalCommand(root, sampleMoveCommand());
    const other = sampleMoveCommand({ command_id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' });
    const { ghApi, apiCallLog } = createMockGhApi({
      files: new Map([
        ['m0-e2e/tactical-command.json', {
          sha: '1'.repeat(40),
          contentB64: Buffer.from(`${JSON.stringify(other, null, 2)}\n`, 'utf8').toString('base64'),
          text: `${JSON.stringify(other, null, 2)}\n`,
        }],
      ]),
    });
    const relayOptions = { ...buildRelayOptionsFromConfig(isolatedRelayConfig()), ghApi };

    await assert.rejects(
      () => publishTacticalCommandOnce({
        localPath,
        publish: true,
        relayOptions,
        apiCallLog,
        requireGhAuth: false,
      }),
      (err) => err.code === 'inbox_occupied',
    );
    assert.equal(apiCallLog.entries.some((e) => e.method === 'PUT'), false);
  });

  it('distinguishes rate limiting from empty inbox', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-pub-429-'));
    const localPath = writeLocalCommand(root, sampleMoveCommand());
    const apiCallLog = createGhApiCallLog();
    const ghApi = (method, apiPath) => {
      if (method === 'GET') {
        apiCallLog.record(method, apiPath, { http_status: 429, outcome: 'error' });
        const err = new Error('rate limit');
        err.code = 'RATE_LIMIT';
        err.stderr = 'HTTP/2.0 429 Too Many Requests\nrate limit exceeded';
        throw err;
      }
      throw new Error('unexpected');
    };
    const relayOptions = { ...buildRelayOptionsFromConfig(isolatedRelayConfig()), ghApi };

    await assert.rejects(
      () => publishTacticalCommandOnce({
        localPath,
        publish: true,
        relayOptions,
        apiCallLog,
        requireGhAuth: false,
      }),
      (err) => err.code === 'rate_limit',
    );
    assert.equal(apiCallLog.entries[0].http_status, 429);
  });

  it('ambiguous PUT recovery requires identical content, not command_id alone', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-pub-ambig-mismatch-'));
    const command = sampleMoveCommand();
    const localPath = writeLocalCommand(root, command);
    const remoteVariant = sampleMoveCommand({ destination: { x: 33, y: 27, z: 0 } });
    const apiCallLog = createGhApiCallLog();
    const store = new Map();
    const contentPath = 'm0-e2e/tactical-command.json';
    const ghApi = (method, apiPath, body) => {
      if (method === 'GET') {
        apiCallLog.record(method, apiPath, { http_status: store.has(contentPath) ? 200 : 404, outcome: 'response' });
        if (!store.has(contentPath)) {
          const err = new Error('Not Found');
          err.stderr = 'HTTP/2.0 404 Not Found';
          throw err;
        }
        const entry = store.get(contentPath);
        return { type: 'file', encoding: 'base64', sha: entry.sha, content: entry.contentB64 };
      }
      if (method === 'PUT') {
        store.set(contentPath, {
          sha: 'b'.repeat(40),
          contentB64: Buffer.from(`${JSON.stringify(remoteVariant, null, 2)}\n`, 'utf8').toString('base64'),
        });
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
      (err) => err.code === 'inbox_occupied' && err.remote_command_id === command.command_id,
    );
    assert.equal(apiCallLog.entries.filter((e) => e.method === 'PUT').length, 1);
    assert.doesNotMatch(
      Buffer.from(store.get(contentPath).contentB64, 'base64').toString('utf8'),
      /"x": 34,\n\s+"y": 25/,
    );
  });

  it('treats HTTP 422 occupied inbox like 409 and never overwrites competing command', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-pub-422-'));
    const localPath = writeLocalCommand(root, sampleMoveCommand());
    const competing = sampleMoveCommand({ command_id: 'dddddddddddddddddddddddddddddddd' });
    const store = new Map();
    const apiCallLog = createGhApiCallLog();
    const contentPath = 'm0-e2e/tactical-command.json';
    const ghApi = (method, apiPath, body) => {
      if (method === 'GET') {
        apiCallLog.record(method, apiPath, { http_status: store.has(contentPath) ? 200 : 404, outcome: 'response' });
        if (!store.has(contentPath)) {
          const err = new Error('Not Found');
          err.stderr = 'HTTP/2.0 404 Not Found';
          throw err;
        }
        const entry = store.get(contentPath);
        return { type: 'file', encoding: 'base64', sha: entry.sha, content: entry.contentB64 };
      }
      if (method === 'PUT') {
        store.set(contentPath, {
          sha: '3'.repeat(40),
          contentB64: Buffer.from(`${JSON.stringify(competing, null, 2)}\n`, 'utf8').toString('base64'),
        });
        apiCallLog.record(method, apiPath, { http_status: 422, outcome: 'error' });
        const err = new Error('Validation Failed');
        err.stderr = 'HTTP/2.0 422 Unprocessable Entity\n{"message":"Invalid request"}';
        throw err;
      }
      throw new Error('unsupported');
    };
    const relayOptions = { ...buildRelayOptionsFromConfig(isolatedRelayConfig()), ghApi };

    await assert.rejects(
      () => publishTacticalCommandOnce({
        localPath,
        publish: true,
        relayOptions,
        apiCallLog,
        requireGhAuth: false,
      }),
      (err) => err.code === 'inbox_occupied' && err.remote_command_id === competing.command_id,
    );
    const remoteText = Buffer.from(store.get(contentPath).contentB64, 'base64').toString('utf8');
    assert.match(remoteText, /dddddddddddddddddddddddddddddddd/);
    assert.equal(apiCallLog.entries.filter((e) => e.method === 'PUT').length, 1);
  });

  it('verifies command_id and content after ambiguous PUT failure and avoids duplicate publish', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-pub-ambig-'));
    const command = sampleMoveCommand();
    const localPath = writeLocalCommand(root, command);
    const { ghApi, apiCallLog } = createMockGhApi({
      putFailOnce: {
        status: 503,
        message: 'network',
        code: 'NETWORK_FAILED',
        stderr: 'HTTP/2.0 503 Service Unavailable',
        writeDespiteError: true,
      },
    });
    const relayOptions = { ...buildRelayOptionsFromConfig(isolatedRelayConfig()), ghApi };

    const outcome = await publishTacticalCommandOnce({
      localPath,
      publish: true,
      relayOptions,
      apiCallLog,
      requireGhAuth: false,
    });

    assert.equal(outcome.verified_idempotent, true);
    assert.equal(outcome.skipped, true);
    assert.equal(apiCallLog.entries.filter((e) => e.method === 'PUT').length, 1);
    assert.equal(apiCallLog.entries.filter((e) => e.method === 'GET').length, 2);
  });

  it('dry-run validates local JSON without GitHub calls', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-pub-dry-'));
    const localPath = writeLocalCommand(root, sampleMoveCommand());
    const { ghApi, apiCallLog } = createMockGhApi();

    const outcome = await publishTacticalCommandOnce({
      localPath,
      dryRun: true,
      relayOptions: { ...buildRelayOptionsFromConfig(isolatedRelayConfig()), ghApi },
      apiCallLog,
    });

    assert.equal(outcome.dryRun, true);
    assert.equal(apiCallLog.countApiCalls(), 0);
  });
});

describe('AUTO_SHOT active_hand publish validation (P1-AUTO-01)', () => {
  it('loadLocalTacticalCommandFromFile surfaces invalid active_hand for malformed AUTO_SHOT', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-hand-malformed-'));
    const missingPath = writeLocalCommand(root, sampleAutoShotCommand());
    assert.throws(
      () => loadLocalTacticalCommandFromFile(missingPath),
      (err) => {
        assert.ok(err instanceof TacticalCommandPublishError);
        assert.equal(err.code, 'invalid_command');
        assert.equal(err.message, 'invalid active_hand');
        return true;
      },
    );

    const wrongTokenPath = writeLocalCommand(
      fs.mkdtempSync(path.join(os.tmpdir(), 'auto-hand-wrong-')),
      sampleAutoShotCommand({ active_hand: 'right' }),
    );
    assert.throws(
      () => loadLocalTacticalCommandFromFile(wrongTokenPath),
      (err) => err instanceof TacticalCommandPublishError
        && err.code === 'invalid_command'
        && err.message === 'invalid active_hand',
    );
  });

  it('loadLocalTacticalCommandFromFile accepts STR_RIGHT_HAND and STR_LEFT_HAND', () => {
    for (const activeHand of ['STR_RIGHT_HAND', 'STR_LEFT_HAND']) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `auto-hand-ok-${activeHand}-`));
      const localPath = writeLocalCommand(root, sampleAutoShotCommand({ active_hand: activeHand }));
      const loaded = loadLocalTacticalCommandFromFile(localPath);
      assert.equal(loaded.command.active_hand, activeHand);
      assert.equal(loaded.command.command_type, 'AUTO_SHOT');
    }
  });

  it('dry-run accepts valid AUTO_SHOT and makes no GitHub calls', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-hand-dry-'));
    const localPath = writeLocalCommand(
      root,
      sampleAutoShotCommand({ active_hand: 'STR_RIGHT_HAND' }),
    );
    const { ghApi, apiCallLog } = createMockGhApi();
    const outcome = await publishTacticalCommandOnce({
      localPath,
      dryRun: true,
      relayOptions: { ...buildRelayOptionsFromConfig(isolatedRelayConfig()), ghApi },
      apiCallLog,
    });
    assert.equal(outcome.dryRun, true);
    assert.equal(outcome.command_type, 'AUTO_SHOT');
    assert.equal(apiCallLog.countApiCalls(), 0);
  });

  it('dry-run rejects malformed AUTO_SHOT without GitHub calls', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-hand-dry-bad-'));
    const localPath = writeLocalCommand(root, sampleAutoShotCommand());
    const { ghApi, apiCallLog } = createMockGhApi();
    await assert.rejects(
      () => publishTacticalCommandOnce({
        localPath,
        dryRun: true,
        relayOptions: { ...buildRelayOptionsFromConfig(isolatedRelayConfig()), ghApi },
        apiCallLog,
      }),
      (err) => err instanceof TacticalCommandPublishError
        && err.code === 'invalid_command'
        && err.message === 'invalid active_hand',
    );
    assert.equal(apiCallLog.countApiCalls(), 0);
  });

  it('CLI dry-run reports invalid_command and invalid active_hand for missing active_hand', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-hand-cli-'));
    const localPath = writeLocalCommand(root, sampleAutoShotCommand());
    const result = spawnSync(process.execPath, [PUBLISH_CLI, '--dry-run', '--path', localPath], {
      encoding: 'utf8',
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    });
    assert.notEqual(result.status, 0);
    const stderr = result.stderr.trim();
    assert.match(stderr, /"code":\s*"invalid_command"/);
    assert.match(stderr, /invalid active_hand/);
    assert.doesNotMatch(stderr, /publish_failed/);
    assert.doesNotMatch(stderr, /instanceof/i);
    assert.doesNotMatch(stderr, /TypeError/);
  });
});
