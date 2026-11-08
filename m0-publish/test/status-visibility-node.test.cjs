'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const YAML = require('yaml');

const { BriefingWatcher } = require('../lib/briefing-watcher.cjs');
const { sha256HexLower } = require('../lib/briefing-snapshot.cjs');
const { loadAndValidateSnapshotFromText } = require('../lib/tactical-publish.cjs');
const { RELAY_SHRINK_EXHAUSTED } = require('../lib/relay-payload-adaptive-shrink.cjs');
const {
  shouldWriteOnDemandStatus,
  writeOnDemandStatus,
  mapBriefingAckToSendFields,
  RELAY_OUTCOME,
  BRIEFING_ACK_STATUS_DEFERRED,
} = require('../lib/companion-on-demand-status.cjs');
const {
  sanitizeBriefingReason,
  createBriefingDiagnosticsEmitter,
  formatBriefingDaemonConsoleLine,
} = require('../lib/companion-briefing-diagnostics.cjs');
const {
  SEND_PHASE,
  createOnDemandRelayContext,
  processPendingRequest,
  runSendOnce,
  resolveOnDemandPaths,
  isNonTerminalUiOutcome,
} = require('../lib/companion-on-demand-relay.cjs');
const { writeJsonAtomic } = require('../lib/local-atomic.cjs');
const { NotificationDeduper } = require('../lib/companion-relay-notify.cjs');
const {
  fingerprintProductionCommandRelayJournal,
  assertProductionCommandRelayJournalUnchanged,
  isolatedCommandRelayStateDir,
} = require('../lib/relay-test-isolation.cjs');

const FIXTURE_V5 = path.join(__dirname, 'fixtures', 'valid-v5.yaml');

function makeRequestFromFixture(snapshotPath, overrides = {}) {
  const text = fs.readFileSync(snapshotPath, 'utf8');
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

describe('M1 status visibility — Node diagnostics (step 1)', () => {
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

  it('shouldWriteOnDemandStatus rejects stale older request over newer terminal error', () => {
    const existing = {
      request_id: 'new-request-id',
      terminal: true,
      updated_at_ms: 2000,
      phase: 'failed',
      error_code: 'AUTH_FAILED',
    };
    const stale = {
      request_id: 'old-request-id',
      terminal: true,
      updated_at_ms: 1000,
      phase: 'sent',
    };
    assert.equal(shouldWriteOnDemandStatus(existing, stale), false);
    assert.equal(shouldWriteOnDemandStatus(stale, existing), true);
  });

  it('sanitizeBriefingReason redacts tokens but keeps perceptionLog diagnostics', () => {
    const redacted = sanitizeBriefingReason('gh: HTTP 401: Bad credentials github_pat_abc123SECRET');
    assert.match(redacted, /Redacted credential|details redacted/i);
    const safe = sanitizeBriefingReason('perceptionLog.events[39].type invalid');
    assert.equal(safe, 'perceptionLog.events[39].type invalid');
  });

  it('mapBriefingAckToSendFields maps deferred without terminal failure', () => {
    const fields = mapBriefingAckToSendFields({
      value: {
        status: BRIEFING_ACK_STATUS_DEFERRED,
        request_id: 'aa'.repeat(16),
        error_code: 'RATE_LIMIT',
        message: 'GitHub rate limit cooldown.',
      },
    }, 'aa'.repeat(16));
    assert.equal(fields.outcome, RELAY_OUTCOME.DEFERRED);
    assert.equal(fields.terminal, false);
    assert.equal(fields.error_code, 'RATE_LIMIT');
  });

  it('mapBriefingAckToSendFields ignores stale acknowledgment request_id', () => {
    const fields = mapBriefingAckToSendFields({
      value: {
        status: 'published',
        request_id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
    }, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    assert.equal(fields, null);
  });

  it('SNAPSHOT_VALIDATION psychological perception failure surfaces in daemon console', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'status-vis-val-'));
    const snapshotPath = path.join(root, 'tactical-live.yaml');
    const requestPath = path.join(root, 'briefing-request.json');
    const stateDir = path.join(root, '.briefing-state');
    fs.mkdirSync(stateDir, { recursive: true });

    const text = fs.readFileSync(FIXTURE_V5, 'utf8');
    const doc = YAML.parse(text);
    const sessionId = doc.eventLog.sessionId;
    doc.perceptionLog = {
      sessionId,
      oldestSeq: 1,
      latestSeq: 40,
      droppedCount: 0,
      events: [],
    };
    for (let index = 0; index < 39; index += 1) {
      doc.perceptionLog.events.push({
        seq: index + 1,
        type: 'unit_last_seen',
        turn: doc.turn,
        perceptionChannel: 'seen',
        confidence: 'sighted',
        positionKnown: false,
      });
    }
    doc.perceptionLog.events.push({
      seq: 40,
      type: 'not_a_real_perception_type',
      turn: doc.turn,
      perceptionChannel: 'seen',
      confidence: 'sighted',
      positionKnown: false,
    });
    fs.writeFileSync(snapshotPath, YAML.stringify(doc), 'utf8');

    const digest = sha256HexLower(fs.readFileSync(snapshotPath));
    const request = {
      schema_version: 1,
      type: 'tactical_briefing_request',
      request_id: crypto.randomBytes(16).toString('hex'),
      session_id: doc.eventLog.sessionId,
      turn: doc.turn,
      snapshot_sha256: digest,
    };
    fs.writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`, 'utf8');

    const consoleLines = [];
    const diagnostics = createBriefingDiagnosticsEmitter({
      log: (line) => consoleLines.push(line),
    });

    const watcher = new BriefingWatcher({
      requestPath,
      snapshotPath,
      stateDir,
      ackDir: root,
      dryRun: false,
      log: () => {},
      briefingDiagnostics: diagnostics,
      publishRelayState: async () => ({ skipped: true }),
    });

    await watcher._pollOnce();

    const ack = JSON.parse(fs.readFileSync(path.join(root, 'briefing-ack.json'), 'utf8'));
    assert.equal(ack.status, 'error');
    assert.equal(ack.error_code, 'SNAPSHOT_VALIDATION');
    assert.match(ack.message, /perceptionLog\.events\[39\]\.type invalid/);

    const failedLine = consoleLines.find((line) => line.includes('outcome=failed') && line.includes('SNAPSHOT_VALIDATION'));
    assert.ok(failedLine, `expected failed console line, got: ${consoleLines.join('\n')}`);
    assert.match(failedLine, /perceptionLog\.events\[39\]/);
  });

  it('processPendingRequest retains pending file on rate-limit defer', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'status-vis-defer-'));
    const snapshotPath = path.join(root, 'tactical-live.yaml');
    fs.copyFileSync(FIXTURE_V5, snapshotPath);
    const relayStateDir = isolatedCommandRelayStateDir(root, 'relay-state');
    const paths = resolveOnDemandPaths(snapshotPath);

    writeJsonAtomic(paths.requestPath, {
      request_id: crypto.randomBytes(16).toString('hex'),
      action: 'send',
      status: 'pending',
      send_scope: 'tactical',
      created_at_ms: Date.now(),
    });

    const ctx = createOnDemandRelayContext({
      snapshotPath,
      commandRelayStateDir: relayStateDir,
      dryRun: false,
      relayPublisher: {
        publishRelayState: async () => {
          const err = new Error('rate limited');
          err.code = 'RATE_LIMIT';
          throw err;
        },
      },
    });

    const result = await processPendingRequest(ctx);
    assert.equal(result.processed, true);
    assert.equal(result.retainPendingRequest, true);
    assert.equal(fs.existsSync(paths.requestPath), true);

    const status = JSON.parse(fs.readFileSync(paths.statusPath, 'utf8'));
    assert.equal(status.outcome, RELAY_OUTCOME.DEFERRED);
    assert.equal(status.terminal, false);
    assert.equal(status.error_code, 'RATE_LIMIT');
    assert.equal(status.phase, SEND_PHASE.SENDING);
    assert.equal(isNonTerminalUiOutcome(status), true);
  });

  it('on-demand status includes error_code for terminal auth failure', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'status-vis-auth-'));
    const snapshotPath = path.join(root, 'tactical-live.yaml');
    fs.copyFileSync(FIXTURE_V5, snapshotPath);
    const relayStateDir = isolatedCommandRelayStateDir(root, 'relay-state');
    const paths = resolveOnDemandPaths(snapshotPath);
    const briefingId = crypto.randomBytes(16).toString('hex');

    writeJsonAtomic(paths.briefingRequest, makeRequestFromFixture(snapshotPath, { request_id: briefingId }));
    writeJsonAtomic(paths.requestPath, {
      request_id: crypto.randomBytes(16).toString('hex'),
      action: 'send',
      status: 'pending',
      send_scope: 'tactical',
      briefing_request_id: briefingId,
      created_at_ms: Date.now(),
    });

    const ctx = createOnDemandRelayContext({
      snapshotPath,
      commandRelayStateDir: relayStateDir,
      dryRun: false,
      relayPublisher: {
        publishRelayState: async () => {
          const err = new Error('auth failed');
          err.code = 'AUTH_FAILED';
          throw err;
        },
      },
    });

    await processPendingRequest(ctx);
    const status = JSON.parse(fs.readFileSync(paths.statusPath, 'utf8'));
    assert.equal(status.phase, SEND_PHASE.FAILED);
    assert.equal(status.error_code, 'AUTH_FAILED');
    assert.equal(status.terminal, true);
    assert.equal(status.outcome, RELAY_OUTCOME.FAILED);
  });

  it('duplicate briefing console events are deduped', () => {
    const lines = [];
    const deduper = new NotificationDeduper();
    const emitter = createBriefingDiagnosticsEmitter({
      deduper,
      log: (line) => lines.push(line),
    });
    const event = {
      outcome: 'published',
      request_id: 'cccccccccccccccccccccccccccccccc',
      turn: 2,
    };
    assert.equal(emitter.emit(event), true);
    assert.equal(emitter.emit(event), false);
    assert.equal(lines.length, 1);
  });

  it('no_new_orders retrieve poll does not erase terminal completed command outcome', () => {
    const statusPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'status-vis-no-new-')), 'status.json');
    writeOnDemandStatus(statusPath, {
      request_id: 'req-a',
      action: 'retrieve',
      phase: 'completed',
      terminal: true,
      last_command_id: 'a'.repeat(32),
      last_command_status: 'COMPLETED',
      updated_at_ms: 5000,
    });
    const suppressed = writeOnDemandStatus(statusPath, {
      request_id: 'req-b',
      action: 'retrieve',
      phase: 'no_new_orders',
      terminal: true,
      updated_at_ms: 6000,
    });
    assert.equal(suppressed.written, false);
    const kept = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    assert.equal(kept.phase, 'completed');
    assert.equal(kept.last_command_status, 'COMPLETED');
  });

  it('writeOnDemandStatus preserves terminal failure until newer request supersedes', () => {
    const statusPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'status-vis-sticky-')), 'status.json');
    const failed = {
      request_id: 'req-a',
      action: 'send',
      phase: SEND_PHASE.FAILED,
      message: 'Auth failed',
      error_code: 'AUTH_FAILED',
      outcome: RELAY_OUTCOME.FAILED,
      terminal: true,
      updated_at_ms: 5000,
    };
    writeOnDemandStatus(statusPath, failed);
    const noopOlder = {
      request_id: 'req-b',
      action: 'send',
      phase: SEND_PHASE.SENT,
      message: 'stale',
      terminal: true,
      updated_at_ms: 4000,
    };
    const write = writeOnDemandStatus(statusPath, noopOlder);
    assert.equal(write.written, false);
    const kept = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    assert.equal(kept.error_code, 'AUTH_FAILED');
  });

  it('runSendOnce rejects stale briefing ack for expected request id', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'status-vis-stale-ack-'));
    const snapshotPath = path.join(root, 'tactical-live.yaml');
    fs.copyFileSync(FIXTURE_V5, snapshotPath);
    const relayStateDir = isolatedCommandRelayStateDir(root, 'relay-state');
    const paths = resolveOnDemandPaths(snapshotPath);
    const expectedId = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

    writeJsonAtomic(paths.briefingRequest, makeRequestFromFixture(snapshotPath, { request_id: expectedId }));
    fs.mkdirSync(paths.briefingStateDir, { recursive: true });
    writeJsonAtomic(path.join(paths.briefingStateDir, 'journal.json'), {
      version: 1,
      records: {
        [expectedId]: { request_id: expectedId, status: 'published', terminal: true },
      },
    });
    writeJsonAtomic(paths.briefingAck, {
      request_id: 'ffffffffffffffffffffffffffffffff',
      status: 'published',
      message: 'wrong request',
    });

    const ctx = createOnDemandRelayContext({
      snapshotPath,
      commandRelayStateDir: relayStateDir,
      dryRun: true,
    });

    const outcome = await runSendOnce(ctx, {
      briefing_request_id: expectedId,
      send_scope: 'tactical',
    });
    assert.equal(outcome.error_code, 'BRIEFING_ACK_STALE');
    assert.equal(outcome.terminal, true);
  });

  it('manual upload required includes artifact in console line', () => {
    const line = formatBriefingDaemonConsoleLine({
      outcome: 'manual_upload_required',
      request_id: 'dddddddddddddddddddddddddddddddd',
      error_code: RELAY_SHRINK_EXHAUSTED,
      artifact_filename: 'manual-intel-abc.json',
      turn: 3,
    });
    assert.match(line, /artifact=manual-intel-abc\.json/);
    assert.match(line, /code=RELAY_SHRINK_EXHAUSTED/);
  });
});
