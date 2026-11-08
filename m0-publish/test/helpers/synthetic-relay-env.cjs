'use strict';

const { RELAY_REPO_ENV, RELAY_BRANCH_ENV } = require('../../lib/relay-config.cjs');

const SYNTHETIC_RELAY_REPO = 'Companion-Test/Synthetic-Relay';
const SYNTHETIC_RELAY_BRANCH = 'main';

function applySyntheticRelayEnv(env = process.env) {
  if (!env[RELAY_REPO_ENV]) {
    env[RELAY_REPO_ENV] = SYNTHETIC_RELAY_REPO;
  }
  if (!env[RELAY_BRANCH_ENV]) {
    env[RELAY_BRANCH_ENV] = SYNTHETIC_RELAY_BRANCH;
  }
}

module.exports = {
  SYNTHETIC_RELAY_REPO,
  SYNTHETIC_RELAY_BRANCH,
  applySyntheticRelayEnv,
};
