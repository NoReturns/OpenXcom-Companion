'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  COMMAND_TYPE_PRIME,
  COMMAND_TYPE_THROW,
  parsePrimeCommand,
  parseThrowCommand,
  parseTacticalCommand,
  validatePrimeAgainstSnapshot,
  validateThrowAgainstSnapshot,
  buildGrenadePlanningHint,
  ValidationError,
} = require('../lib/tactical-command.cjs');
const {
  composePrimeCommand,
  composeThrowCommand,
  buildCommandBinding,
} = require('../lib/command-binding.cjs');

const tacticalFixture = {
  turn: 2,
  side: 0,
  map: { width: 50, height: 50, depth: 4 },
  selectedUnitId: 101,
  eventLog: { sessionId: 'a'.repeat(32), latestSeq: 17 },
  units: [{
    id: 101,
    faction: 0,
    originalFaction: 0,
    timeUnits: 60,
    hands: {
      right: { itemType: 'STR_GRENADE', battleType: 4, primed: false },
    },
    actionCosts: {
      hands: {
        right: {
          actions: [
            { id: 'prime', tuCost: 15, usable: true, canAffordTu: true },
            { id: 'throw', tuCost: 25, usable: true, canAffordTu: true },
            { id: 'snap', tuCost: 35, usable: true, canAffordTu: true },
          ],
        },
      },
    },
  }],
};

const snapshotSha = 'b'.repeat(64);

function primeBase(overrides = {}) {
  return {
    schema_version: 1,
    command_id: 'prime-wp4-1',
    command_type: COMMAND_TYPE_PRIME,
    actor_unit_id: 101,
    active_hand: 'STR_RIGHT_HAND',
    fuse_timer: 3,
    snapshot_sha256: snapshotSha,
    session_id: tacticalFixture.eventLog.sessionId,
    turn: 2,
    state_version: 17,
    ...overrides,
  };
}

describe('M1-WP4 PRIME and THROW schema', () => {
  it('parses PRIME and THROW contracts', () => {
    const prime = primeBase();
    assert.equal(parsePrimeCommand(prime).commandType, COMMAND_TYPE_PRIME);
    assert.equal(parseTacticalCommand(prime).fuseTimer, 3);

    const thr = {
      ...prime,
      command_id: 'throw-wp4-1',
      command_type: COMMAND_TYPE_THROW,
      target: { x: 10, y: 11, z: 0 },
    };
    delete thr.fuse_timer;
    assert.equal(parseThrowCommand(thr).commandType, COMMAND_TYPE_THROW);
  });

  it('rejects missing fuse_timer and invalid fuse for proximity type', () => {
    assert.throws(() => parsePrimeCommand({ ...primeBase(), fuse_timer: undefined }), ValidationError);
    const proxTactical = {
      ...tacticalFixture,
      units: [{
        ...tacticalFixture.units[0],
        hands: { right: { itemType: 'STR_PROXIMITY_GRENADE', battleType: 5, primed: false } },
      }],
    };
    assert.throws(
      () => validatePrimeAgainstSnapshot(primeBase({ fuse_timer: 2 }), proxTactical, snapshotSha),
      ValidationError,
    );
  });

  it('validates snapshot-bound PRIME and THROW', () => {
    validatePrimeAgainstSnapshot(primeBase(), tacticalFixture, snapshotSha);
    const { fuse_timer: _omit, ...primeFields } = primeBase();
    validateThrowAgainstSnapshot({
      ...primeFields,
      command_id: 'throw-1',
      command_type: COMMAND_TYPE_THROW,
      target: { x: 10, y: 10, z: 0 },
    }, tacticalFixture, snapshotSha);
  });

  it('composePrimeCommand and composeThrowCommand match binding', () => {
    const binding = buildCommandBinding(tacticalFixture, snapshotSha);
    const prime = composePrimeCommand(binding, {
      commandId: 'c-prime',
      actorUnitId: 101,
      activeHand: 'STR_RIGHT_HAND',
      fuseTimer: 0,
    });
    assert.equal(prime.command_type, 'PRIME');
    assert.equal(prime.fuse_timer, 0);

    const thr = composeThrowCommand(binding, {
      commandId: 'c-throw',
      actorUnitId: 101,
      activeHand: 'STR_RIGHT_HAND',
      target: { x: 5, y: 6, z: 0 },
    });
    assert.equal(thr.command_type, 'THROW');
  });

  it('buildGrenadePlanningHint estimates combined TU', () => {
    const hint = buildGrenadePlanningHint(tacticalFixture.units[0], 'STR_RIGHT_HAND');
    assert.equal(hint.advisory, true);
    assert.equal(hint.combinedTuCostEstimate, 40);
    assert.equal(hint.alreadyPrimed, false);
  });

  it('post-prime hand export shape validates through tactical-publish', () => {
    const { validateEquipmentItem } = require('../lib/tactical-publish.cjs');
    const primedHand = validateEquipmentItem({
      itemType: 'STR_GRENADE',
      battleType: 4,
      primed: true,
      fuseTimer: 3,
    }, 'hands.right');
    assert.equal(primedHand.fuseTimer, 3);
  });
});
