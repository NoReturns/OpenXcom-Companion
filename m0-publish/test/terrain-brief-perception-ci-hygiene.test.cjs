'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TARGET = path.join(__dirname, 'terrain-brief-perception.test.cjs');
const PINNED_FIXTURE = path.join(__dirname, 'fixtures', 'terrain-brief-near-focus-density-v5.yaml');

/** Split path segment so this guard file never embeds the forbidden live snapshot path. */
const LIVE_SNAPSHOT_PATH_FRAGMENT = ['local', 'm0', 'tactical-live.yaml'].join('/');

describe('CI-HYGIENE-01 terrain-brief-perception', () => {
  it('never gates near-focus density coverage on an optional workstation live snapshot', () => {
    const source = fs.readFileSync(TARGET, 'utf8');
    assert.ok(!source.includes(LIVE_SNAPSHOT_PATH_FRAGMENT));
    assert.ok(!source.includes(['local', 'm0', 'tactical-live.yaml'].join(path.sep)));
    assert.ok(!/if\s*\(\s*!fs\.existsSync\(/m.test(source), 'must not skip tests when local files are absent');
    assert.ok(source.includes('terrain-brief-near-focus-density-v5.yaml'));
    assert.ok(fs.existsSync(PINNED_FIXTURE));
  });
});
