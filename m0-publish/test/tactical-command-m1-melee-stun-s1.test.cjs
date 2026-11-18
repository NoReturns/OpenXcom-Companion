'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const YAML = require('yaml');
const {
  FACTION_PLAYER,
  FACTION_HOSTILE,
  BT_MELEE,
  BT_MEDIKIT,
  BT_PSIAMP,
  loadAndValidateSnapshotFromText,
  ValidationError,
} = require('../lib/tactical-publish.cjs');
const {
  parseTacticalCommand,
  parseMeleeTacticalCommand,
  isMeleeTacticalCommandType,
  validateMeleeAgainstSnapshot,
  validateMeleeTacticalCommandAgainstSnapshot,
  validateTacticalCommandAgainstSnapshot,
  COMMAND_TYPE_MELEE_ATTACK,
  parseHealCommand,
  parsePsiPanicCommand,
  parseSnapShotCommand,
} = require('../lib/tactical-command.cjs');
const {
  buildCommandBinding,
  composeMeleeAttackCommand,
} = require('../lib/command-binding.cjs');

const SESSION = 'abcdef0123456789abcdef0123456789';
const SNAPSHOT_SHA = 'e'.repeat(64);

const STUN_ROD_ID = 515;
const KNIFE_ID = 516;
const HOSTILE_ID = 1_000_042;

function meleeActionCosts(tuCost = 18, canAffordTu = true, handItemType = 'STR_STUN_ROD', handSide = 'right') {
  const primary = handSide === 'left' ? 'left' : 'right';
  const secondary = primary === 'left' ? 'right' : 'left';
  return {
    posture: { kneelDownTu: 4, standUpTu: 8 },
    hands: {
      [primary]: {
        itemType: handItemType,
        actions: [{
          id: 'melee',
          actionType: 8,
          tuCost,
          canAffordTu,
          usable: true,
        }],
      },
      [secondary]: { actions: [] },
    },
  };
}

function meleeActorUnit(overrides = {}) {
  const handWeapon = {
    battleItemId: STUN_ROD_ID,
    itemType: 'STR_STUN_ROD',
    battleType: BT_MELEE,
    slot: 'STR_RIGHT_HAND',
    ...(overrides.handWeapon || {}),
  };
  const {
    handWeapon: _hw,
    actionCosts: acOverride,
    handsExtra: _handsExtra,
    ...rest
  } = overrides;
  return {
    id: 1,
    faction: FACTION_PLAYER,
    originalFaction: FACTION_PLAYER,
    position: [3, 3, 0],
    name: 'Stunner',
    health: 50,
    timeUnits: 60,
    kneeled: false,
    activeHand: 'STR_RIGHT_HAND',
    hands: {
      right: handWeapon,
      left: null,
      ...(overrides.handsExtra || {}),
    },
    inventory: [],
    actionCosts: Object.prototype.hasOwnProperty.call(overrides, 'actionCosts')
      ? acOverride
      : meleeActionCosts(),
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
    ...rest,
  };
}

function genericMeleeActor() {
  return {
    ...meleeActorUnit(),
    activeHand: 'STR_LEFT_HAND',
    hands: {
      right: null,
      left: {
        battleItemId: KNIFE_ID,
        itemType: 'STR_COMBAT_KNIFE',
        battleType: BT_MELEE,
        slot: 'STR_LEFT_HAND',
      },
    },
    actionCosts: meleeActionCosts(15, true, 'STR_COMBAT_KNIFE', 'left'),
  };
}

function visibleHostileUnit(overrides = {}) {
  return {
    id: HOSTILE_ID,
    faction: FACTION_HOSTILE,
    originalFaction: FACTION_HOSTILE,
    position: [4, 3, 0],
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
      memoryNote: 'Melee S1 fixture terrain.',
      tiles: [
        { p: [3, 3, 0], disc: 4, inLos: true, body: { noFloor: false, elev: 0, walkF: 4 } },
        { p: [4, 3, 0], disc: 4, inLos: true, body: { noFloor: false, elev: 0, walkF: 4 } },
        { p: [6, 6, 0], disc: 4, inLos: true, body: { noFloor: false, elev: 0, walkF: 4 } },
      ],
    },
    eventLog: {
      sessionId: SESSION,
      oldestSeq: 0,
      latestSeq: 0,
      droppedCount: 0,
      events: [],
    },
    units: [meleeActorUnit(), visibleHostileUnit()],
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

function meleeDraft(binding, overrides = {}) {
  return {
    ...composeMeleeAttackCommand(binding, {
      commandId: 'melee-stun-01',
      actorUnitId: 1,
      targetUnitId: HOSTILE_ID,
      meleeWeaponBattleItemId: STUN_ROD_ID,
      activeHand: 'STR_RIGHT_HAND',
    }),
    ...overrides,
  };
}

function validateOpts(tactical) {
  return { commandBinding: bindingFor(tactical) };
}

describe('M1 melee MELEE_ATTACK S1 command contract', () => {
  it('parseTacticalCommand and parseMeleeTacticalCommand accept MELEE_ATTACK', () => {
    const raw = {
      schema_version: 1,
      command_id: 'melee-1',
      command_type: COMMAND_TYPE_MELEE_ATTACK,
      actor_unit_id: 1,
      target_unit_id: HOSTILE_ID,
      melee_weapon_battle_item_id: STUN_ROD_ID,
      active_hand: 'STR_RIGHT_HAND',
      snapshot_sha256: SNAPSHOT_SHA,
      session_id: SESSION,
      turn: 1,
      state_version: 0,
    };
    const parsed = parseTacticalCommand(raw);
    assert.equal(parsed.commandType, COMMAND_TYPE_MELEE_ATTACK);
    assert.equal(parseMeleeTacticalCommand(raw).meleeWeaponBattleItemId, STUN_ROD_ID);
    assert.equal(isMeleeTacticalCommandType(COMMAND_TYPE_MELEE_ATTACK), true);
    assert.throws(
      () => parseMeleeTacticalCommand({ ...raw, extra_field: true }),
      /unknown command field/,
    );
  });

  it('valid stun rod command passes with binding and planning hint', () => {
    const tactical = loadTactical([meleeActorUnit(), visibleHostileUnit()]);
    const binding = bindingFor(tactical);
    const draft = meleeDraft(binding);
    const opts = validateOpts(tactical);
    const result = validateMeleeAgainstSnapshot(draft, tactical, SNAPSHOT_SHA, opts);
    assert.equal(result.target.id, HOSTILE_ID);
    assert.match(result.planningHint.note, /engine-authoritative/i);
    assert.ok(validateMeleeTacticalCommandAgainstSnapshot(draft, tactical, SNAPSHOT_SHA, opts).actor);
    assert.ok(validateTacticalCommandAgainstSnapshot(draft, tactical, SNAPSHOT_SHA, opts).target);
  });

  it('valid generic BT_MELEE weapon (non stun rod item type)', () => {
    const actor = genericMeleeActor();
    const tactical = loadTactical([actor, visibleHostileUnit({ position: [3, 4, 0] })]);
    const binding = bindingFor(tactical);
    const draft = composeMeleeAttackCommand(binding, {
      commandId: 'melee-knife',
      actorUnitId: 1,
      targetUnitId: HOSTILE_ID,
      meleeWeaponBattleItemId: KNIFE_ID,
      activeHand: 'STR_LEFT_HAND',
    });
    validateMeleeAgainstSnapshot(draft, tactical, SNAPSHOT_SHA, validateOpts(tactical));
  });

  it('rejects incorrect hand, weapon id, and non-melee item', () => {
    const tactical = loadTactical([meleeActorUnit(), visibleHostileUnit()]);
    const binding = bindingFor(tactical);
    const opts = validateOpts(tactical);
    assert.throws(
      () => validateMeleeAgainstSnapshot(meleeDraft(binding, { active_hand: 'STR_LEFT_HAND' }), tactical, SNAPSHOT_SHA, opts),
      /no equipment|melee_weapon_battle_item_id/,
    );
    assert.throws(
      () => validateMeleeAgainstSnapshot(meleeDraft(binding, { melee_weapon_battle_item_id: 999 }), tactical, SNAPSHOT_SHA, opts),
      /melee_weapon_battle_item_id/,
    );

    const firearmHand = meleeActorUnit({
      handWeapon: {
        battleItemId: 900,
        itemType: 'STR_RIFLE',
        battleType: 0,
        slot: 'STR_RIGHT_HAND',
      },
      actionCosts: {
        posture: { kneelDownTu: 4, standUpTu: 8 },
        hands: {
          right: { itemType: 'STR_RIFLE', actions: [{ id: 'snap', actionType: 5, tuCost: 10, canAffordTu: true, usable: true }] },
          left: { actions: [] },
        },
      },
    });
    const bad = loadTactical([firearmHand, visibleHostileUnit()]);
    assert.throws(
      () => validateMeleeAgainstSnapshot(
        meleeDraft(bindingFor(bad), { melee_weapon_battle_item_id: 900 }),
        bad,
        SNAPSHOT_SHA,
        validateOpts(bad),
      ),
      /must be a melee weapon/,
    );
  });

  it('rejects missing melee action and insufficient TU when exported', () => {
    const tactical = loadTactical([meleeActorUnit(), visibleHostileUnit()]);
    const binding = bindingFor(tactical);
    const opts = validateOpts(tactical);
    const noMeleeRow = meleeActorUnit({
      actionCosts: {
        posture: { kneelDownTu: 4, standUpTu: 8 },
        hands: {
          right: { itemType: 'STR_STUN_ROD', actions: [{ id: 'throw', actionType: 4, tuCost: 20, canAffordTu: true, usable: true }] },
          left: { actions: [] },
        },
      },
    });
    const snapNoMelee = loadTactical([noMeleeRow, visibleHostileUnit()]);
    assert.throws(
      () => validateMeleeAgainstSnapshot(meleeDraft(bindingFor(snapNoMelee)), snapNoMelee, SNAPSHOT_SHA, validateOpts(snapNoMelee)),
      /does not expose melee action/,
    );

    const lowTu = loadTactical([
      meleeActorUnit({ actionCosts: meleeActionCosts(18, false) }),
      visibleHostileUnit(),
    ]);
    assert.throws(
      () => validateMeleeAgainstSnapshot(meleeDraft(bindingFor(lowTu)), lowTu, SNAPSHOT_SHA, validateOpts(lowTu)),
      /insufficient TU for melee/,
    );
  });

  it('rejects missing target, hidden hostiles, and friendly/neutral targets', () => {
    const tactical = loadTactical([meleeActorUnit(), visibleHostileUnit()]);
    const binding = bindingFor(tactical);
    const opts = validateOpts(tactical);
    assert.throws(
      () => validateMeleeAgainstSnapshot(meleeDraft(binding, { target_unit_id: 999_999 }), tactical, SNAPSHOT_SHA, opts),
      /target_unit_id not in snapshot/,
    );

    const hidden = loadAndValidateSnapshotFromText(YAML.stringify(tacticalBase({
      units: [meleeActorUnit(), visibleHostileUnit({ facing: undefined })],
    })), YAML);
    assert.throws(
      () => validateMeleeAgainstSnapshot(meleeDraft(bindingFor(hidden)), hidden, SNAPSHOT_SHA, validateOpts(hidden)),
      (err) => err instanceof ValidationError
        && /confirmed current line of sight/.test(err.message),
    );

    const ally = meleeActorUnit({ id: 2, name: 'Ally', position: [4, 3, 0] });
    const friendlyTarget = loadTactical([meleeActorUnit(), ally]);
    assert.throws(
      () => validateMeleeAgainstSnapshot(
        meleeDraft(bindingFor(friendlyTarget), { target_unit_id: 2 }),
        friendlyTarget,
        SNAPSHOT_SHA,
        validateOpts(friendlyTarget),
      ),
      /friendly roster soldier/,
    );
  });

  it('rejects stale binding and non-commandable actor', () => {
    const tactical = loadTactical([meleeActorUnit(), visibleHostileUnit()]);
    const binding = bindingFor(tactical);
    const opts = validateOpts(tactical);
    assert.throws(
      () => validateMeleeAgainstSnapshot(meleeDraft(binding, { state_version: 99 }), tactical, SNAPSHOT_SHA, opts),
      /state_version/,
    );

    const panicking = loadTactical([
      meleeActorUnit({
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
      () => validateMeleeAgainstSnapshot(meleeDraft(bindingFor(panicking)), panicking, SNAPSHOT_SHA, validateOpts(panicking)),
      /not command-applicable/,
    );
  });

  it('rejects actor not listed in commandBinding.player_soldiers', () => {
    const human = meleeActorUnit({ id: 2, name: 'Human' });
    const tactical = loadTactical([meleeActorUnit(), human, visibleHostileUnit()]);
    const aiOnlyBinding = buildCommandBinding(loadTactical([meleeActorUnit(), visibleHostileUnit()]), SNAPSHOT_SHA);
    const draft = meleeDraft(aiOnlyBinding);
    draft.actor_unit_id = 2;
    assert.throws(
      () => validateMeleeAgainstSnapshot(draft, tactical, SNAPSHOT_SHA, { commandBinding: aiOnlyBinding }),
      /player_soldiers/,
    );
    assert.throws(
      () => composeMeleeAttackCommand(aiOnlyBinding, {
        commandId: 'x',
        actorUnitId: 2,
        targetUnitId: HOSTILE_ID,
        meleeWeaponBattleItemId: STUN_ROD_ID,
        activeHand: 'STR_RIGHT_HAND',
      }),
      /player_soldier/,
    );
  });

  it('geometry advisories only — far target does not hard-reject', () => {
    const tactical = loadTactical([
      meleeActorUnit(),
      visibleHostileUnit({ position: [6, 6, 0] }),
    ]);
    const binding = bindingFor(tactical);
    const result = validateMeleeAgainstSnapshot(meleeDraft(binding), tactical, SNAPSHOT_SHA, validateOpts(tactical));
    const items = result.planningHint.items || [];
    const codes = items.flatMap((i) => (i.items ? i.items.map((x) => x.code) : [i.code])).filter(Boolean);
    assert.ok(codes.includes('target_beyond_one_tile'), `expected geometry advisory, got ${JSON.stringify(result.planningHint)}`);
  });

  it('allows missing actionCosts export with advisory (sparse snapshot)', () => {
    const actor = meleeActorUnit();
    delete actor.actionCosts;
    const sparse = loadTactical([actor, visibleHostileUnit()]);
    const binding = bindingFor(sparse);
    const result = validateMeleeAgainstSnapshot(meleeDraft(binding), sparse, SNAPSHOT_SHA, validateOpts(sparse));
    const notes = (result.planningHint.items || []).map((h) => h.note).join(' ');
    assert.match(notes, /actionCosts not in snapshot/);
  });

  it('parser regression: medikit, psi, and snap still parse', () => {
    assert.equal(parseHealCommand({
      schema_version: 1,
      command_id: 'h1',
      command_type: 'HEAL',
      actor_unit_id: 1,
      target_unit_id: 2,
      medikit_battle_item_id: 1,
      active_hand: 'STR_RIGHT_HAND',
      body_part: 1,
      snapshot_sha256: SNAPSHOT_SHA,
      session_id: SESSION,
      turn: 1,
      state_version: 0,
    }).bodyPart, 1);
    assert.ok(parsePsiPanicCommand({
      schema_version: 1,
      command_id: 'p1',
      command_type: 'PSI_PANIC',
      actor_unit_id: 1,
      target_unit_id: HOSTILE_ID,
      psi_amp_battle_item_id: 1,
      active_hand: 'STR_LEFT_HAND',
      snapshot_sha256: SNAPSHOT_SHA,
      session_id: SESSION,
      turn: 1,
      state_version: 0,
    }));
    assert.ok(parseSnapShotCommand({
      schema_version: 1,
      command_id: 's1',
      command_type: 'SNAP_SHOT',
      actor_unit_id: 1,
      target: { x: 5, y: 5, z: 0 },
      active_hand: 'STR_RIGHT_HAND',
      snapshot_sha256: SNAPSHOT_SHA,
      session_id: SESSION,
      turn: 1,
      state_version: 0,
    }));
  });
});