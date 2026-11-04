'use strict';

const { createRelayRateLimitGate } = require('../../lib/relay-rate-limit-gate.cjs');

const gatePath = process.argv[2];
const now = Number(process.argv[3]);
const cooldownUntilMs = Number(process.argv[4]);
if (!gatePath || !Number.isFinite(now) || !Number.isFinite(cooldownUntilMs)) {
  process.exit(2);
}

const resetSec = Math.floor(cooldownUntilMs / 1000);
const gate = createRelayRateLimitGate({ gatePath, now: () => now });
gate.recordError({
  code: 'RATE_LIMIT',
  stderr: `API rate limit exceeded\nx-ratelimit-reset: ${resetSec}`,
}, now);
