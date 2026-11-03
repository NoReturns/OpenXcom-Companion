'use strict';

const fs = require('node:fs');
const {
  runPreflight,
  formatPreflightReport,
  startRelaySupervisor,
  shutdownSupervisor,
  MODES,
} = require('./lib/companion-relay-launcher.cjs');

function usage() {
  console.log(`Usage: node companion-relay-launcher-cli.cjs [options]

  (default)            Read-only preflight report
  --preflight          Same as default
  --json               Emit preflight JSON on stdout
  --start outbound     Start briefing sidecar only (--publish)
  --start full         Start briefing + command-relay sidecars (--publish)
  --acknowledge-inbound-risk
                       Required for --start full when preflight reports inbound blockers
  --dry-run            Pass --dry-run to sidecars (no GitHub writes)
  --snapshot-path <p>  Override OPENXCOM_COMPANION_SNAPSHOT_PATH`);
}

function parseArgs(argv) {
  let preflight = true;
  let startMode = null;
  let json = false;
  let acknowledgeInboundRisk = false;
  let dryRun = false;
  let snapshotPath = null;

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    if (arg === '--preflight') {
      preflight = true;
      startMode = null;
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--acknowledge-inbound-risk') {
      acknowledgeInboundRisk = true;
      continue;
    }
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--start') {
      i += 1;
      if (i >= argv.length) throw new Error('--start requires outbound or full');
      startMode = argv[i];
      preflight = false;
      continue;
    }
    if (arg === '--snapshot-path') {
      i += 1;
      if (i >= argv.length) throw new Error('--snapshot-path requires a value');
      snapshotPath = argv[i];
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (startMode !== null && startMode !== 'outbound' && startMode !== 'full') {
    throw new Error('--start must be outbound or full');
  }

  return { preflight: startMode === null ? true : false, startMode, json, acknowledgeInboundRisk, dryRun, snapshotPath };
}

async function runPreflightCommand(options) {
  const report = await runPreflight({
    snapshotPath: options.snapshotPath,
    env: options.snapshotPath ? { ...process.env, OPENXCOM_COMPANION_SNAPSHOT_PATH: options.snapshotPath } : process.env,
  });
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatPreflightReport(report));
  }
  process.exitCode = report.ready.outbound ? 0 : 2;
}

async function runStartCommand(options) {
  const mode = options.startMode === 'full' ? MODES.FULL : MODES.OUTBOUND;
  let supervisor;
  try {
    supervisor = await startRelaySupervisor(mode, {
      snapshotPath: options.snapshotPath,
      acknowledgeInboundRisk: options.acknowledgeInboundRisk,
      dryRun: options.dryRun,
      env: options.snapshotPath
        ? { ...process.env, OPENXCOM_COMPANION_SNAPSHOT_PATH: options.snapshotPath }
        : process.env,
      logWrite: (line) => process.stdout.write(line),
    });
  } catch (error) {
    console.error(error.message || String(error));
    if (error.blockers) {
      for (const b of error.blockers) {
        console.error(`  blocker: ${b}`);
      }
    }
    process.exitCode = error.code === 'INBOUND_UNSAFE' ? 3 : 1;
    return;
  }

  console.log(formatPreflightReport(supervisor.preflight));
  console.log('Sidecars started. Unified notifications enabled (deduplicated). Press Ctrl+C to stop.');
  for (const { channel, child } of supervisor.children) {
    console.log(`  [${channel}] pid ${child.pid}`);
  }

  const shutdown = () => {
    shutdownSupervisor(supervisor.children);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await Promise.all(supervisor.children.map(({ child }) => new Promise((resolve) => {
    child.on('exit', resolve);
  })));
}

async function main() {
  const options = parseArgs(process.argv);
  if (options.preflight) {
    await runPreflightCommand(options);
    return;
  }
  await runStartCommand(options);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || String(error));
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, runPreflightCommand, runStartCommand };
