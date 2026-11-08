'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { formatRelayStatusLabel } = require('../lib/relay-status-label.cjs');
const { shouldWriteOnDemandStatus } = require('../lib/companion-on-demand-status.cjs');

describe('M1 retrieve status label semantics (engine mirror)', () => {
  it('COMPLETED command with incomplete relay (failed phase)', () => {
    const label = formatRelayStatusLabel({
      action: 'retrieve',
      phase: 'failed',
      terminal: true,
      error_code: 'RETRIEVE_INCOMPLETE',
      last_command_status: 'COMPLETED',
    });
    assert.equal(label, 'Order done; relay incomplete');
  });

  it('genuine retrieval failure with no executed command', () => {
    assert.equal(
      formatRelayStatusLabel({
        action: 'retrieve',
        phase: 'failed',
        terminal: true,
        error_code: 'RETRIEVAL_ERROR',
      }),
      'Retrieve error',
    );
    assert.equal(
      formatRelayStatusLabel({
        action: 'retrieve',
        phase: 'failed',
        terminal: true,
      }),
      'Retrieve failed',
    );
  });

  it('command FAILED stays distinct from retrieval failure', () => {
    assert.equal(
      formatRelayStatusLabel({
        action: 'retrieve',
        phase: 'failed',
        terminal: true,
        last_command_status: 'FAILED',
      }),
      'Order failed',
    );
  });

  it('empty inbox label is independent of prior command outcome', () => {
    assert.equal(
      formatRelayStatusLabel({
        action: 'retrieve',
        phase: 'no_new_orders',
        terminal: true,
      }),
      'No new orders',
    );
  });

  it('consecutive AUTO polls do not erase sticky completed retrieve on disk', () => {
    const completed = {
      request_id: 'req-a',
      action: 'retrieve',
      phase: 'completed',
      terminal: true,
      last_command_id: 'a'.repeat(32),
      last_command_status: 'COMPLETED',
      updated_at_ms: 1000,
    };
    const poll = {
      request_id: 'req-b',
      action: 'retrieve',
      phase: 'no_new_orders',
      terminal: true,
      updated_at_ms: 2000,
    };
    assert.equal(shouldWriteOnDemandStatus(completed, poll), false);
  });

  it('stale failure cannot replace newer terminal completed retrieve', () => {
    const newer = {
      request_id: 'new',
      action: 'retrieve',
      phase: 'completed',
      terminal: true,
      last_command_id: 'b'.repeat(32),
      last_command_status: 'COMPLETED',
      updated_at_ms: 5000,
    };
    const stale = {
      request_id: 'old',
      action: 'retrieve',
      phase: 'failed',
      terminal: true,
      error_code: 'RETRIEVAL_ERROR',
      updated_at_ms: 1000,
    };
    assert.equal(shouldWriteOnDemandStatus(newer, stale), false);
  });

  it('rapid different request_ids: newer completed supersedes older', () => {
    const older = {
      request_id: 'old',
      action: 'retrieve',
      phase: 'completed',
      terminal: true,
      last_command_id: 'a'.repeat(32),
      last_command_status: 'COMPLETED',
      updated_at_ms: 1000,
    };
    const newer = {
      request_id: 'new',
      action: 'retrieve',
      phase: 'completed',
      terminal: true,
      last_command_id: 'b'.repeat(32),
      last_command_status: 'COMPLETED',
      updated_at_ms: 2000,
    };
    assert.equal(shouldWriteOnDemandStatus(older, newer), true);
  });

  it('local timeout incomplete before late completion fields would publish', () => {
    const afterTimeout = formatRelayStatusLabel({
      action: 'retrieve',
      phase: 'failed',
      terminal: true,
      error_code: 'RETRIEVE_INCOMPLETE',
      last_command_status: 'COMPLETED',
    });
    assert.equal(afterTimeout, 'Order done; relay incomplete');
    const afterLateComplete = formatRelayStatusLabel({
      action: 'retrieve',
      phase: 'completed',
      terminal: true,
      last_command_status: 'COMPLETED',
    });
    assert.equal(afterLateComplete, 'Order completed');
  });
});
