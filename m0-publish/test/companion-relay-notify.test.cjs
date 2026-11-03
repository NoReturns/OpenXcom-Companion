'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const YAML = require('yaml');
const {
  NOTIFICATION_CODES,
  classifySidecarReject,
  classifyEngineTerminal,
  notificationFromLocalResult,
  formatSupervisorConsoleLine,
  NotificationDeduper,
  createNotifyEmitter,
  createSupervisorNotifyBridge,
  serializeStructuredNotify,
} = require('../lib/companion-relay-notify.cjs');
const { CommandRelayWatcher } = require('../lib/command-relay-watcher.cjs');
const { loadAndValidateSnapshotFromText } = require('../lib/tactical-publish.cjs');

const FIXTURE_V5 = path.join(__dirname, 'fixtures', 'valid-v5.yaml');

describe('companion-relay-notify classification', () => {
  it('maps stale validation to COMMAND_STALE', () => {
    assert.equal(
      classifySidecarReject('SIDECAR_VALIDATION', 'turn mismatch'),
      NOTIFICATION_CODES.COMMAND_STALE,
    );
  });

  it('maps duplicate to COMMAND_DUPLICATE', () => {
    assert.equal(
      classifySidecarReject('DUPLICATE_COMMAND_ID', 'Command ID already used.'),
      NOTIFICATION_CODES.COMMAND_DUPLICATE,
    );
  });

  it('distinguishes INTERRUPTED from FAILED terminal movement', () => {
    assert.equal(classifyEngineTerminal('INTERRUPTED', 'Movement interrupted'), NOTIFICATION_CODES.COMMAND_INTERRUPTED);
    assert.equal(classifyEngineTerminal('FAILED', 'No valid path'), NOTIFICATION_CODES.COMMAND_FAILED);
  });

  it('maps identity mismatch rejections to COMMAND_CONFLICT', () => {
    const event = notificationFromLocalResult({
      schema_version: 1,
      command_id: 'incoming-1',
      command_type: 'MOVE',
      status: 'REJECTED',
      session_id: 'a'.repeat(32),
      turn: 1,
      public_reason: 'result_command_id_mismatch',
      inbox_sha256: 'b'.repeat(64),
    });
    assert.equal(event.code, NOTIFICATION_CODES.COMMAND_CONFLICT);
    assert.equal(event.inbox_sha256, 'b'.repeat(64));
  });

  it('does not emit COMPLETED from non-terminal statuses', () => {
    assert.equal(notificationFromLocalResult({
      command_id: 'x',
      status: 'EXECUTING',
      session_id: 'a'.repeat(32),
      turn: 1,
    }).code, NOTIFICATION_CODES.COMMAND_EXECUTING);
    assert.equal(notificationFromLocalResult({
      command_id: 'x',
      status: 'ACCEPTED',
      session_id: 'a'.repeat(32),
      turn: 1,
    }).code, NOTIFICATION_CODES.COMMAND_EXECUTING);
  });
});

describe('companion-relay-notify dedupe', () => {
  it('suppresses repeated stale notifications', () => {
    const lines = [];
    const { emit } = createNotifyEmitter({
      alsoPrintConsole: false,
      writeStructured: (line) => lines.push(line),
    });
    const event = {
      code: NOTIFICATION_CODES.COMMAND_STALE,
      command_id: 'move-stale',
      remote_sha256: 'abc',
      reason_code: 'SIDECAR_VALIDATION',
    };
    assert.equal(emit(event), true);
    assert.equal(emit(event), false);
    assert.equal(lines.length, 1);
  });

  it('allows RELAY_RECONNECTED only after DISCONNECTED', () => {
    const deduper = new NotificationDeduper();
    assert.equal(deduper.shouldEmit({ code: NOTIFICATION_CODES.RELAY_RECONNECTED }), false);
    assert.equal(deduper.shouldEmit({ code: NOTIFICATION_CODES.RELAY_DISCONNECTED, message: 'x' }), true);
    assert.equal(deduper.shouldEmit({ code: NOTIFICATION_CODES.RELAY_DISCONNECTED, message: 'x' }), false);
    assert.equal(deduper.shouldEmit({ code: NOTIFICATION_CODES.RELAY_RECONNECTED }), true);
  });

  it('supervisor bridge dedupes structured lines', () => {
    const out = [];
    const bridge = createSupervisorNotifyBridge({
      writeConsole: (line) => out.push(line),
    });
    const payload = serializeStructuredNotify({
      code: NOTIFICATION_CODES.COMMAND_COMPLETED,
      command_id: 'done-1',
      inbox_sha256: 'c'.repeat(64),
    }).trim();
    assert.equal(bridge.ingestStructuredLine(payload), true);
    assert.equal(bridge.ingestStructuredLine(payload), false);
    assert.equal(out.length, 1);
    assert.match(out[0], /COMMAND_COMPLETED/);
  });
});

describe('CommandRelayWatcher notifications', () => {
  function makeHarness() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-relay-'));
    const fixtureText = fs.readFileSync(FIXTURE_V5, 'utf8');
    const snapshotPath = path.join(root, 'tactical-live.yaml');
    fs.writeFileSync(snapshotPath, fixtureText, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(fixtureText, YAML);
    const digest = crypto.createHash('sha256').update(Buffer.from(fixtureText, 'utf8')).digest('hex');
    const stateDir = path.join(root, 'state');
    const events = [];
    const deduper = new NotificationDeduper();
    const notify = (event) => {
      if (!deduper.shouldEmit(event)) {
        return;
      }
      events.push(formatSupervisorConsoleLine(event));
    };
    let remoteCommand = null;
    let failReads = 0;
    const watcher = new CommandRelayWatcher({
      snapshotPath,
      stateDir,
      dryRun: true,
      pollIntervalMs: 5,
      notify,
      readRemoteCommand: async () => {
        if (failReads > 0) {
          failReads -= 1;
          throw new Error('network down');
        }
        return remoteCommand;
      },
      publishRemoteResult: async () => {},
      fetchRemoteResult: async () => null,
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
      watcher,
      events,
      setRemote(command) {
        remoteCommand = {
          text: `${JSON.stringify(command, null, 2)}\n`,
          sha: crypto.createHash('sha256').update(JSON.stringify(command)).digest('hex'),
        };
      },
      failNextRemoteReads(count) {
        failReads = count;
      },
    };
  }

  it('emits RECEIVED, DELIVERED, EXECUTING, and COMPLETED in order', async () => {
    const h = makeHarness();
    h.setRemote({
      schema_version: 1,
      command_id: 'move-notify-1',
      command_type: 'MOVE',
      actor_unit_id: 1,
      destination: { x: 2, y: 2, z: 0 },
      snapshot_sha256: h.digest,
      session_id: h.tactical.eventLog.sessionId,
      turn: h.tactical.turn,
      state_version: h.tactical.eventLog.latestSeq,
    });
    await h.watcher._pollOnce();
    assert.ok(h.events.some((e) => e.includes('COMMAND_RECEIVED')));
    assert.ok(h.events.some((e) => e.includes('COMMAND_DELIVERED')));

    const local = h.watcher.local;
    fs.writeFileSync(local.result, `${JSON.stringify({
      schema_version: 1,
      command_id: 'move-notify-1',
      command_type: 'MOVE',
      status: 'EXECUTING',
      session_id: h.tactical.eventLog.sessionId,
      turn: h.tactical.turn,
      inbox_sha256: 'd'.repeat(64),
    })}\n`, 'utf8');
    await h.watcher._pollOnce();
    assert.ok(h.events.some((e) => e.includes('COMMAND_EXECUTING')));

    fs.writeFileSync(local.result, `${JSON.stringify({
      schema_version: 1,
      command_id: 'move-notify-1',
      command_type: 'MOVE',
      status: 'COMPLETED',
      session_id: h.tactical.eventLog.sessionId,
      turn: h.tactical.turn,
      inbox_sha256: 'd'.repeat(64),
      destination_reached: true,
    })}\n`, 'utf8');
    await h.watcher._pollOnce();
    assert.ok(h.events.some((e) => e.includes('COMMAND_COMPLETED')));
    fs.rmSync(h.root, { recursive: true, force: true });
  });

  it('emits COMMAND_STALE once for stale remote binding', async () => {
    const h = makeHarness();
    h.setRemote({
      schema_version: 1,
      command_id: 'move-stale',
      command_type: 'MOVE',
      actor_unit_id: 1,
      destination: { x: 2, y: 2, z: 0 },
      snapshot_sha256: h.digest,
      session_id: h.tactical.eventLog.sessionId,
      turn: 99,
      state_version: h.tactical.eventLog.latestSeq,
    });
    await h.watcher._pollOnce();
    const staleLines = h.events.filter((e) => e.includes('COMMAND_STALE'));
    assert.equal(staleLines.length, 1);
    await h.watcher._pollOnce();
    assert.equal(h.events.filter((e) => e.includes('COMMAND_STALE')).length, 1);
    fs.rmSync(h.root, { recursive: true, force: true });
  });

  it('emits DUPLICATE once for terminal journal restart', async () => {
    const h = makeHarness();
    const cmd = {
      schema_version: 1,
      command_id: 'move-once',
      command_type: 'MOVE',
      actor_unit_id: 1,
      destination: { x: 2, y: 2, z: 0 },
      snapshot_sha256: h.digest,
      session_id: h.tactical.eventLog.sessionId,
      turn: h.tactical.turn,
      state_version: h.tactical.eventLog.latestSeq,
    };
    h.setRemote(cmd);
    await h.watcher._pollOnce();
    const journal = h.watcher.loadJournal();
    journal.records['move-once'] = {
      command_id: 'move-once',
      phase: 'published_terminal',
      status: 'COMPLETED',
    };
    h.watcher.persistJournal(journal);
    h.events.length = 0;
    await h.watcher._pollOnce();
    const dupes = h.events.filter((e) => e.includes('COMMAND_DUPLICATE'));
    assert.equal(dupes.length, 1);
    await h.watcher._pollOnce();
    assert.equal(h.events.filter((e) => e.includes('COMMAND_DUPLICATE')).length, 1);
    fs.rmSync(h.root, { recursive: true, force: true });
  });

  it('emits RELAY_DISCONNECTED then RELAY_RECONNECTED', async () => {
    const h = makeHarness();
    h.setRemote({
      schema_version: 1,
      command_id: 'move-net',
      command_type: 'MOVE',
      actor_unit_id: 1,
      destination: { x: 2, y: 2, z: 0 },
      snapshot_sha256: h.digest,
      session_id: h.tactical.eventLog.sessionId,
      turn: h.tactical.turn,
      state_version: h.tactical.eventLog.latestSeq,
    });
    h.failNextRemoteReads(1);
    await h.watcher._pollOnce();
    await h.watcher._pollOnce();
    assert.ok(h.events.some((e) => e.includes('RELAY_DISCONNECTED')));
    assert.ok(h.events.some((e) => e.includes('RELAY_RECONNECTED')));
    fs.rmSync(h.root, { recursive: true, force: true });
  });

  it('emits COMMAND_INTERRUPTED for interrupted movement result', async () => {
    const h = makeHarness();
    h.setRemote({
      schema_version: 1,
      command_id: 'move-int',
      command_type: 'MOVE',
      actor_unit_id: 1,
      destination: { x: 2, y: 2, z: 0 },
      snapshot_sha256: h.digest,
      session_id: h.tactical.eventLog.sessionId,
      turn: h.tactical.turn,
      state_version: h.tactical.eventLog.latestSeq,
    });
    await h.watcher._pollOnce();
    fs.writeFileSync(h.watcher.local.result, `${JSON.stringify({
      schema_version: 1,
      command_id: 'move-int',
      command_type: 'MOVE',
      status: 'INTERRUPTED',
      session_id: h.tactical.eventLog.sessionId,
      turn: h.tactical.turn,
      public_reason: 'Movement interrupted or incomplete.',
      inbox_sha256: 'e'.repeat(64),
    })}\n`, 'utf8');
    await h.watcher._pollOnce();
    assert.ok(h.events.some((e) => e.includes('COMMAND_INTERRUPTED')));
    assert.ok(!h.events.some((e) => e.includes('COMMAND_COMPLETED')));
    fs.rmSync(h.root, { recursive: true, force: true });
  });
});

describe('formatSupervisorConsoleLine', () => {
  it('includes correlation fields', () => {
    const line = formatSupervisorConsoleLine({
      code: NOTIFICATION_CODES.COMMAND_DELIVERED,
      command_id: 'abcd1234efgh5678',
      session_id: '1234567890abcdef1234567890abcdef',
      turn: 2,
      state_version: 5,
      inbox_sha256: 'f'.repeat(64),
      remote_sha256: 'a'.repeat(64),
    });
    assert.match(line, /COMMAND_DELIVERED/);
    assert.match(line, /inbox_sha256=f+/);
    assert.match(line, /remote_sha256=a+/);
  });
});
