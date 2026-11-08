'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  PRODUCTION_COOPERATIVE_RELAY,
  normalizeRelayIsolationConfig,
  assertIsolatedFromProductionCooperative,
  buildRelayOptionsFromConfig,
} = require('../lib/relay-isolation-config.cjs');
const { assertEngineRuntimeIsolation } = require('../lib/m1-34e-engine-isolation.cjs');
const { resolveRelayContentPaths } = require('../lib/github-relay.cjs');

describe('M1-34E relay isolation config', () => {
  it('refuses production cooperative main surface', () => {
    assert.throws(
      () => normalizeRelayIsolationConfig({
        schema_version: 1,
        repo: PRODUCTION_COOPERATIVE_RELAY.repo,
        branch: PRODUCTION_COOPERATIVE_RELAY.branch,
        content_paths: { ...PRODUCTION_COOPERATIVE_RELAY.contentPaths },
      }, 'test'),
      /refusing production cooperative GitHub surface/i,
    );
  });

  it('refuses production repo with production m0 paths on non-main branch', () => {
    assert.throws(
      () => assertIsolatedFromProductionCooperative({
        repo: PRODUCTION_COOPERATIVE_RELAY.repo,
        branch: 'm1-34e-isolated',
        content_paths: { tacticalCommand: PRODUCTION_COOPERATIVE_RELAY.contentPaths.tacticalCommand },
      }),
      /must not equal production path/i,
    );
  });

  it('accepts dedicated test repository with default-like paths', () => {
    const normalized = normalizeRelayIsolationConfig({
      schema_version: 1,
      repo: 'ExampleOrg/OpenXcom-Relay-M134E-Test',
      branch: 'main',
      content_paths: {
        tacticalCommand: 'm0-e2e/tactical-command.json',
        tacticalResult: 'm0-e2e/tactical-result.json',
      },
    }, 'test');
    const relayOptions = buildRelayOptionsFromConfig(normalized);
    assert.equal(relayOptions.repo, 'ExampleOrg/OpenXcom-Relay-M134E-Test');
    const paths = resolveRelayContentPaths(relayOptions);
    assert.equal(paths.tacticalCommand, 'm0-e2e/tactical-command.json');
  });

  it('engine isolation rejects production snapshot and user dirs', () => {
    const layout = require('../lib/companion-canonical-runtime.cjs').companionRuntimeLayout();
    assert.throws(
      () => assertEngineRuntimeIsolation({
        repoRoot: layout.repoRoot,
        isolatedRoot: layout.snapshotDir,
        isolatedSnapshotPath: layout.snapshotYaml,
        isolatedUserDir: layout.userDir,
      }),
      /must not/i,
    );
  });
});
