'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const YAML = require('yaml');

const { BriefingWatcher } = require('../lib/briefing-watcher.cjs');
const { loadJournal, isTerminalRecord } = require('../lib/briefing-journal.cjs');
const { sha256HexLower } = require('../lib/briefing-snapshot.cjs');
const { RELAY_SHRINK_EXHAUSTED } = require('../lib/relay-payload-adaptive-shrink.cjs');
const { buildShrinkExhaustedRelay } = require('./helpers/oversized-relay-fixture.cjs');
const { loadAndValidateSnapshotFromText, buildRelayPayload } = require('../lib/tactical-publish.cjs');
const {
  noticePath,
  readManualUploadNotice,
  isActiveManualUploadNotice,
  MANUAL_UPLOAD_NOTICE_TITLE,
  NOTICE_PRODUCER_ENGINE,
  buildManualUploadNotice,
  writeManualUploadNoticeAtomic,
} = require('../lib/companion-manual-upload-notice.cjs');
const { writeJsonAtomic } = require('../lib/local-atomic.cjs');
const {
  BRIEFING_ACK_STATUS_MANUAL_UPLOAD_REQUIRED,
  publishRelayWithManualFallback,
} = require('../lib/briefing-relay-publish.cjs');
const {
  SEND_PHASE,
  createOnDemandRelayContext,
  runSendOnce,
} = require('../lib/companion-on-demand-relay.cjs');
const { NOTIFICATION_CODES } = require('../lib/companion-relay-notify.cjs');
const {
  fingerprintProductionCommandRelayJournal,
  assertProductionCommandRelayJournalUnchanged,
} = require('../lib/relay-test-isolation.cjs');

const FIXTURE_V5 = path.join(__dirname, 'fixtures', 'valid-v5.yaml');

function makeRequestFromFixture(overrides = {}) {
  const text = fs.readFileSync(FIXTURE_V5, 'utf8');
  const digest = sha256HexLower(Buffer.from(text, 'utf8'));
  const tactical = loadAndValidateSnapshotFromText(text, YAML);
  return {
    schema_version: 1,
    type: 'tactical_briefing_request',
    request_id: overrides.request_id ?? crypto.randomBytes(16).toString('hex'),
    session_id: tactical.eventLog.sessionId,
    turn: tactical.turn,
    snapshot_sha256: digest,
    ...overrides,
  };
}

function createBriefingHarness(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-notice-'));
  const requestPath = path.join(root, 'briefing-request.json');
  const snapshotPath = path.join(root, 'tactical-live.yaml');
  const stateDir = path.join(root, '.briefing-state');
  const notices = [];
  const logs = [];

  fs.mkdirSync(stateDir, { recursive: true });
  fs.copyFileSync(FIXTURE_V5, snapshotPath);

  const watcher = new BriefingWatcher({
    requestPath,
    snapshotPath,
    stateDir,
    ackDir: root,
    dryRun: false,
    pollIntervalMs: 500,
    log: (line) => logs.push(line),
    notify: (payload) => notices.push(payload),
    publishRelayState: options.publishRelayState,
    manualUploadIo: options.manualUploadIo,
    now: () => options.nowMs ?? Date.now(),
  });

  return { root, requestPath, snapshotPath, stateDir, watcher, notices, logs };
}

describe('manual-upload notice integration (M1 P3 step 2)', () => {
  let journalBefore;

  before(() => {
    journalBefore = fingerprintProductionCommandRelayJournal();
  });

  after(() => {
    assertProductionCommandRelayJournalUnchanged(
      journalBefore,
      fingerprintProductionCommandRelayJournal(),
    );
  });

  it('shrink exhaustion creates artifact, notice, journal and ack', async () => {
    const h = createBriefingHarness({
      publishRelayState: async () => {
        const err = new Error('too large');
        err.code = RELAY_SHRINK_EXHAUSTED;
        err.initialBytes = 500_000;
        err.finalBytes = 300_000;
        err.steps = [{ step: 'terrain_map_brief_omit_last_resort' }];
        throw err;
      },
    });
    const request = makeRequestFromFixture();
    fs.writeFileSync(h.requestPath, `${JSON.stringify(request, null, 2)}\n`, 'utf8');

    await h.watcher._pollOnce();

    const ack = JSON.parse(fs.readFileSync(path.join(h.root, 'briefing-ack.json'), 'utf8'));
    assert.equal(ack.status, BRIEFING_ACK_STATUS_MANUAL_UPLOAD_REQUIRED);
    assert.ok(ack.artifact_path);
    assert.equal(ack.artifact_sha256.length, 64);
    assert.match(ack.message, /ChatGPT partner/);
    assert.ok(fs.existsSync(ack.artifact_path));

    const artifactBytes = fs.readFileSync(ack.artifact_path);
    const artifactDigest = crypto.createHash('sha256').update(artifactBytes).digest('hex');
    assert.equal(artifactDigest, ack.artifact_sha256);

    const notice = readManualUploadNotice(h.root);
    assert.ok(isActiveManualUploadNotice(notice));
    assert.equal(notice.producer, 'node');
    assert.equal(notice.artifact_sha256, ack.artifact_sha256);
    assert.equal(notice.title, MANUAL_UPLOAD_NOTICE_TITLE);
    assert.equal(notice.reason_code, RELAY_SHRINK_EXHAUSTED);

    const journal = loadJournal(h.stateDir);
    const record = journal.records[request.request_id];
    assert.ok(isTerminalRecord(record));
    assert.equal(record.status, BRIEFING_ACK_STATUS_MANUAL_UPLOAD_REQUIRED);

    assert.equal(h.notices.length, 1);
    assert.equal(h.notices[0].code, NOTIFICATION_CODES.MANUAL_UPLOAD_REQUIRED);
  });

  it('successful automatic publish creates no active manual notice', async () => {
    const h = createBriefingHarness({
      publishRelayState: async () => ({ skipped: false }),
    });
    const request = makeRequestFromFixture();
    fs.writeFileSync(h.requestPath, `${JSON.stringify(request, null, 2)}\n`, 'utf8');

    await h.watcher._pollOnce();
    const notice = readManualUploadNotice(h.root);
    assert.ok(!isActiveManualUploadNotice(notice));
    assert.equal(h.notices.filter((n) => n.code === NOTIFICATION_CODES.MANUAL_UPLOAD_REQUIRED).length, 0);
  });

  it('successful publish clears an obsolete node notice for the same session', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-clear-'));
    const text = fs.readFileSync(FIXTURE_V5, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(text, YAML);
    const digest = sha256HexLower(Buffer.from(text, 'utf8'));
    const relay = buildRelayPayload(tactical, new Date(0).toISOString(), null, { snapshotSha256: digest });

    const staleNotice = buildManualUploadNotice({
      createdAtMs: 1000,
      artifactPath: path.join(root, 'manual-exports', 'stale.json'),
      artifactSha256: 'a'.repeat(64),
      sessionId: tactical.eventLog.sessionId,
      snapshotId: relay.snapshot_id,
      turn: tactical.turn,
      requestId: 'older-request',
    });
    writeManualUploadNoticeAtomic(root, staleNotice);

    await publishRelayWithManualFallback({
      relay,
      publishRelayState: async () => ({ skipped: false }),
      snapshotDir: root,
      requestId: 'newer-request',
      sessionId: tactical.eventLog.sessionId,
      turn: tactical.turn,
      snapshotSha256: digest,
      now: () => 5000,
    });

    const notice = readManualUploadNotice(root);
    assert.equal(notice.active, false);
    assert.equal(notice.cleared_reason, 'relay_published');
  });

  it('older request cannot overwrite a newer active notice', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-stale-'));
    const newer = buildManualUploadNotice({
      createdAtMs: 5000,
      artifactPath: path.join(root, 'manual-exports', 'newer.json'),
      artifactSha256: 'b'.repeat(64),
      sessionId: 'session-a',
      snapshotId: 'snap',
      turn: 2,
      requestId: 'req-new',
    });
    writeManualUploadNoticeAtomic(root, newer);

    const older = buildManualUploadNotice({
      createdAtMs: 1000,
      artifactPath: path.join(root, 'manual-exports', 'older.json'),
      artifactSha256: 'c'.repeat(64),
      sessionId: 'session-a',
      snapshotId: 'snap',
      turn: 2,
      requestId: 'req-old',
    });
    const result = writeManualUploadNoticeAtomic(root, older);
    assert.equal(result.written, false);
    assert.equal(readManualUploadNotice(root).artifact_sha256, 'b'.repeat(64));
  });

  it('does not replace an engine producer notice', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-engine-'));
    const engineNotice = {
      schema_version: 1,
      active: true,
      notice_id: 'engine-1',
      producer: NOTICE_PRODUCER_ENGINE,
      artifact_path: '/engine/only.yaml',
      artifact_sha256: 'd'.repeat(64),
      session_id: 'sess',
      snapshot_id: 'snap',
      turn: 1,
      created_at_ms: 1000,
    };
    writeJsonAtomic(noticePath(root), engineNotice);

    const nodeNotice = buildManualUploadNotice({
      createdAtMs: 9000,
      artifactPath: path.join(root, 'x.json'),
      artifactSha256: 'e'.repeat(64),
      sessionId: 'sess',
      snapshotId: 'snap',
      turn: 1,
    });
    const result = writeManualUploadNoticeAtomic(root, nodeNotice);
    assert.equal(result.written, false);
    assert.equal(readManualUploadNotice(root).producer, NOTICE_PRODUCER_ENGINE);
  });

  it('manual write failure does not write upload-required notice', async () => {
    const h = createBriefingHarness({
      publishRelayState: async () => {
        const err = new Error('too large');
        err.code = RELAY_SHRINK_EXHAUSTED;
        err.initialBytes = 1;
        err.finalBytes = 999_999;
        err.steps = [];
        throw err;
      },
      manualUploadIo: {
        writeFileSync: () => {
          throw new Error('ENOSPC');
        },
      },
    });
    const request = makeRequestFromFixture();
    fs.writeFileSync(h.requestPath, `${JSON.stringify(request, null, 2)}\n`, 'utf8');
    await h.watcher._pollOnce();

    const ack = JSON.parse(fs.readFileSync(path.join(h.root, 'briefing-ack.json'), 'utf8'));
    assert.equal(ack.status, 'error');
    assert.notEqual(ack.status, BRIEFING_ACK_STATUS_MANUAL_UPLOAD_REQUIRED);
    assert.ok(!fs.existsSync(noticePath(h.root)));
    assert.equal(h.notices.length, 0);
  });

  it('auth failure stays error without manual notice', async () => {
    const h = createBriefingHarness({
      publishRelayState: async () => {
        const err = new Error('GitHub authentication failed.');
        err.code = 'AUTH_FAILED';
        throw err;
      },
    });
    const request = makeRequestFromFixture();
    fs.writeFileSync(h.requestPath, `${JSON.stringify(request, null, 2)}\n`, 'utf8');
    await h.watcher._pollOnce();

    const ack = JSON.parse(fs.readFileSync(path.join(h.root, 'briefing-ack.json'), 'utf8'));
    assert.equal(ack.status, 'error');
    assert.equal(ack.error_code, 'AUTH_FAILED');
    assert.ok(!fs.existsSync(noticePath(h.root)));
  });

  it('daemon runSendOnce surfaces manual_upload_required terminal phase from briefing ack', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-manual-'));
    const snapshotPath = path.join(root, 'tactical-live.yaml');
    fs.copyFileSync(FIXTURE_V5, snapshotPath);

    const request = makeRequestFromFixture();
    fs.writeFileSync(path.join(root, 'briefing-request.json'), `${JSON.stringify(request, null, 2)}\n`, 'utf8');

    const ctx = createOnDemandRelayContext({
      snapshotPath,
      dryRun: false,
      commandRelayStateDir: path.join(root, 'relay-state'),
      relayPublisher: {
        publishRelayState: async () => {
          const err = new Error('too large');
          err.code = RELAY_SHRINK_EXHAUSTED;
          err.initialBytes = 1;
          err.finalBytes = 999_999;
          err.steps = [];
          throw err;
        },
      },
    });

    const outcome = await runSendOnce(ctx, {
      request_id: 'daemon-send',
      action: 'send',
      status: 'pending',
      briefing_request_id: request.request_id,
    });

    assert.equal(outcome.phase, SEND_PHASE.MANUAL_UPLOAD_REQUIRED);
    const notice = readManualUploadNotice(root);
    assert.ok(isActiveManualUploadNotice(notice));
  });
});
