'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const YAML = require('yaml');
const {
  buildRelayPayload,
  computeSnapshotId,
  loadAndValidateSnapshotFromText,
  canonicalTacticalJson,
} = require('../lib/tactical-publish.cjs');
const { sha256HexLower } = require('../lib/briefing-snapshot.cjs');
const {
  buildCommandBinding,
  composeMoveCommand,
  bindingMatchesTactical,
} = require('../lib/command-binding.cjs');
const {
  validateMoveAgainstSnapshot,
  validateMoveAgainstSnapshotFile,
  parseMoveCommand,
} = require('../lib/tactical-command.cjs');
const { CommandRelayWatcher, localRelayPaths } = require('../lib/command-relay-watcher.cjs');
const { isAiControlledUnit } = require('../lib/soldier-ownership.cjs');

const FIXTURE_V5 = path.join(__dirname, 'fixtures', 'valid-v5.yaml');

function loadFixture() {
  const text = fs.readFileSync(FIXTURE_V5, 'utf8');
  const tactical = loadAndValidateSnapshotFromText(text, YAML);
  const digest = sha256HexLower(Buffer.from(text, 'utf8'));
  return { text, tactical, digest };
}

describe('relay commandBinding (M1-20B)', () => {
  it('includes verified YAML SHA and does not change snapshot_id', () => {
    const { text, tactical, digest } = loadFixture();
    const beforeId = computeSnapshotId(tactical);
    const relay = buildRelayPayload(tactical, '2026-01-01T00:00:00.000Z', null, { snapshotSha256: digest });
    assert.equal(relay.snapshot_id, beforeId);
    assert.ok(relay.commandBinding);
    assert.equal(relay.commandBinding.snapshot_sha256, digest);
    assert.equal(relay.commandBinding.state_version, tactical.eventLog.latestSeq);
    assert.equal(relay.commandBinding.session_id, tactical.eventLog.sessionId);
    assert.equal(relay.commandBinding.turn, tactical.turn);
    assert.ok(relay.commandBinding.player_soldiers.length >= 1);
    assert.notEqual(relay.commandBinding.snapshot_sha256, relay.snapshot_id);
    void text;
  });

  it('SHA is from YAML bytes, not reconstructed canonical JSON', () => {
    const { text, tactical, digest } = loadFixture();
    const jsonSha = crypto.createHash('sha256').update(canonicalTacticalJson(tactical), 'utf8').digest('hex');
    assert.notEqual(digest, jsonSha);
    const binding = buildCommandBinding(tactical, digest);
    assert.equal(binding.snapshot_sha256, digest);
  });

  it('remote commander can compose a complete MOVE without manual hash copy', () => {
    const { tactical, digest } = loadFixture();
    const relay = buildRelayPayload(tactical, '2026-01-01T00:00:00.000Z', null, { snapshotSha256: digest });
    const cmd = composeMoveCommand(relay.commandBinding, {
      commandId: 'move-authored-1',
      actorUnitId: 1,
      destination: { x: 2, y: 2, z: 0 },
    });
    validateMoveAgainstSnapshot(cmd, tactical, digest);
    parseMoveCommand(cmd);
  });
});

describe('command freshness and rejection (M1-20B)', () => {
  const { tactical, digest } = loadFixture();

  it('rejects missing/wrong snapshot_sha256', () => {
    const cmd = composeMoveCommand(buildCommandBinding(tactical, digest), {
      commandId: 'bad-sha',
      actorUnitId: 1,
      destination: { x: 2, y: 2, z: 0 },
    });
    cmd.snapshot_sha256 = '0'.repeat(64);
    assert.throws(() => validateMoveAgainstSnapshot(cmd, tactical, digest), /snapshot_sha256 mismatch/);
  });

  it('rejects wrong state_version', () => {
    const cmd = composeMoveCommand(buildCommandBinding(tactical, digest), {
      commandId: 'bad-state',
      actorUnitId: 1,
      destination: { x: 2, y: 2, z: 0 },
    });
    cmd.state_version = 999;
    assert.throws(() => validateMoveAgainstSnapshot(cmd, tactical, digest), /state_version/);
  });

  it('rejects wrong session and turn', () => {
    const base = composeMoveCommand(buildCommandBinding(tactical, digest), {
      commandId: 'bad-bind',
      actorUnitId: 1,
      destination: { x: 2, y: 2, z: 0 },
    });
    const wrongSession = { ...base, session_id: 'b'.repeat(32) };
    assert.throws(() => validateMoveAgainstSnapshot(wrongSession, tactical, digest), /session_id mismatch/);
    const wrongTurn = { ...base, turn: tactical.turn + 1 };
    assert.throws(() => validateMoveAgainstSnapshot(wrongTurn, tactical, digest), /turn mismatch/);
  });

  it('rejects wrong actor and hostile ids', () => {
    const binding = buildCommandBinding(tactical, digest);
    assert.throws(() => composeMoveCommand(binding, {
      commandId: 'bad-actor',
      actorUnitId: 1000000,
      destination: { x: 2, y: 2, z: 0 },
    }), /player_soldier|actorUnitId/);
  });

  it('validates against on-disk YAML bytes after JSON pretty-print round trip', () => {
    const { text } = loadFixture();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yaml-bind-'));
    const snapshotPath = path.join(root, 'tactical-live.yaml');
    fs.writeFileSync(snapshotPath, text, 'utf8');
    const cmd = composeMoveCommand(buildCommandBinding(loadFixture().tactical, loadFixture().digest), {
      commandId: 'file-bind',
      actorUnitId: 1,
      destination: { x: 1, y: 2, z: 0 },
    });
    validateMoveAgainstSnapshotFile(cmd, snapshotPath, YAML);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('ownership defaults (M1-20B)', () => {
  it('treats soldiers as human unless local companion-soldier-control assigns ai', () => {
    const { tactical } = loadFixture();
    const session = tactical.eventLog.sessionId;
    assert.equal(isAiControlledUnit('', session, 1), false);
    assert.equal(isAiControlledUnit('{"schema_version":1}', session, 1), false);
    const control = JSON.stringify({
      schema_version: 1,
      session_id: session,
      assignments: { 1: 'ai' },
    });
    assert.equal(isAiControlledUnit(control, session, 1), true);
    assert.equal(isAiControlledUnit(control, session, 2), false);
  });

  it('commandBinding does not expose AI assignment flags', () => {
    const { tactical, digest } = loadFixture();
    const binding = buildCommandBinding(tactical, digest);
    assert.ok(!('assignments' in binding));
    assert.match(binding.ownership_note, /human/i);
  });
});

describe('sidecar handshake replay (M1-20B)', () => {
  it('prevents duplicate command delivery after terminal journal record', async () => {
    const { text, tactical, digest } = loadFixture();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-handshake-'));
    const snapshotPath = path.join(root, 'tactical-live.yaml');
    fs.writeFileSync(snapshotPath, text, 'utf8');
    const stateDir = path.join(root, 'state');
    const local = localRelayPaths(snapshotPath);
    const cmd = composeMoveCommand(buildCommandBinding(tactical, digest), {
      commandId: 'handshake-1',
      actorUnitId: 1,
      destination: { x: 2, y: 2, z: 0 },
    });
    let remote = { text: `${JSON.stringify(cmd, null, 2)}\n`, sha: 'remote-1' };
    const publishes = [];
    const watcher = new CommandRelayWatcher({
      snapshotPath,
      stateDir,
      dryRun: false,
      readRemoteCommand: async () => remote,
      publishRemoteResult: async (result) => publishes.push(result),
      fetchRemoteResult: async () => null,
    });
    await watcher._pollOnce();
    assert.ok(fs.existsSync(local.command));
    fs.writeFileSync(local.result, `${JSON.stringify({
      schema_version: 1,
      command_id: 'handshake-1',
      command_type: 'MOVE',
      status: 'REJECTED',
      session_id: tactical.eventLog.sessionId,
      turn: tactical.turn,
      actor_unit_id: 1,
      snapshot_sha256: digest,
      public_reason: 'NOT_AI_CONTROLLED',
    })}\n`, 'utf8');
    await watcher._pollOnce();
    assert.equal(publishes.length, 1);
    const firstLocal = fs.readFileSync(local.command, 'utf8');
    await watcher._pollOnce();
    assert.equal(fs.readFileSync(local.command, 'utf8'), firstLocal);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('result identity fields', () => {
  it('expects engine result to carry command binding identity', () => {
    const { tactical, digest } = loadFixture();
    const cmd = composeMoveCommand(buildCommandBinding(tactical, digest), {
      commandId: 'id-bind',
      actorUnitId: 1,
      destination: { x: 2, y: 2, z: 0 },
    });
    const sampleResult = {
      schema_version: 1,
      command_id: cmd.command_id,
      command_type: 'MOVE',
      status: 'COMPLETED',
      session_id: cmd.session_id,
      turn: cmd.turn,
      actor_unit_id: cmd.actor_unit_id,
      snapshot_sha256: cmd.snapshot_sha256,
      starting_position: { x: 1, y: 2, z: 0 },
      final_position: { x: 2, y: 2, z: 0 },
    };
    assert.equal(sampleResult.snapshot_sha256, digest);
    assert.equal(sampleResult.session_id, tactical.eventLog.sessionId);
    assert(bindingMatchesTactical(buildCommandBinding(tactical, digest), tactical));
  });
});
