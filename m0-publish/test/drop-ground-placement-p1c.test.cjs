'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyDropResult,
  compareDropGroundPlacementToSnapshot,
  assessDropSnapshotFreshness,
  buildDropOutcomeBrief,
} = require('../lib/drop-result-ground-placement.cjs');

const SESSION = 'a1b2c3d4e5f6789012345678abcdef01';

function completedDropResult(overrides = {}) {
  return {
    schema_version: 1,
    command_id: 'drop-p1c',
    command_type: 'DROP',
    status: 'COMPLETED',
    session_id: SESSION,
    turn: 1,
    actor_unit_id: 1,
    item_battle_item_id: 300,
    source_slot: 'STR_BELT',
    tu_spent: 6,
    ground_placement: {
      item_battle_item_id: 300,
      tile: { x: 1, y: 1, z: 0 },
      inventory_x: 0,
      inventory_y: 0,
      ground_slot: 'STR_GROUND',
      verification_status: 'engine_postcondition_verified',
      evidence_class: 'engine_immediate',
      independent_snapshot_confirmed: false,
    },
    ...overrides,
  };
}

function tacticalWithGround(rows) {
  return {
    turn: 1,
    map: { width: 10, height: 10, depth: 1 },
    units: [{
      id: 1,
      faction: 0,
      originalFaction: 0,
      position: [1, 1, 0],
      groundInventory: rows,
    }],
    eventLog: { sessionId: SESSION, latestSeq: 0 },
  };
}

describe('P1-C DROP ground placement result consumer', () => {
  it('classifies rejected DROP without placement claims', () => {
    const c = classifyDropResult({ command_type: 'DROP', status: 'REJECTED', public_reason: 'NOT_AI_CONTROLLED' });
    assert.equal(c.category, 'drop_rejected');
    assert.equal(c.canClaimPlacement, false);
  });

  it('classifies COMPLETED without ground_placement as unverified', () => {
    const c = classifyDropResult({ command_type: 'DROP', status: 'COMPLETED' });
    assert.equal(c.category, 'drop_completed_placement_unverified');
  });

  it('classifies engine-verified COMPLETED', () => {
    const c = classifyDropResult(completedDropResult());
    assert.equal(c.category, 'drop_executed_placement_verified');
    assert.equal(c.canClaimPlacement, true);
  });

  it('does not confirm independently until snapshot groundInventory matches', () => {
    const cmp = compareDropGroundPlacementToSnapshot(completedDropResult(), tacticalWithGround([
      {
        battleItemId: 300,
        inventoryX: 0,
        inventoryY: 0,
        slot: 'STR_GROUND',
        inventorySlotType: 'ground',
        itemType: 'STR_RIFLE_CLIP',
        battleType: 9,
      },
    ]));
    assert.equal(cmp.independentSnapshotConfirmed, true);
    assert.equal(cmp.engineVerified, true);
  });

  it('keeps independent confirmation false when snapshot item missing', () => {
    const cmp = compareDropGroundPlacementToSnapshot(completedDropResult(), tacticalWithGround([]));
    assert.equal(cmp.independentSnapshotConfirmed, false);
    assert.match(cmp.limitation, /not found/i);
  });

  it('preserves corpse linkage field passthrough in snapshot match metadata', () => {
    const cmp = compareDropGroundPlacementToSnapshot(completedDropResult({
      ground_placement: {
        item_battle_item_id: 9001,
        tile: { x: 1, y: 1, z: 0 },
        inventory_x: 1,
        inventory_y: 0,
        verification_status: 'engine_postcondition_verified',
        evidence_class: 'engine_immediate',
      },
      item_battle_item_id: 9001,
    }), tacticalWithGround([
      {
        battleItemId: 9001,
        inventoryX: 1,
        inventoryY: 0,
        slot: 'STR_GROUND',
        inventorySlotType: 'ground',
        itemType: 'STR_XCOM_CORPSE',
        battleType: 11,
        carriedRosterUnitId: 3,
      },
    ]));
    assert.equal(cmp.independentSnapshotConfirmed, true);
    assert.equal(cmp.snapshotMatch.carriedRosterUnitId, 3);
  });

  it('refuses independent confirmation for mismatched tactical session', () => {
    const cmp = compareDropGroundPlacementToSnapshot(
      completedDropResult({ session_id: 'b'.repeat(32) }),
      tacticalWithGround([{ battleItemId: 300, inventoryX: 0, inventoryY: 0, slot: 'STR_GROUND', inventorySlotType: 'ground' }]),
    );
    assert.equal(cmp.independentSnapshotConfirmed, false);
    assert.equal(cmp.freshnessVerified, false);
    assert.match(cmp.limitation, /session_id/i);
  });

  it('allows post-command digest to differ from pre-command binding hash', () => {
    const pre = 'a'.repeat(64);
    const post = 'b'.repeat(64);
    const tactical = tacticalWithGround([{ battleItemId: 300, inventoryX: 0, inventoryY: 0, slot: 'STR_GROUND', inventorySlotType: 'ground' }]);
    tactical.eventLog.latestSeq = 6;
    const cmp = compareDropGroundPlacementToSnapshot(
      completedDropResult({ snapshot_sha256: post, state_version: 5 }),
      tactical,
      { snapshotSha256Lower: post, preCommandSnapshotSha256: pre },
    );
    assert.equal(cmp.independentSnapshotConfirmed, true);
  });

  it('refuses independent confirmation when snapshot digest is still pre-command binding', () => {
    const pre = 'a'.repeat(64);
    const cmp = compareDropGroundPlacementToSnapshot(
      completedDropResult({ snapshot_sha256: pre, state_version: 5 }),
      tacticalWithGround([{ battleItemId: 300, inventoryX: 0, inventoryY: 0, slot: 'STR_GROUND', inventorySlotType: 'ground' }]),
      { snapshotSha256Lower: pre, preCommandSnapshotSha256: pre },
    );
    assert.equal(cmp.independentSnapshotConfirmed, false);
    assert.match(cmp.limitation, /pre_command|freshness/i);
  });

  it('refuses snapshot older than DROP command binding state_version', () => {
    const tactical = tacticalWithGround([{ battleItemId: 300, inventoryX: 0, inventoryY: 0, slot: 'STR_GROUND', inventorySlotType: 'ground' }]);
    tactical.eventLog.latestSeq = 2;
    const cmp = compareDropGroundPlacementToSnapshot(
      completedDropResult({ state_version: 5, snapshot_sha256: 'c'.repeat(64) }),
      tactical,
      { snapshotSha256Lower: 'd'.repeat(64), preCommandSnapshotSha256: 'a'.repeat(64) },
    );
    assert.equal(cmp.independentSnapshotConfirmed, false);
    assert.match(cmp.limitation, /older|freshness|binding/i);
  });

  it('buildDropOutcomeBrief classifies engine-only vs independent confirmation', () => {
    const engineOnly = buildDropOutcomeBrief(completedDropResult());
    assert.equal(engineOnly.verification_class, 'drop_completed_engine_verified');
    const tactical = tacticalWithGround([{ battleItemId: 300, inventoryX: 0, inventoryY: 0, slot: 'STR_GROUND', inventorySlotType: 'ground' }]);
    tactical.eventLog.latestSeq = 3;
    const independent = buildDropOutcomeBrief(
      completedDropResult({ snapshot_sha256: 'f'.repeat(64), state_version: 2 }),
      null,
      { tactical, snapshotSha256Lower: 'f'.repeat(64), preCommandSnapshotSha256: 'a'.repeat(64) },
    );
    assert.equal(independent.verification_class, 'drop_independently_confirmed');
  });

  it('refuses unrelated ground item with matching cell but wrong battleItemId', () => {
    const cmp = compareDropGroundPlacementToSnapshot(completedDropResult(), tacticalWithGround([
      { battleItemId: 999, inventoryX: 0, inventoryY: 0, slot: 'STR_GROUND', inventorySlotType: 'ground' },
    ]));
    assert.equal(cmp.independentSnapshotConfirmed, false);
    assert.match(cmp.limitation, /not found|does not match/i);
  });

  it('distinguishes multiple items on same tile by inventory cell', () => {
    const tactical = tacticalWithGround([
      { battleItemId: 301, inventoryX: 0, inventoryY: 0, slot: 'STR_GROUND', inventorySlotType: 'ground' },
      { battleItemId: 302, inventoryX: 1, inventoryY: 0, slot: 'STR_GROUND', inventorySlotType: 'ground' },
    ]);
    const cmp = compareDropGroundPlacementToSnapshot(completedDropResult({
      item_battle_item_id: 302,
      ground_placement: {
        item_battle_item_id: 302,
        tile: { x: 1, y: 1, z: 0 },
        inventory_x: 1,
        inventory_y: 0,
        verification_status: 'engine_postcondition_verified',
        evidence_class: 'engine_immediate',
      },
    }), tactical);
    assert.equal(cmp.independentSnapshotConfirmed, true);
    assert.equal(cmp.snapshotMatch.battleItemId, 302);
  });
});
