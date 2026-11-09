'use strict';

const fs = require('node:fs');
const path = require('node:path');

const RELAY_REPO_ENV = 'OPENXCOM_COMPANION_RELAY_REPO';
const RELAY_BRANCH_ENV = 'OPENXCOM_COMPANION_RELAY_BRANCH';
const RELAY_LOCAL_CONFIG_ENV = 'OPENXCOM_COMPANION_RELAY_CONFIG';

const DEFAULT_RELAY_BRANCH = 'main';
const DEFAULT_STATE_PATH = 'm0/state.json';
const DEFAULT_BASE_STATE_PATH = 'm0/base-state.json';
const DEFAULT_MAX_REMOTE_BYTES = 256 * 1024;

const RELAY_LOCAL_CONFIG_FILENAME = 'relay.local.json';

class RelayConfigurationError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'RelayConfigurationError';
    this.code = options.code || 'RELAY_CONFIG_MISSING';
  }
}

function defaultLocalConfigPath() {
  return path.resolve(__dirname, '..', 'config', RELAY_LOCAL_CONFIG_FILENAME);
}

function resolveRelayLocalConfigPath(env = process.env) {
  const fromEnv = env[RELAY_LOCAL_CONFIG_ENV];
  if (fromEnv && String(fromEnv).trim()) {
    return path.resolve(String(fromEnv).trim());
  }
  return defaultLocalConfigPath();
}

function assertRepoSlug(repo, sourceLabel) {
  const trimmed = String(repo || '').trim();
  if (!trimmed || !trimmed.includes('/') || trimmed.startsWith('/') || trimmed.endsWith('/')) {
    throw new RelayConfigurationError(
      `${sourceLabel}: repo must be a non-empty GitHub slug in owner/name form (example: your-org/your-private-relay).`,
    );
  }
  const [owner, name] = trimmed.split('/');
  if (!owner || !name || trimmed.split('/').length !== 2) {
    throw new RelayConfigurationError(
      `${sourceLabel}: repo must be exactly owner/name (got "${trimmed}").`,
    );
  }
  return trimmed;
}

function readRelayLocalConfigFile(configPath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new RelayConfigurationError(
      `Relay local config parse failed (${configPath}): ${error.message || String(error)}`,
      { code: 'RELAY_CONFIG_INVALID' },
    );
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new RelayConfigurationError(
      `Relay local config must be a JSON object (${configPath}).`,
      { code: 'RELAY_CONFIG_INVALID' },
    );
  }
  const repo = assertRepoSlug(parsed.repo, configPath);
  const branch = String(parsed.branch || DEFAULT_RELAY_BRANCH).trim() || DEFAULT_RELAY_BRANCH;
  return { repo, branch, source: configPath };
}

function tryResolveRelayRepoTarget(env = process.env) {
  const fromEnv = env[RELAY_REPO_ENV];
  if (fromEnv && String(fromEnv).trim()) {
    const repo = assertRepoSlug(fromEnv, RELAY_REPO_ENV);
    const branch = String(env[RELAY_BRANCH_ENV] || DEFAULT_RELAY_BRANCH).trim() || DEFAULT_RELAY_BRANCH;
    return { repo, branch, source: RELAY_REPO_ENV };
  }
  const configPath = resolveRelayLocalConfigPath(env);
  if (fs.existsSync(configPath)) {
    return readRelayLocalConfigFile(configPath);
  }
  return null;
}

function resolveRelayRepoTarget(env = process.env) {
  const resolved = tryResolveRelayRepoTarget(env);
  if (!resolved) {
    throw new RelayConfigurationError(
      'GitHub relay repository is not configured. Set OPENXCOM_COMPANION_RELAY_REPO to owner/name '
      + '(recommended), or create a gitignored local file at '
      + `m0-publish/config/${RELAY_LOCAL_CONFIG_FILENAME} from relay.local.example.json. `
      + 'Authentication stays in `gh auth login` — never commit tokens or relay.local.json.',
    );
  }
  return resolved;
}

function resolveRelayDefaults(env = process.env) {
  const target = resolveRelayRepoTarget(env);
  return {
    repo: target.repo,
    branch: target.branch,
    statePath: DEFAULT_STATE_PATH,
    baseStatePath: DEFAULT_BASE_STATE_PATH,
    maxRemoteBytes: DEFAULT_MAX_REMOTE_BYTES,
    configSource: target.source,
  };
}

function tryResolveRelayDefaults(env = process.env) {
  const target = tryResolveRelayRepoTarget(env);
  if (!target) {
    return null;
  }
  return {
    repo: target.repo,
    branch: target.branch,
    statePath: DEFAULT_STATE_PATH,
    baseStatePath: DEFAULT_BASE_STATE_PATH,
    maxRemoteBytes: DEFAULT_MAX_REMOTE_BYTES,
    configSource: target.source,
  };
}

function applyRelayEnvFromLocalConfig(env = process.env) {
  if (env[RELAY_REPO_ENV] && String(env[RELAY_REPO_ENV]).trim()) {
    return { applied: false, reason: 'env_already_set', repo: env[RELAY_REPO_ENV].trim() };
  }
  const configPath = resolveRelayLocalConfigPath(env);
  if (!fs.existsSync(configPath)) {
    return { applied: false, reason: 'local_config_missing', configPath };
  }
  const target = readRelayLocalConfigFile(configPath);
  env[RELAY_REPO_ENV] = target.repo;
  if (!env[RELAY_BRANCH_ENV] && target.branch) {
    env[RELAY_BRANCH_ENV] = target.branch;
  }
  return { applied: true, configPath, repo: target.repo, branch: target.branch };
}

module.exports = {
  RELAY_REPO_ENV,
  RELAY_BRANCH_ENV,
  RELAY_LOCAL_CONFIG_ENV,
  DEFAULT_RELAY_BRANCH,
  DEFAULT_STATE_PATH,
  DEFAULT_BASE_STATE_PATH,
  DEFAULT_MAX_REMOTE_BYTES,
  RELAY_LOCAL_CONFIG_FILENAME,
  RelayConfigurationError,
  defaultLocalConfigPath,
  resolveRelayLocalConfigPath,
  resolveRelayRepoTarget,
  tryResolveRelayRepoTarget,
  resolveRelayDefaults,
  tryResolveRelayDefaults,
  applyRelayEnvFromLocalConfig,
};
