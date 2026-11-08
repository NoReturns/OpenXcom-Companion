'use strict';

/**
 * Deterministic equipment summary for AI briefing consumers (derived from tactical.units only).
 * Does not add relay fields; does not imply items are commandable without engine/binding checks.
 */

const {
  FACTION_PLAYER,
  BT_FIREARM,
  BT_AMMO,
  BT_MELEE,
  BT_GRENADE,
  BT_PROXIMITYGRENADE,
  BT_MEDIKIT,
} = require('./tactical-publish.cjs');

const EQUIPMENT_REVIEW_VERSION = 1;

const USABILITY_DISCLAIMER =
  'Snapshot equipment is situational awareness only. Presence does not imply usable TU, valid inventory slot, or Companion command support — verify actionCosts, actor AI ownership, and binding before ordering.';

const TACTICAL_CATEGORY = {
  STANDARD_GRENADE: 'standard_grenade',
  SMOKE_GRENADE: 'smoke_grenade',
  PROXIMITY_GRENADE: 'proximity_grenade',
  HIGH_EXPLOSIVE: 'high_explosive',
  MEDIKIT: 'medikit',
  FIREARM: 'firearm',
  AMMUNITION: 'ammunition',
  MELEE: 'melee',
  OTHER_TOOL: 'other_tool',
};

function unitLabel(unitId, name) {
  if (typeof name === 'string' && name.length > 0) {
    return `${name} (#${unitId})`;
  }
  return `Unit #${unitId}`;
}

function isFriendlyRosterSoldier(unit) {
  if (!unit || !Number.isInteger(unit.id) || unit.id >= 1_000_000) {
    return false;
  }
  return (
    unit.faction === FACTION_PLAYER &&
    unit.originalFaction === FACTION_PLAYER &&
    typeof unit.name === 'string' &&
    unit.name.length > 0
  );
}

function normalizeAiCommandActorIds(raw) {
  if (raw === null || raw === undefined) {
    return null;
  }
  const ids = raw instanceof Set ? [...raw] : Array.isArray(raw) ? raw : [];
  return new Set(ids.filter((id) => Number.isInteger(id)));
}

function inferGrenadeSubcategory(itemType) {
  if (typeof itemType !== 'string') {
    return TACTICAL_CATEGORY.STANDARD_GRENADE;
  }
  const upper = itemType.toUpperCase();
  if (upper.includes('SMOKE')) {
    return TACTICAL_CATEGORY.SMOKE_GRENADE;
  }
  if (upper.includes('HIGH_EXPLOSIVE') || upper.includes('BLASTER') || upper === 'STR_HC_AMMO' || upper.includes('_HE_')) {
    return TACTICAL_CATEGORY.HIGH_EXPLOSIVE;
  }
  return TACTICAL_CATEGORY.STANDARD_GRENADE;
}

function classifyTacticalItem(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }
  const bt = item.battleType;
  const itemType = item.itemType;

  if (bt === BT_PROXIMITYGRENADE || item.explosiveKind === 'proximity') {
    return TACTICAL_CATEGORY.PROXIMITY_GRENADE;
  }
  if (bt === BT_GRENADE || item.explosiveKind === 'timed') {
    return inferGrenadeSubcategory(itemType);
  }
  if (bt === BT_MEDIKIT) {
    return TACTICAL_CATEGORY.MEDIKIT;
  }
  if (bt === BT_FIREARM) {
    return TACTICAL_CATEGORY.FIREARM;
  }
  if (bt === BT_AMMO) {
    return TACTICAL_CATEGORY.AMMUNITION;
  }
  if (bt === BT_MELEE) {
    return TACTICAL_CATEGORY.MELEE;
  }
  if (typeof itemType === 'string' && itemType.length > 0) {
    return TACTICAL_CATEGORY.OTHER_TOOL;
  }
  return null;
}

function resolvePlacement(item, handSide) {
  if (handSide === 'right' || handSide === 'left') {
    return handSide === 'right' ? 'in_hand_right' : 'in_hand_left';
  }
  if (item.inventorySlotType === 'ground') {
    return 'on_ground_at_actor_tile';
  }
  if (item.inventorySlotType === 'hand' && (item.hand === 'right' || item.hand === 'left')) {
    return item.hand === 'right' ? 'in_hand_right' : 'in_hand_left';
  }
  return 'belt_or_backpack';
}

function medikitChargeSummary(charges) {
  if (!charges || typeof charges !== 'object') {
    return { depleted: true, detail: 'charges unknown' };
  }
  const heal = Number(charges.heal) || 0;
  const pain = Number(charges.painKiller) || 0;
  const stim = Number(charges.stimulant) || 0;
  const total = heal + pain + stim;
  return {
    depleted: total <= 0,
    heal,
    painKiller: pain,
    stimulant: stim,
    detail: `heal ${heal}, pain ${pain}, stim ${stim}`,
  };
}

function describeEquipmentEntry(item, placement) {
  const category = classifyTacticalItem(item);
  if (!category) {
    return null;
  }

  const base = {
    category,
    placement,
    itemType: item.itemType,
    battleType: item.battleType,
    battleItemId: Number.isInteger(item.battleItemId) ? item.battleItemId : undefined,
  };

  if (category === TACTICAL_CATEGORY.FIREARM) {
    if (item.noMagazineInserted) {
      base.ammunition = { state: 'no_magazine_inserted' };
    } else if (item.loaded && typeof item.loaded === 'object') {
      base.ammunition = {
        state: 'loaded',
        ammoType: item.loaded.ammoType,
        rounds: item.loaded.rounds,
        battleItemId: item.loaded.battleItemId,
      };
    } else if (item.empty === true) {
      base.ammunition = { state: 'empty_weapon' };
    } else {
      base.ammunition = { state: 'unknown' };
    }
  }

  if (category === TACTICAL_CATEGORY.AMMUNITION) {
    if (item.empty === true) {
      base.ammunition = { state: 'empty_clip' };
    } else if (item.loaded && typeof item.loaded === 'object') {
      base.ammunition = {
        state: 'spare_loaded',
        ammoType: item.loaded.ammoType,
        rounds: item.loaded.rounds,
      };
    } else if (item.nestedAmmo && typeof item.nestedAmmo === 'object') {
      base.ammunition = {
        state: 'nested_ammo',
        ammoType: item.nestedAmmo.ammoType,
        rounds: item.nestedAmmo.rounds,
        battleItemId: item.nestedAmmo.battleItemId,
      };
    } else {
      base.ammunition = { state: 'spare' };
    }
  }

  if (
    category === TACTICAL_CATEGORY.STANDARD_GRENADE ||
    category === TACTICAL_CATEGORY.SMOKE_GRENADE ||
    category === TACTICAL_CATEGORY.HIGH_EXPLOSIVE ||
    category === TACTICAL_CATEGORY.PROXIMITY_GRENADE
  ) {
    base.explosive = {
      primed: item.primed === true,
      fuseTimer: Number.isInteger(item.fuseTimer) ? item.fuseTimer : undefined,
      explosiveKind: item.explosiveKind,
    };
  }

  if (category === TACTICAL_CATEGORY.MEDIKIT) {
    base.medikit = medikitChargeSummary(item.medikitCharges);
  }

  return base;
}

/**
 * Walk hands, inventory, and actor-tile ground rows; dedupe by battleItemId (hands first).
 * @returns {{ entries: object[], duplicateBattleItemIdsSkipped: number }}
 */
function enumerateUnitEquipment(unit) {
  const entries = [];
  const seenBattleItemIds = new Set();
  let duplicateBattleItemIdsSkipped = 0;

  function tryAdd(item, handSide) {
    if (!item || typeof item !== 'object') {
      return;
    }
    const bid = item.battleItemId;
    if (Number.isInteger(bid)) {
      if (seenBattleItemIds.has(bid)) {
        duplicateBattleItemIdsSkipped += 1;
        return;
      }
      seenBattleItemIds.add(bid);
    }
    const described = describeEquipmentEntry(item, resolvePlacement(item, handSide));
    if (described) {
      entries.push(described);
    }
  }

  if (unit.hands && typeof unit.hands === 'object') {
    if (unit.hands.right) {
      tryAdd(unit.hands.right, 'right');
    }
    if (unit.hands.left) {
      tryAdd(unit.hands.left, 'left');
    }
  }

  if (Array.isArray(unit.inventory)) {
    for (const row of unit.inventory) {
      tryAdd(row, null);
    }
  }

  if (Array.isArray(unit.groundInventory)) {
    for (const row of unit.groundInventory) {
      const groundRow = { ...row, inventorySlotType: 'ground' };
      tryAdd(groundRow, null);
    }
  }

  return { entries, duplicateBattleItemIdsSkipped };
}

function formatEntryLine(entry) {
  const place =
    entry.placement === 'in_hand_right'
      ? 'right hand'
      : entry.placement === 'in_hand_left'
        ? 'left hand'
        : entry.placement === 'on_ground_at_actor_tile'
          ? 'ground (actor tile)'
          : 'belt/backpack';

  let detail = `${place}: ${entry.itemType}`;
  if (entry.explosive) {
    detail += entry.explosive.primed ? ' (primed' : ' (unprimed';
    if (entry.explosive.fuseTimer != null) {
      detail += `, fuse ${entry.explosive.fuseTimer}`;
    }
    detail += ')';
  }
  if (entry.ammunition?.state === 'loaded') {
    detail += ` loaded ${entry.ammunition.rounds}× ${entry.ammunition.ammoType}`;
  } else if (entry.ammunition?.state === 'empty_clip') {
    detail += ' (empty clip)';
  } else if (entry.ammunition?.state === 'no_magazine_inserted') {
    detail += ' (no magazine)';
  }
  if (entry.medikit) {
    detail += entry.medikit.depleted ? ' (depleted)' : ` (${entry.medikit.detail})`;
  }
  return detail;
}

function mindControlledRosterIds(relay, statusReview) {
  const fromStatus = (statusReview?.unitAssessments ?? [])
    .filter((row) => row.confirmed?.includes('mind_control'))
    .map((row) => row.unitId);
  const fromExceptions = (relay?.unitStateBrief?.exceptions ?? [])
    .filter((ex) => ex.kind === 'mind_controlled_roster_soldier' && Number.isInteger(ex.id))
    .map((ex) => ex.id);
  return new Set([...fromStatus, ...fromExceptions]);
}

function summarizeGroundItemObservations(groundItems) {
  if (!groundItems || !Array.isArray(groundItems.observations)) {
    return [];
  }
  const lines = [];
  for (const obs of groundItems.observations) {
    if (!obs || !Array.isArray(obs.items) || obs.items.length === 0) {
      continue;
    }
    const pos = obs.position;
    const posLabel =
      pos && Number.isInteger(pos.x) && Number.isInteger(pos.y) && Number.isInteger(pos.z)
        ? `(${pos.x},${pos.y},${pos.z})`
        : 'unknown tile';
    const labels = obs.items.map((it) => {
      const primed = it.primed === true ? ' primed' : '';
      return `${it.itemCategory || 'item'}${primed}`;
    });
    lines.push(`Ground ${posLabel}: ${labels.join(', ')} (${obs.observationStatus || 'unknown status'})`);
  }
  return lines;
}

function getEquipmentReviewContractMarkdown() {
  return [
    '## Mandatory tactical equipment review (M1)',
    '',
    'After battlefield status and **command-authority** checks (steps 5–6), and **before** terrain analysis or MOVE authoring, derive equipment from `tactical.units` for every **friendly roster soldier** (`faction`/`originalFaction` player, `id` < 1_000_000, `name` present).',
    '',
    'Include **human-owned** soldiers for situational awareness. Companion orders remain limited to operator-confirmed **AI-owned** actors in `commandBinding.player_soldiers` — never extend authority because equipment is visible on a human-controlled soldier.',
    '',
    'Inspect separately:',
    '',
    '- **Hands** (active weapons, held grenades, primed explosives)',
    '- **Belt/backpack** `inventory`',
    '- **`groundInventory`** on the actor’s tile (not the same as map `groundItems`)',
    '- **`tactical.groundItems`** observations for abandoned equipment (do not merge into personal carry counts)',
    '',
    'Classify tactically significant gear: standard/smoke/proximity grenades and high explosives; medikits and remaining charges; loaded firearms vs spare ammunition; other exported tools when present.',
    '',
    'Respect **primed vs unprimed**, **loaded vs spare ammo**, and **depleted** medikits/empty clips. When the same `battleItemId` appears in hands and inventory, count it **once** (hands win).',
    '',
    USABILITY_DISCLAIMER,
    '',
    'Programmatic mirror: `runMandatoryTacticalEquipmentReview(relay, { aiCommandActorIds })` in `tactical-briefing-ai-workflow.cjs`.',
    '',
  ].join('\n');
}

/**
 * @param {object} relay
 * @param {{ aiCommandActorIds?: number[]|Set|null, statusReview?: object }} [options]
 */
function runMandatoryTacticalEquipmentReview(relay, options = {}) {
  const tactical = relay?.tactical ?? null;
  const units = Array.isArray(tactical?.units) ? tactical.units : [];
  const binding = relay?.commandBinding ?? null;
  const commandedIds = new Set(
    (binding?.player_soldiers ?? []).map((s) => s.id).filter((id) => Number.isInteger(id)),
  );
  const aiActorIds = normalizeAiCommandActorIds(options.aiCommandActorIds);
  const mindControlled = mindControlledRosterIds(relay, options.statusReview);

  const soldiers = [];
  const equipmentSummaryLines = [];

  for (const unit of units) {
    if (!isFriendlyRosterSoldier(unit)) {
      continue;
    }

    const label = unitLabel(unit.id, unit.name);
    const { entries, duplicateBattleItemIdsSkipped } = enumerateUnitEquipment(unit);
    const inBinding = commandedIds.has(unit.id);
    const mindControl = mindControlled.has(unit.id);

    let companionOrderActor = null;
    if (aiActorIds !== null) {
      companionOrderActor = inBinding && !mindControl && aiActorIds.has(unit.id);
    }

    const soldierRow = {
      unitId: unit.id,
      label,
      inBinding,
      mindControl,
      companionOrderActor,
      situationalAwarenessOnly: aiActorIds !== null && !companionOrderActor,
      items: entries,
      duplicateBattleItemIdsSkipped,
      hasExportedEquipment: entries.length > 0,
      schemaHasHandsField: Object.prototype.hasOwnProperty.call(unit, 'hands'),
      schemaHasInventoryField: Object.prototype.hasOwnProperty.call(unit, 'inventory'),
    };
    soldiers.push(soldierRow);

    let authorityNote = '';
    if (companionOrderActor === true) {
      authorityNote = ' Companion command actor.';
    } else if (companionOrderActor === false) {
      authorityNote = ' Human-owned — situational awareness only; not a Companion command actor.';
    } else if (mindControl) {
      authorityNote = ' Mind-controlled — not commandable.';
    }

    if (entries.length === 0) {
      const exportNote =
        !soldierRow.schemaHasHandsField && !soldierRow.schemaHasInventoryField
          ? 'no equipment fields in snapshot (older schema)'
          : 'no tactically classified equipment exported';
      equipmentSummaryLines.push(`${label}: ${exportNote}.${authorityNote}`);
    } else {
      const parts = entries.map((e) => formatEntryLine(e));
      equipmentSummaryLines.push(`${label}: ${parts.join('; ')}.${authorityNote}`);
    }
  }

  soldiers.sort((a, b) => a.unitId - b.unitId);

  const groundLines = summarizeGroundItemObservations(tactical?.groundItems);
  equipmentSummaryLines.push(...groundLines);

  return {
    equipmentReviewVersion: EQUIPMENT_REVIEW_VERSION,
    sequenceCompleted: true,
    usabilityDisclaimer: USABILITY_DISCLAIMER,
    soldiers,
    equipmentSummaryLines,
    groundObservationLines: groundLines,
  };
}

module.exports = {
  EQUIPMENT_REVIEW_VERSION,
  TACTICAL_CATEGORY,
  USABILITY_DISCLAIMER,
  isFriendlyRosterSoldier,
  enumerateUnitEquipment,
  classifyTacticalItem,
  describeEquipmentEntry,
  getEquipmentReviewContractMarkdown,
  runMandatoryTacticalEquipmentReview,
};
