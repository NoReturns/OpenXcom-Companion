'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeTacticalPublicationConfirmAtomic, FILENAME } = require('../lib/tactical-publication-confirm.cjs');

describe('tactical publication confirm (M1)', () => {
  it('writes companion-tactical-publication-confirm.json atomically', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-confirm-'));
    writeTacticalPublicationConfirmAtomic(root, {
      session_id: '0123456789abcdef0123456789abcdef',
      turn: 4,
      state_version: 12,
      snapshot_sha256: 'a'.repeat(64),
      source: 'post_command',
      status: 'published',
      confirmed_at_ms: 1,
    });
    const parsed = JSON.parse(fs.readFileSync(path.join(root, FILENAME), 'utf8'));
    assert.equal(parsed.schema_version, 1);
    assert.equal(parsed.state_version, 12);
    assert.equal(parsed.source, 'post_command');
  });
});
