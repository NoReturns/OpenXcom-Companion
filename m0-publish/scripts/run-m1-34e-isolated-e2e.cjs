'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');
const { companionRuntimeLayout } = require('../lib/companion-canonical-runtime.cjs');
const {
  loadRelayIsolationConfig,
  loadRelayIsolationConfigFromEnv,
  buildRelayOptionsFromConfig,
  describeRelayIsolationTarget,
} = require('../lib/relay-isolation-config.cjs');
const {
  captureProductionIntegrityBaseline,
  assertProductionIntegrityUnchanged,
} = require('../lib/m1-34e-production-guards.cjs');
const {
  prepareIsolatedUserDir,
  assertEngineRuntimeIsolation,
} = require('../lib/m1-34e-engine-isolation.cjs');
const {
  createRelayContentClient,
  checkGhAuthReadiness,
} = require('../lib/github-relay.cjs');
const {
  isolatedCommandRelayStateDir,
} = require('../lib/relay-test-isolation.cjs');
const {
  resolveOnDemandPaths,
  RETRIEVE_PHASE,
} = require('../lib/companion-on-demand-relay.cjs');
const { loadAndValidateSnapshotFromText } = require('../lib/tactical-publish.cjs');
const { writeJsonAtomic, writeTextAtomic } = require('../lib/local-atomic.cjs');
const { startOnDemandDaemonVerified, stopProcessTree, removeDaemonReady, removeDaemonPid } = require('../lib/on-demand-daemon-process.cjs');
const { journalPath } = require('../lib/command-journal.cjs');

const M0_PUBLISH_ROOT = path.resolve(__dirname, '..');
const DAEMON_SCRIPT = path.join(M0_PUBLISH_ROOT, 'companion-on-demand-relay-daemon.cjs');
const SNAPSHOT_FIXTURE = path.join(M0_PUBLISH_ROOT, 'test', 'fixtures', 'valid-v5.yaml');
const USER_SEED_CANDIDATES = [
  path.join(M0_PUBLISH_ROOT, '..', '..', 'engine', 'OpenXcom', 'build-isolated-m1-23e', 'verify-user-m1-23f6a'),
  path.join(M0_PUBLISH_ROOT, '..', '..', 'engine', 'OpenXcom', 'build-isolated-m1-23e', 'verify-user-visual'),
];

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomCommandId() {
  return crypto.randomBytes(16).toString('hex');
}

function resolveUserSeedDir() {
  for (const candidate of USER_SEED_CANDIDATES) {
    if (fs.existsSync(candidate)) {
      return path.resolve(candidate);
    }
  }
  throw new Error(
    `No isolated user seed found. Expected one of: ${USER_SEED_CANDIDATES.join(', ')}`,
  );
}

function buildRemoteMoveCommand(snapshotPath, commandId) {
  const text = fs.readFileSync(snapshotPath, 'utf8');
  const tactical = loadAndValidateSnapshotFromText(text, YAML);
  const digest = crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
  return {
    schema_version: 1,
    command_id: commandId,
    command_type: 'MOVE',
    actor_unit_id: 1,
    destination: { x: 2, y: 2, z: 0 },
    snapshot_sha256: digest,
    session_id: tactical.eventLog.sessionId,
    turn: tactical.turn,
    state_version: tactical.eventLog.latestSeq,
  };
}

function buildEngineFailedMoveResult(command, inboxSha256) {
  return {
    schema_version: 1,
    command_id: command.command_id,
    command_type: command.command_type,
    status: 'FAILED',
    session_id: command.session_id,
    turn: command.turn,
    actor_unit_id: command.actor_unit_id,
    starting_position: { x: 1, y: 2, z: 0 },
    final_position: { x: 1, y: 3, z: 0 },
    remaining_tu: 40,
    kneeled: false,
    destination_reached: true,
    snapshot_sha256: command.snapshot_sha256,
    inbox_sha256: inboxSha256,
    completed_at: 'engine-local',
  };
}

async function waitForLocalCommandInbox(commandPath, maxMs = 15000, pollMs = 50) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(commandPath)) {
      return JSON.parse(fs.readFileSync(commandPath, 'utf8'));
    }
    await sleepMs(pollMs);
  }
  throw new Error(`Timed out waiting for local command inbox at ${commandPath}`);
}

async function runEngineResultSimulator({ commandPath, resultPath, buildResult, maxMs = 20000 }) {
  const command = await waitForLocalCommandInbox(commandPath, maxMs);
  const inboxSha256 = crypto.createHash('sha256')
    .update(fs.readFileSync(commandPath, 'utf8'))
    .digest('hex');
  const result = buildResult(command, inboxSha256);
  writeTextAtomic(
    resultPath,
    `${JSON.stringify(result, null, 2)}\n`,
    fs.writeFileSync,
    fs.renameSync,
  );
  return result;
}

async function waitForOnDemandStatusTerminal(statusPath, requestId, maxMs = 45000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(statusPath)) {
      const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
      if (status.request_id === requestId && status.terminal === true) {
        return status;
      }
    }
    await sleepMs(100);
  }
  throw new Error(`Timed out waiting for terminal on-demand status (request ${requestId})`);
}

function readLatestRetrieveTransaction(snapshotDir) {
  const tracePath = path.join(snapshotDir, 'companion-on-demand-relay-transactions.jsonl');
  if (!fs.existsSync(tracePath)) {
    return null;
  }
  const lines = fs.readFileSync(tracePath, 'utf8').trim().split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const row = JSON.parse(lines[i]);
    if (row.action === 'retrieve' && row.retrieve_tx) {
      return row;
    }
  }
  return null;
}

function countSidecarDeliveries(relayStateDir, commandId) {
  const journalFile = journalPath(relayStateDir);
  if (!fs.existsSync(journalFile)) {
    return 0;
  }
  const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
  const record = journal.records && journal.records[commandId];
  if (!record) {
    return 0;
  }
  return record.phase === 'delivered_local' || record.phase === 'published_terminal' || record.phase === 'retirement_closed'
    ? 1
    : 0;
}

async function seedIsolatedRemoteCommand(relayOptions, command) {
  const client = createRelayContentClient(relayOptions);
  const serialized = `${JSON.stringify(command, null, 2)}\n`;
  await client.publishFile(
    client.paths.tacticalCommand,
    serialized,
    `M1-34E isolated e2e seed ${command.command_id.slice(0, 8)}`,
  );
  const remote = client.readFile(client.paths.tacticalCommand);
  if (!remote || !remote.text.includes(command.command_id)) {
    throw new Error('Failed to verify seeded isolated remote command');
  }
  return remote.sha;
}

async function cleanupIsolatedRemote(relayOptions) {
  const client = createRelayContentClient(relayOptions);
  for (const key of ['tacticalResult', 'tacticalCommand']) {
    const contentPath = client.paths[key];
    let remote;
    try {
      remote = client.readFile(contentPath);
    } catch {
      remote = null;
    }
    if (remote && remote.sha) {
      await client.deleteFile(contentPath, remote.sha, `M1-34E isolated e2e cleanup ${key}`);
    }
  }
}

function parseDiagnosticsJsonLines(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      if (!line.startsWith('{')) {
        return [];
      }
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function assertDaemonRelayIsolationRecorded(snapshotDir, expectedRepo) {
  const diagPath = path.join(snapshotDir, 'companion-on-demand-daemon-diagnostics.jsonl');
  if (!fs.existsSync(diagPath)) {
    throw new Error('Missing daemon diagnostics; cannot verify relay isolation');
  }
  const events = parseDiagnosticsJsonLines(fs.readFileSync(diagPath, 'utf8'));
  const ready = events.find((event) => event.kind === 'daemon_ready');
  if (!ready || !ready.relay_isolation || !ready.relay_isolation.repo) {
    throw new Error('Daemon ready without relay_isolation metadata; refusing GitHub retrieve');
  }
  if (ready.relay_isolation.repo !== expectedRepo) {
    throw new Error(
      `Daemon relay repo mismatch (expected ${expectedRepo}, got ${ready.relay_isolation.repo})`,
    );
  }
}

async function runM134eIsolatedE2e(options = {}) {
  const repoRoot = options.repoRoot ?? companionRuntimeLayout().repoRoot;
  const productionBefore = captureProductionIntegrityBaseline(repoRoot);

  if (!productionBefore.github.ok) {
    throw new Error(
      `Cannot fingerprint production GitHub read-only baseline: ${productionBefore.github.error || 'unknown error'}`,
    );
  }

  if (!options.skipGhAuthCheck && !checkGhAuthReadiness()) {
    throw new Error('GitHub CLI is not authenticated; run gh auth login before M1-34E e2e.');
  }

  const isolationConfig = options.isolationConfig
    ?? (options.configPath
      ? loadRelayIsolationConfig(options.configPath)
      : loadRelayIsolationConfigFromEnv());
  const relayOptions = buildRelayOptionsFromConfig(isolationConfig);
  const relayTarget = describeRelayIsolationTarget(isolationConfig);

  const root = options.workspaceRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), 'm1-34e-'));
  const snapshotPath = path.join(root, 'tactical-live.yaml');
  fs.copyFileSync(SNAPSHOT_FIXTURE, snapshotPath);
  const relayStateDir = isolatedCommandRelayStateDir(root, 'relay-state');
  const isolatedUserDir = prepareIsolatedUserDir(
    options.userSeedDir ?? resolveUserSeedDir(),
    path.join(root, 'user'),
  );
  const enginePaths = assertEngineRuntimeIsolation({
    repoRoot,
    isolatedRoot: root,
    isolatedSnapshotPath: snapshotPath,
    isolatedUserDir,
  });

  const paths = resolveOnDemandPaths(snapshotPath);
  const commandId = options.commandId ?? randomCommandId();
  const command = buildRemoteMoveCommand(snapshotPath, commandId);

  const isolatedConfigPath = path.join(root, 'relay-isolation-config.json');
  writeJsonAtomic(isolatedConfigPath, isolationConfig, fs.writeFileSync, fs.renameSync);

  let harnessDaemonPid = null;
  let startedByUs = false;

  try {
    await seedIsolatedRemoteCommand(relayOptions, command);

    const start = startOnDemandDaemonVerified({
      snapshotPath,
      daemonScript: DAEMON_SCRIPT,
      cwd: M0_PUBLISH_ROOT,
      commandRelayStateDir: relayStateDir,
      disableLiveDaemonReuse: true,
      extraArgs: ['--relay-isolation-config', isolatedConfigPath],
      timeoutMs: options.daemonStartupMs ?? 20000,
    });
    if (!start.ok) {
      throw new Error(`Isolated daemon failed to start: ${start.error || 'unknown'}`);
    }
    harnessDaemonPid = start.pid;
    startedByUs = Boolean(start.startedByUs);
    assertDaemonRelayIsolationRecorded(paths.snapshotDir, relayTarget.repo);

    const requestId = crypto.randomBytes(16).toString('hex');
    const createdAt = Date.now();
    writeJsonAtomic(paths.requestPath, {
      request_id: requestId,
      action: 'retrieve',
      status: 'pending',
      created_at_ms: createdAt,
    }, fs.writeFileSync, fs.renameSync);

    const engineSimPromise = runEngineResultSimulator({
      commandPath: paths.localRelay.command,
      resultPath: paths.localRelay.result,
      buildResult: buildEngineFailedMoveResult,
      maxMs: options.engineSimMaxMs ?? 30000,
    });

    const [engineResult, terminalStatus] = await Promise.all([
      engineSimPromise,
      waitForOnDemandStatusTerminal(paths.statusPath, requestId, options.statusWaitMs ?? 45000),
    ]);

    const txRow = readLatestRetrieveTransaction(paths.snapshotDir);
    const retrieveTx = txRow?.retrieve_tx ?? null;

    const contentClient = createRelayContentClient(relayOptions);
    const remoteResult = contentClient.readFile(contentClient.paths.tacticalResult);
    const remoteCommand = contentClient.readFile(contentClient.paths.tacticalCommand);
    const publishedStatus = remoteResult
      ? JSON.parse(remoteResult.text).status
      : null;

    const deliveries = retrieveTx?.deliveredCommandId === commandId ? 1 : 0;

    const report = {
      ok: false,
      relayTarget,
      enginePaths,
      commandId,
      engineResultStatus: engineResult.status,
      uiStatus: terminalStatus,
      retrieveTx,
      deliveries,
      remoteCommandPresent: Boolean(remoteCommand),
      remoteResultStatus: publishedStatus,
    };

    if (terminalStatus.phase !== RETRIEVE_PHASE.COMPLETED) {
      throw new Error(`Expected UI phase ${RETRIEVE_PHASE.COMPLETED}, got ${terminalStatus.phase}: ${terminalStatus.message}`);
    }
    if (terminalStatus.terminal !== true) {
      throw new Error('Expected terminal UI status after isolated retrieve');
    }
    if (!retrieveTx || !retrieveTx.publishedResult || !retrieveTx.retiredRemote) {
      throw new Error(`Retrieve transaction incomplete: ${JSON.stringify(retrieveTx)}`);
    }
    if (retrieveTx.deliveredCommandId !== commandId) {
      throw new Error(
        `Expected delivered command ${commandId}, got ${retrieveTx.deliveredCommandId}`,
      );
    }
    if (engineResult.status !== 'FAILED') {
      throw new Error(`Expected engine FAILED status, got ${engineResult.status}`);
    }
    if (publishedStatus !== 'FAILED') {
      throw new Error(`Expected published remote FAILED, got ${publishedStatus}`);
    }
    if (report.remoteCommandPresent) {
      throw new Error('Isolated remote command was not retired');
    }
    if (deliveries !== 1) {
      throw new Error(`Expected exactly one sidecar delivery record, got ${deliveries}`);
    }

    report.ok = true;
    return report;
  } finally {
    if (harnessDaemonPid && startedByUs) {
      stopProcessTree(harnessDaemonPid);
    }
    removeDaemonReady(paths.snapshotDir);
    removeDaemonPid(paths.snapshotDir);
    try {
      await cleanupIsolatedRemote(relayOptions);
    } catch (cleanupError) {
      if (!options.ignoreCleanupErrors) {
        throw cleanupError;
      }
    }
    const productionAfter = captureProductionIntegrityBaseline(repoRoot);
    assertProductionIntegrityUnchanged(productionBefore, productionAfter);
  }
}

async function main() {
  const configPath = process.argv[2]
    ? path.resolve(process.argv[2])
    : null;
  const report = await runM134eIsolatedE2e({ configPath });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  runM134eIsolatedE2e,
  buildRemoteMoveCommand,
  buildEngineFailedMoveResult,
  resolveUserSeedDir,
};
