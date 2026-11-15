'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { FACTION_HOSTILE, ValidationError } = require('../lib/tactical-publish.cjs');
const {
  parseTacticalCommand,
  validateTacticalCommandAgainstSnapshot,
} = require('../lib/tactical-command.cjs');
const {
  SNAPSHOT_SHA,
  MEDIKIT_ID,
  TARGET_ID,
  medkitActorUnit,
  woundedTargetUnit,
  loadMedikitTactical,
} = require('./helpers/medikit-wp9-fixture.cjs');

function healDraft(overrides = {}) {
  return {
    schema_version: 1,
    command_id: 'heal-s3-1',
    command_type: 'HEAL',
    actor_unit_id: 1,
    target_unit_id: TARGET_ID,
    medikit_battle_item_id: MEDIKIT_ID,
    active_hand: 'STR_RIGHT_HAND',
    body_part: 1,
    snapshot_sha256: SNAPSHOT_SHA,
    session_id: 'abcdef0123456789abcdef0123456789',
    turn: 1,
    state_version: 0,
    ...overrides,
  };
}

describe('M1-WP9 medikit S3 relay integration (Node)', () => {
  it('production parse + validate accepts HEAL with friendly roster target', () => {
    const tactical = loadMedikitTactical([medkitActorUnit(), woundedTargetUnit()]);
    const raw = healDraft();
    const parsed = parseTacticalCommand(raw);
    assert.equal(parsed.targetUnitId, TARGET_ID);
    const verdict = validateTacticalCommandAgainstSnapshot(raw, tactical, SNAPSHOT_SHA);
    assert.equal(verdict.target.id, TARGET_ID);
  });

  it('rejects hostile target via validateTacticalCommandAgainstSnapshot', () => {
    const tactical = loadMedikitTactical([
      medkitActorUnit(),
      {
        id: 1_000_100,
        faction: FACTION_HOSTILE,
        originalFaction: FACTION_HOSTILE,
        position: [2, 2, 0],
        kneeled: false,
        facing: { direction: 2, vector: { dx: 1, dy: 0 } },
      },
    ]);
    assert.throws(
      () => validateTacticalCommandAgainstSnapshot(
        healDraft({ target_unit_id: 1_000_100 }),
        tactical,
        SNAPSHOT_SHA,
      ),
      (err) => err instanceof ValidationError && /friendly roster/.test(err.message),
    );
  });

  it('rejects stale binding and depleted heal charge', () => {
    const tactical = loadMedikitTactical([medkitActorUnit(), woundedTargetUnit()]);
    assert.throws(
      () => validateTacticalCommandAgainstSnapshot(healDraft({ state_version: 99 }), tactical, SNAPSHOT_SHA),
      ValidationError,
    );
    const depletedMedic = medkitActorUnit({
      hands: {
        right: {
          ...medkitActorUnit().hands.right,
          medikitCharges: { heal: 0, painKiller: 1, stimulant: 1 },
        },
        left: null,
      },
    });
    const depletedTac = loadMedikitTactical([depletedMedic, woundedTargetUnit()]);
    assert.throws(
      () => validateTacticalCommandAgainstSnapshot(healDraft(), depletedTac, SNAPSHOT_SHA),
      /charge depleted/,
    );
  });
});