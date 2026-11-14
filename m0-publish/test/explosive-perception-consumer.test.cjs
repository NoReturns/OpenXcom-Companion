'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  getExplosivePerceptionContractMarkdown,
} = require('../lib/explosive-perception-consumer.cjs');
const { getAiBriefingInstructionsMarkdown } = require('../lib/tactical-briefing-ai-workflow.cjs');

describe('M1 explosive perception briefing contract (B7 close-out)', () => {
  it('states fair-play rules for blasts vs attribution', () => {
    const md = getExplosivePerceptionContractMarkdown();
    assert.match(md, /does \*\*not\*\* identify the source unit/);
    assert.match(md, /does \*\*not\*\* automatically authorize kill attribution/);
    assert.match(md, /combat_casualty_attributed/);
    assert.match(md, /Never infer a hidden alien/);
  });

  it('is embedded in getAiBriefingInstructionsMarkdown', () => {
    const md = getAiBriefingInstructionsMarkdown();
    assert.match(md, /Explosive perception \(fair-play\)/);
    assert.match(md, /grenade_throw_observed/);
  });
});