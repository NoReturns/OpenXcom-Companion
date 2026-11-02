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

const DEFAULT_SNAPSHOT = path.resolve(__dirname, '../../local/m0/tactical-m1-04.yaml');

function usage() {
  console.log(`Usage: node publish-tactical-once.cjs [--dry-run] [--publish] [--watch] [--path <file>]

  --dry-run   Parse/validate locally, or watch without remote writes (default)
  --publish   Publish to ${DEFAULTS.repo}:${DEFAULTS.statePath} on branch ${DEFAULTS.branch}
  --watch     Poll snapshot file every 1s and publish on tactical changes
  --path      Tactical YAML input (default: ${DEFAULT_SNAPSHOT})`);
}

function parseArgs(argv) {
  let publish = false;
  let dryRun = false;
  let watch = false;
  let inputPath = DEFAULT_SNAPSHOT;

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
    if (arg === '--path') {
      i += 1;
      if (i >= argv.length) throw new Error('--path requires a value');
      inputPath = path.resolve(argv[i]);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (publish && dryRun) {
    throw new Error('Use either --dry-run or --publish, not both');
  }
  if (!publish) {
    dryRun = true;
  }

  return { publish, dryRun, watch, inputPath };
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

  const publisher = createRelayPublisher();
  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort());
  process.on('SIGTERM', () => controller.abort());

  const watcher = new TacticalWatcher({
    inputPath,
    dryRun,
    publishRelayState: (relay) => publisher.publishRelayState(relay),
    signal: controller.signal,
  });
  watcher.start();

  await new Promise((resolve) => {
    controller.signal.addEventListener('abort', resolve, { once: true });
  });
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
  const relay = buildRelayPayload(tactical, publishedAt);
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

async function main() {
  const args = parseArgs(process.argv);
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
