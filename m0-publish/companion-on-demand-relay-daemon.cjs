'use strict';

const path = require('node:path');
const { resolveSnapshotPath } = require('./lib/companion-relay-launcher.cjs');
const { createOnDemandRelayDaemon } = require('./lib/companion-on-demand-relay.cjs');
const {
  isNodeTestProcess,
  getProductionCommandRelayJournalPath,
} = require('./lib/relay-test-isolation.cjs');
const { checkGhAuthReadiness } = require('./lib/github-relay.cjs');
const {
  writeDaemonPid,
  removeDaemonPid,
  readDaemonPid,
  isProcessRunning,
  writeDaemonReady,
  removeDaemonReady,
} = require('./lib/on-demand-daemon-process.cjs');
const {
  appendDiagnosticEvent,
  writeLifecycleState,
} = require('./lib/on-demand-daemon-diagnostics.cjs');
const {
  writeDaemonHealth,
  DAEMON_STATE,
} = require('./lib/on-demand-daemon-health.cjs');
const {
  claimDaemonOwnership,
  releaseOwnershipIfTokenMatches,
  canonicalSnapshotPath,
} = require('./lib/on-demand-daemon-ownership.cjs');
const {
  createGameSessionWatchdog,
  gameSessionGateDisabled,
} = require('./lib/on-demand-game-session.cjs');
const { reconcileDaemonMarkersForStoppedPid } = require('./lib/on-demand-daemon-health.cjs');
const {
  adoptDaemonIntoPlaySessionLease,
  readPlaySessionLease,
  reconcilePlaySessionLeaseForExitingDaemon,
} = require('./lib/on-demand-play-session.cjs');

function usage() {
  console.log(`Usage: node companion-on-demand-relay-daemon.cjs [options]

  Local-only poll for ${require('./lib/companion-on-demand-relay.cjs').REQUEST_FILENAME}.
  GitHub is contacted only while processing a pending send/retrieve request.

  --dry-run          Validate/publish without remote writes where supported
  --once             Process one daemon tick and exit (tests)
  --snapshot-path    Override OPENXCOM_COMPANION_SNAPSHOT_PATH
  --command-relay-state-dir  Override command-relay journal directory (tests/isolated runs)
  --relay-isolation-config   JSON file with isolated GitHub repo/branch/paths (M1-34E; fail-closed)`);
}

function parseArgs(argv) {
  let dryRun = false;
  let once = false;
  let snapshotPath = null;
  let commandRelayStateDir = null;
  let relayIsolationConfigPath = null;
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--once') {
      once = true;
      continue;
    }
    if (arg === '--snapshot-path') {
      i += 1;
      snapshotPath = path.resolve(argv[i]);
      continue;
    }
    if (arg === '--command-relay-state-dir') {
      i += 1;
      commandRelayStateDir = path.resolve(argv[i]);
      continue;
    }
    if (arg === '--relay-isolation-config') {
      i += 1;
      relayIsolationConfigPath = path.resolve(argv[i]);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return {
    dryRun,
    once,
    snapshotPath: snapshotPath ?? resolveSnapshotPath(),
    commandRelayStateDir,
    relayIsolationConfigPath,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (isNodeTestProcess() && !args.commandRelayStateDir) {
    console.error(
      'Refusing default production command-relay journal under node:test; '
      + `pass --command-relay-state-dir (production journal: ${getProductionCommandRelayJournalPath()}).`,
    );
    process.exitCode = 1;
    return;
  }
  if (!args.dryRun && !checkGhAuthReadiness()) {
    console.error('GitHub CLI is not authenticated; run gh auth login or use --dry-run.');
    process.exitCode = 1;
    return;
  }

  const daemonOptions = {
    snapshotPath: args.snapshotPath,
    dryRun: args.dryRun,
    log: (line) => console.log(line),
  };
  if (args.commandRelayStateDir) {
    daemonOptions.commandRelayStateDir = args.commandRelayStateDir;
  }
  if (args.relayIsolationConfigPath) {
    const {
      loadRelayIsolationConfig,
      buildRelayOptionsFromConfig,
      buildRelayIsolationContract,
      describeRelayIsolationTarget,
    } = require('./lib/relay-isolation-config.cjs');
    const isolationConfig = loadRelayIsolationConfig(args.relayIsolationConfigPath);
    daemonOptions.relayOptions = buildRelayOptionsFromConfig(isolationConfig);
    daemonOptions.relayIsolationContract = buildRelayIsolationContract(isolationConfig);
    daemonOptions.requireRelayIsolation = true;
    daemonOptions.relayIsolationTarget = describeRelayIsolationTarget(isolationConfig);
  }
  const snapshotPath = canonicalSnapshotPath(args.snapshotPath);
  const snapshotDir = path.dirname(snapshotPath);
  const ownershipClaim = claimDaemonOwnership({ snapshotPath, owner: 'daemon' });
  if (!ownershipClaim.ok) {
    appendDiagnosticEvent(snapshotDir, {
      kind: ownershipClaim.reason === 'existing_live_owner' ? 'daemon_deferred_to_owner' : 'daemon_claim_failed',
      pid: process.pid,
      owner_pid: ownershipClaim.ownerPid,
      reason: ownershipClaim.reason,
    });
    process.exit(ownershipClaim.reason === 'existing_live_owner' ? 0 : 1);
    return;
  }
  const ownershipToken = ownershipClaim.ownershipToken;
  daemonOptions.ownershipToken = ownershipToken;
  const healthIo = { ownershipToken };

  let shuttingDown = false;
  let daemon;

  const recordExit = (kind, extra = {}) => {
    writeDaemonHealth(snapshotDir, {
      pid: process.pid,
      state: kind === 'clean' ? DAEMON_STATE.STOPPED : DAEMON_STATE.EXITED_UNEXPECTED,
      exit_reason: extra.reason,
      exit_code: extra.code,
    }, healthIo);
    appendDiagnosticEvent(snapshotDir, {
      kind: kind === 'clean' ? 'daemon_stopped' : 'daemon_exited_unexpected',
      pid: process.pid,
      ...extra,
    });
    removeDaemonReady(snapshotDir, {}, { ownershipToken });
    removeDaemonPid(snapshotDir, {}, { ownershipToken });
    releaseOwnershipIfTokenMatches(snapshotDir, ownershipToken);
  };

  const shutdown = (signal) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    if (daemon) {
      daemon.stop();
    }
    const watchdogBound = daemonOptions.gameSessionWatchdog?.state?.boundSessionId ?? null;
    const signalText = String(signal || '');
    const boundSessionId = watchdogBound
      ?? (signalText.startsWith('game_session:')
        ? null
        : (readPlaySessionLease(snapshotDir)?.session_id ?? null));
    if (boundSessionId) {
      reconcilePlaySessionLeaseForExitingDaemon({
        snapshotPath,
        sessionId: boundSessionId,
        daemonPid: process.pid,
        ownershipToken,
        shutdownReason: signal || 'shutdown',
        deps: { ownershipToken },
      });
    }
    recordExit('clean', { reason: signal || 'shutdown', code: 0 });
    reconcileDaemonMarkersForStoppedPid(snapshotDir, snapshotPath, process.pid, {
      ownershipToken,
      exitReason: signal || 'shutdown',
    });
    process.exit(0);
  };

  if (!args.once && !gameSessionGateDisabled() && !isNodeTestProcess()) {
    daemonOptions.gameSessionWatchdog = createGameSessionWatchdog({
      snapshotPath,
      daemonPid: process.pid,
      onShutdown: (reason) => shutdown(`game_session:${reason}`),
    });
  }

  daemon = createOnDemandRelayDaemon(daemonOptions);

  process.on('uncaughtException', (error) => {
    appendDiagnosticEvent(snapshotDir, {
      kind: 'uncaught_exception',
      pid: process.pid,
      message: error.message || String(error),
    });
    recordExit('unexpected', { reason: 'uncaught_exception', code: 1 });
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    appendDiagnosticEvent(snapshotDir, {
      kind: 'unhandled_rejection',
      pid: process.pid,
      message: reason && reason.message ? reason.message : String(reason),
    });
    recordExit('unexpected', { reason: 'unhandled_rejection', code: 1 });
    process.exit(1);
  });

  if (args.once) {
    await daemon.runTickOnce();
    releaseOwnershipIfTokenMatches(snapshotDir, ownershipToken);
    return;
  }

  daemon.start();
  writeDaemonPid(snapshotDir, process.pid, {}, {
    owner: 'daemon',
    snapshotPath,
    ownershipToken,
  });
  writeDaemonReady(snapshotDir, {
    pid: process.pid,
    ready_at_ms: Date.now(),
    script: path.basename(__filename),
  });
  writeDaemonHealth(snapshotDir, {
    pid: process.pid,
    state: DAEMON_STATE.READY,
  }, healthIo);
  writeLifecycleState(snapshotDir, {
    last_started_at_ms: Date.now(),
    last_pid: process.pid,
  });
  appendDiagnosticEvent(snapshotDir, {
    kind: 'daemon_ready',
    pid: process.pid,
    dry_run: args.dryRun,
    relay_isolation: daemonOptions.relayIsolationTarget ?? null,
  });
  const leaseForAdopt = readPlaySessionLease(snapshotDir);
  if (leaseForAdopt?.session_id) {
    adoptDaemonIntoPlaySessionLease(snapshotPath, process.pid, leaseForAdopt.session_id);
  }
  console.log(`Companion on-demand relay daemon watching ${daemon.ctx.paths.requestPath}`);
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('exit', (code) => {
    if (shuttingDown) {
      return;
    }
    recordExit(code === 0 ? 'clean' : 'unexpected', { reason: 'process_exit', code });
  });
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exitCode = 1;
});
