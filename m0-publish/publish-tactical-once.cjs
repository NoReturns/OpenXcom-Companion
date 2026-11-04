'use strict';

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const {
  buildRelayPayload,
  loadAndValidateSnapshotFromText,
  ValidationError,
} = require('./lib/tactical-publish.cjs');
const {
  DEFAULTS,
  checkGhAuthReadiness,
  createRelayPublisher,
} = require('./lib/github-relay.cjs');
const { TacticalWatcher } = require('./lib/tactical-watcher.cjs');
const { BriefingWatcher } = require('./lib/briefing-watcher.cjs');
const { startTacticalRelaySidecar } = require('./lib/tactical-relay-sidecar.cjs');
const {
  acquireCommandRelaySidecarLock,
} = require('./lib/command-relay-process-lock.cjs');
const { createRelayRateLimitGate, resolveSharedRelayRateLimitGatePath } = require('./lib/relay-rate-limit-gate.cjs');
const { createGithubQuotaTelemetryStore } = require('./lib/github-quota-telemetry.cjs');
const { createGithubQuotaConsoleMonitor } = require('./lib/github-quota-console.cjs');
const { removeCompanionGithubQuotaHudFile } = require('./lib/github-quota-hud-file.cjs');
const { sha256HexLower, readSnapshotByteBuffer } = require('./lib/briefing-snapshot.cjs');
const { createNotifyEmitter } = require('./lib/companion-relay-notify.cjs');

function resolveStructuredSidecarNotify(customNotify) {
  if (typeof customNotify === 'function') {
    return customNotify;
  }
  if (process.env.COMPANION_RELAY_STRUCTURED_NOTIFY === '1') {
    return createNotifyEmitter({ alsoPrintConsole: false }).emit;
  }
  return undefined;
}

const DEFAULT_SNAPSHOT = path.resolve(__dirname, '../../local/m0/tactical-m1-04.yaml');
const DEFAULT_LIVE_SNAPSHOT = path.resolve(__dirname, '../../local/m0/tactical-live.yaml');
const DEFAULT_BRIEFING_REQUEST = path.resolve(__dirname, '../../local/m0/briefing-request.json');
const DEFAULT_BRIEFING_STATE_DIR = path.resolve(__dirname, '.briefing-sidecar-state');
const DEFAULT_COMMAND_RELAY_STATE_DIR = path.resolve(__dirname, '.command-relay-sidecar-state');
const DEFAULT_COMMAND_RELAY_LOCK = path.resolve(__dirname, '.command-relay-sidecar.lock');

function createSharedRateLimitGate(options = {}) {
  return createRelayRateLimitGate({
    gatePath: resolveSharedRelayRateLimitGatePath(__dirname),
    now: options.now,
  });
}

function usage() {
  console.log(`Usage: node publish-tactical-once.cjs [options]

  --dry-run            Parse/validate locally, or watch without remote writes (default)
  --publish            Publish to ${DEFAULTS.repo}:${DEFAULTS.statePath} on branch ${DEFAULTS.branch}
  --watch              Dev mode: poll snapshot file every 1s and publish on YAML changes
  --briefing-watch     F6 mode: poll briefing-request.json and publish verified snapshots
  --command-relay-watch  Poll GitHub tactical-command/terrain-query and mirror local engine files
  --path               Tactical YAML input (default: ${DEFAULT_LIVE_SNAPSHOT} with --briefing-watch, else ${DEFAULT_SNAPSHOT})
  --request-path       Briefing request file (default: briefing-request.json beside --path, else ${DEFAULT_BRIEFING_REQUEST})
  --state-dir          Sidecar journal directory (briefing default: ${DEFAULT_BRIEFING_STATE_DIR}, command relay: ${DEFAULT_COMMAND_RELAY_STATE_DIR})`);
}

function parseArgs(argv) {
  let publish = false;
  let dryRun = false;
  let watch = false;
  let briefingWatch = false;
  let commandRelayWatch = false;
  let inputPath = null;
  let requestPath = null;
  let requestPathExplicit = false;
  let stateDir = null;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    if (arg === '--publish') {
      publish = true;
      continue;
    }
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--watch') {
      watch = true;
      continue;
    }
    if (arg === '--command-relay-watch') {
      commandRelayWatch = true;
      continue;
    }
    if (arg === '--briefing-watch') {
      briefingWatch = true;
      continue;
    }
    if (arg === '--path') {
      i += 1;
      if (i >= argv.length) throw new Error('--path requires a value');
      inputPath = path.resolve(argv[i]);
      continue;
    }
    if (arg === '--request-path') {
      i += 1;
      if (i >= argv.length) throw new Error('--request-path requires a value');
      requestPath = path.resolve(argv[i]);
      requestPathExplicit = true;
      continue;
    }
    if (arg === '--state-dir') {
      i += 1;
      if (i >= argv.length) throw new Error('--state-dir requires a value');
      stateDir = path.resolve(argv[i]);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (watch && briefingWatch) {
    throw new Error('Use either --watch or --briefing-watch, not both');
  }
  if (commandRelayWatch && (watch || briefingWatch)) {
    throw new Error('--command-relay-watch cannot combine with --watch or --briefing-watch');
  }
  if (publish && dryRun) {
    throw new Error('Use either --dry-run or --publish, not both');
  }
  if (!publish) {
    dryRun = true;
  }

  if (inputPath === null) {
    inputPath = (briefingWatch || commandRelayWatch) ? DEFAULT_LIVE_SNAPSHOT : DEFAULT_SNAPSHOT;
  }

  if (requestPath === null) {
    requestPath = DEFAULT_BRIEFING_REQUEST;
  }
  if (briefingWatch && !requestPathExplicit) {
    requestPath = path.join(path.dirname(inputPath), 'briefing-request.json');
  }

  if (stateDir === null) {
    if (commandRelayWatch) {
      stateDir = DEFAULT_COMMAND_RELAY_STATE_DIR;
    } else {
      stateDir = DEFAULT_BRIEFING_STATE_DIR;
    }
  }

  return { publish, dryRun, watch, briefingWatch, commandRelayWatch, inputPath, requestPath, stateDir };
}

function reportDryRun({ inputPath, tactical, relay, ghReady }) {
  const payload = JSON.stringify(relay, null, 2) + '\n';
  console.log('Mode: dry-run (no network writes to relay)');
  console.log(`Input: ${inputPath}`);
  console.log(`Companion schema: ${tactical.schemaVersion}`);
  console.log(`Turn: ${tactical.turn}  Side: ${tactical.side}  Units: ${tactical.units.length}`);
  console.log(`Snapshot ID: ${relay.snapshot_id}`);
  console.log(`Relay payload size: ${Buffer.byteLength(payload, 'utf8')} bytes`);
  console.log(`Target: https://github.com/${DEFAULTS.repo}/blob/${DEFAULTS.branch}/${DEFAULTS.statePath}`);
  console.log(`GitHub CLI ready: ${ghReady ? 'yes' : 'no'}`);
}

async function runWatch({ dryRun, inputPath }) {
  if (!dryRun) {
    const ghReady = checkGhAuthReadiness();
    if (!ghReady) {
      console.error('GitHub CLI is not authenticated; run gh auth login first.');
      process.exitCode = 1;
      return;
    }
  }

  const quotaTelemetryStore = createGithubQuotaTelemetryStore();
  const quotaConsoleMonitor = createGithubQuotaConsoleMonitor({ store: quotaTelemetryStore });
  const publisherWithTelemetry = createRelayPublisher({ quotaTelemetryStore });
  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort());
  process.on('SIGTERM', () => controller.abort());

  const watcher = new TacticalWatcher({
    inputPath,
    dryRun,
    publishRelayState: (relay) => publisherWithTelemetry.publishRelayState(relay),
    githubQuotaMonitor: quotaConsoleMonitor,
    signal: controller.signal,
  });
  watcher.start();

  await new Promise((resolve) => {
    controller.signal.addEventListener('abort', resolve, { once: true });
  });
}

async function runBriefingWatch({ dryRun, inputPath, requestPath, stateDir }) {
  if (!dryRun) {
    const ghReady = checkGhAuthReadiness();
    if (!ghReady) {
      console.error('GitHub CLI is not authenticated; run gh auth login first.');
      process.exitCode = 1;
      return;
    }
  }

  const rateLimitGate = createSharedRateLimitGate();
  const quotaTelemetryStore = createGithubQuotaTelemetryStore();
  const quotaConsoleMonitor = createGithubQuotaConsoleMonitor({
    store: quotaTelemetryStore,
    rateLimitGate,
  });
  const publisher = createRelayPublisher({ rateLimitGate, quotaTelemetryStore });
  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort());
  process.on('SIGTERM', () => controller.abort());

  const watcher = new BriefingWatcher({
    requestPath,
    snapshotPath: inputPath,
    stateDir,
    dryRun,
    publishRelayState: (relay) => publisher.publishRelayState(relay),
    rateLimitGate,
    githubQuotaMonitor: quotaConsoleMonitor,
    signal: controller.signal,
    notify: resolveStructuredSidecarNotify(),
  });
  watcher.start();

  await new Promise((resolve) => {
    controller.signal.addEventListener('abort', resolve, { once: true });
  });
  watcher.stop();
  removeCompanionGithubQuotaHudFile();
}

function runOnce({ publish, dryRun, inputPath }) {
  if (!fs.existsSync(inputPath)) {
    console.error(`Input not found: ${inputPath}`);
    process.exitCode = 1;
    return;
  }

  const text = fs.readFileSync(inputPath, 'utf8');
  let tactical;
  try {
    tactical = loadAndValidateSnapshotFromText(text, YAML);
  } catch (error) {
    const message = error instanceof ValidationError ? error.message : String(error);
    console.error(`Validation failed: ${message}`);
    process.exitCode = 1;
    return;
  }

  const publishedAt = new Date().toISOString();
  const snapshotBytes = readSnapshotByteBuffer(fs.readFileSync, inputPath);
  const digest = sha256HexLower(snapshotBytes);
  const relay = buildRelayPayload(tactical, publishedAt, null, { snapshotSha256: digest });
  const ghReady = checkGhAuthReadiness();

  if (dryRun) {
    reportDryRun({ inputPath, tactical, relay, ghReady });
    return;
  }

  if (!ghReady) {
    console.error('GitHub CLI is not authenticated; run gh auth login first.');
    process.exitCode = 1;
    return;
  }

  const publisher = createRelayPublisher();
  publisher.publishRelayState(relay)
    .then((result) => {
      console.log(result.skipped ? 'Publish skipped.' : 'Publish complete.');
    })
    .catch((error) => {
      console.error(error.message || String(error));
      process.exitCode = 1;
    });
}

async function runCommandRelayWatch({ dryRun, inputPath, stateDir }) {
  if (!dryRun) {
    const ghReady = checkGhAuthReadiness();
    if (!ghReady) {
      console.error('GitHub CLI is not authenticated; run gh auth login first.');
      process.exitCode = 1;
      return;
    }
  }

  let sidecarLock;
  try {
    sidecarLock = acquireCommandRelaySidecarLock({
      lockPath: DEFAULT_COMMAND_RELAY_LOCK,
      snapshotPath: inputPath,
    });
  } catch (error) {
    console.error(error.message || String(error));
    process.exitCode = 1;
    return;
  }

  const controller = new AbortController();
  const releaseLock = () => {
    sidecarLock.release();
  };
  process.on('SIGINT', () => controller.abort());
  process.on('SIGTERM', () => controller.abort());

  const rateLimitGate = createSharedRateLimitGate();
  const sidecar = startTacticalRelaySidecar({
    snapshotPath: inputPath,
    stateDir,
    dryRun,
    rateLimitGate,
    rateLimitGatePath: resolveSharedRelayRateLimitGatePath(__dirname),
    signal: controller.signal,
    notify: resolveStructuredSidecarNotify(),
  });

  await new Promise((resolve) => {
    controller.signal.addEventListener('abort', resolve, { once: true });
  });
  sidecar.stop();
  releaseLock();
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.commandRelayWatch) {
    await runCommandRelayWatch(args);
    return;
  }
  if (args.briefingWatch) {
    await runBriefingWatch(args);
    return;
  }
  if (args.watch) {
    await runWatch(args);
    return;
  }
  runOnce(args);
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exitCode = 1;
});

module.exports = {
  DEFAULT_LIVE_SNAPSHOT,
  DEFAULT_BRIEFING_REQUEST,
  DEFAULT_BRIEFING_STATE_DIR,
  DEFAULT_COMMAND_RELAY_STATE_DIR,
  DEFAULT_COMMAND_RELAY_LOCK,
  createSharedRateLimitGate,
  parseArgs,
};
