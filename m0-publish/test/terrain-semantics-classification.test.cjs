'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { categoryLabel } = require('../lib/terrain-semantics-sparse-v1.cjs');
const { classifyDiscoveredTile } = require('../lib/terrain-brief.cjs');

describe('terrain semantics classification (M1 WP1B)', () => {
  it('never treats impassable geometry alone as UFO structure', () => {
    const c = classifyDiscoveredTile({
      p: [1, 0, 0],
      disc: 4,
      inLos: true,
      body: { noFloor: false, elev: 0, walkO: 255, blockSightO: true },
    });
    assert.ok(!c.terrainSemantics.some((s) => s.category.startsWith('UFO_')));
    assert.ok(c.movementObstruction.length > 0);
  });

  it('labels craft modules only when semantics export XCOM_CRAFT', () => {
    const c = classifyDiscoveredTile({
      p: [0, 0, 0],
      disc: 4,
      inLos: true,
      body: { noFloor: false, elev: 0, walkF: 8 },
      sem: { body: 9 },
    });
    assert.ok(c.terrainSemantics.some((s) => s.category === 'XCOM_CRAFT'));
    assert.equal(categoryLabel(9), 'XCOM_CRAFT');
  });

  it('defaults unknown categories safely', () => {
    assert.equal(categoryLabel(0), 'UNKNOWN');
    assert.equal(categoryLabel(99), 'UNKNOWN');
  });
});
