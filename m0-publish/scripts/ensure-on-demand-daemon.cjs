'use strict';

const path = require('node:path');
const { resolveSnapshotPath } = require('../lib/companion-relay-launcher.cjs');
const { ensureOnDemandDaemonRunning } = require('../lib/on-demand-daemon-process.cjs');

async function main() {
  const snapshotPath = process.argv[2]
    ? path.resolve(process.argv[2])
    : resolveSnapshotPath();
  const daemonScript = process.argv[3]
    ? path.resolve(process.argv[3])
    : path.resolve(__dirname, '..', 'companion-on-demand-relay-daemon.cjs');
  const commandRelayStateDir = process.argv[4] ? path.resolve(process.argv[4]) : null;
  const extraArgs = process.argv.includes('--dry-run') ? ['--dry-run'] : [];

  const outcome = await ensureOnDemandDaemonRunning({
    snapshotPath,
    daemonScript,
    cwd: path.dirname(daemonScript),
    commandRelayStateDir,
    extraArgs,
    owner: 'request_recovery',
  });
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
  process.exit(outcome.ok ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`${error.message || String(error)}\n`);
  process.exit(1);
});
