'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { tryResolveRelayDefaults, RELAY_CONTENT_PATHS, resolveRelayDefaults } = require('./github-relay.cjs');
const { DEFAULT_BASE_STATE_PATH } = require('./relay-config.cjs');

const CONFIG_SCHEMA_VERSION = 1;

function getProductionCooperativeRelay(env = process.env) {
  const defaults = resolveRelayDefaults(env);
  return Object.freeze({
    repo: defaults.repo,
    branch: defaults.branch,
    statePath: defaults.statePath,
    contentPaths: { ...RELAY_CONTENT_PATHS },
  });
}

function tryGetProductionCooperativeRelay(env = process.env) {
  const defaults = tryResolveRelayDefaults(env);
  if (!defaults) {
    return null;
  }
  return Object.freeze({
    repo: defaults.repo,
    branch: defaults.branch,
    statePath: defaults.statePath,
    contentPaths: { ...RELAY_CONTENT_PATHS },
  });
}

function mergeContentPaths(partial) {
  const merged = { ...RELAY_CONTENT_PATHS };
  if (!partial || typeof partial !== 'object') {
    return merged;
  }
  for (const key of Object.keys(RELAY_CONTENT_PATHS)) {
    if (partial[key] != null) {
      merged[key] = String(partial[key]).trim();
    }
  }
  for (const key of Object.keys(merged)) {
    if (!merged[key]) {
      throw new Error(`relay isolation config: content_paths.${key} must be a non-empty string`);
    }
  }
  return merged;
}

function matchesProductionCooperativeSurface(config, env = process.env) {
  if (!config || typeof config !== 'object') {
    return false;
  }
  const production = tryGetProductionCooperativeRelay(env);
  if (!production) {
    return false;
  }
  const repo = String(config.repo || '').trim();
  const branch = String(config.branch || 'main').trim();
  if (repo !== production.repo || branch !== production.branch) {
    return false;
  }
  const paths = mergeContentPaths(config.content_paths ?? config.contentPaths);
  for (const key of Object.keys(RELAY_CONTENT_PATHS)) {
    if (paths[key] === production.contentPaths[key]) {
      return true;
    }
  }
  const statePath = String(config.state_path ?? config.statePath ?? production.statePath).trim();
  return statePath === production.statePath;
}

function assertIsolatedFromProductionCooperative(config, label = 'relay isolation config', env = process.env) {
  const production = tryGetProductionCooperativeRelay(env);
  if (production && matchesProductionCooperativeSurface(config, env)) {
    throw new Error(
      `${label}: refusing production cooperative GitHub surface `
      + `(${production.repo}@${production.branch} `
      + 'and production m0/* paths). Use a dedicated test repository or non-overlapping paths on a non-main branch.',
    );
  }
  const repo = String(config.repo || '').trim();
  const branch = String(config.branch || '').trim();
  if (!repo.includes('/')) {
    throw new Error(`${label}: repo must be owner/name`);
  }
  if (!branch) {
    throw new Error(`${label}: branch is required`);
  }
  if (production && repo === production.repo && branch === production.branch) {
    throw new Error(`${label}: refusing production repo main branch for isolated validation`);
  }
  if (production && repo === production.repo) {
    const paths = mergeContentPaths(config.content_paths ?? config.contentPaths);
    for (const key of Object.keys(RELAY_CONTENT_PATHS)) {
      const productionPath = production.contentPaths[key];
      if (productionPath && paths[key] === productionPath) {
        throw new Error(
          `${label}: on production repo ${repo}, content_paths.${key} must not equal production path ${paths[key]}`,
        );
      }
    }
    const statePath = String(config.state_path ?? config.statePath ?? production.statePath).trim();
    if (statePath === production.statePath) {
      throw new Error(`${label}: on production repo ${repo}, state_path must not equal ${production.statePath}`);
    }
    const baseStatePath = String(config.base_state_path ?? config.baseStatePath ?? DEFAULT_BASE_STATE_PATH).trim();
    if (baseStatePath === production.statePath) {
      throw new Error(`${label}: on production repo ${repo}, base_state_path must not equal tactical state path ${production.statePath}`);
    }
  }
}

function normalizeRelayIsolationConfig(raw, sourceLabel) {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`${sourceLabel}: config must be a JSON object`);
  }
  if (raw.schema_version !== CONFIG_SCHEMA_VERSION) {
    throw new Error(`${sourceLabel}: schema_version must be ${CONFIG_SCHEMA_VERSION}`);
  }
  const repo = String(raw.repo || '').trim();
  const branch = String(raw.branch || 'main').trim();
  if (!repo) {
    throw new Error(`${sourceLabel}: repo is required`);
  }
  const contentPaths = mergeContentPaths(raw.content_paths ?? raw.contentPaths);
  const statePath = String(raw.state_path ?? raw.statePath ?? 'm0/state.json').trim();
  const baseStatePath = String(raw.base_state_path ?? raw.baseStatePath ?? DEFAULT_BASE_STATE_PATH).trim();
  if (!statePath) {
    throw new Error(`${sourceLabel}: state_path must be non-empty`);
  }
  if (!baseStatePath) {
    throw new Error(`${sourceLabel}: base_state_path must be non-empty`);
  }
  const normalized = {
    schema_version: CONFIG_SCHEMA_VERSION,
    repo,
    branch,
    state_path: statePath,
    base_state_path: baseStatePath,
    content_paths: contentPaths,
  };
  assertIsolatedFromProductionCooperative(normalized, sourceLabel);
  return normalized;
}

function loadRelayIsolationConfig(configPath) {
  const resolved = path.resolve(String(configPath));
  if (!fs.existsSync(resolved)) {
    throw new Error(`relay isolation config not found: ${resolved}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (error) {
    throw new Error(`relay isolation config parse failed (${resolved}): ${error.message || String(error)}`);
  }
  return normalizeRelayIsolationConfig(parsed, resolved);
}

function loadRelayIsolationConfigFromEnv(env = process.env) {
  const fromEnv = env.COMPANION_M134E_RELAY_ISOLATION_CONFIG
    ?? env.COMPANION_RELAY_ISOLATION_CONFIG;
  if (!fromEnv || !String(fromEnv).trim()) {
    throw new Error(
      'Missing relay isolation config. Set COMPANION_M134E_RELAY_ISOLATION_CONFIG to a JSON file path '
      + '(see config/m1-34e-relay-isolation.example.json).',
    );
  }
  return loadRelayIsolationConfig(String(fromEnv).trim());
}

function fingerprintRelayIsolationConfig(config) {
  const normalized = normalizeRelayIsolationConfig(config, 'relay isolation fingerprint');
  const canonical = {
    repo: normalized.repo,
    branch: normalized.branch,
    state_path: normalized.state_path,
    base_state_path: normalized.base_state_path,
    content_paths: normalized.content_paths,
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function buildRelayIsolationContract(config) {
  const normalized = normalizeRelayIsolationConfig(config, 'relay isolation contract');
  return Object.freeze({
    repo: normalized.repo,
    branch: normalized.branch,
    statePath: normalized.state_path,
    baseStatePath: normalized.base_state_path,
    contentPaths: { ...normalized.content_paths },
    fingerprint: fingerprintRelayIsolationConfig(normalized),
  });
}

function relayOptionsMatchContract(relayOptions, contract) {
  if (!contract) {
    return { ok: true };
  }
  if (!relayOptions || typeof relayOptions !== 'object') {
    return { ok: false, reason: 'missing relay options for isolation contract' };
  }
  const defaults = tryResolveRelayDefaults();
  const repo = String(relayOptions.repo ?? (defaults && defaults.repo) ?? '').trim();
  const branch = String(relayOptions.branch ?? (defaults && defaults.branch) ?? 'main').trim();
  if (repo !== contract.repo || branch !== contract.branch) {
    return {
      ok: false,
      reason: `repo/branch mismatch (expected ${contract.repo}@${contract.branch}, got ${repo}@${branch})`,
    };
  }
  const paths = mergeContentPaths(relayOptions.contentPaths ?? relayOptions.content_paths);
  for (const key of Object.keys(contract.contentPaths)) {
    if (paths[key] !== contract.contentPaths[key]) {
      return {
        ok: false,
        reason: `contentPaths.${key} mismatch (expected ${contract.contentPaths[key]}, got ${paths[key]})`,
      };
    }
  }
  const statePath = String(
    relayOptions.statePath
    ?? relayOptions.state_path
    ?? (defaults && defaults.statePath)
    ?? 'm0/state.json',
  ).trim();
  if (statePath !== contract.statePath) {
    return {
      ok: false,
      reason: `statePath mismatch (expected ${contract.statePath}, got ${statePath})`,
    };
  }
  if (relayOptions.isolationEnforced !== true) {
    return { ok: false, reason: 'isolationEnforced must be true under relay isolation contract' };
  }
  return { ok: true };
}

function assertRelayOptionsMatchContract(relayOptions, contract, label = 'relay client') {
  const check = relayOptionsMatchContract(relayOptions, contract);
  if (!check.ok) {
    const err = new Error(`RELAY_ISOLATION_CONTRACT_VIOLATION (${label}): ${check.reason}`);
    err.code = 'RELAY_ISOLATION_CONTRACT_VIOLATION';
    throw err;
  }
}

function buildRelayOptionsFromConfig(config) {
  const normalized = normalizeRelayIsolationConfig(config, 'relay isolation config');
  const contract = buildRelayIsolationContract(normalized);
  return {
    repo: contract.repo,
    branch: contract.branch,
    statePath: contract.statePath,
    contentPaths: { ...contract.contentPaths },
    isolationEnforced: true,
    relayIsolationContract: contract,
  };
}

function describeRelayIsolationTarget(config) {
  const normalized = normalizeRelayIsolationConfig(config, 'relay isolation config');
  return {
    repo: normalized.repo,
    branch: normalized.branch,
    statePath: normalized.state_path,
    contentPaths: { ...normalized.content_paths },
  };
}

module.exports = {
  CONFIG_SCHEMA_VERSION,
  get PRODUCTION_COOPERATIVE_RELAY() {
    return getProductionCooperativeRelay();
  },
  getProductionCooperativeRelay,
  tryGetProductionCooperativeRelay,
  mergeContentPaths,
  matchesProductionCooperativeSurface,
  assertIsolatedFromProductionCooperative,
  normalizeRelayIsolationConfig,
  loadRelayIsolationConfig,
  loadRelayIsolationConfigFromEnv,
  fingerprintRelayIsolationConfig,
  buildRelayIsolationContract,
  relayOptionsMatchContract,
  assertRelayOptionsMatchContract,
  buildRelayOptionsFromConfig,
  describeRelayIsolationTarget,
};
