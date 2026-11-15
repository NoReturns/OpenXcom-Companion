'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const YAML = require('yaml');
const {
  FACTION_PLAYER,
  FACTION_HOSTILE,
  BT_MEDIKIT,
  loadAndValidateSnapshotFromText,
  ValidationError,
} = require('../lib/tactical-publish.cjs');
const {
  parseTacticalCommand,
  parseMedikitTacticalCommand,
  isMedikitCommandType,
  validateMedikitTacticalCommandAgainstSnapshot,
  validateHealAgainstSnapshot,
  COMMAND_TYPE_HEAL,
} = require('../lib/tactical-command.cjs');
const {
  buildCommandBinding,
  composeHealCommand,
  composeStimulantCommand,
  composePainKillerCommand,
} = require('../lib/command-binding.cjs');

const SESSION = 'abcdef0123456789abcdef0123456789';
const SNAPSHOT_SHA = 'c'.repeat(64);

const MEDIKIT_ID = 701;
const TARGET_ID = 2;

function tacticalBase(overrides = {}) {
  return {
    schemaVersion: 5,
    turn: 1,
    side: 0,
    selectedUnitId: 1,
    map: { width: 10, height: 10, depth: 1 },
    terrain: {
      memoryNote: 'WP9 medikit S1 fixture terrain.',
      tiles: [
        { p: [1, 1, 0], disc: 4, inLos: true, body: { noFloor: false, elev: 0, walkF: 4 } },
        { p: [1, 2, 0], disc: 4, inLos: true, body: { noFloor: false, elev: 0, walkF: 4 } },
      ],
    },
    eventLog: {
      sessionId: SESSION,
      oldestSeq: 0,
      latestSeq: 0,
      droppedCount: 0,
      events: [],
    },
    units: [
      medkitActorUnit(),
      woundedTargetUnit(),
    ],
    ...overrides,
  };
}

function medikitActionCosts(tuCost = 10, canAffordTu = true) {
  return {
    posture: { kneelDownTu: 4, standUpTu: 8 },
    hands: {
      right: {
        itemType: 'STR_MEDI_KIT',
        actions: [{
          id: 'use',
          actionType: 9,
          tuCost,
          canAffordTu,
          usable: true,
        }],
      },
      left: { actions: [] },
    },
  };
}

function medkitActorUnit(overrides = {}) {
  return {
    id: 1,
    faction: FACTION_PLAYER,
    originalFaction: FACTION_PLAYER,
    position: [1, 1, 0],
    name: 'Medic',
    health: 45,
    timeUnits: 50,
    kneeled: false,
    activeHand: 'STR_RIGHT_HAND',
    hands: {
      right: {
        battleItemId: MEDIKIT_ID,
        itemType: 'STR_MEDI_KIT',
        battleType: BT_MEDIKIT,
        slot: 'STR_RIGHT_HAND',
        medikitCharges: { heal: 2, painKiller: 2, stimulant: 1 },
      },
      left: null,
    },
    inventory: [],
    actionCosts: medikitActionCosts(),
    facing: { direction: 4, vector: { dx: 0, dy: 1 } },
    condition: {
      energy: 40,
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
    fatalWounds: [0, 0, 0, 0, 0, 0],
    ...overrides,
  };
}

function woundedTargetUnit(overrides = {}) {
  return {
    id: TARGET_ID,
    faction: FACTION_PLAYER,
    originalFaction: FACTION_PLAYER,
    position: [1, 2, 0],
    name: 'Patient',
    health: 20,
    timeUnits: 0,
    kneeled: false,
    activeHand: 'STR_RIGHT_HAND',
    hands: { right: null, left: null },
    inventory: [],
    facing: { direction: 0, vector: { dx: 0, dy: -1 } },
    condition: {
      energy: 10,
      maxEnergy: 60,
      maxHealth: 60,
      morale: 40,
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
      engineActingUnitAvailable: false,
      observationNote: 'fixture',
    },
    fatalWounds: [1, 0, 0, 0, 0, 0],
    ...overrides,
  };
}

function loadTactical(rawUnits) {
  const text = YAML.stringify(tacticalBase({ units: rawUnits }));
  return loadAndValidateSnapshotFromText(text, YAML);
}

function bindingFor(tactical) {
  return buildCommandBinding(tactical, SNAPSHOT_SHA);
}

function healDraft(binding, overrides = {}) {
  return {
    ...composeHealCommand(binding, {
      commandId: 'heal-01',
      actorUnitId: 1,
      targetUnitId: TARGET_ID,
      medikitBattleItemId: MEDIKIT_ID,
      activeHand: 'STR_RIGHT_HAND',
      bodyPart: 0,
    }),
    ...overrides,
  };
}

describe('M1-WP9 medikit S1 command contract', () => {
  it('parseTacticalCommand accepts medikit types on the production relay path', () => {
    const heal = parseTacticalCommand({
      schema_version: 1,
      command_id: 'h-relay-1',
      command_type: COMMAND_TYPE_HEAL,
      actor_unit_id: 1,
      target_unit_id: TARGET_ID,
      medikit_battle_item_id: MEDIKIT_ID,
      active_hand: 'STR_RIGHT_HAND',
      body_part: 1,
      snapshot_sha256: SNAPSHOT_SHA,
      session_id: SESSION,
      turn: 1,
      state_version: 0,
    });
    assert.equal(heal.commandType, COMMAND_TYPE_HEAL);
    assert.equal(isMedikitCommandType('HEAL'), true);
    assert.equal(isMedikitCommandType('MOVE'), false);
  });

  it('parseMedikitTacticalCommand accepts the three atomic types', () => {
    const heal = {
      schema_version: 1,
      command_id: 'h1',
      command_type: 'HEAL',
      actor_unit_id: 1,
      target_unit_id: 2,
      medikit_battle_item_id: MEDIKIT_ID,
      active_hand: 'STR_RIGHT_HAND',
      body_part: 3,
      snapshot_sha256: SNAPSHOT_SHA,
      session_id: SESSION,
      turn: 1,
      state_version: 0,
    };
    const parsed = parseMedikitTacticalCommand(heal);
    assert.equal(parsed.bodyPart, 3);
    assert.throws(
      () => parseMedikitTacticalCommand({ ...heal, unknown_field: true }),
      /unknown command field/,
    );
    assert.throws(
      () => parseMedikitTacticalCommand({ ...heal, body_part: 6 }),
      /body_part/,
    );
  });

  it('valid HEAL/STIMULANT/PAINKILLER pass snapshot validation', () => {
    const tactical = loadTactical([medkitActorUnit(), woundedTargetUnit()]);
    const binding = bindingFor(tactical);
    const heal = healDraft(binding);
    const stim = composeStimulantCommand(binding, {
      commandId: 'stim-01',
      actorUnitId: 1,
      targetUnitId: TARGET_ID,
      medikitBattleItemId: MEDIKIT_ID,
      activeHand: 'STR_RIGHT_HAND',
    });
    const pk = composePainKillerCommand(binding, {
      commandId: 'pk-01',
      actorUnitId: 1,
      targetUnitId: TARGET_ID,
      medikitBattleItemId: MEDIKIT_ID,
      activeHand: 'STR_RIGHT_HAND',
    });
    assert.equal(validateHealAgainstSnapshot(heal, tactical, SNAPSHOT_SHA).target.id, TARGET_ID);
    assert.ok(validateMedikitTacticalCommandAgainstSnapshot(stim, tactical, SNAPSHOT_SHA).actor);
    assert.ok(validateMedikitTacticalCommandAgainstSnapshot(pk, tactical, SNAPSHOT_SHA).planningHint);
  });

  it('rejects wrong medikit id, wrong hand, and stale binding', () => {
    const tactical = loadTactical([medkitActorUnit(), woundedTargetUnit()]);
    const binding = bindingFor(tactical);
    assert.throws(
      () => validateHealAgainstSnapshot(
        healDraft(binding, { medikit_battle_item_id: 999 }),
        tactical,
        SNAPSHOT_SHA,
      ),
      /medikit_battle_item_id/,
    );
    assert.throws(
      () => validateHealAgainstSnapshot(
        healDraft(binding, { active_hand: 'STR_LEFT_HAND' }),
        tactical,
        SNAPSHOT_SHA,
      ),
      /active_hand/,
    );
    assert.throws(
      () => validateHealAgainstSnapshot(healDraft(binding, { state_version: 99 }), tactical, SNAPSHOT_SHA),
      /state_version/,
    );
  });

  it('rejects depleted charges and insufficient TU when export shows them', () => {
    const tactical = loadTactical([
      medkitActorUnit({
        hands: {
          right: {
            battleItemId: MEDIKIT_ID,
            itemType: 'STR_MEDI_KIT',
            battleType: BT_MEDIKIT,
            slot: 'STR_RIGHT_HAND',
            medikitCharges: { heal: 0, painKiller: 1, stimulant: 1 },
          },
          left: null,
        },
      }),
      woundedTargetUnit(),
    ]);
    const heal = healDraft(bindingFor(tactical));
    assert.throws(
      () => validateHealAgainstSnapshot(heal, tactical, SNAPSHOT_SHA),
      /charge depleted/,
    );

    const lowTu = loadTactical([
      medkitActorUnit({ actionCosts: medikitActionCosts(10, false) }),
      woundedTargetUnit(),
    ]);
    assert.throws(
      () => validateHealAgainstSnapshot(healDraft(bindingFor(lowTu)), lowTu, SNAPSHOT_SHA),
      /insufficient TU/,
    );
  });

  it('rejects invalid targets without hostile wound leak', () => {
    const tactical = loadTactical([medkitActorUnit(), woundedTargetUnit()]);
    const binding = bindingFor(tactical);
    assert.throws(
      () => validateHealAgainstSnapshot(healDraft(binding, { target_unit_id: 999 }), tactical, SNAPSHOT_SHA),
      /target_unit_id not in snapshot/,
    );

    const tacticalHostile = loadAndValidateSnapshotFromText(YAML.stringify(tacticalBase({
      units: [
        medkitActorUnit(),
        {
          id: 1_000_100,
          faction: FACTION_HOSTILE,
          originalFaction: FACTION_HOSTILE,
          position: [2, 2, 0],
          kneeled: false,
          facing: { direction: 2, vector: { dx: 1, dy: 0 } },
        },
      ],
    })), YAML);
    const cmd = healDraft(bindingFor(tacticalHostile), { target_unit_id: 1_000_100 });
    assert.throws(
      () => validateHealAgainstSnapshot(cmd, tacticalHostile, SNAPSHOT_SHA),
      (err) => err instanceof ValidationError
        && /friendly roster soldier/.test(err.message)
        && !/sectoid/i.test(err.message),
    );
  });

  it('allows missing S0 fields with advisory; HEAL no-op wound emits advisory not hard reject', () => {
    const tactical = loadTactical([
      medkitActorUnit({
        actionCosts: undefined,
        hands: {
          right: {
            battleItemId: MEDIKIT_ID,
            itemType: 'STR_MEDI_KIT',
            battleType: BT_MEDIKIT,
            slot: 'STR_RIGHT_HAND',
          },
          left: null,
        },
      }),
      woundedTargetUnit({ fatalWounds: [0, 0, 0, 0, 0, 0] }),
    ]);
    const result = validateHealAgainstSnapshot(
      healDraft(bindingFor(tactical), { body_part: 2 }),
      tactical,
      SNAPSHOT_SHA,
    );
    const items = result.planningHint.items || [];
    assert.ok(items.some((h) => h.code === 'heal_no_fatal_wound_on_part'));
    assert.ok(items.some((h) => h.note && /actionCosts not in snapshot/.test(h.note)));
  });

  it('compose rejects actor not in player_soldiers', () => {
    const tactical = loadTactical([medkitActorUnit(), woundedTargetUnit()]);
    const binding = buildCommandBinding(tactical, SNAPSHOT_SHA);
    assert.throws(
      () => composeHealCommand(binding, {
        commandId: 'heal-bad',
        actorUnitId: 3,
        targetUnitId: TARGET_ID,
        medikitBattleItemId: MEDIKIT_ID,
        activeHand: 'STR_RIGHT_HAND',
        bodyPart: 0,
      }),
      /player_soldier/,
    );
  });
});