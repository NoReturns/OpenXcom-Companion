'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const YAML = require('yaml');
const { BriefingWatcher } = require('../lib/briefing-watcher.cjs');
const { parseBriefingRequestJson, BriefingRequestError } = require('../lib/briefing-request.cjs');
const { verifyBriefingSnapshot, sha256HexLower } = require('../lib/briefing-snapshot.cjs');
const { loadJournal, isTerminalRecord } = require('../lib/briefing-journal.cjs');
const { createRelayPublisher } = require('../lib/github-relay.cjs');
const { buildRelayPayload, computeSnapshotId, loadAndValidateSnapshotFromText } = require('../lib/tactical-publish.cjs');
const { DEFAULTS } = require('../lib/github-relay.cjs');

const FIXTURE_V4 = fs.readFileSync(path.join(__dirname, 'fixtures', 'valid-v4.yaml'), 'utf8');
const SESSION_ID = 'a1b2c3d4e5f6789012345678abcdef01';

function makeRequest(overrides = {}) {
  const snapshot_sha256 = overrides.snapshot_sha256 ?? sha256HexLower(Buffer.from(FIXTURE_V4, 'utf8'));
  return {
    schema_version: 1,
    type: 'tactical_briefing_request',
    request_id: overrides.request_id ?? '0123456789abcdef0123456789abcdef',
    session_id: overrides.session_id ?? SESSION_ID,
    turn: overrides.turn ?? 1,
    snapshot_sha256,
    ...overrides,
  };
}

function createHarness(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'briefing-sidecar-'));
  const requestPath = path.join(root, 'briefing-request.json');
  const snapshotPath = path.join(root, 'tactical-live.yaml');
  const stateDir = path.join(root, 'state');
  const ackPath = path.join(root, 'briefing-ack.json');
  fs.writeFileSync(snapshotPath, options.snapshotText ?? FIXTURE_V4, 'utf8');

  const publishes = [];
  const logs = [];

  const watcher = new BriefingWatcher({
    requestPath,
    snapshotPath,
    stateDir,
    ackDir: root,
    dryRun: options.dryRun ?? true,
    pollIntervalMs: 500,
    log: (line) => logs.push(line),
    publishRelayState: options.publishRelayState ?? (async (relay) => {
      publishes.push(relay);
      return options.publishResult ?? { skipped: false };
    }),
    readFileSync: fs.readFileSync,
    existsSync: fs.existsSync,
  });

  return {
    root,
    requestPath,
    snapshotPath,
    stateDir,
    ackPath,
    watcher,
    publishes,
    logs,
    writeRequest(req) {
      fs.writeFileSync(requestPath, `${JSON.stringify(req, null, 2)}\n`, 'utf8');
    },
  };
}

describe('briefing request parsing', () => {
  it('accepts a valid F6 request', () => {
    const req = makeRequest();
    const parsed = parseBriefingRequestJson(JSON.stringify(req));
    assert.equal(parsed.request_id, req.request_id);
    assert.equal(parsed.snapshot_sha256.length, 64);
  });

  it('rejects malformed requests', () => {
    assert.throws(
      () => parseBriefingRequestJson(JSON.stringify({ schema_version: 1, type: 'ping' })),
      BriefingRequestError
    );
  });
});

describe('briefing snapshot verification', () => {
  it('accepts matching snapshot bytes', () => {
    const request = makeRequest();
    const bytes = Buffer.from(FIXTURE_V4, 'utf8');
    const result = verifyBriefingSnapshot({ request, snapshotBytes: bytes, yaml: YAML });
    assert.equal(result.tactical.schemaVersion, 4);
    assert.equal(result.digest, request.snapshot_sha256);
  });

  it('rejects incorrect YAML hash', () => {
    const request = makeRequest({ snapshot_sha256: 'f'.repeat(64) });
    const bytes = Buffer.from(FIXTURE_V4, 'utf8');
    assert.throws(
      () => verifyBriefingSnapshot({ request, snapshotBytes: bytes, yaml: YAML }),
      (error) => error.code === 'SNAPSHOT_HASH_MISMATCH'
    );
  });

  it('rejects session mismatch', () => {
    const request = makeRequest({ session_id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' });
    const bytes = Buffer.from(FIXTURE_V4, 'utf8');
    assert.throws(
      () => verifyBriefingSnapshot({ request, snapshotBytes: bytes, yaml: YAML }),
      (error) => error.code === 'SESSION_MISMATCH'
    );
  });

  it('rejects turn mismatch', () => {
    const request = makeRequest({ turn: 2 });
    const bytes = Buffer.from(FIXTURE_V4, 'utf8');
    assert.throws(
      () => verifyBriefingSnapshot({ request, snapshotBytes: bytes, yaml: YAML }),
      (error) => error.code === 'TURN_MISMATCH'
    );
  });
});

describe('BriefingWatcher', () => {
  it('publishes on valid request with matching snapshot (dry-run)', async () => {
    const h = createHarness({ dryRun: true });
    h.writeRequest(makeRequest());
    await h.watcher._pollOnce();
    assert.equal(h.publishes.length, 0);
    assert.match(h.logs.join('\n'), /Dry-run publish/);
    assert.ok(fs.existsSync(h.ackPath));
    const ack = JSON.parse(fs.readFileSync(h.ackPath, 'utf8'));
    assert.equal(ack.status, 'dry_run');
    assert.equal(ack.request_id, '0123456789abcdef0123456789abcdef');
    const journal = loadJournal(h.stateDir);
    assert.equal(journal.records['0123456789abcdef0123456789abcdef'], undefined);
  });

  it('does not republish the same request_id after successful live publish', async () => {
    const h = createHarness({ dryRun: false, publishResult: { skipped: false } });
    h.writeRequest(makeRequest());
    await h.watcher._pollOnce();
    assert.equal(h.publishes.length, 1);
    await h.watcher._pollOnce();
    assert.match(h.logs.join('\n'), /already terminal/);
    assert.equal(h.publishes.length, 1);
  });
  it('does not publish on hash mismatch and marks terminal failure', async () => {
    const h = createHarness({ dryRun: false });
    h.writeRequest(makeRequest({ snapshot_sha256: 'a'.repeat(64) }));
    await h.watcher._pollOnce();
    assert.equal(h.publishes.length, 0);
    const journal = loadJournal(h.stateDir);
    assert.equal(journal.records['0123456789abcdef0123456789abcdef'].terminal, true);
    const ack = JSON.parse(fs.readFileSync(h.ackPath, 'utf8'));
    assert.equal(ack.status, 'error');
    assert.equal(ack.error_code, 'SNAPSHOT_HASH_MISMATCH');
  });

  it('publishes different request_id with identical snapshot_id', async () => {
    const h = createHarness({ dryRun: false });
    h.writeRequest(makeRequest({ request_id: '11111111111111111111111111111111' }));
    await h.watcher._pollOnce();
    assert.equal(h.publishes.length, 1);
    const firstSnapshotId = h.publishes[0].snapshot_id;

    h.writeRequest(makeRequest({
      request_id: '22222222222222222222222222222222',
    }));
    h.watcher._loggedTerminal.clear();
    await h.watcher._pollOnce();
    assert.equal(h.publishes.length, 2);
    assert.equal(h.publishes[0].snapshot_id, firstSnapshotId);
    assert.equal(h.publishes[1].snapshot_id, firstSnapshotId);
    assert.notEqual(h.publishes[0].request_id, h.publishes[1].request_id);
  });

  it('aborts when request is replaced during processing', async () => {
    let publishCalls = 0;
    const h = createHarness({
      dryRun: false,
      publishRelayState: async () => {
        publishCalls += 1;
        h.writeRequest(makeRequest({ request_id: '99999999999999999999999999999999' }));
        return { skipped: false };
      },
    });
    h.writeRequest(makeRequest({ request_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }));
    await h.watcher._pollOnce();
    assert.equal(publishCalls, 1);
    const journal = loadJournal(h.stateDir);
    assert.equal(journal.records.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, undefined);
  });

  it('retries after retryable publish failure without duplicate success', async () => {
    let attempts = 0;
    const successfulPublishes = [];
    const h = createHarness({
      dryRun: false,
      publishRelayState: async (relay) => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('temporary network');
        }
        successfulPublishes.push(relay);
        return { skipped: false };
      },
    });
    h.writeRequest(makeRequest({ request_id: 'cccccccccccccccccccccccccccccccc' }));
    await h.watcher._pollOnce();
    assert.equal(attempts, 1);
    assert.equal(successfulPublishes.length, 0);
    await h.watcher._pollOnce();
    assert.equal(attempts, 2);
    assert.equal(successfulPublishes.length, 1);
    const ack = JSON.parse(fs.readFileSync(h.ackPath, 'utf8'));
    assert.equal(ack.status, 'published');
  });

  it('persists journal across watcher restart', async () => {
    const h = createHarness({ dryRun: false, publishResult: { skipped: false } });
    h.writeRequest(makeRequest({ request_id: 'dddddddddddddddddddddddddddddddd' }));
    await h.watcher._pollOnce();

    let secondPublishCalls = 0;
    const w2 = new BriefingWatcher({
      requestPath: h.requestPath,
      snapshotPath: h.snapshotPath,
      stateDir: h.stateDir,
      ackDir: h.root,
      dryRun: false,
      log: () => {},
      publishRelayState: async () => {
        secondPublishCalls += 1;
        return { skipped: false };
      },
    });
    await w2._pollOnce();
    const journal = loadJournal(h.stateDir);
    assert.ok(isTerminalRecord(journal.records.dddddddddddddddddddddddddddddddd));
    assert.equal(secondPublishCalls, 0);
  });

  it('acknowledges successful GitHub publication only after publish resolves', async () => {
    const h = createHarness({ dryRun: false, publishResult: { skipped: false } });
    h.writeRequest(makeRequest({ request_id: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' }));
    await h.watcher._pollOnce();
    const ack = JSON.parse(fs.readFileSync(h.ackPath, 'utf8'));
    assert.equal(ack.status, 'published');
    assert.ok(ack.snapshot_id);
  });

  it('stops on authentication failure without successful ack', async () => {
    const h = createHarness({
      dryRun: false,
      publishRelayState: async () => {
        const error = new Error('GitHub authentication failed.');
        error.code = 'AUTH_FAILED';
        throw error;
      },
    });
    h.writeRequest(makeRequest({ request_id: 'ffffffffffffffffffffffffffffffff' }));
    await h.watcher._pollOnce();
    assert.equal(h.publishes.length, 0);
    const ack = JSON.parse(fs.readFileSync(h.ackPath, 'utf8'));
    assert.equal(ack.status, 'error');
    assert.equal(ack.error_code, 'AUTH_FAILED');
    assert.equal(h.watcher.running, false);
    assert.match(h.logs.join('\n'), /AUTH_FAILED/);
  });

  it('does not reference relay inbox or outbox files', () => {
    const files = [
      '../lib/briefing-watcher.cjs',
      '../lib/briefing-request.cjs',
      '../lib/briefing-snapshot.cjs',
      '../publish-tactical-once.cjs',
    ];
    for (const file of files) {
      const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
      assert.doesNotMatch(src, /command\.json/);
      assert.doesNotMatch(src, /result\.json/);
    }
    assert.equal(DEFAULTS.statePath, 'm0/state.json');
  });
});

describe('briefing dry-run journal (M1-16C1)', () => {
  const requestId = '12121212121212121212121212121212';

  it('validates successfully without consuming the request id in the journal', async () => {
    const h = createHarness({ dryRun: true });
    h.writeRequest(makeRequest({ request_id: requestId }));
    await h.watcher._pollOnce();
    assert.match(h.logs.join('\n'), /Dry-run publish/);
    const journal = loadJournal(h.stateDir);
    assert.equal(journal.records[requestId], undefined);
    const ack = JSON.parse(fs.readFileSync(h.ackPath, 'utf8'));
    assert.equal(ack.status, 'dry_run');
  });

  it('allows a later live run to publish the same request_id', async () => {
    const h = createHarness({ dryRun: true });
    h.writeRequest(makeRequest({ request_id: requestId }));
    await h.watcher._pollOnce();
    assert.equal(h.publishes.length, 0);

    h.watcher.dryRun = false;
    await h.watcher._pollOnce();
    assert.equal(h.publishes.length, 1);
    assert.equal(h.publishes[0].request_id, requestId);
    const journal = loadJournal(h.stateDir);
    assert.equal(journal.records[requestId].status, 'published');
    const ack = JSON.parse(fs.readFileSync(h.ackPath, 'utf8'));
    assert.equal(ack.status, 'published');
  });

  it('still deduplicates after a successful live publish', async () => {
    const h = createHarness({ dryRun: false, publishResult: { skipped: false } });
    h.writeRequest(makeRequest({ request_id: requestId }));
    await h.watcher._pollOnce();
    assert.equal(h.publishes.length, 1);
    await h.watcher._pollOnce();
    assert.equal(h.publishes.length, 1);
    assert.match(h.logs.join('\n'), /already terminal/);
  });
});

describe('github relay briefing semantics', () => {
  it('skips only when remote snapshot_id and request_id both match', async () => {
    const remotePayload = {
      schema_version: 1,
      type: 'tactical_snapshot',
      snapshot_id: 'abc123',
      request_id: '11111111111111111111111111111111',
      source: { turn: 1 },
    };
    const ghApi = (method, apiPath, body) => {
      if (method === 'GET') {
        return {
          type: 'file',
          encoding: 'base64',
          sha: 'deadbeef',
          content: Buffer.from(`${JSON.stringify(remotePayload, null, 2)}\n`).toString('base64'),
        };
      }
      throw new Error(`unexpected ${method}`);
    };
    const publisher = createRelayPublisher({ ghApi });
    const skipped = await publisher.publishRelayState({
      ...remotePayload,
      request_id: '11111111111111111111111111111111',
    });
    assert.equal(skipped.skipped, true);

    let putCount = 0;
    const ghApi2 = (method, apiPath, body) => {
      if (method === 'GET') {
        return {
          type: 'file',
          encoding: 'base64',
          sha: 'deadbeef',
          content: Buffer.from(`${JSON.stringify(remotePayload, null, 2)}\n`).toString('base64'),
        };
      }
      if (method === 'PUT') {
        putCount += 1;
        return { content: {} };
      }
      throw new Error(`unexpected ${method}`);
    };
    const publisher2 = createRelayPublisher({ ghApi: ghApi2 });
    const result = await publisher2.publishRelayState({
      ...remotePayload,
      request_id: '22222222222222222222222222222222',
    });
    assert.equal(result.skipped, false);
    assert.equal(putCount, 1);
  });
});

describe('buildRelayPayload briefing envelope', () => {
  it('includes commandBinding with verified digest without changing snapshot_id', () => {
    const tactical = loadAndValidateSnapshotFromText(FIXTURE_V4, YAML);
    const digest = sha256HexLower(Buffer.from(FIXTURE_V4, 'utf8'));
    const base = buildRelayPayload(tactical, '2026-01-01T00:00:00.000Z');
    const briefing = buildRelayPayload(tactical, '2026-01-02T00:00:00.000Z', {
      request_id: 'a'.repeat(32),
      session_id: tactical.eventLog.sessionId,
      turn: tactical.turn,
    }, { snapshotSha256: digest });
    assert.equal(base.snapshot_id, briefing.snapshot_id);
    assert.ok(briefing.commandBinding);
    assert.equal(briefing.commandBinding.snapshot_sha256, digest);
  });

  it('includes request metadata without changing snapshot_id semantics', () => {
    const tactical = loadAndValidateSnapshotFromText(FIXTURE_V4, YAML);
    const base = buildRelayPayload(tactical, '2026-01-01T00:00:00.000Z');
    const briefing = buildRelayPayload(tactical, '2026-01-02T00:00:00.000Z', {
      request_id: '0123456789abcdef0123456789abcdef',
      session_id: SESSION_ID,
      turn: 1,
    });
    assert.equal(base.snapshot_id, briefing.snapshot_id);
    assert.equal(briefing.request_id, '0123456789abcdef0123456789abcdef');
    assert.equal(briefing.session_id, SESSION_ID);
    assert.equal(briefing.turn, 1);
    assert.equal(computeSnapshotId(tactical), briefing.snapshot_id);
  });
});
