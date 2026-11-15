'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const YAML = require('yaml');
const {
  FACTION_PLAYER,
  FACTION_HOSTILE,
  BT_PSIAMP,
  loadAndValidateSnapshotFromText,
  ValidationError,
} = require('../lib/tactical-publish.cjs');
const {
  parseTacticalCommand,
  parsePsiTacticalCommand,
  isPsiMindControlCommandType,
  isPsiPanicCommandType,
  validatePsiTacticalCommandAgainstSnapshot,
  validatePsiMindControlAgainstSnapshot,
  COMMAND_TYPE_PSI_MIND_CONTROL,
} = require('../lib/tactical-command.cjs');
const {
  buildCommandBinding,
  composePsiMindControlCommand,
} = require('../lib/command-binding.cjs');

const SESSION = 'abcdef0123456789abcdef0123456789';
const SNAPSHOT_SHA = 'e'.repeat(64);

const PSI_AMP_ID = 802;
const HOSTILE_ID = 1_000_043;

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

function tacticalBase(overrides = {}) {
  return {
    schemaVersion: 5,
    turn: 1,
    side: 0,
    selectedUnitId: 1,
    map: { width: 10, height: 10, depth: 1 },
    terrain: {
      memoryNote: 'WP10 psi mind control S1 fixture terrain.',
      tiles: [
        { p: [3, 3, 0], disc: 4, inLos: true, body: { noFloor: false, elev: 0, walkF: 4 } },
        { p: [5, 5, 0], disc: 4, inLos: true, body: { noFloor: false, elev: 0, walkF: 4 } },
      ],
    },
    eventLog: {
      sessionId: SESSION,
      oldestSeq: 0,
      latestSeq: 0,
      droppedCount: 0,
      events: [],
    },
    units: [psiActorUnit(), visibleHostileUnit()],
    ...overrides,
  };
}

function loadTactical(units) {
  const text = YAML.stringify(tacticalBase({ units }));
  return loadAndValidateSnapshotFromText(text, YAML);
}

function bindingFor(tactical) {
  return buildCommandBinding(tactical, SNAPSHOT_SHA);
}

function mindControlDraft(binding, overrides = {}) {
  return {
    ...composePsiMindControlCommand(binding, {
      commandId: 'psi-mc-01',
      actorUnitId: 1,
      targetUnitId: HOSTILE_ID,
      psiAmpBattleItemId: PSI_AMP_ID,
      activeHand: 'STR_LEFT_HAND',
    }),
    ...overrides,
  };
}

describe('M1-WP10 PSI_MIND_CONTROL S1 command contract', () => {
  it('parseTacticalCommand and parsePsiTacticalCommand accept PSI_MIND_CONTROL', () => {
    const raw = {
      schema_version: 1,
      command_id: 'psi-mc-1',
      command_type: COMMAND_TYPE_PSI_MIND_CONTROL,
      actor_unit_id: 1,
      target_unit_id: HOSTILE_ID,
      psi_amp_battle_item_id: PSI_AMP_ID,
      active_hand: 'STR_LEFT_HAND',
      snapshot_sha256: SNAPSHOT_SHA,
      session_id: SESSION,
      turn: 1,
      state_version: 0,
    };
    const parsed = parseTacticalCommand(raw);
    assert.equal(parsed.commandType, COMMAND_TYPE_PSI_MIND_CONTROL);
    assert.equal(parsePsiTacticalCommand(raw).psiAmpBattleItemId, PSI_AMP_ID);
    assert.equal(isPsiMindControlCommandType('PSI_MIND_CONTROL'), true);
    assert.equal(isPsiMindControlCommandType('PSI_PANIC'), false);
    assert.equal(isPsiPanicCommandType('PSI_MIND_CONTROL'), false);
    assert.throws(
      () => parsePsiTacticalCommand({ ...raw, extra_field: true }),
      /unknown command field/,
    );
  });

  it('valid PSI_MIND_CONTROL passes snapshot validation with MC planning hint', () => {
    const tactical = loadTactical([psiActorUnit(), visibleHostileUnit()]);
    const binding = bindingFor(tactical);
    const result = validatePsiMindControlAgainstSnapshot(mindControlDraft(binding), tactical, SNAPSHOT_SHA);
    assert.equal(result.target.id, HOSTILE_ID);
    assert.ok(validatePsiTacticalCommandAgainstSnapshot(mindControlDraft(binding), tactical, SNAPSHOT_SHA).actor);
    assert.match(result.planningHint.note, /engine-authoritative/i);
    assert.match(result.planningHint.note, /non-commandable/i);
  });

  it('rejects stale binding, wrong psi amp id, and wrong hand', () => {
    const tactical = loadTactical([psiActorUnit(), visibleHostileUnit()]);
    const binding = bindingFor(tactical);
    assert.throws(
      () => validatePsiMindControlAgainstSnapshot(mindControlDraft(binding, { state_version: 99 }), tactical, SNAPSHOT_SHA),
      /state_version/,
    );
    assert.throws(
      () => validatePsiMindControlAgainstSnapshot(mindControlDraft(binding, { psi_amp_battle_item_id: 999 }), tactical, SNAPSHOT_SHA),
      /psi_amp_battle_item_id/,
    );
    assert.throws(
      () => validatePsiMindControlAgainstSnapshot(mindControlDraft(binding, { active_hand: 'STR_RIGHT_HAND' }), tactical, SNAPSHOT_SHA),
      /active_hand|no equipment/,
    );
  });

  it('rejects fog-of-war and faction edge targets without alien identity leak', () => {
    const tactical = loadTactical([psiActorUnit(), visibleHostileUnit()]);
    const binding = bindingFor(tactical);
    assert.throws(
      () => validatePsiMindControlAgainstSnapshot(mindControlDraft(binding, { target_unit_id: 999_999 }), tactical, SNAPSHOT_SHA),
      /target_unit_id not in snapshot/,
    );

    const hiddenHostile = loadAndValidateSnapshotFromText(YAML.stringify(tacticalBase({
      units: [psiActorUnit(), visibleHostileUnit({ facing: undefined })],
    })), YAML);
    assert.throws(
      () => validatePsiMindControlAgainstSnapshot(mindControlDraft(bindingFor(hiddenHostile)), hiddenHostile, SNAPSHOT_SHA),
      (err) => err instanceof ValidationError
        && /confirmed current line of sight/.test(err.message)
        && !/sectoid/i.test(err.message),
    );

    const mcAlien = loadAndValidateSnapshotFromText(YAML.stringify(tacticalBase({
      units: [
        psiActorUnit(),
        {
          id: 1_000_001,
          faction: FACTION_PLAYER,
          originalFaction: FACTION_HOSTILE,
          position: [5, 5, 0],
          facing: { direction: 2, vector: { dx: 1, dy: 0 } },
        },
      ],
    })), YAML);
    assert.throws(
      () => validatePsiMindControlAgainstSnapshot(
        mindControlDraft(bindingFor(mcAlien), { target_unit_id: 1_000_001 }),
        mcAlien,
        SNAPSHOT_SHA,
      ),
      (err) => err instanceof ValidationError
        && /mind control/.test(err.message)
        && !/sectoid/i.test(err.message),
    );

    const mcRoster = loadAndValidateSnapshotFromText(YAML.stringify(tacticalBase({
      units: [
        psiActorUnit(),
        {
          id: 3,
          faction: FACTION_HOSTILE,
          originalFaction: FACTION_PLAYER,
          position: [5, 5, 0],
          name: 'Compromised',
          facing: { direction: 2, vector: { dx: 1, dy: 0 } },
        },
      ],
    })), YAML);
    assert.throws(
      () => validatePsiMindControlAgainstSnapshot(
        mindControlDraft(bindingFor(mcRoster), { target_unit_id: 3 }),
        mcRoster,
        SNAPSHOT_SHA,
      ),
      /mind control/,
    );
  });

  it('rejects insufficient TU when exported; allows missing psiSkill and mindcontrol actionCosts with advisory', () => {
    const lowTu = loadTactical([
      psiActorUnit({ actionCosts: mcActionCosts(25, false) }),
      visibleHostileUnit(),
    ]);
    assert.throws(
      () => validatePsiMindControlAgainstSnapshot(mindControlDraft(bindingFor(lowTu)), lowTu, SNAPSHOT_SHA),
      /insufficient TU/,
    );

    const sparse = loadTactical([
      psiActorUnit({ actionCosts: undefined }),
      visibleHostileUnit(),
    ]);
    const result = validatePsiMindControlAgainstSnapshot(mindControlDraft(bindingFor(sparse)), sparse, SNAPSHOT_SHA);
    const notes = (result.planningHint.items || []).map((h) => h.note).join(' ');
    assert.match(notes, /psiSkill not in snapshot/);
    assert.match(notes, /mindcontrol actionCosts not in snapshot/);
  });

  it('rejects zero psiSkill when exported; rejects non-commandable actor readiness', () => {
    const noPsi = loadTactical([psiActorUnit(), visibleHostileUnit()]);
    noPsi.units[0].psiSkill = 0;
    assert.throws(
      () => validatePsiMindControlAgainstSnapshot(mindControlDraft(bindingFor(noPsi)), noPsi, SNAPSHOT_SHA),
      /psiSkill must be positive/,
    );

    const panicking = loadTactical([
      psiActorUnit({
        readiness: {
          summary: 'panicking',
          engineStatus: 'panicking',
          liveRosterSoldier: true,
          engineActingUnitAvailable: false,
          observationNote: 'fixture',
        },
      }),
      visibleHostileUnit(),
    ]);
    assert.throws(
      () => validatePsiMindControlAgainstSnapshot(mindControlDraft(bindingFor(panicking)), panicking, SNAPSHOT_SHA),
      /not command-applicable/,
    );
  });

  it('compose rejects actor not in player_soldiers', () => {
    const tactical = loadTactical([psiActorUnit(), visibleHostileUnit()]);
    const binding = buildCommandBinding(tactical, SNAPSHOT_SHA);
    assert.throws(
      () => composePsiMindControlCommand(binding, {
        commandId: 'bad',
        actorUnitId: 99,
        targetUnitId: HOSTILE_ID,
        psiAmpBattleItemId: PSI_AMP_ID,
        activeHand: 'STR_LEFT_HAND',
      }),
      /player_soldier/,
    );
  });
});