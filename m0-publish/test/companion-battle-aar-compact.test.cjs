'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  projectBattleAarForRelay,
  validateCompactBattleAar,
  COMPACT_TYPE,
} = require('../lib/battle-aar-compact-project.cjs');

const FIXTURE = path.join(__dirname, 'fixtures', 'minimal-battle-aar-finalized.json');

describe('battle AAR compact projection', () => {
  it('mirrors debrief outcome and personnel without tactical payloads', () => {
    const full = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    const compact = projectBattleAarForRelay(full);
    validateCompactBattleAar(compact);

    assert.equal(compact.type, COMPACT_TYPE);
    assert.equal(compact.outcome.score, full.outcome.score);
    assert.equal(compact.outcome.rating, full.outcome.rating);
    assert.deepEqual(compact.outcome.score_breakdown, full.outcome.score_breakdown);
    assert.equal(compact.debrief.wounded[0].recovery_days, 5);
    assert.equal(compact.debrief.promotions[0].rank_after, 'RANK_SERGEANT');
    assert.equal(compact.debrief.commendations[0].decoration_level, 1);
    assert.equal('tactical_terminal' in compact, false);
    assert.equal('mission_summary' in compact, false);
    assert.equal(JSON.stringify(compact).includes('terminal_payload'), false);
    assert.equal(JSON.stringify(compact).includes('engine_kills'), false);
  });

  it('omits zero-quantity score rows absent from the debrief screen', () => {
    const full = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    full.outcome.score_breakdown = [
      ...full.outcome.score_breakdown,
      { line_id: 'STR_CIVILIANS_SAVED', quantity: 0, points: 0, recovery: false },
    ];
    const compact = projectBattleAarForRelay(full);
    assert.equal(compact.outcome.score_breakdown.length, 2);
    assert.equal(compact.outcome.score, full.outcome.score);
  });

  it('derives lost in service with career kills when explicit block absent', () => {
    const full = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    delete full.post_debrief.lost_in_service;
    full.post_debrief.soldiers.push({
      display_name: 'Fallen Operative',
      rank: 'RANK_CAPTAIN',
      kia: true,
      mia: false,
      career_kills: 42,
      wound_recovery_days: 0,
    });
    const compact = projectBattleAarForRelay(full);
    assert.equal(compact.debrief.lost_in_service.length, 1);
    assert.equal(compact.debrief.lost_in_service[0].career_kills, 42);
    assert.equal(compact.debrief.lost_in_service[0].display_name, 'Fallen Operative');
  });

  it('rejects compact payloads that would leak tactical fields', () => {
    const bad = {
      schema_version: 1,
      type: COMPACT_TYPE,
      status: 'finalized',
      outcome: { score: 0, rating: 'STR_RATING_OK', score_breakdown: [] },
      debrief: {
        lost_in_service: [],
        promotions: [],
        wounded: [],
        commendations: [],
        stat_increases: [],
        tactical_terminal: {},
      },
    };
    assert.throws(() => validateCompactBattleAar(bad), /tactical/);
  });
});