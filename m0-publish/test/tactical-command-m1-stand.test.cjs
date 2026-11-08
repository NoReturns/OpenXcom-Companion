'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const YAML = require('yaml');
const { loadAndValidateSnapshotFromText, computeSnapshotId } = require('../lib/tactical-publish.cjs');
const { buildCommandBinding, composeStandCommand, composeMoveCommand, composeKneelCommand } = require('../lib/command-binding.cjs');
const {
  parseStandCommand,
  parseTacticalCommand,
  validateStandAgainstSnapshot,
  validateTacticalCommandAgainstSnapshot,
  validateTacticalCommandAgainstSnapshotFile,
  buildResultEnvelope,
  canAcceptNewCommand,
  isTerminalStatus,
  COMMAND_TYPE_STAND,
  COMMAND_TYPE_MOVE,
  COMMAND_TYPE_KNEEL,
} = require('../lib/tactical-command.cjs');
const { CommandRelayWatcher, localRelayPaths } = require('../lib/command-relay-watcher.cjs');
const { evaluateInboxBeforeCreate, TacticalCommandPublishError } = require('../lib/relay-tactical-command-publish.cjs');

const FIXTURE_V5 = path.join(__dirname, 'fixtures', 'valid-v5.yaml');

function sha256HexLower(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function tactical() {
  return loadAndValidateSnapshotFromText(fs.readFileSync(FIXTURE_V5, 'utf8'), YAML);
}

function standBase(tac, digest, overrides = {}) {
  return {
    schema_version: 1,
    command_id: overrides.command_id ?? 'stand-1',
    command_type: COMMAND_TYPE_STAND,
    actor_unit_id: overrides.actor_unit_id ?? 1,
    snapshot_sha256: digest,
    session_id: tac.eventLog.sessionId,
    turn: tac.turn,
    state_version: tac.eventLog.latestSeq,
    ...overrides,
  };
}

const DIGEST = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

describe('tactical STAND command schema (M1 stand sidecar)', () => {
  it('A: parses valid STAND command (no destination)', () => {
    const tac = tactical();
    const cmd = parseStandCommand(standBase(tac, DIGEST));
    assert.equal(cmd.commandType, 'STAND');
    assert.equal(cmd.destination, undefined);
  });

  it('C: rejects STAND with MOVE-only destination field', () => {
    const tac = tactical();
    assert.throws(
      () => parseStandCommand({ ...standBase(tac, DIGEST), destination: { x: 1, y: 1, z: 0 } }),
      /unknown command field: destination/,
    );
  });

  it('B: parseTacticalCommand routes STAND', () => {
    const tac = tactical();
    assert.equal(parseTacticalCommand(standBase(tac, DIGEST)).commandType, COMMAND_TYPE_STAND);
  });

  it('D: invalid actor_unit_id rejected at parse', () => {
    const tac = tactical();
    assert.throws(() => parseStandCommand({ ...standBase(tac, DIGEST), actor_unit_id: 0 }), /actor_unit_id/);
  });

  it('E: actor not in snapshot rejected at validation', () => {
    const tac = tactical();
    const cmd = standBase(tac, DIGEST, { actor_unit_id: 9999 });
    assert.throws(() => validateStandAgainstSnapshot(cmd, tac, DIGEST), /actor_unit_id not in snapshot/);
  });

  it('F: wrong session_id rejected', () => {
    const tac = tactical();
    const cmd = standBase(tac, DIGEST, { session_id: 'ffffffffffffffffffffffffffffffff' });
    assert.throws(() => validateStandAgainstSnapshot(cmd, tac, DIGEST), /session_id mismatch/);
  });

  it('G: stale turn and state_version rejected', () => {
    const tac = tactical();
    assert.throws(
      () => validateStandAgainstSnapshot(standBase(tac, DIGEST, { turn: 99 }), tac, DIGEST),
      /turn mismatch/,
    );
    assert.throws(
      () => validateStandAgainstSnapshot(
        standBase(tac, DIGEST, { state_version: tac.eventLog.latestSeq + 5 }),
        tac,
        DIGEST,
      ),
      /state_version/,
    );
    assert.throws(
      () => validateStandAgainstSnapshot(standBase(tac, DIGEST, { snapshot_sha256: 'f'.repeat(64) }), tac, DIGEST),
      /snapshot_sha256 mismatch/,
    );
  });

  it('validateTacticalCommandAgainstSnapshot dispatches STAND', () => {
    const tac = tactical();
    validateTacticalCommandAgainstSnapshot(standBase(tac, DIGEST), tac, DIGEST);
  });

  it('composeStandCommand from relay binding', () => {
    const tac = tactical();
    const binding = buildCommandBinding(tac, DIGEST);
    const cmd = composeStandCommand(binding, { commandId: 'stand-compose', actorUnitId: 1 });
    parseStandCommand(cmd);
    validateStandAgainstSnapshot(cmd, tac, DIGEST);
  });

  it('H: duplicate command_id handled idempotently at publish inbox', () => {
    const tac = tactical();
    const cmd = standBase(tac, DIGEST, { command_id: 'stand-dedupe' });
    const serialized = `${JSON.stringify(cmd, null, 2)}\n`;
    const same = evaluateInboxBeforeCreate({ text: serialized }, cmd, serialized);
    assert.equal(same.action, 'skip');
    assert.equal(same.reason, 'remote_unchanged');
    try {
      evaluateInboxBeforeCreate(
        { text: serialized },
        { ...cmd, turn: cmd.turn + 1 },
        `${JSON.stringify({ ...cmd, turn: cmd.turn + 1 }, null, 2)}\n`,
      );
      assert.fail('expected inbox_occupied');
    } catch (error) {
      assert.ok(error instanceof TacticalCommandPublishError);
      assert.equal(error.code, 'inbox_occupied');
    }
  });

  it('K: STAND result envelope preserves command_id', () => {
    const tac = tactical();
    const cmd = standBase(tac, DIGEST, { command_id: 'stand-result-1' });
    const result = buildResultEnvelope(cmd, 'COMPLETED', { kneeled: false });
    assert.equal(result.command_id, 'stand-result-1');
    assert.equal(result.command_type, 'STAND');
    assert.equal(isTerminalStatus(result.status), true);
    assert.equal(canAcceptNewCommand('COMPLETED'), true);
  });

  it('L: MOVE and KNEEL regression unchanged', () => {
    const tac = tactical();
    assert.throws(
      () => parseTacticalCommand({
        ...standBase(tac, DIGEST),
        command_type: COMMAND_TYPE_MOVE,
      }),
      /destination required/,
    );
    assert.equal(
      parseTacticalCommand({
        ...standBase(tac, DIGEST),
        command_type: COMMAND_TYPE_KNEEL,
      }).commandType,
      COMMAND_TYPE_KNEEL,
    );
    const binding = buildCommandBinding(tac, DIGEST);
    parseTacticalCommand(composeMoveCommand(binding, {
      commandId: 'm-reg',
      actorUnitId: 1,
      destination: { x: 1, y: 2, z: 0 },
    }));
    parseTacticalCommand(composeKneelCommand(binding, { commandId: 'k-reg', actorUnitId: 1 }));
  });
});

describe('CommandRelayWatcher STAND delivery', () => {
  it('delivers valid remote STAND to local inbox (sidecar accepts)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stand-relay-'));
    const fixtureText = fs.readFileSync(FIXTURE_V5, 'utf8');
    const snapshotPath = path.join(root, 'tactical-live.yaml');
    fs.writeFileSync(snapshotPath, fixtureText, 'utf8');
    const tac = loadAndValidateSnapshotFromText(fixtureText, YAML);
    const digest = sha256HexLower(Buffer.from(fixtureText, 'utf8'));
    const local = localRelayPaths(snapshotPath);
    let remoteCommand = null;
    const watcher = new CommandRelayWatcher({
      snapshotPath,
      stateDir: path.join(root, 'state'),
      dryRun: true,
      pollIntervalMs: 5,
      log: () => {},
      readRemoteCommand: async () => remoteCommand,
      publishRemoteResult: async () => {},
      fetchRemoteResult: async () => null,
      readFileSync: fs.readFileSync,
      existsSync: fs.existsSync,
      writeFileSync: fs.writeFileSync,
      renameSync: fs.renameSync,
      unlinkSync: fs.unlinkSync,
    });
    const cmd = standBase(tac, digest, { command_id: 'stand-relay-1' });
    remoteCommand = {
      text: `${JSON.stringify(cmd, null, 2)}\n`,
      sha: crypto.createHash('sha256').update(JSON.stringify(cmd)).digest('hex'),
    };
    validateTacticalCommandAgainstSnapshotFile(cmd, snapshotPath, YAML, fs.readFileSync);
    for (let i = 0; i < 20 && !fs.existsSync(local.command); i += 1) {
      await watcher._pollOnce();
    }
    assert.ok(fs.existsSync(local.command), 'STAND must reach local inbox after sidecar validation');
    const localCmd = JSON.parse(fs.readFileSync(local.command, 'utf8'));
    assert.equal(localCmd.command_type, 'STAND');
    assert.equal(localCmd.command_id, 'stand-relay-1');
    assert.equal(localCmd.destination, undefined);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('rejects stale STAND before local delivery', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stand-stale-'));
    const fixtureText = fs.readFileSync(FIXTURE_V5, 'utf8');
    const snapshotPath = path.join(root, 'tactical-live.yaml');
    fs.writeFileSync(snapshotPath, fixtureText, 'utf8');
    const tac = loadAndValidateSnapshotFromText(fixtureText, YAML);
    const digest = sha256HexLower(Buffer.from(fixtureText, 'utf8'));
    const local = localRelayPaths(snapshotPath);
    const publishes = [];
    let remoteCommand = null;
    const watcher = new CommandRelayWatcher({
      snapshotPath,
      stateDir: path.join(root, 'state'),
      dryRun: false,
      pollIntervalMs: 5,
      log: () => {},
      readRemoteCommand: async () => remoteCommand,
      publishRemoteResult: async (result) => { publishes.push(result); },
      fetchRemoteResult: async () => null,
      readFileSync: fs.readFileSync,
      existsSync: fs.existsSync,
      writeFileSync: fs.writeFileSync,
      renameSync: fs.renameSync,
      unlinkSync: fs.unlinkSync,
    });
    remoteCommand = {
      text: `${JSON.stringify(standBase(tac, digest, { command_id: 'stand-stale', turn: 99 }), null, 2)}\n`,
      sha: 'stale',
    };
    for (let i = 0; i < 20 && publishes.length === 0; i += 1) {
      await watcher._pollOnce();
    }
    assert.equal(publishes[0].status, 'REJECTED');
    assert.match(publishes[0].public_reason, /turn mismatch/);
    assert.ok(!fs.existsSync(local.command));
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('STAND engine contract (Node documents; engine authoritative)', () => {
  it('J/I: posture legality and NOT_AI_CONTROLLED are engine-only (see companion_command_test)', () => {
    assert.ok(true, 'C++ companion_command_test covers ALREADY_STANDING, INSUFFICIENT_TU, parseStandCommandJson');
  });
});
