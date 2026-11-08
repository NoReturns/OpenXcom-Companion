'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const YAML = require('yaml');
const { CommandRelayWatcher, localRelayPaths } = require('../lib/command-relay-watcher.cjs');
const { TerrainQueryRelayWatcher } = require('../lib/terrain-query-relay-watcher.cjs');
const { startTacticalRelaySidecar } = require('../lib/tactical-relay-sidecar.cjs');
const { loadAndValidateSnapshotFromText, computeSnapshotId } = require('../lib/tactical-publish.cjs');
const { executeTerrainQuery } = require('../lib/terrain-query.cjs');

const FIXTURE_V5 = path.join(__dirname, 'fixtures', 'valid-v5.yaml');

function sha256HexLower(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function makeMoveCommand(tactical, digest, overrides = {}) {
  return {
    schema_version: 1,
    command_id: overrides.command_id ?? 'move-relay-1',
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

function makeKneelCommand(tactical, digest, overrides = {}) {
  return {
    schema_version: 1,
    command_id: overrides.command_id ?? 'kneel-relay-1',
    command_type: 'KNEEL',
    actor_unit_id: 1,
    snapshot_sha256: digest,
    session_id: tactical.eventLog.sessionId,
    turn: tactical.turn,
    state_version: tactical.eventLog.latestSeq,
    ...overrides,
  };
}

function makeHarness(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'command-relay-'));
  const fixtureText = fs.readFileSync(FIXTURE_V5, 'utf8');
  const snapshotPath = path.join(root, 'tactical-live.yaml');
  fs.writeFileSync(snapshotPath, fixtureText, 'utf8');
  const tactical = loadAndValidateSnapshotFromText(fixtureText, YAML);
  const digest = sha256HexLower(Buffer.from(fixtureText, 'utf8'));
  const stateDir = path.join(root, 'state');
  const local = localRelayPaths(snapshotPath);
  const logs = [];
  const publishes = [];
  let remoteCommand = null;
  let remoteResult = null;
  let remoteQuery = null;
  let remoteQueryResult = null;

  const watcher = new CommandRelayWatcher({
    snapshotPath,
    stateDir,
    dryRun: options.dryRun ?? true,
    pollIntervalMs: 5,
    log: (line) => logs.push(line),
    readRemoteCommand: async () => remoteCommand,
    publishRemoteResult: async (result) => {
      publishes.push(result);
      remoteResult = { text: JSON.stringify(result), sha: 'result-sha' };
    },
    fetchRemoteResult: async () => (remoteResult ? { value: JSON.parse(remoteResult.text) } : null),
    readFileSync: fs.readFileSync,
    existsSync: fs.existsSync,
    writeFileSync: fs.writeFileSync,
    renameSync: fs.renameSync,
    unlinkSync: fs.unlinkSync,
  });

  return {
    root,
    snapshotPath,
    tactical,
    digest,
    local,
    stateDir,
    logs,
    publishes,
    watcher,
    setRemoteCommand(command) {
      remoteCommand = {
        text: `${JSON.stringify(command, null, 2)}\n`,
        sha: crypto.createHash('sha256').update(JSON.stringify(command)).digest('hex'),
      };
    },
    setRemoteResult(result) {
      remoteResult = { text: JSON.stringify(result), sha: 'already-published' };
    },
    setLocalResult(result) {
      fs.writeFileSync(local.result, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    },
  };
}

async function pollUntil(h, predicate, maxTicks = 20) {
  for (let i = 0; i < maxTicks; i += 1) {
    await h.watcher._pollOnce();
    if (predicate()) {
      return;
    }
  }
  assert.fail('condition not met before poll budget exhausted');
}

describe('CommandRelayWatcher', () => {
  it('refuses local inbox write when game session delivery gate rejects', async () => {
    const h = makeHarness();
    h.watcher.assertCommandDeliveryAllowed = () => ({ ok: false, reason: 'game_not_running' });
    h.setRemoteCommand(makeMoveCommand(h.tactical, h.digest));
    await h.watcher._pollOnce();
    assert.ok(!fs.existsSync(h.local.command));
    assert.ok(h.logs.some((line) => line.includes('Command delivery blocked')));
    fs.rmSync(h.root, { recursive: true, force: true });
  });

  it('delivers valid remote MOVE to local inbox atomically', async () => {
    const h = makeHarness();
    h.setRemoteCommand(makeMoveCommand(h.tactical, h.digest));
    await pollUntil(h, () => fs.existsSync(h.local.command));
    const local = JSON.parse(fs.readFileSync(h.local.command, 'utf8'));
    assert.equal(local.command_id, 'move-relay-1');
    assert.equal(local.actor_unit_id, 1);
    assert.ok(!fs.existsSync(path.join(path.dirname(h.local.command), 'companion-soldier-control.json')));
    fs.rmSync(h.root, { recursive: true, force: true });
  });

  it('delivers valid remote KNEEL to local inbox atomically', async () => {
    const h = makeHarness();
    h.setRemoteCommand(makeKneelCommand(h.tactical, h.digest));
    await pollUntil(h, () => fs.existsSync(h.local.command));
    const local = JSON.parse(fs.readFileSync(h.local.command, 'utf8'));
    assert.equal(local.command_type, 'KNEEL');
    assert.equal(local.command_id, 'kneel-relay-1');
    assert.equal(local.destination, undefined);
    fs.rmSync(h.root, { recursive: true, force: true });
  });

  it('rejects stale turn without local delivery', async () => {
    const h = makeHarness({ dryRun: false });
    h.setRemoteCommand(makeMoveCommand(h.tactical, h.digest, { turn: 99, command_id: 'move-stale-turn' }));
    await pollUntil(h, () => h.publishes.length === 1);
    assert.equal(h.publishes[0].status, 'REJECTED');
    assert.match(h.publishes[0].public_reason, /turn mismatch/);
    assert.ok(!fs.existsSync(h.local.command));
    fs.rmSync(h.root, { recursive: true, force: true });
  });

  it('rejects malformed remote JSON', async () => {
    const h = makeHarness({ dryRun: false });
    h.watcher.readRemoteCommand = async () => ({ text: '{not-json', sha: 'bad' });
    await pollUntil(h, () => h.publishes.length === 1);
    assert.equal(h.publishes[0].status, 'REJECTED');
    fs.rmSync(h.root, { recursive: true, force: true });
  });

  it('publishes terminal local engine result', async () => {
    const h = makeHarness({ dryRun: false });
    h.setRemoteCommand(makeMoveCommand(h.tactical, h.digest, { command_id: 'move-complete' }));
    await pollUntil(h, () => fs.existsSync(h.local.command));
    h.setLocalResult({
      schema_version: 1,
      command_id: 'move-complete',
      command_type: 'MOVE',
      status: 'COMPLETED',
      session_id: h.tactical.eventLog.sessionId,
      turn: h.tactical.turn,
      actor_unit_id: 1,
      starting_position: { x: 1, y: 2, z: 0 },
      final_position: { x: 2, y: 2, z: 0 },
      remaining_tu: 42,
      kneeled: false,
      destination_reached: true,
      snapshot_sha256: h.digest,
    });
    await pollUntil(h, () => h.publishes.length === 1);
    assert.equal(h.publishes[0].status, 'COMPLETED');
    assert.equal(h.publishes[0].destination_reached, true);
    fs.rmSync(h.root, { recursive: true, force: true });
  });

  it('does not replay terminal command ids', async () => {
    const h = makeHarness({ dryRun: false });
    h.setRemoteCommand(makeMoveCommand(h.tactical, h.digest, { command_id: 'move-once' }));
    await pollUntil(h, () => fs.existsSync(h.local.command));
    h.setLocalResult({
      schema_version: 1,
      command_id: 'move-once',
      command_type: 'MOVE',
      status: 'REJECTED',
      session_id: h.tactical.eventLog.sessionId,
      turn: h.tactical.turn,
      public_reason: 'NOT_AI_CONTROLLED',
    });
    await pollUntil(h, () => h.publishes.length === 1);
    const publishCount = h.publishes.length;
    await h.watcher._pollOnce();
    assert.equal(h.publishes.length, publishCount);
    fs.rmSync(h.root, { recursive: true, force: true });
  });

  it('skips duplicate result publication when remote already matches', async () => {
    const h = makeHarness({ dryRun: false });
    h.setRemoteCommand(makeMoveCommand(h.tactical, h.digest, { command_id: 'move-dedupe' }));
    await pollUntil(h, () => fs.existsSync(h.local.command));
    const terminal = {
      schema_version: 1,
      command_id: 'move-dedupe',
      command_type: 'MOVE',
      status: 'FAILED',
      session_id: h.tactical.eventLog.sessionId,
      turn: h.tactical.turn,
      public_reason: 'No valid path to destination.',
    };
    h.setRemoteResult(terminal);
    h.setLocalResult(terminal);
    await pollUntil(h, () => h.logs.some((line) => line.includes('skipping publish')));
    assert.equal(h.publishes.length, 0);
    fs.rmSync(h.root, { recursive: true, force: true });
  });

  it('waits while local result is EXECUTING', async () => {
    const h = makeHarness();
    fs.writeFileSync(h.local.result, `${JSON.stringify({
      schema_version: 1,
      command_id: 'prior',
      command_type: 'MOVE',
      status: 'EXECUTING',
      session_id: h.tactical.eventLog.sessionId,
      turn: h.tactical.turn,
    })}\n`, 'utf8');
    h.setRemoteCommand(makeMoveCommand(h.tactical, h.digest, { command_id: 'move-blocked' }));
    await h.watcher._pollOnce();
    assert.ok(!fs.existsSync(h.local.command));
    fs.rmSync(h.root, { recursive: true, force: true });
  });

  it('M1-32D: publishes COMPLETED engine result instead of revalidating stale remote binding', async () => {
    const h = makeHarness({ dryRun: false });
    const commandId = '9f4d6c2a1b7e4d9f8a53c02eb176d49a';
    const kneelCommand = makeKneelCommand(h.tactical, h.digest, { command_id: commandId });
    h.setRemoteCommand(kneelCommand);
    await pollUntil(h, () => fs.existsSync(h.local.command));

    const postTactical = structuredClone(h.tactical);
    postTactical.units[0].kneeled = true;
    postTactical.units[0].timeUnits = 52;
    const postYaml = `${YAML.stringify(postTactical)}\n`;
    fs.writeFileSync(h.snapshotPath, postYaml, 'utf8');
    const postDigest = sha256HexLower(Buffer.from(postYaml, 'utf8'));
    assert.notEqual(postDigest, h.digest);

    h.setLocalResult({
      schema_version: 1,
      command_id: commandId,
      command_type: 'KNEEL',
      status: 'COMPLETED',
      session_id: h.tactical.eventLog.sessionId,
      turn: h.tactical.turn,
      actor_unit_id: 1,
      starting_position: { x: 1, y: 2, z: 0 },
      final_position: { x: 1, y: 2, z: 0 },
      remaining_tu: 52,
      kneeled: true,
      destination_reached: false,
      snapshot_sha256: postDigest,
    });

    await pollUntil(h, () => h.publishes.length === 1);
    assert.equal(h.publishes[0].status, 'COMPLETED');
    assert.equal(h.publishes[0].command_id, commandId);
    assert.notEqual(h.publishes[0].sidecar_reject_code, 'SIDECAR_VALIDATION');
    await h.watcher._pollOnce();
    assert.equal(h.publishes.length, 1, 'must not publish synthetic REJECTED over COMPLETED');
    fs.rmSync(h.root, { recursive: true, force: true });
  });

  it('M1-32D: still rejects genuinely stale remote command before delivery', async () => {
    const h = makeHarness({ dryRun: false });
    const postTactical = structuredClone(h.tactical);
    postTactical.units[0].kneeled = true;
    const postYaml = `${YAML.stringify(postTactical)}\n`;
    fs.writeFileSync(h.snapshotPath, postYaml, 'utf8');
    const postDigest = sha256HexLower(Buffer.from(postYaml, 'utf8'));
    h.setRemoteCommand(makeKneelCommand(h.tactical, h.digest, {
      command_id: 'kneel-stale-pre-delivery',
    }));
    await pollUntil(h, () => h.publishes.length === 1);
    assert.equal(h.publishes[0].status, 'REJECTED');
    assert.match(h.publishes[0].public_reason, /snapshot_sha256 mismatch/);
    assert.ok(!fs.existsSync(h.local.command));
    fs.rmSync(h.root, { recursive: true, force: true });
  });
});

describe('TerrainQueryRelayWatcher', () => {
  it('publishes bounded terrain query results for matching snapshot_id', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terrain-query-relay-'));
    const fixtureText = fs.readFileSync(FIXTURE_V5, 'utf8');
    const snapshotPath = path.join(root, 'tactical-live.yaml');
    fs.writeFileSync(snapshotPath, fixtureText, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(fixtureText, YAML);
    const snapshotId = computeSnapshotId(tactical);
    const publishes = [];
    let remoteQuery = {
      text: JSON.stringify({
        snapshot_id: snapshotId,
        center: { x: 1, y: 2, z: 0 },
        radius: 2,
      }),
      sha: 'query-sha-1',
    };

    const watcher = new TerrainQueryRelayWatcher({
      snapshotPath,
      stateDir: path.join(root, 'state'),
      dryRun: false,
      pollIntervalMs: 5,
      readRemoteQuery: async () => remoteQuery,
      publishRemoteQueryResult: async (response) => publishes.push(response),
    });
    await watcher._pollOnce();
    assert.equal(publishes.length, 1);
    assert.equal(publishes[0].snapshot_id, snapshotId);
    assert.ok(publishes[0].discovered.length >= 1);
    assert.ok(publishes[0].unknown.length >= 1);
    await watcher._pollOnce();
    assert.equal(publishes.length, 1);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('terrain fairness regression (M1-20)', () => {
  it('walk export uses Tile::getTUCost without off-LOS MapData bypass', () => {
    const capturePath = path.join(
      __dirname,
      '../../../engine/OpenXcom/src/Engine/CompanionSnapshotTerrainCapture.cpp',
    );
    const src = fs.readFileSync(capturePath, 'utf8');
    assert.match(src, /return tile->getTUCost\(part, MT_WALK\)/);
    assert.doesNotMatch(src, /isUFODoor\(\)\s*&&\s*!inLos/);
    assert.doesNotMatch(src, /getMapData\(part\)->getTUCost/);
  });
});

describe('tactical relay sidecar integration', () => {
  it('does not touch ping contract files', () => {
    const sidecarSource = fs.readFileSync(path.join(__dirname, '../lib/tactical-relay-sidecar.cjs'), 'utf8');
    assert.ok(!/m0\/command\.json/.test(sidecarSource));
    assert.ok(!/m0\/result\.json/.test(sidecarSource));
  });
});
