'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { formatRelayStatusLabel } = require('../lib/relay-status-label.cjs');
const {
  shouldWriteOnDemandStatus,
  writeOnDemandStatus,
  shouldAcceptIncomingRetrieveAttempt,
  incomingRetrieveFailureWouldEraseStickyCommand,
  buildOnDemandStatusPayload,
} = require('../lib/companion-on-demand-status.cjs');

function writeTerminalStatus(statusPath, fields) {
  return writeOnDemandStatus(statusPath, buildOnDemandStatusPayload({ message: '', ...fields }));
}
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

  it('failed retrieve after completed command uses last_retrieve attempt for HUD label', () => {
    const label = formatRelayStatusLabel({
      action: 'retrieve',
      phase: 'completed',
      terminal: true,
      last_command_status: 'COMPLETED',
      updated_at_ms: 1000,
      last_retrieve_phase: 'failed',
      last_retrieve_error_code: 'NETWORK_FAILED',
      last_retrieve_updated_at_ms: 2000,
      last_retrieve_request_id: 'b'.repeat(32),
    });
    assert.equal(label, 'Retrieve error');
  });

  it('RETRIEVE_INCOMPLETE attempt after sticky completion shows relay incomplete not Order completed', () => {
    const label = formatRelayStatusLabel({
      action: 'retrieve',
      phase: 'completed',
      terminal: true,
      last_command_status: 'COMPLETED',
      updated_at_ms: 1000,
      last_retrieve_phase: 'failed',
      last_retrieve_error_code: 'RETRIEVE_INCOMPLETE',
      last_retrieve_updated_at_ms: 2000,
    });
    assert.equal(label, 'Order done; relay incomplete');
  });

  it('sticky merge records last_retrieve without erasing command completion', () => {
    const statusPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'm1-sticky-merge-')),
      'status.json',
    );
    writeOnDemandStatus(statusPath, {
      request_id: 'a'.repeat(32),
      action: 'retrieve',
      phase: 'completed',
      terminal: true,
      last_command_id: 'c'.repeat(32),
      last_command_status: 'COMPLETED',
      updated_at_ms: 1000,
    });
    const merged = writeOnDemandStatus(statusPath, {
      request_id: 'b'.repeat(32),
      action: 'retrieve',
      phase: 'failed',
      terminal: true,
      error_code: 'RETRIEVAL_ERROR',
      updated_at_ms: 2000,
    });
    assert.equal(merged.written, true);
    assert.equal(merged.preserved_sticky, true);
    const kept = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    assert.equal(kept.phase, 'completed');
    assert.equal(kept.last_command_status, 'COMPLETED');
    assert.equal(kept.last_retrieve_phase, 'failed');
    assert.equal(kept.last_retrieve_error_code, 'RETRIEVAL_ERROR');
    assert.equal(formatRelayStatusLabel(kept), 'Retrieve error');
  });

  it('lifecycle B: successful retrieve after failure clears HUD error and updates last_retrieve', () => {
    const statusPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'm1-lifecycle-b-')),
      'status.json',
    );
    writeTerminalStatus(statusPath, {
      request_id: 'a'.repeat(32),
      action: 'retrieve',
      phase: 'completed',
      terminal: true,
      last_command_id: 'c'.repeat(32),
      last_command_status: 'COMPLETED',
      updated_at_ms: 1000,
    });
    writeTerminalStatus(statusPath, {
      request_id: 'b'.repeat(32),
      action: 'retrieve',
      phase: 'failed',
      terminal: true,
      error_code: 'NETWORK_FAILED',
      updated_at_ms: 2000,
    });
    assert.equal(formatRelayStatusLabel(JSON.parse(fs.readFileSync(statusPath, 'utf8'))), 'Retrieve error');

    writeTerminalStatus(statusPath, {
      request_id: 'd'.repeat(32),
      action: 'retrieve',
      phase: 'completed',
      terminal: true,
      last_command_id: 'e'.repeat(32),
      last_command_status: 'COMPLETED',
      updated_at_ms: 3000,
    });
    const after = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    assert.equal(after.phase, 'completed');
    assert.equal(after.last_retrieve_phase, 'completed');
    assert.equal(after.last_retrieve_updated_at_ms, 3000);
    assert.equal(after.last_retrieve_error_code, undefined);
    assert.equal(formatRelayStatusLabel(after), 'Order completed');
  });

  it('lifecycle C: delayed older retrieve failure does not replace newer last_retrieve', () => {
    const statusPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'm1-lifecycle-c-')),
      'status.json',
    );
    const sticky = {
      request_id: 'a'.repeat(32),
      action: 'retrieve',
      phase: 'completed',
      terminal: true,
      last_command_id: 'c'.repeat(32),
      last_command_status: 'COMPLETED',
      updated_at_ms: 1000,
      last_retrieve_request_id: 'b'.repeat(32),
      last_retrieve_phase: 'failed',
      last_retrieve_error_code: 'RETRIEVAL_ERROR',
      last_retrieve_updated_at_ms: 5000,
    };
    writeOnDemandStatus(statusPath, sticky);
    const staleFailure = writeOnDemandStatus(statusPath, {
      request_id: 'c'.repeat(32),
      action: 'retrieve',
      phase: 'failed',
      terminal: true,
      error_code: 'NETWORK_FAILED',
      updated_at_ms: 2000,
    });
    assert.equal(staleFailure.written, false);
    const kept = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    assert.equal(kept.last_retrieve_updated_at_ms, 5000);
    assert.equal(kept.last_retrieve_error_code, 'RETRIEVAL_ERROR');
    assert.equal(
      shouldAcceptIncomingRetrieveAttempt(kept, {
        last_retrieve_updated_at_ms: 2000,
      }),
      false,
    );
    assert.equal(formatRelayStatusLabel(kept), 'Retrieve error');
  });

  it('lifecycle D: no_new_orders after sticky completion keeps Order completed label on disk', () => {
    const statusPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'm1-lifecycle-d-')),
      'status.json',
    );
    writeOnDemandStatus(statusPath, {
      request_id: 'a'.repeat(32),
      action: 'retrieve',
      phase: 'completed',
      terminal: true,
      last_command_id: 'c'.repeat(32),
      last_command_status: 'COMPLETED',
      updated_at_ms: 1000,
    });
    const poll = writeOnDemandStatus(statusPath, {
      request_id: 'b'.repeat(32),
      action: 'retrieve',
      phase: 'no_new_orders',
      terminal: true,
      updated_at_ms: 2000,
    });
    assert.equal(poll.written, false);
    const kept = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    assert.equal(kept.phase, 'completed');
    assert.equal(kept.last_command_status, 'COMPLETED');
    assert.equal(formatRelayStatusLabel(kept), 'Order completed');
  });

  it('bare retrieval failure would erase sticky command without merge guard', () => {
    const existing = {
      request_id: 'a'.repeat(32),
      action: 'retrieve',
      phase: 'completed',
      terminal: true,
      last_command_id: 'c'.repeat(32),
      last_command_status: 'COMPLETED',
      updated_at_ms: 1000,
    };
    const failure = {
      request_id: 'b'.repeat(32),
      action: 'retrieve',
      phase: 'failed',
      terminal: true,
      error_code: 'RELAY_OFFLINE',
      updated_at_ms: 2000,
    };
    assert.equal(incomingRetrieveFailureWouldEraseStickyCommand(existing, failure), true);
    assert.equal(shouldWriteOnDemandStatus(existing, failure), false);
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
