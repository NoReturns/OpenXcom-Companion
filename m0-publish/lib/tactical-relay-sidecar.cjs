'use strict';

const path = require('node:path');
const { CommandRelayWatcher, DEFAULT_IDLE_POLL_MS: COMMAND_IDLE_POLL_MS } = require('./command-relay-watcher.cjs');
const { TerrainQueryRelayWatcher, DEFAULT_IDLE_POLL_MS: TERRAIN_IDLE_POLL_MS } = require('./terrain-query-relay-watcher.cjs');
const {
  createRelayContentClient,
  createRelayPublisher,
  RELAY_CONTENT_PATHS,
  DEFAULT_COMMAND_MAX_BYTES,
  DEFAULT_RESULT_MAX_BYTES,
  DEFAULT_TERRAIN_QUERY_MAX_BYTES,
  DEFAULT_TERRAIN_QUERY_RESULT_MAX_BYTES,
} = require('./github-relay.cjs');
const { createRelayRateLimitGate, resolveSharedRelayRateLimitGatePath } = require('./relay-rate-limit-gate.cjs');
const { createGithubQuotaTelemetryStore } = require('./github-quota-telemetry.cjs');
const { createGithubQuotaConsoleMonitor } = require('./github-quota-console.cjs');
const { removeCompanionGithubQuotaHudFile, resolveCompanionGithubQuotaHudPath } = require('./github-quota-hud-file.cjs');

const M0_PUBLISH_ROOT = path.resolve(__dirname, '..');

function createTacticalRelaySidecar(options) {
  const gatePath = options.rateLimitGatePath
    ?? resolveSharedRelayRateLimitGatePath(M0_PUBLISH_ROOT);
  const rateLimitGate = options.rateLimitGate
    ?? createRelayRateLimitGate({ gatePath, now: options.now });
  const hudPath = resolveCompanionGithubQuotaHudPath({ snapshotPathEnv: options.snapshotPath });
  const quotaTelemetryStore = options.quotaTelemetryStore
    ?? createGithubQuotaTelemetryStore({ now: options.now, persistPath: hudPath });
  const baseLog = options.log ?? ((line) => console.log(line));
  const quotaConsoleMonitor = options.quotaConsoleMonitor
    ?? createGithubQuotaConsoleMonitor({
      store: quotaTelemetryStore,
      rateLimitGate,
      log: baseLog,
      now: options.now,
      hudPath,
      snapshotPathEnv: options.snapshotPath,
    });
  const relayOptions = {
    ...(options.relayOptions ?? {}),
    rateLimitGate,
    quotaTelemetryStore,
    now: options.now,
  };

  const content = options.contentClient ?? createRelayContentClient(relayOptions);
  const paths = content.paths;
  const relayPublisher = options.relayPublisher ?? createRelayPublisher(relayOptions);

  const commandPollIntervalMs = options.commandPollIntervalMs
    ?? options.pollIntervalMs
    ?? COMMAND_IDLE_POLL_MS;
  const terrainPollIntervalMs = options.terrainPollIntervalMs
    ?? TERRAIN_IDLE_POLL_MS;

  const commandWatcher = new CommandRelayWatcher({
    snapshotPath: options.snapshotPath,
    stateDir: options.stateDir,
    dryRun: options.dryRun,
    pollIntervalMs: commandPollIntervalMs,
    activePollIntervalMs: options.activePollIntervalMs,
    rateLimitGate,
    log: baseLog,
    githubQuotaMonitor: quotaConsoleMonitor,
    signal: options.signal,
    notify: options.notify,
    now: options.now,
    publishRemoteRelayState: (relay) => relayPublisher.publishRelayState(relay),
    readRemoteCommand: () => Promise.resolve(
      content.readFile(paths.tacticalCommand, DEFAULT_COMMAND_MAX_BYTES),
    ),
    publishRemoteResult: async (result, commandId) => {
      await content.publishFile(
        paths.tacticalResult,
        result,
        `M1 tactical result ${commandId.slice(0, 8)} ${result.status}`,
        DEFAULT_RESULT_MAX_BYTES,
      );
    },
    fetchRemoteResult: async () => {
      const remote = content.readFile(paths.tacticalResult, DEFAULT_RESULT_MAX_BYTES);
      if (!remote) {
        return null;
      }
      return { value: JSON.parse(remote.text), sha: remote.sha };
    },
    retireRemoteCommand: async (expectedSha, commandId) => {
      await content.deleteFile(
        paths.tacticalCommand,
        expectedSha,
        `M1 retire tactical command ${commandId.slice(0, 8)}`,
      );
    },
  });

  const queryWatcher = new TerrainQueryRelayWatcher({
    snapshotPath: options.snapshotPath,
    stateDir: options.stateDir,
    dryRun: options.dryRun,
    pollIntervalMs: terrainPollIntervalMs,
    rateLimitGate,
    log: baseLog,
    githubQuotaMonitor: quotaConsoleMonitor,
    signal: options.signal,
    now: options.now,
    readRemoteQuery: () => Promise.resolve(
      content.readFile(paths.terrainQuery, DEFAULT_TERRAIN_QUERY_MAX_BYTES),
    ),
    publishRemoteQueryResult: async (response) => {
      await content.publishFile(
        paths.terrainQueryResult,
        response,
        `M1 terrain query ${response.snapshot_id.slice(0, 12)}`,
        DEFAULT_TERRAIN_QUERY_RESULT_MAX_BYTES,
      );
    },
  });

  return { commandWatcher, queryWatcher, rateLimitGate, quotaTelemetryStore, quotaConsoleMonitor };
}

function startTacticalRelaySidecar(options) {
  const created = createTacticalRelaySidecar(options);
  const { commandWatcher, queryWatcher } = created;
  commandWatcher.start();
  queryWatcher.start();
  return {
    stop() {
      commandWatcher.stop();
      queryWatcher.stop();
      removeCompanionGithubQuotaHudFile({
        snapshotPathEnv: process.env.OPENXCOM_COMPANION_SNAPSHOT_PATH,
        m0PublishRoot: M0_PUBLISH_ROOT,
      });
    },
    commandWatcher,
    queryWatcher,
  };
}

module.exports = {
  createTacticalRelaySidecar,
  startTacticalRelaySidecar,
  M0_PUBLISH_ROOT,
  RELAY_CONTENT_PATHS,
};
