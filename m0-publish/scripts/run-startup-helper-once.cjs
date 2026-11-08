'use strict';

const path = require('node:path');
const { startOnDemandDaemonVerified } = require('../lib/on-demand-daemon-process.cjs');

const snapshotPath = path.resolve(process.argv[2]);
const daemonScript = path.resolve(process.argv[3]);
const commandRelayStateDir = process.argv[4] ? path.resolve(process.argv[4]) : null;
const cwd = path.dirname(daemonScript);

const outcome = startOnDemandDaemonVerified({
  snapshotPath,
  daemonScript,
  cwd,
  commandRelayStateDir,
  extraArgs: ['--dry-run'],
  disableLiveDaemonReuse: true,
});

process.stdout.write(`${JSON.stringify(outcome)}\n`);
