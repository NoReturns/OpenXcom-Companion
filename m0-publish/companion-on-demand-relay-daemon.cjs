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

function usage() {
  console.log(`Usage: node companion-on-demand-relay-daemon.cjs [options]

  Local-only poll for ${require('./lib/companion-on-demand-relay.cjs').REQUEST_FILENAME}.
  GitHub is contacted only while processing a pending send/retrieve request.

  --dry-run          Validate/publish without remote writes where supported
  --once             Process one daemon tick and exit (tests)
  --snapshot-path    Override OPENXCOM_COMPANION_SNAPSHOT_PATH
  --command-relay-state-dir  Override command-relay journal directory (tests/isolated runs)`);
}

function parseArgs(argv) {
  let dryRun = false;
  let once = false;
  let snapshotPath = null;
  let commandRelayStateDir = null;
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
    throw new Error(`Unknown argument: ${arg}`);
  }
  return {
    dryRun,
    once,
    snapshotPath: snapshotPath ?? resolveSnapshotPath(),
    commandRelayStateDir,
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
  const daemon = createOnDemandRelayDaemon(daemonOptions);

  if (args.once) {
    await daemon.runTickOnce();
    return;
  }

  daemon.start();
  const snapshotDir = path.dirname(args.snapshotPath);
  writeDaemonPid(snapshotDir, process.pid);
  writeDaemonReady(snapshotDir, {
    pid: process.pid,
    ready_at_ms: Date.now(),
    script: path.basename(__filename),
  });
  console.log(`Companion on-demand relay daemon watching ${daemon.ctx.paths.requestPath}`);
  const shutdown = () => {
    daemon.stop();
    removeDaemonReady(snapshotDir);
    removeDaemonPid(snapshotDir);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('exit', () => {
    removeDaemonReady(snapshotDir);
    removeDaemonPid(snapshotDir);
  });
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exitCode = 1;
});
