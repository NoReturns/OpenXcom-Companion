'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
describe('retrieve pending work disposition (stale local inbox)', () => {
  it('non-terminal local result is not classified as no_new_orders', () => {
    const { isTerminalStatus } = require('../lib/tactical-command.cjs');
    const localResult = { command_id: 'a7f0e2d51c9b4f8da65b30c192e74f06', status: 'EXECUTING' };
    assert.equal(isTerminalStatus(localResult.status), false);
  });
});
