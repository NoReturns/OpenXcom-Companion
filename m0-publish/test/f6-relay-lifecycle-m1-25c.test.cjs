'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  evaluateInboxQuarantine,
  inboxBindingMatchesSnapshot,
  readSnapshotExportBinding,
  sha256FileHex,
} = require('../lib/companion-canonical-runtime.cjs');

const SNAPSHOT_YAML = [
  'schemaVersion: 5',
  'turn: 2',
  'eventLog:',
  '  sessionId: a1b2c3d4e5f6789012345678abcdef01',
  '  latestSeq: 3',
  '',
].join('\n');

describe('F6 / reload relay lifecycle (M1-25C)', () => {
  it('quarantines inbox when binding disagrees with on-disk snapshot export', () => {
    const decision = evaluateInboxQuarantine({
      inboxExists: true,
      resultExists: false,
      resultStatus: undefined,
      resultParseError: false,
      inboxValue: {
        session_id: '00000000000000000000000000000000',
        snapshot_sha256: 'b'.repeat(64),
        turn: 2,
        state_version: 3,
      },
      snapshotBinding: {
        sessionId: 'a1b2c3d4e5f6789012345678abcdef01',
        snapshotSha256: 'a'.repeat(64),
        turn: 2,
        stateVersion: 3,
      },
    });
    assert.equal(decision.action, 'quarantine');
    assert.equal(decision.reason, 'stale_binding');
  });

  it('reads snapshot export binding from tactical-live.yaml', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-25c-yaml-'));
    const yamlPath = path.join(dir, 'tactical-live.yaml');
    fs.writeFileSync(yamlPath, SNAPSHOT_YAML, 'utf8');
    const binding = readSnapshotExportBinding(yamlPath, fs.readFileSync, fs.existsSync, sha256FileHex);
    assert.equal(binding.sessionId, 'a1b2c3d4e5f6789012345678abcdef01');
    assert.equal(binding.turn, 2);
    assert.equal(binding.stateVersion, 3);
    assert.match(binding.snapshotSha256, /^[a-f0-9]{64}$/);
  });

  it('inboxBindingMatchesSnapshot requires all binding fields', () => {
    const snap = {
      sessionId: 'a1b2c3d4e5f6789012345678abcdef01',
      snapshotSha256: 'c'.repeat(64),
      turn: 1,
      stateVersion: 0,
    };
    assert.equal(inboxBindingMatchesSnapshot({
      session_id: snap.sessionId,
      snapshot_sha256: snap.snapshotSha256,
      turn: snap.turn,
      state_version: snap.stateVersion,
    }, snap), true);
    assert.equal(inboxBindingMatchesSnapshot({
      session_id: snap.sessionId,
      snapshot_sha256: snap.snapshotSha256,
      turn: 99,
      state_version: snap.stateVersion,
    }, snap), false);
  });
});
