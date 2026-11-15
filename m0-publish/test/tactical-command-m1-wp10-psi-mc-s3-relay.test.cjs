'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const YAML = require('yaml');
const { FACTION_PLAYER, FACTION_HOSTILE, BT_PSIAMP, loadAndValidateSnapshotFromText, ValidationError } = require('../lib/tactical-publish.cjs');
const {
  parseTacticalCommand,
  validatePsiTacticalCommandAgainstSnapshot,
} = require('../lib/tactical-command.cjs');
const { buildCommandBinding, composePsiMindControlCommand } = require('../lib/command-binding.cjs');

const SESSION = 'abcdef0123456789abcdef0123456789';
const SNAPSHOT_SHA = 'f'.repeat(64);
const PSI_AMP_ID = 803;
const HOSTILE_ID = 1_000_044;

function tacticalBase(overrides = {}) {
  return {
    schemaVersion: 5,
    turn: 1,
    side: 0,
    selectedUnitId: 1,
    map: { width: 10, height: 10, depth: 1 },
    terrain: {
      memoryNote: 'WP10 MC S3 relay fixture terrain.',
      tiles: [
        { p: [3, 3, 0], disc: 4, inLos: true, body: { noFloor: false, elev: 0, walkF: 4 } },
        { p: [5, 5, 0], disc: 4, inLos: true, body: { noFloor: false, elev: 0, walkF: 4 } },
      ],
    },
    eventLog: { sessionId: SESSION, oldestSeq: 0, latestSeq: 0, droppedCount: 0, events: [] },
    units: [],
    ...overrides,
  };
}

function mcActionCosts(tuCost = 25, canAffordTu = true) {
  return {
    posture: { kneelDownTu: 4, standUpTu: 8 },
    hands: {
      left: {
        itemType: 'STR_PSI_AMP',
        actions: [{
          id: 'mindcontrol',
          actionType: 11,
          tuCost,
          canAffordTu,
          usable: true,
        }],
      },
      right: { actions: [] },
    },
  };
}

function psiActorUnit(overrides = {}) {
  return {
    id: 1,
    faction: FACTION_PLAYER,
    originalFaction: FACTION_PLAYER,
    position: [3, 3, 0],
    name: 'Psi Soldier',
    health: 50,
    timeUnits: 60,
    psiSkill: 60,
    kneeled: false,
    activeHand: 'STR_LEFT_HAND',
    hands: {
      left: {
        battleItemId: PSI_AMP_ID,
        itemType: 'STR_PSI_AMP',
        battleType: BT_PSIAMP,
        slot: 'STR_LEFT_HAND',
      },
      right: null,
    },
    inventory: [],
    actionCosts: mcActionCosts(),
    facing: { direction: 2, vector: { dx: 1, dy: 0 } },
    condition: {
      energy: 50,
      maxEnergy: 60,
      maxHealth: 60,
      morale: 80,
      stunLevel: 0,
      alive: true,
      conscious: true,
      engineStatus: 'standing',
      engineStatusId: 0,
      floating: false,
      movementTypeId: 0,
      movementType: 'walk',
    },
    readiness: {
      summary: 'ready_to_act',
      engineStatus: 'standing',
      liveRosterSoldier: true,
      engineActingUnitAvailable: true,
      observationNote: 'fixture',
    },
    ...overrides,
  };
}

function visibleHostileUnit(overrides = {}) {
  return {
    id: HOSTILE_ID,
    faction: FACTION_HOSTILE,
    originalFaction: FACTION_HOSTILE,
    position: [5, 5, 0],
    kneeled: false,
    facing: { direction: 6, vector: { dx: -1, dy: 0 } },
    ...overrides,
  };
}

function loadTactical(units) {
  return loadAndValidateSnapshotFromText(YAML.stringify(tacticalBase({ units })), YAML);
}

function mindControlDraft(binding, overrides = {}) {
  return {
    ...composePsiMindControlCommand(binding, {
      commandId: 'psi-mc-s3-01',
      actorUnitId: 1,
      targetUnitId: HOSTILE_ID,
      psiAmpBattleItemId: PSI_AMP_ID,
      activeHand: 'STR_LEFT_HAND',
    }),
    ...overrides,
  };
}

describe('M1-WP10 PSI_MIND_CONTROL S3 relay integration (Node)', () => {
  it('production parse + validate accepts mind control against visible hostile', () => {
    const tactical = loadTactical([psiActorUnit(), visibleHostileUnit()]);
    const binding = buildCommandBinding(tactical, SNAPSHOT_SHA);
    const raw = mindControlDraft(binding);
    const parsed = parseTacticalCommand(raw);
    assert.equal(parsed.commandType, 'PSI_MIND_CONTROL');
    const verdict = validatePsiTacticalCommandAgainstSnapshot(raw, tactical, SNAPSHOT_SHA);
    assert.equal(verdict.target.id, HOSTILE_ID);
    assert.match(verdict.planningHint.note, /non-commandable/i);
  });

  it('rejects hidden hostile without confirmed LOS', () => {
    const hidden = visibleHostileUnit();
    delete hidden.facing;
    const tactical = loadTactical([psiActorUnit(), hidden]);
    const binding = buildCommandBinding(tactical, SNAPSHOT_SHA);
    assert.throws(
      () => validatePsiTacticalCommandAgainstSnapshot(mindControlDraft(binding), tactical, SNAPSHOT_SHA),
      ValidationError,
    );
  });

  it('rejects stale binding and insufficient TU when exported', () => {
    const tactical = loadTactical([psiActorUnit(), visibleHostileUnit()]);
    const binding = buildCommandBinding(tactical, SNAPSHOT_SHA);
    assert.throws(
      () => validatePsiTacticalCommandAgainstSnapshot(
        mindControlDraft(binding, { state_version: 99 }),
        tactical,
        SNAPSHOT_SHA,
      ),
      ValidationError,
    );
    const lowTu = loadTactical([
      psiActorUnit({
        timeUnits: 10,
        actionCosts: mcActionCosts(25, false),
      }),
      visibleHostileUnit(),
    ]);
    const lowBinding = buildCommandBinding(lowTu, SNAPSHOT_SHA);
    assert.throws(
      () => validatePsiTacticalCommandAgainstSnapshot(mindControlDraft(lowBinding), lowTu, SNAPSHOT_SHA),
      /insufficient TU/i,
    );
  });

  it('rejects already mind-controlled hostile target at Node advisory layer', () => {
    const tactical = loadTactical([
      psiActorUnit(),
      {
        id: 1_000_001,
        faction: FACTION_PLAYER,
        originalFaction: FACTION_HOSTILE,
        position: [5, 5, 0],
        facing: { direction: 2, vector: { dx: 1, dy: 0 } },
      },
    ]);
    const binding = buildCommandBinding(tactical, SNAPSHOT_SHA);
    assert.throws(
      () => validatePsiTacticalCommandAgainstSnapshot(
        mindControlDraft(binding, { target_unit_id: 1_000_001 }),
        tactical,
        SNAPSHOT_SHA,
      ),
      /mind control/,
    );
  });
});