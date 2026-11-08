'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  beginCompanionPlaySession,
  registerPlaySessionDaemonPid,
  registerPlaySessionGamePid,
  readPlaySessionLease,
} = require('../lib/on-demand-play-session.cjs');
const {
  assessDaemonGameSessionTick,
  assertCommandDeliveryAllowed,
  createGameSessionWatchdog,
  verifyOpenXcomGameProcessIdentity,
  GAME_INIT_GRACE_MS,
  GAME_PID_SPAWN_GRACE_MS,
  UNBOUND_DAEMON_MAX_MS,
} = require('../lib/on-demand-game-session.cjs');
const {
  processPendingRequest,
  createOnDemandRelayContext,
} = require('../lib/companion-on-demand-relay.cjs');
const {
  DAEMON_STATE,
  readDaemonHealth,
} = require('../lib/on-demand-daemon-health.cjs');
const {
  isolatedCommandRelayStateDir,
} = require('../lib/relay-test-isolation.cjs');

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'game-session-'));
}

const RUNTIME_OPENXCOM = 'E:\\Open X-Com Companion\\runtime\\m0\\bin\\openxcom.exe';

function openxcomDeps(gamePid, { alive = true, creationMs = Date.now() - 5000 } = {}) {
  return {
    platform: 'win32',
    isProcessRunning: (pid) => (alive ? pid === gamePid || pid === 424242 : false),
    getProcessCreationIdentity: (pid) => {
      if (pid !== gamePid) {
        return { ok: false, reason: 'process_not_found' };
      }
      return {
        ok: true,
        creationMs,
        executablePath: RUNTIME_OPENXCOM,
        commandLine: `"${RUNTIME_OPENXCOM}" -data "x" -user "y"`,
      };
    },
  };
}

describe('M1 play session game lifecycle watchdog', () => {
  let root;
  let snapshotPath;
  let snapshotDir;

  beforeEach(() => {
    root = makeRoot();
    snapshotPath = path.join(root, 'tactical-live.yaml');
    snapshotDir = path.dirname(snapshotPath);
    fs.writeFileSync(snapshotPath, 'tactical: {}\n', 'utf8');
  });

  it('normal game exit triggers daemon shutdown decision', () => {
    const session = beginCompanionPlaySession({ snapshotPath, launcherPid: 424242 });
    const gamePid = 50001;
    registerPlaySessionDaemonPid(snapshotPath, session.sessionId, 60001);
    registerPlaySessionGamePid(snapshotPath, session.sessionId, gamePid, openxcomDeps(gamePid));

    const state = {
      snapshotPath,
      daemonPid: 60001,
      daemonStartedAtMs: Date.now() - 10_000,
      boundSessionId: session.sessionId,
      gameEverVerified: true,
    };

    const alive = assessDaemonGameSessionTick(state, openxcomDeps(gamePid, { alive: true }));
    assert.equal(alive.action, 'continue');

    const exited = assessDaemonGameSessionTick(state, openxcomDeps(gamePid, { alive: false }));
    assert.equal(exited.action, 'shutdown');
    assert.equal(exited.reason, 'game_exited');
  });

  it('forced game termination before first verify uses spawn grace then shutdown', () => {
    const now = Date.now();
    const session = beginCompanionPlaySession({ snapshotPath, launcherPid: 424242, nowMs: now });
    const gamePid = 50002;
    registerPlaySessionGamePid(snapshotPath, session.sessionId, gamePid, {
      ...openxcomDeps(gamePid),
      nowMs: now,
    });

    const state = {
      snapshotPath,
      daemonPid: 60002,
      daemonStartedAtMs: now,
      boundSessionId: session.sessionId,
      gameEverVerified: false,
    };

    const deps = openxcomDeps(gamePid, { alive: false });
    deps.nowMs = now + 1000;
    const grace = assessDaemonGameSessionTick(state, deps);
    assert.equal(grace.action, 'grace');

    deps.nowMs = now + GAME_PID_SPAWN_GRACE_MS + 1;
    const shut = assessDaemonGameSessionTick(state, deps);
    assert.equal(shut.action, 'shutdown');
    assert.equal(shut.reason, 'game_exited_before_bind');
  });

  it('launcher terminated: game bound then exit still shuts down daemon', () => {
    const session = beginCompanionPlaySession({ snapshotPath, launcherPid: 777777 });
    const gamePid = 50003;
    registerPlaySessionGamePid(snapshotPath, session.sessionId, gamePid, openxcomDeps(gamePid));

    const state = {
      snapshotPath,
      daemonPid: 60003,
      daemonStartedAtMs: Date.now() - 5000,
      boundSessionId: session.sessionId,
      gameEverVerified: true,
    };

    const deps = {
      ...openxcomDeps(gamePid, { alive: false }),
      isProcessRunning: (pid) => pid === gamePid && false,
    };
    const result = assessDaemonGameSessionTick(state, deps);
    assert.equal(result.action, 'shutdown');
    assert.equal(result.reason, 'game_exited');
  });

  it('engine recovery daemon adopts lease and survives while game active', () => {
    const session = beginCompanionPlaySession({ snapshotPath, launcherPid: 888888 });
    const gamePid = 50004;
    const daemonPid = 60004;
    registerPlaySessionGamePid(snapshotPath, session.sessionId, gamePid, openxcomDeps(gamePid));

    const daemonLine = `"${process.execPath}" "${path.join(__dirname, '..', 'companion-on-demand-relay-daemon.cjs')}" --snapshot-path "${snapshotPath}"`;
    const state = {
      snapshotPath,
      daemonPid,
      daemonStartedAtMs: Date.now(),
      boundSessionId: null,
      gameEverVerified: false,
    };

    const deps = {
      ...openxcomDeps(gamePid),
      isProcessRunning: (pid) => pid === gamePid || pid === daemonPid,
      listProcesses: () => [{ pid: daemonPid, commandLine: daemonLine }],
      getProcessCreationIdentity: (pid) => {
        if (pid === gamePid) {
          return openxcomDeps(gamePid).getProcessCreationIdentity(pid);
        }
        if (pid === daemonPid) {
          return {
            ok: true,
            creationMs: Date.now(),
            executablePath: process.execPath,
            commandLine: daemonLine,
          };
        }
        return { ok: false, reason: 'not_found' };
      },
    };
    const tick = assessDaemonGameSessionTick(state, deps);
    assert.equal(tick.action, 'continue');
    const lease = readPlaySessionLease(snapshotDir);
    assert.ok(lease.daemon_pids.includes(60004));
  });

  it('unregistered split-brain daemon exits when registered owner exists', () => {
    const session = beginCompanionPlaySession({ snapshotPath, launcherPid: 424242 });
    const gamePid = 50005;
    registerPlaySessionDaemonPid(snapshotPath, session.sessionId, 60005);
    registerPlaySessionGamePid(snapshotPath, session.sessionId, gamePid, openxcomDeps(gamePid));

    const daemonLine = `"${process.execPath}" "${path.join(__dirname, '..', 'companion-on-demand-relay-daemon.cjs')}" --snapshot-path "${snapshotPath}"`;
    const deps = {
      ...openxcomDeps(gamePid),
      isProcessRunning: (pid) => pid === gamePid || pid === 60005 || pid === 60006,
      getProcessCreationIdentity: (pid) => {
        if (pid === gamePid) {
          return openxcomDeps(gamePid).getProcessCreationIdentity(gamePid);
        }
        if (pid === 60005 || pid === 60006) {
          return {
            ok: true,
            creationMs: Date.now(),
            executablePath: process.execPath,
            commandLine: daemonLine,
          };
        }
        return { ok: false, reason: 'process_not_found' };
      },
      listProcesses: () => ([
        { pid: 60005, commandLine: daemonLine },
        { pid: 60006, commandLine: daemonLine },
      ]),
    };

    const state = {
      snapshotPath,
      daemonPid: 60006,
      daemonStartedAtMs: Date.now(),
      boundSessionId: session.sessionId,
      gameEverVerified: true,
    };

    fs.writeFileSync(path.join(snapshotDir, '.companion-on-demand-daemon-ownership.json'), `${JSON.stringify({
      schema_version: 1,
      pid: 60005,
      ownership_token: 'owner-a',
      started_at_ms: Date.now(),
      owner: 'daemon',
    })}\n`);

    const result = assessDaemonGameSessionTick(state, deps);
    assert.equal(result.action, 'shutdown');
    assert.equal(result.reason, 'unregistered_split_brain_daemon');
  });

  it('stale PID reuse on game process is rejected', () => {
    const lease = {
      game_pid: 50006,
      game_creation_ms: Date.now(),
      game_executable_path: RUNTIME_OPENXCOM,
    };
    const identity = verifyOpenXcomGameProcessIdentity(50006, lease, {
      ...openxcomDeps(50006),
      getProcessCreationIdentity: () => ({
        ok: true,
        creationMs: Date.now() - 120_000,
        executablePath: RUNTIME_OPENXCOM,
        commandLine: 'openxcom',
      }),
    });
    assert.equal(identity.ok, false);
    assert.equal(identity.reason, 'game_pid_reuse');
  });

  it('active second session causes stale daemon to exit', () => {
    const sessionA = beginCompanionPlaySession({
      snapshotPath,
      launcherPid: 1,
      sessionId: 'sess-a',
      nowMs: Date.now() - 60_000,
    });
    beginCompanionPlaySession({
      snapshotPath,
      launcherPid: 2,
      sessionId: 'sess-b',
      nowMs: Date.now(),
    });

    const deps = {
      platform: 'win32',
      isProcessRunning: (pid) => pid === 2 || pid === 70001,
      getProcessCreationIdentity: (pid) => ({
        ok: true,
        creationMs: Date.now(),
        executablePath: RUNTIME_OPENXCOM,
        commandLine: 'openxcom',
      }),
    };

    const state = {
      snapshotPath,
      daemonPid: 60007,
      daemonStartedAtMs: Date.now() - 60_000,
      boundSessionId: sessionA.sessionId,
      gameEverVerified: true,
    };

    const tick = assessDaemonGameSessionTick(state, deps);
    assert.equal(tick.action, 'shutdown');
    assert.equal(tick.reason, 'foreign_play_session_active');
  });

  it('in-flight request gate closes after shutdown requested', async () => {
    let shutdownReason = null;
    const now = Date.now();
    const watchdog = createGameSessionWatchdog({
      snapshotPath,
      daemonPid: 90001,
      startedAtMs: now - UNBOUND_DAEMON_MAX_MS - 5000,
      deps: { disableGameSessionGate: false, nowMs: now },
      onShutdown: (reason) => {
        shutdownReason = reason;
      },
    });

    await watchdog.beforeTick();
    assert.equal(watchdog.acceptingRequests(), false);
    assert.ok(shutdownReason);

    const relayStateDir = isolatedCommandRelayStateDir(root, 'relay-state');
    const ctx = createOnDemandRelayContext({
      snapshotPath,
      dryRun: true,
      commandRelayStateDir: relayStateDir,
    });
    ctx.gameSessionWatchdog = watchdog;
    fs.writeFileSync(ctx.paths.requestPath, `${JSON.stringify({
      status: 'pending',
      request_id: 'req-1',
      action: 'send',
    })}\n`);

    const outcome = await processPendingRequest(ctx);
    assert.equal(outcome.processed, false);
    assert.equal(outcome.reason, 'game_session_closed');
  });

  it('fail closed without lease after unbound max window', () => {
    const state = {
      snapshotPath,
      daemonPid: 60008,
      daemonStartedAtMs: Date.now() - UNBOUND_DAEMON_MAX_MS - 1,
      boundSessionId: null,
      gameEverVerified: false,
    };
    const tick = assessDaemonGameSessionTick(state, { nowMs: Date.now() });
    assert.equal(tick.action, 'shutdown');
    assert.equal(tick.reason, 'no_lease_fail_closed');
  });

  it('initialization grace before game pid recorded', () => {
    const now = Date.now();
    beginCompanionPlaySession({ snapshotPath, launcherPid: 424242, nowMs: now });
    const state = {
      snapshotPath,
      daemonPid: 60009,
      daemonStartedAtMs: now,
      boundSessionId: null,
      gameEverVerified: false,
    };
    const tick = assessDaemonGameSessionTick(state, {
      ...openxcomDeps(1),
      nowMs: now + GAME_INIT_GRACE_MS - 1000,
      isProcessRunning: (pid) => pid === 424242,
    });
    assert.equal(tick.action, 'grace');
    assert.equal(tick.reason, 'awaiting_game_pid');
  });

  it('assertCommandDeliveryAllowed permits staging when lease game is live', () => {
    const session = beginCompanionPlaySession({ snapshotPath, launcherPid: 424242 });
    const gamePid = 50011;
    registerPlaySessionDaemonPid(snapshotPath, session.sessionId, 60011);
    registerPlaySessionGamePid(snapshotPath, session.sessionId, gamePid, openxcomDeps(gamePid));

    const gate = assertCommandDeliveryAllowed(snapshotPath, {
      deps: { ...openxcomDeps(gamePid), disableGameSessionGate: false },
      daemonPid: 60011,
    });
    assert.equal(gate.ok, true);
    assert.equal(gate.gamePid, gamePid);
  });

  it('assertCommandDeliveryAllowed rejects staging after game exit', () => {
    const session = beginCompanionPlaySession({ snapshotPath, launcherPid: 424242 });
    const gamePid = 50012;
    const deps = openxcomDeps(gamePid, { alive: false });
    registerPlaySessionDaemonPid(snapshotPath, session.sessionId, 60012);
    registerPlaySessionGamePid(snapshotPath, session.sessionId, gamePid, deps);

    const gate = assertCommandDeliveryAllowed(snapshotPath, { deps, daemonPid: 60012 });
    assert.equal(gate.ok, false);
    assert.equal(gate.reason, 'game_not_running');
  });

  it('assertCommandDeliveryAllowed rejects when watchdog is closed', async () => {
    const now = Date.now();
    const watchdog = createGameSessionWatchdog({
      snapshotPath,
      daemonPid: 60013,
      startedAtMs: now - UNBOUND_DAEMON_MAX_MS - 5000,
      deps: { disableGameSessionGate: false, nowMs: now },
    });
    await watchdog.beforeTick();
    assert.equal(watchdog.acceptingRequests(), false);

    const gate = assertCommandDeliveryAllowed(snapshotPath, {
      gameSessionWatchdog: watchdog,
      deps: { disableGameSessionGate: false },
    });
    assert.equal(gate.ok, false);
    assert.equal(gate.reason, 'game_session_closed');
  });

  it('in-flight retrieve poll does not stage command after game session closes', async () => {
    const session = beginCompanionPlaySession({ snapshotPath, launcherPid: 424242 });
    const gamePid = 50013;
    registerPlaySessionDaemonPid(snapshotPath, session.sessionId, 60014);
    registerPlaySessionGamePid(snapshotPath, session.sessionId, gamePid, openxcomDeps(gamePid));

    const now = Date.now();
    const watchdog = createGameSessionWatchdog({
      snapshotPath,
      daemonPid: 60014,
      startedAtMs: now - 60_000,
      deps: { disableGameSessionGate: false, nowMs: now, ...openxcomDeps(gamePid) },
    });
    await watchdog.beforeTick();
    assert.equal(watchdog.acceptingRequests(), true);

    const relayStateDir = isolatedCommandRelayStateDir(root, 'relay-deliver-gate');
    const ctx = createOnDemandRelayContext({
      snapshotPath,
      dryRun: true,
      commandRelayStateDir: relayStateDir,
      deps: { disableGameSessionGate: false, ...openxcomDeps(gamePid, { alive: false }) },
    });
    ctx.gameSessionWatchdog = watchdog;

    const fixturePath = path.join(__dirname, 'fixtures', 'valid-v5.yaml');
    const fixtureText = fs.readFileSync(fixturePath, 'utf8');
    fs.writeFileSync(snapshotPath, fixtureText, 'utf8');
    const tactical = require('../lib/tactical-publish.cjs').loadAndValidateSnapshotFromText(
      fixtureText,
      require('yaml'),
    );
    const digest = require('node:crypto').createHash('sha256').update(fixtureText).digest('hex');
    const command = {
      schema_version: 1,
      command_id: 'gate-blocked-move',
      command_type: 'MOVE',
      actor_unit_id: 1,
      destination: { x: 2, y: 2, z: 0 },
      snapshot_sha256: digest,
      session_id: tactical.eventLog.sessionId,
      turn: tactical.turn,
      state_version: tactical.eventLog.latestSeq,
    };
    ctx.commandWatcher.readRemoteCommand = async () => ({
      text: `${JSON.stringify(command, null, 2)}\n`,
      sha: digest,
    });

    await ctx.commandWatcher._pollOnce();
    const commandPath = path.join(snapshotDir, 'tactical-command.json');
    assert.ok(!fs.existsSync(commandPath));
  });

  it('watchdog onShutdown triggers reconciliation path marker state', async () => {
    const session = beginCompanionPlaySession({ snapshotPath, launcherPid: 424242 });
    registerPlaySessionGamePid(snapshotPath, session.sessionId, 50010, openxcomDeps(50010));

    const healthPath = path.join(snapshotDir, '.companion-on-demand-daemon-health.json');
    fs.writeFileSync(healthPath, `${JSON.stringify({
      schema_version: 1,
      state: DAEMON_STATE.READY,
      pid: 60010,
      updated_at_ms: Date.now(),
    })}\n`);

    const state = {
      snapshotPath,
      daemonPid: 60010,
      daemonStartedAtMs: Date.now(),
      boundSessionId: session.sessionId,
      gameEverVerified: true,
    };

    const assessment = assessDaemonGameSessionTick(state, openxcomDeps(50010, { alive: false }));
    assert.equal(assessment.action, 'shutdown');
    assert.equal(assessment.reason, 'game_exited');
  });
});
