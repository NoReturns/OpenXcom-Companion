'use strict';

delete process.env.NODE_TEST_CONTEXT;
const fs = require('node:fs');
const path = require('node:path');
const { writeJsonAtomic } = require('../../lib/local-atomic.cjs');
const {
  startOnDemandDaemonVerified,
  isProcessRunning,
} = require('../../lib/on-demand-daemon-process.cjs');
const {
  isolatedCommandRelayStateDir,
} = require('../../lib/relay-test-isolation.cjs');

const [, , manifestPath, snapshotPath, relayLabel, dryRunFlag] = process.argv;

if (!manifestPath || !snapshotPath) {
  process.exitCode = 2;
  process.stderr.write('usage: test-supervisor-daemon-worker.cjs <manifest.json> <snapshotPath> [relayLabel] [dry-run]\n');
  process.exit();
}

const snapshotDir = path.dirname(path.resolve(snapshotPath));
const relayStateDir = isolatedCommandRelayStateDir(path.dirname(snapshotDir), relayLabel || 'relay-state-worker');
const daemonScript = path.join(__dirname, '..', '..', 'companion-on-demand-relay-daemon.cjs');
const controlPath = `${manifestPath}.control.json`;

const extraArgs = dryRunFlag === 'dry-run' ? ['--dry-run'] : [];

function readManifestSafe() {
  if (!fs.existsSync(manifestPath)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }
}

function writeManifest(patch) {
  const current = readManifestSafe();
  if (current === null) {
    return;
  }
  const next = { ...current, ...patch, last_heartbeat_ms: Date.now() };
  writeJsonAtomic(manifestPath, next, fs.writeFileSync, fs.renameSync);
}

writeManifest({
  phase: 'starting',
  worker_pid: process.pid,
  supervisor_pid: process.pid,
  daemon_pid: null,
  started_at_ms: Date.now(),
});

const start = startOnDemandDaemonVerified({
  snapshotPath: path.resolve(snapshotPath),
  daemonScript,
  cwd: path.dirname(daemonScript),
  commandRelayStateDir: relayStateDir,
  extraArgs,
  timeoutMs: 30000,
});

if (!start.ok) {
  writeManifest({
    phase: 'failed',
    start_ok: false,
    start_error: start.error ?? null,
    relay_state_dir: relayStateDir,
    snapshot_path: path.resolve(snapshotPath),
  });
  process.exitCode = 1;
  process.exit();
}

writeManifest({
  phase: 'ready',
  start_ok: true,
  start_error: null,
  daemon_pid: start.pid,
  relay_state_dir: relayStateDir,
  snapshot_path: path.resolve(snapshotPath),
});

const safetyMaxMs = Number(process.env.COMPANION_TEST_SUPERVISOR_MAX_MS || 1_800_000);
const safetyDeadline = Date.now() + safetyMaxMs;

const tick = () => {
  const daemonAlive = isProcessRunning(start.pid);
  if (!daemonAlive) {
    writeManifest({
      phase: 'unexpected_daemon_exit',
      daemon_exit_observed_ms: Date.now(),
    });
    process.exit(2);
  }
  if (fs.existsSync(controlPath)) {
    try {
      const control = JSON.parse(fs.readFileSync(controlPath, 'utf8'));
      if (control.shutdown === true) {
        writeManifest({ phase: 'shutdown_ack', control });
        process.exit(0);
      }
    } catch {
      // ignore malformed control
    }
  }
  if (Date.now() >= safetyDeadline) {
    writeManifest({ phase: 'safety_timeout', safety_max_ms: safetyMaxMs });
    process.exit(4);
  }
  writeManifest({ phase: 'ready' });
  setTimeout(tick, 200);
};

tick();
