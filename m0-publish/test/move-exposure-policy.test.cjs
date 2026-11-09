'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  MOVE_EXPOSURE_POLICY_RULES,
  getMoveExposurePolicyMarkdown,
} = require('../lib/move-exposure-policy.cjs');
const { getAiBriefingInstructionsMarkdown } = require('../lib/tactical-briefing-ai-workflow.cjs');
const { getMoveResultContractMarkdown } = require('../lib/move-result-consumer.cjs');

describe('P1-REACTION-RISK-02C/02D move exposure policy', () => {
  it('embeds exposure policy in generated AI briefing', () => {
    const md = getAiBriefingInstructionsMarkdown();
    const exposure = getMoveExposurePolicyMarkdown();
    assert.ok(md.includes(exposure.slice(0, 80)), 'briefing should include exposure markdown body');
    assert.match(md, /KNOWN THREAT/);
    assert.match(md, /POSSIBLE THREAT/);
    assert.match(md, /UNKNOWN EXPOSURE/);
    assert.match(md, /last_seen/);
    assert.match(md, /reaction_fire/);
    assert.match(md, /not confirmed hit/i);
    assert.match(md, /Pre-MOVE exposure and reaction fire/);
    assert.match(md, /runMandatoryPostCommandPrelude/);
    assert.match(md, /staged MOVE/i);
    assert.match(md, /aggressive|mission-critical/i);
    assert.match(md, /neutrals/i);
    assert.match(md, /confirmed_current_los/);
    assert.match(md, /movement_incomplete/);
    assert.match(md, /not confirmed battlefield events/i);
  });

  it('keeps MOVE result and FIRE-adjacent workflow sections intact', () => {
    const md = getAiBriefingInstructionsMarkdown();
    const moveContract = getMoveResultContractMarkdown();
    assert.ok(md.includes(moveContract.slice(0, 60)), 'MOVE result contract still embedded');
    assert.match(md, /Mandatory MOVE result verification/);
    assert.match(md, /Hostile intelligence fair-play/);
    assert.match(md, /commandBinding/);
    assert.doesNotMatch(md, /danger score/i);
    assert.doesNotMatch(md, /threat score/i);
  });

  it('02D strategic context in briefing without score/casualty maximization mandate', () => {
    const md = getAiBriefingInstructionsMarkdown();
    assert.match(md, /Strategic context/i);
    assert.match(md, /campaign/i);
    assert.match(md, /not always.*primary goals|not universal objectives/i);
    assert.match(md, /human-controlled|AI-owned/i);
    assert.doesNotMatch(md, /maximize mission score/i);
    assert.match(md, /do not invent.*funding/i);
    const ids = new Set(MOVE_EXPOSURE_POLICY_RULES.map((r) => r.id));
    assert.ok(ids.has('strategic_not_tactical_only'));
    assert.ok(ids.has('strategic_context_factors'));
    assert.ok(ids.has('deliberate_risk'));
  });

  it('policy rules cover required regression concepts', () => {
    const ids = new Set(MOVE_EXPOSURE_POLICY_RULES.map((r) => r.id));
    const required = [
      'exposure_before_move',
      'known_vs_possible_vs_unknown',
      'no_last_seen_as_live',
      'neutrals_not_hostile',
      'reaction_fire_mechanics',
      'no_hidden_stats',
      'staged_move_preference',
      'aggressive_allowed',
      'post_interrupt',
      'incomplete_not_event',
      'strategic_not_tactical_only',
      'strategic_context_factors',
      'deliberate_risk',
    ];
    for (const id of required) {
      assert.ok(ids.has(id), `missing rule id ${id}`);
    }
    const exposure = getMoveExposurePolicyMarkdown();
    assert.match(exposure, /known_hostile_near_route/);
    assert.match(exposure, /uncertain_open_ground/);
    assert.match(exposure, /emergency_skyranger/);
  });
});
