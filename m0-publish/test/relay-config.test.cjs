'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  resolveRelayRepoTarget,
  tryResolveRelayRepoTarget,
  applyRelayEnvFromLocalConfig,
  RelayConfigurationError,
} = require('../lib/relay-config.cjs');

describe('relay-config', () => {
  it('fails closed when relay repo is not configured', () => {
    const env = {
      OPENXCOM_COMPANION_RELAY_CONFIG: path.join(os.tmpdir(), `relay-missing-${process.pid}.json`),
    };
    assert.equal(tryResolveRelayRepoTarget(env), null);
    assert.throws(() => resolveRelayRepoTarget(env), RelayConfigurationError);
  });

  it('reads OPENXCOM_COMPANION_RELAY_REPO from environment', () => {
    const env = { OPENXCOM_COMPANION_RELAY_REPO: 'ExampleOrg/Example-Relay' };
    const target = resolveRelayRepoTarget(env);
    assert.equal(target.repo, 'ExampleOrg/Example-Relay');
    assert.equal(target.branch, 'main');
    assert.equal(target.source, 'OPENXCOM_COMPANION_RELAY_REPO');
  });

  it('loads gitignored relay.local.json when env is unset', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-config-'));
    const configPath = path.join(root, 'relay.local.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ schema_version: 1, repo: 'LocalFile/Private-Relay', branch: 'develop' }),
      'utf8',
    );
    const env = { OPENXCOM_COMPANION_RELAY_CONFIG: configPath };
    const target = resolveRelayRepoTarget(env);
    assert.equal(target.repo, 'LocalFile/Private-Relay');
    assert.equal(target.branch, 'develop');
    assert.equal(target.source, configPath);
  });

  it('applyRelayEnvFromLocalConfig does not override an existing env var', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-apply-'));
    const configPath = path.join(root, 'relay.local.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ repo: 'Should/Not-Win', branch: 'main' }),
      'utf8',
    );
    const env = {
      OPENXCOM_COMPANION_RELAY_REPO: 'EnvWins/Configured-Relay',
      OPENXCOM_COMPANION_RELAY_CONFIG: configPath,
    };
    const result = applyRelayEnvFromLocalConfig(env);
    assert.equal(result.applied, false);
    assert.equal(env.OPENXCOM_COMPANION_RELAY_REPO, 'EnvWins/Configured-Relay');
  });
});
