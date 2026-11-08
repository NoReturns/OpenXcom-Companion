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

const {
  listTestOwnedOnDemandRelayLeaks,
  formatRelayDaemonLeakReport,
} = require('../lib/on-demand-test-supervisor.cjs');
const relayLeaks = listTestOwnedOnDemandRelayLeaks();
if (relayLeaks.length > 0) {
  console.error('\n[companion] Test-owned on-demand relay daemon leak check FAILED');
  console.error(formatRelayDaemonLeakReport(relayLeaks));
  for (const row of relayLeaks) {
    console.error(`  cmd: ${row.commandLine}`);
  }
  process.exit(1);
}

if ((result.status ?? 1) !== 0) {
  process.exit(result.status ?? 1);
}

console.log('[companion] Test-owned on-demand relay daemon leak check: PASS');
process.exit(0);
