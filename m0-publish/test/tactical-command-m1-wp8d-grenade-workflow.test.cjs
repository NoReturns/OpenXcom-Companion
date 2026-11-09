'use strict';

/**
 * WP8D — Grenade workflow integration (Node preflight / production composers).
 *
 * Layer labels used in test titles:
 *   [Node-only] — snapshot + validateTacticalCommandAgainstSnapshot + binding compose (no engine)
 *   [Engine harness] — child_process companion_command_test (skipped when binary absent)
 *   [Live game] — not covered here
 *
 * This file does NOT implement an autonomous command queue; it checks stage gates
 * explicitly in tests to mirror the approved operator/agent sequence.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const YAML = require('yaml');
const {
  loadAndValidateSnapshotFromText,
  FACTION_PLAYER,
  BT_GRENADE,
  BT_PROXIMITYGRENADE,
  BT_FIREARM,
} = require('../lib/tactical-publish.cjs');
const {
  validateInventoryMoveAgainstSnapshot,
  validatePickupAgainstSnapshot,
  validatePrimeAgainstSnapshot,
  validateThrowAgainstSnapshot,
  validateTacticalCommandAgainstSnapshot,
  ValidationError,
  isTerminalStatus,
  NON_TERMINAL_STATUSES,
  TERMINAL_STATUSES,
  canAcceptNewCommand,
} = require('../lib/tactical-command.cjs');
const {
  buildCommandBinding,
  composeInventoryMoveCommand,
  composePickupCommand,
  composePrimeCommand,
  composeThrowCommand,
} = require('../lib/command-binding.cjs');

const SESSION = 'a1b2c3d4e5f6789012345678abcdef01';
const GRENADE_ID = 401;
const GRENADE_ID_BACKPACK = 402;
const GRENADE_ID_GROUND = 403;

const SHA_STAGE0 = 'a'.repeat(64);
const SHA_STAGE1 = 'b'.repeat(64);
const SHA_STAGE2 = 'c'.repeat(64);
const SHA_STAGE3 = 'd'.repeat(64);

const {
  resolveCompanionEngineHarness,
  listCompanionEngineHarnessCandidates,
} = require('./helpers/companion-engine-harness-path.cjs');

const COMPANION_COMMAND_TEST_EXE = 'companion_command_test.exe';

function resolveEngineHarness() {
  const resolved = resolveCompanionEngineHarness(COMPANION_COMMAND_TEST_EXE);
  return resolved ? resolved.executablePath : null;
}

function baseUnit(overrides = {}) {
  return {
    id: 1,
    faction: FACTION_PLAYER,
    originalFaction: FACTION_PLAYER,
    position: [1, 1, 0],
    name: 'WP8D',
    health: 40,
    timeUnits: 60,
    kneeled: false,
    activeHand: 'STR_RIGHT_HAND',
    hands: {
      right: null,
      left: null,
    },
    inventory: [],
    groundInventory: [],
    ...overrides,
  };
}

function snapshotDoc(unit) {
  return {
    schemaVersion: 4,
    turn: 1,
    side: 0,
    selectedUnitId: 1,
    map: { width: 10, height: 10, depth: 1 },
    units: [unit],
    eventLog: {
      sessionId: SESSION,
      oldestSeq: 0,
      latestSeq: 0,
      droppedCount: 0,
      events: [],
    },
    groundItems: {
      schemaVersion: 1,
      sessionId: SESSION,
      memoryNote: 'wp8d-grenade-workflow',
      droppedCount: 0,
      observations: [],
    },
  };
}

function loadTactical(unit) {
  return loadAndValidateSnapshotFromText(YAML.stringify(snapshotDoc(unit)), YAML);
}

function grenadeInventoryRow({
  battleItemId,
  slot,
  x = 0,
  y = 0,
  primed = false,
  battleType = BT_GRENADE,
  itemType = 'STR_GRENADE',
}) {
  return {
    battleItemId,
    slot,
    inventorySlotType: 'slot',
    inventoryX: x,
    inventoryY: y,
    itemType,
    battleType,
    explosiveKind: battleType === BT_PROXIMITYGRENADE ? 'proximity' : 'timed',
    primed,
    ...(primed ? { fuseTimer: 0 } : {}),
  };
}

function grenadeHandEquip(battleItemId, { primed = false, fuseTimer = 3, battleType = BT_GRENADE } = {}) {
  return {
    battleItemId,
    itemType: battleType === BT_PROXIMITYGRENADE ? 'STR_PROXIMITY_GRENADE' : 'STR_GRENADE',
    battleType,
    explosiveKind: battleType === BT_PROXIMITYGRENADE ? 'proximity' : 'timed',
    primed,
    ...(primed ? { fuseTimer } : {}),
  };
}

function grenadeActionCosts({ primeTu = 15, throwTu = 12, canAffordPrime = true, canAffordThrow = true } = {}) {
  return {
    posture: { kneelDownTu: 4, standUpTu: 8 },
    hands: {
      right: {
        itemType: 'STR_GRENADE',
        actions: [
          { id: 'throw', actionType: 5, tuCost: throwTu, usable: true, canAffordTu: canAffordThrow },
          { id: 'prime', actionType: 4, tuCost: primeTu, usable: true, canAffordTu: canAffordPrime },
        ],
      },
      left: { actions: [] },
    },
  };
}

function afterInventoryMoveToHand(unit, itemId, destHand, sourceSlot, sourceX, sourceY) {
  const inventory = (unit.inventory || []).filter((r) => r.battleItemId !== itemId);
  const handKey = destHand === 'STR_LEFT_HAND' ? 'left' : 'right';
  const otherKey = handKey === 'left' ? 'right' : 'left';
  const costs = grenadeActionCosts();
  const movedCosts = {
    posture: costs.posture,
    hands: {
      [handKey]: costs.hands.right,
      [otherKey]: { actions: [] },
    },
  };
  return {
    ...unit,
    inventory,
    hands: {
      ...unit.hands,
      [handKey]: grenadeHandEquip(itemId, { primed: false }),
    },
    actionCosts: movedCosts,
  };
}

function afterInventoryMoveToRightHand(unit, itemId, sourceSlot, sourceX, sourceY) {
  return afterInventoryMoveToHand(unit, itemId, 'STR_RIGHT_HAND', sourceSlot, sourceX, sourceY);
}

function afterPickupToRightHand(unit, itemId) {
  const groundInventory = (unit.groundInventory || []).filter((r) => r.battleItemId !== itemId);
  return {
    ...unit,
    groundInventory,
    hands: {
      ...unit.hands,
      right: grenadeHandEquip(itemId, { primed: false }),
    },
    actionCosts: grenadeActionCosts(),
  };
}

function afterPrime(unit, handSlot, fuseTimer = 3) {
  const handKey = handSlot === 'STR_RIGHT_HAND' ? 'right' : 'left';
  return {
    ...unit,
    hands: {
      ...unit.hands,
      [handKey]: grenadeHandEquip(unit.hands[handKey].battleItemId, { primed: true, fuseTimer }),
    },
    actionCosts: {
      ...unit.actionCosts,
      hands: {
        ...unit.actionCosts.hands,
        [handKey]: {
          ...unit.actionCosts.hands[handKey],
          actions: unit.actionCosts.hands[handKey].actions.filter((a) => a.id !== 'prime'),
        },
      },
    },
  };
}

/** Test-only stage gate (not production orchestration). */
function assertWorkflowAllows({ moveDone, primeDone }, next) {
  if (next === 'PRIME') assert.ok(moveDone, 'workflow: INVENTORY_MOVE/PICKUP must complete before PRIME');
  if (next === 'THROW') assert.ok(primeDone, 'workflow: PRIME must succeed before THROW in WP8D policy tests');
}

function preflightStage(command, tactical, sha) {
  validateTacticalCommandAgainstSnapshot(command, tactical, sha);
}

describe('WP8D grenade workflow — composition support [Node-only]', () => {
  it('existing composers cover INVENTORY_MOVE, PRIME, THROW without new command types', () => {
    const unit0 = baseUnit({
      inventory: [grenadeInventoryRow({ battleItemId: GRENADE_ID, slot: 'STR_BELT', y: 0 })],
    });
    const tactical0 = loadTactical(unit0);
    const binding0 = buildCommandBinding(tactical0, SHA_STAGE0);

    const move = composeInventoryMoveCommand(binding0, {
      commandId: 'wp8d-move-1',
      actorUnitId: 1,
      itemBattleItemId: GRENADE_ID,
      sourceSlot: 'STR_BELT',
      destinationSlot: 'STR_RIGHT_HAND',
      destinationX: 0,
      destinationY: 0,
      sourceX: 0,
      sourceY: 0,
    });
    assert.equal(move.command_type, 'INVENTORY_MOVE');
    assert.equal(move.item_battle_item_id, GRENADE_ID);

    const unit1 = afterInventoryMoveToRightHand(unit0, GRENADE_ID, 'STR_BELT', 0, 0);
    const tactical1 = loadTactical(unit1);
    const binding1 = buildCommandBinding(tactical1, SHA_STAGE1);

    const prime = composePrimeCommand(binding1, {
      commandId: 'wp8d-prime-1',
      actorUnitId: 1,
      activeHand: 'STR_RIGHT_HAND',
      fuseTimer: 3,
    });
    assert.equal(prime.command_type, 'PRIME');

    const unit2 = afterPrime(unit1, 'STR_RIGHT_HAND', 3);
    const tactical2 = loadTactical(unit2);
    const binding2 = buildCommandBinding(tactical2, SHA_STAGE2);

    const thr = composeThrowCommand(binding2, {
      commandId: 'wp8d-throw-1',
      actorUnitId: 1,
      activeHand: 'STR_RIGHT_HAND',
      target: { x: 5, y: 5, z: 0 },
    });
    assert.equal(thr.command_type, 'THROW');
    assert.deepEqual(thr.target, { x: 5, y: 5, z: 0 });
  });
});

describe('WP8D grenade workflow — staged preflight', () => {
  it('[Node-only] (1) unprimed belt grenade → hand → PRIME → THROW with fresh binding each stage', () => {
    const unit0 = baseUnit({
      inventory: [grenadeInventoryRow({ battleItemId: GRENADE_ID, slot: 'STR_BELT', y: 0 })],
    });
    const tactical0 = loadTactical(unit0);
    const binding0 = buildCommandBinding(tactical0, SHA_STAGE0);
    const move = composeInventoryMoveCommand(binding0, {
      commandId: 'wp8d-belt-move',
      actorUnitId: 1,
      itemBattleItemId: GRENADE_ID,
      sourceSlot: 'STR_BELT',
      destinationSlot: 'STR_RIGHT_HAND',
      destinationX: 0,
      destinationY: 0,
      sourceX: 0,
      sourceY: 0,
    });
    preflightStage(move, tactical0, SHA_STAGE0);

    let moveDone = true;
    const unit1 = afterInventoryMoveToRightHand(unit0, GRENADE_ID, 'STR_BELT', 0, 0);
    assert.equal(unit1.hands.right.battleItemId, GRENADE_ID);
    const tactical1 = loadTactical(unit1);
    const binding1 = buildCommandBinding(tactical1, SHA_STAGE1);

    assertWorkflowAllows({ moveDone, primeDone: false }, 'PRIME');
    const prime = composePrimeCommand(binding1, {
      commandId: 'wp8d-belt-prime',
      actorUnitId: 1,
      activeHand: 'STR_RIGHT_HAND',
      fuseTimer: 3,
    });
    preflightStage(prime, tactical1, SHA_STAGE1);
    assert.throws(
      () => preflightStage(prime, tactical0, SHA_STAGE0),
      ValidationError,
      'stale snapshot after move must reject PRIME',
    );

    const primeDone = true;
    const unit2 = afterPrime(unit1, 'STR_RIGHT_HAND');
    const tactical2 = loadTactical(unit2);
    const binding2 = buildCommandBinding(tactical2, SHA_STAGE2);

    assertWorkflowAllows({ moveDone, primeDone }, 'THROW');
    const thr = composeThrowCommand(binding2, {
      commandId: 'wp8d-belt-throw',
      actorUnitId: 1,
      activeHand: 'STR_RIGHT_HAND',
      target: { x: 4, y: 4, z: 0 },
    });
    preflightStage(thr, tactical2, SHA_STAGE2);
    assert.equal(thr.item_battle_item_id, undefined);
    assert.equal(unit2.hands.right.battleItemId, GRENADE_ID);
  });

  it('[Node-only] (2) unprimed backpack grenade → hand', () => {
    const unit0 = baseUnit({
      inventory: [grenadeInventoryRow({
        battleItemId: GRENADE_ID_BACKPACK,
        slot: 'STR_BACK_PACK',
        x: 1,
        y: 1,
      })],
    });
    const tactical0 = loadTactical(unit0);
    const binding0 = buildCommandBinding(tactical0, SHA_STAGE0);
    const move = composeInventoryMoveCommand(binding0, {
      commandId: 'wp8d-backpack-move',
      actorUnitId: 1,
      itemBattleItemId: GRENADE_ID_BACKPACK,
      sourceSlot: 'STR_BACK_PACK',
      destinationSlot: 'STR_LEFT_HAND',
      destinationX: 0,
      destinationY: 0,
      sourceX: 1,
      sourceY: 1,
    });
    validateInventoryMoveAgainstSnapshot(move, tactical0, SHA_STAGE0);

    const unit1 = afterInventoryMoveToHand(
      unit0,
      GRENADE_ID_BACKPACK,
      'STR_LEFT_HAND',
      'STR_BACK_PACK',
      1,
      1,
    );
    const tactical1 = loadTactical(unit1);
    const binding1 = buildCommandBinding(tactical1, SHA_STAGE1);
    const prime = composePrimeCommand(binding1, {
      commandId: 'wp8d-backpack-prime',
      actorUnitId: 1,
      activeHand: 'STR_LEFT_HAND',
      fuseTimer: 0,
    });
    preflightStage(prime, tactical1, SHA_STAGE1);
  });

  it('[Node-only] (3) ground grenade PICKUP into hand then PRIME', () => {
    const unit0 = baseUnit({
      groundInventory: [{
        slot: 'STR_GROUND',
        inventorySlotType: 'ground',
        battleItemId: GRENADE_ID_GROUND,
        itemType: 'STR_GRENADE',
        battleType: BT_GRENADE,
        inventoryX: 0,
        inventoryY: 0,
      }],
    });
    const tactical0 = loadTactical(unit0);
    const binding0 = buildCommandBinding(tactical0, SHA_STAGE0);
    const pickup = composePickupCommand(binding0, {
      commandId: 'wp8d-ground-pickup',
      actorUnitId: 1,
      itemBattleItemId: GRENADE_ID_GROUND,
      groundPosition: { x: 1, y: 1, z: 0 },
      destinationSlot: 'STR_RIGHT_HAND',
      destinationX: 0,
      destinationY: 0,
    });
    validatePickupAgainstSnapshot(pickup, tactical0, SHA_STAGE0);

    const unit1 = afterPickupToRightHand(unit0, GRENADE_ID_GROUND);
    const tactical1 = loadTactical(unit1);
    const binding1 = buildCommandBinding(tactical1, SHA_STAGE1);
    const prime = composePrimeCommand(binding1, {
      commandId: 'wp8d-ground-prime',
      actorUnitId: 1,
      activeHand: 'STR_RIGHT_HAND',
      fuseTimer: 2,
    });
    preflightStage(prime, tactical1, SHA_STAGE1);
    assert.equal(unit1.hands.right.battleItemId, GRENADE_ID_GROUND);
  });

  it('[Node-only] (6) fresh snapshot: state_version and sha must match each stage', () => {
    const unit1 = afterInventoryMoveToRightHand(
      baseUnit({ inventory: [grenadeInventoryRow({ battleItemId: GRENADE_ID, slot: 'STR_BELT' })] }),
      GRENADE_ID,
      'STR_BELT',
      0,
      0,
    );
    const tactical1 = loadTactical(unit1);
    const binding1 = buildCommandBinding(tactical1, SHA_STAGE1);
    const stalePrime = {
      ...composePrimeCommand(binding1, {
        commandId: 'wp8d-stale-ver',
        actorUnitId: 1,
        activeHand: 'STR_RIGHT_HAND',
        fuseTimer: 1,
      }),
      state_version: 0,
      snapshot_sha256: SHA_STAGE0,
    };
    assert.throws(
      () => validatePrimeAgainstSnapshot(stalePrime, tactical1, SHA_STAGE1),
      ValidationError,
    );
  });

  it('[Node-only] (7) insufficient TU rejects PRIME preflight', () => {
    const unit1 = afterInventoryMoveToRightHand(
      baseUnit({ inventory: [grenadeInventoryRow({ battleItemId: GRENADE_ID, slot: 'STR_BELT' })] }),
      GRENADE_ID,
      'STR_BELT',
      0,
      0,
    );
    unit1.actionCosts = grenadeActionCosts({ canAffordPrime: false });
    const tactical1 = loadTactical(unit1);
    const binding1 = buildCommandBinding(tactical1, SHA_STAGE1);
    const prime = composePrimeCommand(binding1, {
      commandId: 'wp8d-tu-prime',
      actorUnitId: 1,
      activeHand: 'STR_RIGHT_HAND',
      fuseTimer: 3,
    });
    assert.throws(() => validatePrimeAgainstSnapshot(prime, tactical1, SHA_STAGE1), /insufficient TU/i);
  });

  it('[Node-only] (8) illegal destination STR_GROUND rejects inventory move compose validation path', () => {
    const unit0 = baseUnit({
      inventory: [grenadeInventoryRow({ battleItemId: GRENADE_ID, slot: 'STR_BELT' })],
    });
    const tactical0 = loadTactical(unit0);
    const binding0 = buildCommandBinding(tactical0, SHA_STAGE0);
    const move = composeInventoryMoveCommand(binding0, {
      commandId: 'wp8d-bad-ground',
      actorUnitId: 1,
      itemBattleItemId: GRENADE_ID,
      sourceSlot: 'STR_BELT',
      destinationSlot: 'STR_GROUND',
      destinationX: 0,
      destinationY: 0,
    });
    assert.throws(() => validateInventoryMoveAgainstSnapshot(move, tactical0, SHA_STAGE0), ValidationError);
  });

  it('[Node-only] (8b) occupied hand: PRIME still blocked before belt move (no implicit hand fill)', () => {
    const unit0 = baseUnit({
      hands: {
        right: { itemType: 'STR_RIFLE', battleType: BT_FIREARM, battleItemId: 99 },
        left: null,
      },
      inventory: [grenadeInventoryRow({ battleItemId: GRENADE_ID, slot: 'STR_BELT' })],
      actionCosts: {
        posture: { kneelDownTu: 4, standUpTu: 8 },
        hands: {
          right: { itemType: 'STR_RIFLE', actions: [{ id: 'snap', actionType: 3, tuCost: 10, usable: true, canAffordTu: true }] },
          left: { actions: [] },
        },
      },
    });
    const tactical0 = loadTactical(unit0);
    const binding0 = buildCommandBinding(tactical0, SHA_STAGE0);
    const prime = composePrimeCommand(binding0, {
      commandId: 'wp8d-occ-prime',
      actorUnitId: 1,
      activeHand: 'STR_RIGHT_HAND',
      fuseTimer: 3,
    });
    assert.throws(() => validatePrimeAgainstSnapshot(prime, tactical0, SHA_STAGE0), ValidationError);
  });

  it('[Node-only] (9) item identity battleItemId preserved across simulated stages', () => {
    const ids = [];
    const unit0 = baseUnit({
      inventory: [grenadeInventoryRow({ battleItemId: GRENADE_ID, slot: 'STR_BELT' })],
    });
    ids.push(unit0.inventory[0].battleItemId);
    const unit1 = afterInventoryMoveToRightHand(unit0, GRENADE_ID, 'STR_BELT', 0, 0);
    ids.push(unit1.hands.right.battleItemId);
    const unit2 = afterPrime(unit1, 'STR_RIGHT_HAND');
    ids.push(unit2.hands.right.battleItemId);
    assert.deepEqual(ids, [GRENADE_ID, GRENADE_ID, GRENADE_ID]);
  });

  it('[Node-only] (10) primed grenade in belt rejects INVENTORY_MOVE', () => {
    const unit0 = baseUnit({
      inventory: [grenadeInventoryRow({ battleItemId: GRENADE_ID, slot: 'STR_BELT', primed: true })],
    });
    const tactical0 = loadTactical(unit0);
    const binding0 = buildCommandBinding(tactical0, SHA_STAGE0);
    const move = composeInventoryMoveCommand(binding0, {
      commandId: 'wp8d-primed-belt',
      actorUnitId: 1,
      itemBattleItemId: GRENADE_ID,
      sourceSlot: 'STR_BELT',
      destinationSlot: 'STR_RIGHT_HAND',
      destinationX: 0,
      destinationY: 0,
    });
    assert.throws(() => validateInventoryMoveAgainstSnapshot(move, tactical0, SHA_STAGE0), /primed explosive/i);
  });

  it('[Node-only] (11) invalid explosive type: rifle in hand rejects PRIME', () => {
    const unit0 = baseUnit({
      hands: {
        right: { itemType: 'STR_RIFLE', battleType: BT_FIREARM, battleItemId: 50 },
        left: null,
      },
      actionCosts: {
        posture: { kneelDownTu: 4, standUpTu: 8 },
        hands: {
          right: { itemType: 'STR_RIFLE', actions: [{ id: 'snap', actionType: 3, tuCost: 10, usable: true, canAffordTu: true }] },
          left: { actions: [] },
        },
      },
    });
    const tactical0 = loadTactical(unit0);
    const binding0 = buildCommandBinding(tactical0, SHA_STAGE0);
    const prime = composePrimeCommand(binding0, {
      commandId: 'wp8d-rifle-prime',
      actorUnitId: 1,
      activeHand: 'STR_RIGHT_HAND',
      fuseTimer: 3,
    });
    assert.throws(() => validatePrimeAgainstSnapshot(prime, tactical0, SHA_STAGE0), ValidationError);
  });

  it('[Node-only] (12) stale binding and duplicate inbox gate', () => {
    const unit0 = baseUnit({
      inventory: [grenadeInventoryRow({ battleItemId: GRENADE_ID, slot: 'STR_BELT' })],
    });
    const tactical0 = loadTactical(unit0);
    const binding0 = buildCommandBinding(tactical0, SHA_STAGE0);
    const move = composeInventoryMoveCommand(binding0, {
      commandId: 'wp8d-dup',
      actorUnitId: 1,
      itemBattleItemId: GRENADE_ID,
      sourceSlot: 'STR_BELT',
      destinationSlot: 'STR_RIGHT_HAND',
      destinationX: 0,
      destinationY: 0,
    });
    preflightStage(move, tactical0, SHA_STAGE0);

    const staleMove = { ...move, snapshot_sha256: SHA_STAGE1 };
    assert.throws(() => preflightStage(staleMove, tactical0, SHA_STAGE0), ValidationError);

    assert.equal(canAcceptNewCommand('EXECUTING'), false);
    assert.equal(canAcceptNewCommand('COMPLETED'), true);
    assert.equal(NON_TERMINAL_STATUSES.has('EXECUTING'), true);
  });

  it('[Node-only] (13) failed movement: PRIME preflight fails while grenade remains on belt', () => {
    const unit0 = baseUnit({
      inventory: [grenadeInventoryRow({ battleItemId: GRENADE_ID, slot: 'STR_BELT', primed: true })],
    });
    const tactical0 = loadTactical(unit0);
    const binding0 = buildCommandBinding(tactical0, SHA_STAGE0);
    const move = composeInventoryMoveCommand(binding0, {
      commandId: 'wp8d-fail-move',
      actorUnitId: 1,
      itemBattleItemId: GRENADE_ID,
      sourceSlot: 'STR_BELT',
      destinationSlot: 'STR_RIGHT_HAND',
      destinationX: 0,
      destinationY: 0,
    });
    assert.throws(() => validateInventoryMoveAgainstSnapshot(move, tactical0, SHA_STAGE0));
    assert.throws(
      () => assertWorkflowAllows({ moveDone: false, primeDone: false }, 'PRIME'),
      /must complete before PRIME/,
    );
    const prime = composePrimeCommand(binding0, {
      commandId: 'wp8d-after-fail-prime',
      actorUnitId: 1,
      activeHand: 'STR_RIGHT_HAND',
      fuseTimer: 3,
    });
    assert.throws(() => validatePrimeAgainstSnapshot(prime, tactical0, SHA_STAGE0));
  });

  it('[Node-only] (14) failed PRIME (insufficient TU): workflow gate blocks THROW policy step', () => {
    const unit1 = afterInventoryMoveToRightHand(
      baseUnit({ inventory: [grenadeInventoryRow({ battleItemId: GRENADE_ID, slot: 'STR_BELT' })] }),
      GRENADE_ID,
      'STR_BELT',
      0,
      0,
    );
    unit1.actionCosts = grenadeActionCosts({ canAffordPrime: false, canAffordThrow: true });
    const tactical1 = loadTactical(unit1);
    const binding1 = buildCommandBinding(tactical1, SHA_STAGE1);
    const prime = composePrimeCommand(binding1, {
      commandId: 'wp8d-fail-prime',
      actorUnitId: 1,
      activeHand: 'STR_RIGHT_HAND',
      fuseTimer: 3,
    });
    assert.throws(() => validatePrimeAgainstSnapshot(prime, tactical1, SHA_STAGE1));
    const moveDone = true;
    const primeDone = false;
    assert.throws(
      () => assertWorkflowAllows({ moveDone, primeDone }, 'THROW'),
      /PRIME must succeed/,
    );
  });

  it('[Node-only] (15) THROW EXECUTING is non-terminal; COMPLETED is terminal', () => {
    assert.equal(isTerminalStatus('EXECUTING'), false);
    assert.equal(isTerminalStatus('ACCEPTED'), false);
    assert.equal(TERMINAL_STATUSES.has('COMPLETED'), true);
    assert.equal(TERMINAL_STATUSES.has('FAILED'), true);
  });

  it('[Node-only] (16) relay layer treats COMPLETED throw result as terminal (shape only)', () => {
    const terminal = {
      schema_version: 1,
      command_id: 'wp8d-throw-done',
      command_type: 'THROW',
      status: 'COMPLETED',
      session_id: SESSION,
      turn: 1,
    };
    assert.equal(isTerminalStatus(terminal.status), true);
    const inFlight = { ...terminal, status: 'EXECUTING' };
    assert.equal(isTerminalStatus(inFlight.status), false);
  });
});

describe('WP8D grenade workflow — engine harness', () => {
  let engineHarness = null;

  before(() => {
    engineHarness = resolveEngineHarness();
  });

  it('[Engine harness] companion_command_test core (CompanionCommandCore — not BattlescapeGame)', (t) => {
    if (!engineHarness) {
      const checked = listCompanionEngineHarnessCandidates(COMPANION_COMMAND_TEST_EXE).length;
      t.skip(`companion_command_test.exe not found (${checked} repo-relative candidates under build-*/bin/<Configuration>/)`);
      return;
    }
    assert.equal(
      path.basename(engineHarness),
      COMPANION_COMMAND_TEST_EXE,
      'must not substitute unrelated harness binaries',
    );
    const out = execFileSync(engineHarness, [], { encoding: 'utf8', timeout: 120_000 });
    assert.match(
      out,
      /companion_command_test: all tests passed/,
      'core harness exit 0 implies PRIME/THROW parse+validate tests ran (failure messages are stderr-only)',
    );
  });
});
