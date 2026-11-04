'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const YAML = require('yaml');
const { CommandRelayWatcher, localRelayPaths } = require('../lib/command-relay-watcher.cjs');
const { tryPublishPostCommandTacticalState } = require('../lib/post-command-tactical-publish.cjs');
const { loadCommandJournal } = require('../lib/command-journal.cjs');
const {
  loadAndValidateSnapshotFromText,
} = require('../lib/tactical-publish.cjs');
const { composeMoveCommand, buildCommandBinding } = require('../lib/command-binding.cjs');
const { BriefingWatcher } = require('../lib/briefing-watcher.cjs');

const FIXTURE_V5 = path.join(__dirname, 'fixtures', 'valid-v5.yaml');

function sha256HexLower(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function makeUpdatedSnapshot(baseText, patch) {
  const doc = YAML.parse(baseText);
  const unit = doc.units.find((u) => u.id === patch.unitId);
  assert.ok(unit, 'unit for patch');
  unit.position = patch.position;
  if (patch.timeUnits !== undefined) {
    unit.timeUnits = patch.timeUnits;
  }
  if (patch.latestSeq !== undefined && patch.latestSeq !== doc.eventLog.latestSeq) {
    doc.eventLog.latestSeq = patch.latestSeq;
    const template = doc.eventLog.events[doc.eventLog.events.length - 1];
    doc.eventLog.events.push({
      ...template,
      seq: patch.latestSeq,
    });
  }
  return YAML.stringify(doc);
}

function makeCompletedResult(tactical, digest, overrides = {}) {
  const actor = tactical.units.find((u) => u.id === (overrides.actor_unit_id ?? 1));
  return {
    schema_version: 1,
    command_id: overrides.command_id ?? 'move-post-1',
    command_type: 'MOVE',
    status: 'COMPLETED',
    session_id: tactical.eventLog.sessionId,
    turn: tactical.turn,
    actor_unit_id: actor.id,
    final_position: { x: actor.position[0], y: actor.position[1], z: actor.position[2] },
    remaining_tu: actor.timeUnits,
    destination_reached: true,
    snapshot_sha256: digest,
    ...overrides,
  };
}

describe('post-command tactical publish', () => {
  it('publishes validated snapshot after COMPLETED result', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'post-cmd-pub-'));
    try {
      const baseText = fs.readFileSync(FIXTURE_V5, 'utf8');
      const baseTactical = loadAndValidateSnapshotFromText(baseText, YAML);
      const oldDigest = sha256HexLower(Buffer.from(baseText, 'utf8'));
      const updatedText = makeUpdatedSnapshot(baseText, {
        unitId: 1,
        position: [3, 3, 0],
        timeUnits: 50,
      });
      const snapshotPath = path.join(root, 'tactical-live.yaml');
      fs.writeFileSync(snapshotPath, updatedText, 'utf8');
      const updatedTactical = loadAndValidateSnapshotFromText(updatedText, YAML);
      const newDigest = sha256HexLower(Buffer.from(updatedText, 'utf8'));
      assert.notEqual(newDigest, oldDigest);

      const result = makeCompletedResult(updatedTactical, newDigest, {
        final_position: { x: 3, y: 3, z: 0 },
        remaining_tu: 50,
      });
      const journal = { version: 1, active: null, records: {} };
      const relayPublishes = [];
      const outcome = await tryPublishPostCommandTacticalState({
        snapshotPath,
        result,
        commandId: result.command_id,
        journal,
        record: {
          delivered_command_snapshot_sha256: oldDigest,
        },
        dryRun: false,
        publishRelayState: async (relay) => {
          relayPublishes.push(relay);
          return { skipped: false };
        },
        readFileSync: fs.readFileSync,
        existsSync: fs.existsSync,
      });

      assert.equal(outcome.action, 'published');
      assert.equal(relayPublishes.length, 1);
      assert.equal(relayPublishes[0].commandBinding.snapshot_sha256, newDigest);
      assert.equal(relayPublishes[0].commandBinding.state_version, updatedTactical.eventLog.latestSeq);
      assert.equal(relayPublishes[0].request_id, undefined);
      assert.equal(journal.records[result.command_id].post_command_tactical_sha256, newDigest);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('second MOVE can bind to newly published commandBinding', async () => {
    const baseText = fs.readFileSync(FIXTURE_V5, 'utf8');
    const baseTactical = loadAndValidateSnapshotFromText(baseText, YAML);
    const updatedText = makeUpdatedSnapshot(baseText, {
      unitId: 1,
      position: [4, 4, 0],
      timeUnits: 48,
      latestSeq: baseTactical.eventLog.latestSeq + 1,
    });
    const updatedTactical = loadAndValidateSnapshotFromText(updatedText, YAML);
    const digest = sha256HexLower(Buffer.from(updatedText, 'utf8'));
    const binding = buildCommandBinding(updatedTactical, digest);
    const cmd = composeMoveCommand(binding, {
      commandId: 'move-second',
      actorUnitId: 1,
      destination: { x: 5, y: 4, z: 0 },
    });
    assert.equal(cmd.snapshot_sha256, digest);
    assert.equal(cmd.state_version, updatedTactical.eventLog.latestSeq);
  });

  it('does not republish when observing the same terminal result again', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'post-cmd-dedupe-'));
    try {
      const text = fs.readFileSync(FIXTURE_V5, 'utf8');
      const tactical = loadAndValidateSnapshotFromText(text, YAML);
      const digest = sha256HexLower(Buffer.from(text, 'utf8'));
      const snapshotPath = path.join(root, 'tactical-live.yaml');
      fs.writeFileSync(snapshotPath, text, 'utf8');
      const result = makeCompletedResult(tactical, digest);
      const journal = {
        version: 1,
        active: null,
        records: {
          [result.command_id]: {
            post_command_tactical_sha256: digest,
          },
        },
      };
      let calls = 0;
      const outcome = await tryPublishPostCommandTacticalState({
        snapshotPath,
        result,
        commandId: result.command_id,
        journal,
        record: journal.records[result.command_id],
        publishRelayState: async () => {
          calls += 1;
          return { skipped: false };
        },
        readFileSync: fs.readFileSync,
        existsSync: fs.existsSync,
      });
      assert.equal(outcome.action, 'skip');
      assert.equal(outcome.reason, 'already_published');
      assert.equal(calls, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects session mismatch fail-closed', async () => {
    const text = fs.readFileSync(FIXTURE_V5, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(text, YAML);
    const digest = sha256HexLower(Buffer.from(text, 'utf8'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'post-cmd-session-'));
    try {
      const snapshotPath = path.join(root, 'tactical-live.yaml');
      fs.writeFileSync(snapshotPath, text, 'utf8');
      const result = makeCompletedResult(tactical, digest, {
        session_id: 'b'.repeat(32),
      });
      const outcome = await tryPublishPostCommandTacticalState({
        snapshotPath,
        result,
        commandId: result.command_id,
        journal: { version: 1, active: null, records: {} },
        record: null,
        publishRelayState: async () => ({ skipped: false }),
        readFileSync: fs.readFileSync,
        existsSync: fs.existsSync,
      });
      assert.equal(outcome.action, 'fail_closed');
      assert.equal(outcome.reason, 'session_mismatch');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when snapshot sha unchanged from delivered command', async () => {
    const text = fs.readFileSync(FIXTURE_V5, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(text, YAML);
    const digest = sha256HexLower(Buffer.from(text, 'utf8'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'post-cmd-stale-'));
    try {
      const snapshotPath = path.join(root, 'tactical-live.yaml');
      fs.writeFileSync(snapshotPath, text, 'utf8');
      const result = makeCompletedResult(tactical, digest);
      const outcome = await tryPublishPostCommandTacticalState({
        snapshotPath,
        result,
        commandId: result.command_id,
        journal: { version: 1, active: null, records: {} },
        record: { delivered_command_snapshot_sha256: digest },
        publishRelayState: async () => ({ skipped: false }),
        readFileSync: fs.readFileSync,
        existsSync: fs.existsSync,
      });
      assert.equal(outcome.action, 'fail_closed');
      assert.equal(outcome.reason, 'snapshot_stale_unchanged');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when result lacks snapshot_sha256', async () => {
    const text = fs.readFileSync(FIXTURE_V5, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(text, YAML);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'post-cmd-nosha-'));
    try {
      const snapshotPath = path.join(root, 'tactical-live.yaml');
      fs.writeFileSync(snapshotPath, text, 'utf8');
      const result = makeCompletedResult(tactical, 'a'.repeat(64));
      delete result.snapshot_sha256;
      const outcome = await tryPublishPostCommandTacticalState({
        snapshotPath,
        result,
        commandId: result.command_id,
        journal: { version: 1, active: null, records: {} },
        record: null,
        publishRelayState: async () => ({ skipped: false }),
        readFileSync: fs.readFileSync,
        existsSync: fs.existsSync,
      });
      assert.equal(outcome.action, 'fail_closed');
      assert.equal(outcome.reason, 'missing_result_snapshot_sha256');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('CommandRelayWatcher post-command integration', () => {
  it('publishes tactical state once through publishResult without breaking retirement', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'post-cmd-watcher-'));
    try {
      const baseText = fs.readFileSync(FIXTURE_V5, 'utf8');
      const baseTactical = loadAndValidateSnapshotFromText(baseText, YAML);
      const oldDigest = sha256HexLower(Buffer.from(baseText, 'utf8'));
      const updatedText = makeUpdatedSnapshot(baseText, {
        unitId: 1,
        position: [2, 2, 0],
        timeUnits: 51,
      });
      const updatedTactical = loadAndValidateSnapshotFromText(updatedText, YAML);
      const newDigest = sha256HexLower(Buffer.from(updatedText, 'utf8'));
      const snapshotPath = path.join(root, 'tactical-live.yaml');
      fs.writeFileSync(snapshotPath, updatedText, 'utf8');
      const stateDir = path.join(root, 'state');
      const local = localRelayPaths(snapshotPath);

      const result = makeCompletedResult(updatedTactical, newDigest, {
        final_position: { x: 2, y: 2, z: 0 },
        remaining_tu: 51,
      });
      fs.writeFileSync(local.result, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

      const journal = {
        version: 1,
        active: { command_id: result.command_id, remote_sha256: 'remote-sha' },
        records: {
          [result.command_id]: {
            phase: 'delivered_local',
            delivered_command_snapshot_sha256: oldDigest,
            remote_sha256: 'remote-sha',
          },
        },
      };
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, 'command-relay-journal.json'), `${JSON.stringify(journal)}\n`);

      const relayPublishes = [];
      const resultPublishes = [];
      const logs = [];
      let retireCalls = 0;
      const watcher = new CommandRelayWatcher({
        snapshotPath,
        stateDir,
        dryRun: false,
        pollIntervalMs: 5000,
        log: (line) => logs.push(line),
        readRemoteCommand: async () => null,
        publishRemoteResult: async (payload) => {
          resultPublishes.push(payload);
        },
        publishRemoteRelayState: async (relay) => {
          relayPublishes.push(relay);
          return { skipped: false };
        },
        fetchRemoteResult: async () => null,
        retireRemoteCommand: async () => {
          retireCalls += 1;
        },
        readFileSync: fs.readFileSync,
        existsSync: fs.existsSync,
        writeFileSync: fs.writeFileSync,
        renameSync: fs.renameSync,
        unlinkSync: fs.unlinkSync,
      });

      const loaded = loadCommandJournal(stateDir, fs.readFileSync, fs.existsSync);
      await watcher.publishResult(result, result.command_id, loaded);

      assert.equal(resultPublishes.length, 1, logs.join('\n'));
      assert.equal(relayPublishes.length, 1, logs.join('\n'));
      const after = loadCommandJournal(stateDir, fs.readFileSync, fs.existsSync);
      assert.equal(after.records[result.command_id].post_command_tactical_sha256, newDigest);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('F6 briefing flow isolation', () => {
  it('BriefingWatcher still requires briefing-request and writes ack', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'post-cmd-f6-'));
    try {
      const snapshotText = fs.readFileSync(FIXTURE_V5, 'utf8');
      const snapshotPath = path.join(root, 'tactical-live.yaml');
      fs.writeFileSync(snapshotPath, snapshotText, 'utf8');
      const tactical = loadAndValidateSnapshotFromText(snapshotText, YAML);
      const digest = sha256HexLower(Buffer.from(snapshotText, 'utf8'));
      const requestPath = path.join(root, 'briefing-request.json');
      fs.writeFileSync(requestPath, `${JSON.stringify({
        schema_version: 1,
        type: 'tactical_briefing_request',
        request_id: '0123456789abcdef0123456789abcdef',
        session_id: tactical.eventLog.sessionId,
        turn: tactical.turn,
        snapshot_sha256: digest,
      }, null, 2)}\n`);

      const relayPublishes = [];
      const watcher = new BriefingWatcher({
        requestPath,
        snapshotPath,
        stateDir: path.join(root, 'briefing-state'),
        dryRun: false,
        pollIntervalMs: 5000,
        publishRelayState: async (relay) => {
          relayPublishes.push(relay);
          return { skipped: false };
        },
        readFileSync: fs.readFileSync,
        existsSync: fs.existsSync,
        writeFileSync: fs.writeFileSync,
        renameSync: fs.renameSync,
        unlinkSync: fs.unlinkSync,
      });

      await watcher._pollOnce();
      assert.equal(relayPublishes.length, 1);
      assert.equal(relayPublishes[0].request_id, '0123456789abcdef0123456789abcdef');
      assert.ok(fs.existsSync(path.join(root, 'briefing-ack.json')));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
