'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TARGET = path.join(__dirname, 'terrain-map-brief-relay-p1.test.cjs');
const PINNED_FIXTURE = path.join(__dirname, 'fixtures', 'terrain-map-brief-novosibirsk-oso-v5.yaml');
const LIVE_SNAPSHOT_PATH_FRAGMENT = ['local', 'm0', 'tactical-live.yaml'].join('/');

describe('CI-HYGIENE-02 terrainMapBrief P1 relay', () => {
  it('never binds Novosibirsk Oso relay map assertions to optional local live export', () => {
    const source = fs.readFileSync(TARGET, 'utf8');
    assert.ok(!source.includes(LIVE_SNAPSHOT_PATH_FRAGMENT));
    assert.ok(!source.includes(['local', 'm0', 'tactical-live.yaml'].join(path.sep)));
    assert.ok(!/liveIt\s*\(/m.test(source));
    assert.ok(source.includes('terrain-map-brief-novosibirsk-oso-v5.yaml'));
    assert.ok(fs.existsSync(PINNED_FIXTURE));
  });
});
