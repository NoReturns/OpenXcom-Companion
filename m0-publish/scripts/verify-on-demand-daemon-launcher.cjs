'use strict';

const path = require('node:path');
const {
  startOnDemandDaemonVerified,
  isProcessRunning,
  readDaemonReady,
  readDaemonPid,
  stopProcessTree,
  removeDaemonReady,
  removeDaemonPid,
} = require('../lib/on-demand-daemon-process.cjs');

const repoRoot = path.resolve(__dirname, '../../..');
const snapshotPath = path.join(repoRoot, 'local', 'm0', 'tactical-live.yaml');
const snapshotDir = path.dirname(snapshotPath);
const daemonScript = path.join(repoRoot, 'companion', 'm0-publish', 'companion-on-demand-relay-daemon.cjs');

function cleanup(pid) {
  if (pid) {
    stopProcessTree(pid);
  }
  removeDaemonReady(snapshotDir);
  removeDaemonPid(snapshotDir);
}

const first = startOnDemandDaemonVerified({
  snapshotPath,
  daemonScript,
  cwd: path.dirname(daemonScript),
  extraArgs: ['--dry-run'],
});
if (!first.ok) {
  console.error(JSON.stringify({ ok: false, stage: 'first_start', error: first.error }, null, 2));
  process.exit(1);
}

const readyAfterFirst = readDaemonReady(snapshotDir);
const pidFromFile = readDaemonPid(snapshotDir);
const liveAfterFirst = isProcessRunning(first.pid);

const second = startOnDemandDaemonVerified({
  snapshotPath,
  daemonScript,
  cwd: path.dirname(daemonScript),
  extraArgs: ['--dry-run'],
});

const bad = startOnDemandDaemonVerified({
  snapshotPath,
  daemonScript: path.join(snapshotDir, 'missing-daemon.cjs'),
  cwd: snapshotDir,
});

const ok = Boolean(
  readyAfterFirst
  && liveAfterFirst
  && second.ok
  && second.startedByUs === false
  && !bad.ok
  && String(bad.error || '').includes('Missing daemon script'),
);

console.log(JSON.stringify({
  ok,
  first: { pid: first.pid, startedByUs: first.startedByUs, ready: Boolean(readyAfterFirst), live: liveAfterFirst, pidFile: pidFromFile },
  second: { pid: second.pid, startedByUs: second.startedByUs },
  startupErrorSample: bad.error,
}, null, 2));

cleanup(first.pid);
process.exit(ok ? 0 : 1);
