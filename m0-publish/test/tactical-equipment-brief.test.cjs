'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  FACTION_PLAYER,
  BT_FIREARM,
  BT_AMMO,
  BT_GRENADE,
  BT_PROXIMITYGRENADE,
  BT_MEDIKIT,
  validateUnit,
  buildRelayPayload,
} = require('../lib/tactical-publish.cjs');
const {
  TACTICAL_CATEGORY,
  enumerateUnitEquipment,
  runMandatoryTacticalEquipmentReview,
} = require('../lib/tactical-equipment-brief.cjs');
const { runMandatoryBriefingPrelude } = require('../lib/tactical-briefing-ai-workflow.cjs');

function rosterBase(overrides = {}) {
  return {
    id: 1,
    faction: FACTION_PLAYER,
    originalFaction: FACTION_PLAYER,
    position: [1, 2, 0],
    name: 'Alpha',
    health: 40,
    timeUnits: 50,
    kneeled: false,
    activeHand: 'STR_RIGHT_HAND',
    hands: { right: null, left: null },
    inventory: [],
    ...overrides,
  };
}

function relayFromUnits(units, schemaVersion = 5) {
  const tactical = {
    schemaVersion,
    turn: 1,
    side: 0,
    selectedUnitId: units[0]?.id ?? 1,
    map: { width: 10, height: 10, depth: 1 },
    units,
    eventLog: {
      sessionId: '0123456789abcdef0123456789abcdef',
      oldestSeq: 1,
      latestSeq: 1,
      droppedCount: 0,
      events: [],
    },
  };
  return buildRelayPayload(tactical, '2026-11-08T20:00:00.000Z', null, {
    snapshotSha256: 'a'.repeat(64),
  });
}

function invItem(fields) {
  return { slot: 'STR_BELT', inventorySlotType: 'slot', ...fields };
}

describe('M1 mandatory tactical equipment brief', () => {
  it('soldier carrying a grenade on belt', () => {
    const unit = validateUnit(
      rosterBase({
        inventory: [
          invItem({
            battleItemId: 10,
            itemType: 'STR_GRENADE',
            battleType: BT_GRENADE,
            explosiveKind: 'timed',
            primed: false,
          }),
        ],
      }),
      0,
      5,
    );
    const { entries } = enumerateUnitEquipment(unit);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].category, TACTICAL_CATEGORY.STANDARD_GRENADE);
    assert.equal(entries[0].placement, 'belt_or_backpack');
    assert.equal(entries[0].explosive.primed, false);
  });

  it('soldier holding a grenade in the right hand', () => {
    const unit = validateUnit(
      rosterBase({
        hands: {
          right: {
            battleItemId: 11,
            itemType: 'STR_GRENADE',
            battleType: BT_GRENADE,
            explosiveKind: 'timed',
            primed: false,
          },
          left: null,
        },
      }),
      0,
      5,
    );
    const { entries } = enumerateUnitEquipment(unit);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].placement, 'in_hand_right');
  });

  it('classifies primed explosive and proximity grenade', () => {
    const unit = validateUnit(
      rosterBase({
        inventory: [
          invItem({
            battleItemId: 12,
            itemType: 'STR_GRENADE',
            battleType: BT_GRENADE,
            explosiveKind: 'timed',
            primed: true,
            fuseTimer: 2,
          }),
          invItem({
            battleItemId: 13,
            itemType: 'STR_PROXIMITY_GRENADE',
            battleType: BT_PROXIMITYGRENADE,
            explosiveKind: 'proximity',
            primed: false,
          }),
        ],
      }),
      0,
      5,
    );
    const { entries } = enumerateUnitEquipment(unit);
    assert.equal(entries.length, 2);
    const primed = entries.find((e) => e.battleItemId === 12);
    assert.equal(primed.explosive.primed, true);
    assert.equal(primed.explosive.fuseTimer, 2);
    const prox = entries.find((e) => e.battleItemId === 13);
    assert.equal(prox.category, TACTICAL_CATEGORY.PROXIMITY_GRENADE);
  });

  it('summarizes medikit with remaining charges and depleted medikit', () => {
    const charged = validateUnit(
      rosterBase({
        inventory: [
          invItem({
            battleItemId: 20,
            itemType: 'STR_MEDI_KIT',
            battleType: BT_MEDIKIT,
            medikitCharges: { heal: 1, painKiller: 1, stimulant: 0 },
          }),
        ],
      }),
      0,
      5,
    );
    const depleted = validateUnit(
      rosterBase({
        id: 2,
        name: 'Beta',
        inventory: [
          invItem({
            battleItemId: 21,
            itemType: 'STR_MEDI_KIT',
            battleType: BT_MEDIKIT,
            medikitCharges: { heal: 0, painKiller: 0, stimulant: 0 },
          }),
        ],
      }),
      0,
      5,
    );
    const r1 = runMandatoryTacticalEquipmentReview(relayFromUnits([charged]));
    assert.equal(r1.soldiers[0].items[0].medikit.depleted, false);
    const r2 = runMandatoryTacticalEquipmentReview(relayFromUnits([charged, depleted]));
    const beta = r2.soldiers.find((s) => s.unitId === 2);
    assert.equal(beta.items[0].medikit.depleted, true);
    assert.match(r2.equipmentSummaryLines.join('\n'), /depleted/);
  });

  it('distinguishes loaded rifle from spare ammunition and dry inserted magazine', () => {
    const unit = validateUnit(
      rosterBase({
        hands: {
          right: {
            itemType: 'STR_RIFLE',
            battleType: BT_FIREARM,
            loaded: { ammoType: 'STR_RIFLE_CLIP', rounds: 18 },
          },
          left: null,
        },
        inventory: [
          invItem({
            battleItemId: 30,
            itemType: 'STR_RIFLE_CLIP',
            battleType: BT_AMMO,
          }),
        ],
      }),
      0,
      5,
    );
    const depletedMag = validateUnit(
      rosterBase({
        id: 3,
        name: 'Gamma',
        hands: {
          right: {
            itemType: 'STR_RIFLE',
            battleType: BT_FIREARM,
            empty: true,
            nestedAmmo: { battleItemId: 90, ammoType: 'STR_RIFLE_CLIP', rounds: 0 },
            loaded: { ammoType: 'STR_RIFLE_CLIP', rounds: 0, battleItemId: 90 },
          },
          left: null,
        },
      }),
      0,
      5,
    );
    const review = runMandatoryTacticalEquipmentReview(relayFromUnits([unit, depletedMag]));
    assert.equal(review.soldiers[0].items.length, 2);
    assert.match(review.equipmentSummaryLines.join('\n'), /loaded 18/);
    const gamma = review.soldiers.find((s) => s.unitId === 3);
    assert.equal(gamma.items[0].ammunition.state, 'loaded');
    assert.equal(gamma.items[0].ammunition.rounds, 0);
  });

  it('soldier with no equipment fields (older snapshot)', () => {
    const v2Unit = {
      id: 1,
      faction: FACTION_PLAYER,
      originalFaction: FACTION_PLAYER,
      position: [1, 2, 0],
      name: 'Legacy',
      health: 40,
      timeUnits: 50,
    };
    const review = runMandatoryTacticalEquipmentReview(relayFromUnits([v2Unit], 2));
    assert.equal(review.soldiers[0].hasExportedEquipment, false);
    assert.match(review.equipmentSummaryLines[0], /older schema/i);
  });

  it('human-owned soldier visible without companion command authority', () => {
    const units = [
      validateUnit(rosterBase({ id: 1, name: 'AI-One' }), 0, 5),
      validateUnit(rosterBase({ id: 2, name: 'Human-Two', inventory: [] }), 0, 5),
    ];
    const relay = relayFromUnits(units);
    const review = runMandatoryTacticalEquipmentReview(relay, { aiCommandActorIds: [1] });
    const ai = review.soldiers.find((s) => s.unitId === 1);
    const human = review.soldiers.find((s) => s.unitId === 2);
    assert.equal(ai.companionOrderActor, true);
    assert.equal(human.companionOrderActor, false);
    assert.equal(human.situationalAwarenessOnly, true);
    assert.match(review.equipmentSummaryLines.join('\n'), /Human-Two.*not a Companion command actor/i);
  });

  it('does not double-count inventory and hands sharing battleItemId', () => {
    const unit = validateUnit(
      rosterBase({
        hands: {
          right: {
            battleItemId: 55,
            itemType: 'STR_GRENADE',
            battleType: BT_GRENADE,
            explosiveKind: 'timed',
            primed: false,
          },
          left: null,
        },
        inventory: [
          invItem({
            battleItemId: 55,
            itemType: 'STR_GRENADE',
            battleType: BT_GRENADE,
            explosiveKind: 'timed',
            primed: false,
          }),
        ],
      }),
      0,
      5,
    );
    const { entries, duplicateBattleItemIdsSkipped } = enumerateUnitEquipment(unit);
    assert.equal(entries.length, 1);
    assert.equal(duplicateBattleItemIdsSkipped, 1);
    assert.equal(entries[0].placement, 'in_hand_right');
  });

  it('briefing prelude chains status and equipment without relay extensions', () => {
    const unit = validateUnit(
      rosterBase({
        inventory: [
          invItem({
            battleItemId: 77,
            itemType: 'STR_SMOKE_GRENADE',
            battleType: BT_GRENADE,
            explosiveKind: 'timed',
            primed: false,
          }),
        ],
      }),
      0,
      5,
    );
    const relay = relayFromUnits([unit]);
    const prelude = runMandatoryBriefingPrelude(relay, { aiCommandActorIds: [1] });
    assert.equal(prelude.workflowVersion, 3);
    assert.equal(prelude.status.sequenceCompleted, true);
    assert.equal(prelude.equipment.sequenceCompleted, true);
    assert.equal(prelude.equipment.soldiers[0].items[0].category, TACTICAL_CATEGORY.SMOKE_GRENADE);
    assert.equal(Object.prototype.hasOwnProperty.call(relay, 'equipmentBrief'), false);
  });
});
