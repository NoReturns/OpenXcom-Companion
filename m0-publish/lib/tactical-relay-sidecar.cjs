'use strict';

const { CommandRelayWatcher } = require('./command-relay-watcher.cjs');
const { TerrainQueryRelayWatcher } = require('./terrain-query-relay-watcher.cjs');
const {
  createRelayContentClient,
  RELAY_CONTENT_PATHS,
  DEFAULT_COMMAND_MAX_BYTES,
  DEFAULT_RESULT_MAX_BYTES,
  DEFAULT_TERRAIN_QUERY_MAX_BYTES,
  DEFAULT_TERRAIN_QUERY_RESULT_MAX_BYTES,
} = require('./github-relay.cjs');

function createTacticalRelaySidecar(options) {
  const content = options.contentClient ?? createRelayContentClient(options.relayOptions);
  const paths = content.paths;

  const commandWatcher = new CommandRelayWatcher({
    snapshotPath: options.snapshotPath,
    stateDir: options.stateDir,
    dryRun: options.dryRun,
    pollIntervalMs: options.pollIntervalMs,
    log: options.log,
    signal: options.signal,
    notify: options.notify,
    notify: options.notify,
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
    pollIntervalMs: options.pollIntervalMs,
    log: options.log,
    signal: options.signal,
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

  return { commandWatcher, queryWatcher };
}

function startTacticalRelaySidecar(options) {
  const { commandWatcher, queryWatcher } = createTacticalRelaySidecar(options);
  commandWatcher.start();
  queryWatcher.start();
  return {
    stop() {
      commandWatcher.stop();
      queryWatcher.stop();
    },
    commandWatcher,
    queryWatcher,
  };
}

module.exports = {
  createTacticalRelaySidecar,
  startTacticalRelaySidecar,
  RELAY_CONTENT_PATHS,
};
