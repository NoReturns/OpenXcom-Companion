'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  runPreflight,
  assessInboundDeliverySafety,
  inspectLocalState,
  detectRunningSidecars,
  startRelaySupervisor,
  shutdownSupervisor,
  prefixLines,
  MODES,
  resolvePaths,
} = require('../lib/companion-relay-launcher.cjs');
const { parseArgs } = require('../companion-relay-launcher-cli.cjs');

const YAML = require('yaml');
const { loadAndValidateSnapshotFromText } = require('../lib/tactical-publish.cjs');
const { sha256HexLower, readSnapshotByteBuffer } = require('../lib/briefing-snapshot.cjs');

const FIXTURE_V5 = path.join(__dirname, 'fixtures', 'valid-v5.yaml');

function fixtureTacticalAndDigest() {
  const text = fs.readFileSync(FIXTURE_V5, 'utf8');
  const tactical = loadAndValidateSnapshotFromText(text, YAML);
  const digest = sha256HexLower(readSnapshotByteBuffer(fs.readFileSync, FIXTURE_V5));
  return { tactical, digest };
}

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'relay-launcher-'));
}

describe('companion-relay-launcher preflight', () => {
  it('reports safe inbound when no remote command', async () => {
    const root = makeTempRoot();
    try {
      const snapshotPath = path.join(root, 'tactical-live.yaml');
      fs.copyFileSync(FIXTURE_V5, snapshotPath);
      const report = await runPreflight({
        snapshotPath,
        checkGhAuth: () => true,
        readRemoteFile: async () => null,
      });
      assert.equal(report.inbound.safe, true);
      assert.equal(report.ready.outbound, true);
      assert.equal(report.ready.full, true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks full relay on unresolved remote command without terminal result', async () => {
    const root = makeTempRoot();
    try {
      const snapshotPath = path.join(root, 'tactical-live.yaml');
      fs.copyFileSync(FIXTURE_V5, snapshotPath);
      const { tactical, digest } = fixtureTacticalAndDigest();
      const command = {
        schema_version: 1,
        command_id: 'move-unresolved-1',
        command_type: 'MOVE',
        actor_unit_id: 1,
        destination: { x: 2, y: 2, z: 0 },
        snapshot_sha256: digest,
        session_id: tactical.eventLog.sessionId,
        turn: tactical.turn,
        state_version: tactical.eventLog.latestSeq,
      };
      const report = await runPreflight({
        snapshotPath,
        checkGhAuth: () => true,
        readRemoteFile: async (p) => {
          if (p.endsWith('tactical-command.json')) {
            return { text: `${JSON.stringify(command)}\n`, sha: 'abc123' };
          }
          return null;
        },
      });
      assert.equal(report.inbound.safe, false);
      assert.equal(report.ready.full, false);
      assert.ok(report.inbound.blockers.some((b) => b.includes('no matching terminal result')));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('detects already-running sidecars via injected process list', () => {
    const running = detectRunningSidecars({
      listProcesses: () => ([
        { pid: 1001, commandLine: 'node publish-tactical-once.cjs --briefing-watch --publish' },
        { pid: 1002, commandLine: 'node publish-tactical-once.cjs --command-relay-watch --publish' },
      ]),
    });
    assert.equal(running.length, 2);
    assert.equal(running[0].kind, 'briefing');
    assert.equal(running[1].kind, 'command-relay');
  });

  it('flags local EXECUTING result as inbound unsafe', () => {
    const root = makeTempRoot();
    try {
      const snapshotPath = path.join(root, 'tactical-live.yaml');
      fs.copyFileSync(FIXTURE_V5, snapshotPath);
      const paths = resolvePaths(snapshotPath);
      fs.writeFileSync(paths.localResult, `${JSON.stringify({
        schema_version: 1,
        command_id: 'x',
        command_type: 'MOVE',
        status: 'EXECUTING',
        session_id: 'a'.repeat(32),
        turn: 1,
      })}\n`, 'utf8');
      const local = inspectLocalState(paths);
      const inbound = assessInboundDeliverySafety(local, {
        readErrors: [],
        remoteCommand: null,
        parsedCommand: null,
      }, paths);
      assert.equal(inbound.safe, false);
      assert.ok(inbound.blockers.some((b) => b.includes('EXECUTING')));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('companion-relay-launcher supervisor', () => {
  it('fail closed on full start when inbound unsafe', async () => {
    const root = makeTempRoot();
    try {
      const snapshotPath = path.join(root, 'tactical-live.yaml');
      fs.copyFileSync(FIXTURE_V5, snapshotPath);
      await assert.rejects(
        () => startRelaySupervisor(MODES.FULL, {
          snapshotPath,
          checkGhAuth: () => true,
          readRemoteFile: async () => ({ text: '{"schema_version":1,"command_id":"x","command_type":"MOVE"}\n', sha: 'x' }),
        }),
        (error) => error.code === 'INBOUND_UNSAFE',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows full start with acknowledge flag despite blockers', async () => {
    const root = makeTempRoot();
    try {
      const snapshotPath = path.join(root, 'tactical-live.yaml');
      fs.copyFileSync(FIXTURE_V5, snapshotPath);
      const children = [];
      const supervisor = await startRelaySupervisor(MODES.FULL, {
        snapshotPath,
        acknowledgeInboundRisk: true,
        dryRun: true,
        checkGhAuth: () => true,
        readRemoteFile: async () => null,
        spawnSidecarProcess: (mode, paths, opts) => {
          const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
          children.push(child);
          return { child, channel: mode, args: [] };
        },
      });
      assert.equal(supervisor.children.length, 2);
      shutdownSupervisor(supervisor.children);
      await Promise.all(supervisor.children.map(({ child }) => new Promise((r) => child.on('exit', r))));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('stops mock child processes on shutdown', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 200)'], { stdio: 'ignore' });
    const entry = { child, channel: 'test', args: [] };
    shutdownSupervisor([entry], 'SIGTERM');
    await new Promise((resolve) => child.on('exit', resolve));
    assert.ok(child.exitCode !== null || child.signalCode !== null);
  });

  it('prefixes log lines with channel', () => {
    let out = '';
    prefixLines('briefing', Buffer.from('hello\nworld\n'), (line) => { out += line; });
    assert.match(out, /\[briefing\] hello/);
    assert.match(out, /\[briefing\] world/);
  });

  it('propagates spawn failure without leaving running children', async () => {
    const root = makeTempRoot();
    try {
      const snapshotPath = path.join(root, 'tactical-live.yaml');
      fs.copyFileSync(FIXTURE_V5, snapshotPath);
      let started = 0;
      await assert.rejects(
        () => startRelaySupervisor(MODES.FULL, {
          snapshotPath,
          dryRun: true,
          checkGhAuth: () => true,
          readRemoteFile: async () => null,
          spawnSidecarProcess: () => {
            started += 1;
            if (started === 1) {
              return { child: spawn(process.execPath, ['-e', 'setInterval(() => {}, 500)'], { stdio: 'ignore' }), channel: 'briefing', args: [] };
            }
            throw new Error('spawn failed');
          },
        }),
        /spawn failed/,
      );
      assert.equal(started, 2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('companion-relay-launcher-cli args', () => {
  it('defaults to preflight mode', () => {
    const args = parseArgs(['node', 'cli.cjs']);
    assert.equal(args.preflight, true);
    assert.equal(args.startMode, null);
  });

  it('parses full start with acknowledge flag', () => {
    const args = parseArgs(['node', 'cli.cjs', '--start', 'full', '--acknowledge-inbound-risk']);
    assert.equal(args.startMode, 'full');
    assert.equal(args.acknowledgeInboundRisk, true);
  });
});
