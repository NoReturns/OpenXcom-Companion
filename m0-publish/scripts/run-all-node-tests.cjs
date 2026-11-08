'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { applySyntheticRelayEnv } = require('../test/helpers/synthetic-relay-env.cjs');

const env = { ...process.env };
delete env.COMPANION_ON_DEMAND_TEST_NO_LIVE_REUSE;
delete env.NODE_TEST_CONTEXT;
applySyntheticRelayEnv(env);

const testDir = path.join(__dirname, '..', 'test');
const files = fs.readdirSync(testDir)
  .filter((name) => name.endsWith('.test.cjs'))
  .map((name) => path.join(testDir, name));

const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], {
  cwd: path.join(__dirname, '..'),
  env,
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
