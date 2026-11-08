'use strict';

const {
  listTestOwnedOnDemandRelayLeaks,
  formatRelayDaemonLeakReport,
} = require('../lib/on-demand-test-supervisor.cjs');

const leaks = listTestOwnedOnDemandRelayLeaks();
console.log(formatRelayDaemonLeakReport(leaks));
if (leaks.length > 0) {
  for (const row of leaks) {
    console.log(JSON.stringify(row, null, 2));
  }
  process.exitCode = 1;
}
