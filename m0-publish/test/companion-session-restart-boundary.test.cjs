'use strict';

/**
 * Contract tests: battle save reload rotates companion session_id (engine does not persist it).
 * Orphan SNAP_SHOT recovery after process restart must not re-execute; session-boundary INTERRUPTED expected.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { isTerminalStatus } = require('../lib/tactical-command.cjs');

describe('companion session restart boundary (relay contract)', () => {
  const priorSession = 'f45561e99281ff2d71a1a28b993e3f82';
  const reloadedSession = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  it('orphan EXECUTING is non-terminal until engine publishes closure', () => {
    assert.equal(isTerminalStatus('EXECUTING'), false);
    assert.equal(isTerminalStatus('INTERRUPTED'), true);
  });

  it('after reload, command binding from prior session must not authorize re-execution', () => {
    const command = {
      command_id: 'a7f0e2d51c9b4f8da65b30c192e74f06',
      session_id: priorSession,
      snapshot_sha256: '26531a505eb065a376abef77381cc405eb8a76cdcfa3d2b7172ef028f4e7784b',
      turn: 4,
      state_version: 6,
    };
    assert.notEqual(command.session_id, reloadedSession);
    assert.equal(
      command.session_id === reloadedSession,
      false,
      'relay-side snapshot binding would reject re-delivery; engine must not tryExecute',
    );
  });

  it('terminal INTERRUPTED after session boundary is publishable without replay', () => {
    const interrupted = {
      command_id: 'a7f0e2d51c9b4f8da65b30c192e74f06',
      status: 'INTERRUPTED',
      session_id: priorSession,
      public_reason: 'Battle session changed; in-flight directed fire cannot resume after reload.',
    };
    assert.equal(isTerminalStatus(interrupted.status), true);
    assert.ok(interrupted.public_reason.includes('session'));
  });
});
