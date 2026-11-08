'use strict';

const crypto = require('node:crypto');
const { decodePackedV1Base64, maxPackedTerrainDataBase64Length } = require('./terrain-packed-v1.cjs');
const { decodeSparseV1Base64 } = require('./terrain-semantics-sparse-v1.cjs');
const { decodeSparseSemanticsBase64 } = require('./terrain-semantics-sparse-v2.cjs');
const { buildTerrainBrief } = require('./terrain-brief.cjs');
const { buildTerrainMapBrief } = require('./terrain-map-brief.cjs');
const { buildUnitStateBrief } = require('./unit-state-brief.cjs');
const { buildCommandBinding } = require('./command-binding.cjs');
const {
  isRosterSoldierUnitId,
  isFriendlyRosterSoldier,
  isMindControlledRosterSoldier,
  isNeutralCivilianUnit,
  isGenuineHostileUnit,
  isXcomControlledHostileUnit,
} = require('./unit-state-brief.cjs');

const FACTION_PLAYER = 0;
const FACTION_HOSTILE = 1;
const FACTION_NEUTRAL = 2;

const MAX_INPUT_BYTES = 256 * 1024;
const MAX_ITEM_TYPE_LENGTH = 128;
const MAX_SLOT_ID_LENGTH = 64;
const MAX_ACTIVE_HAND_LENGTH = 64;
const MAX_INVENTORY_ENTRIES = 24;
const MAX_GROUND_INVENTORY_ENTRIES_PER_UNIT = 16;
const MIN_BATTLE_TYPE = 0;
const MAX_BATTLE_TYPE = 11; // BT_CORPSE
const BT_FIREARM = 1;
const BT_AMMO = 2;
const BT_MELEE = 3;
const BT_GRENADE = 4;
const BT_PROXIMITYGRENADE = 5;
const BT_MEDIKIT = 6;
const MAX_BATTLE_ITEM_ID = 2147483647;
const MAX_INVENTORY_GRID = 32;

const ROOT_KEYS = new Set(['schemaVersion', 'turn', 'side', 'selectedUnitId', 'map', 'units', 'groundItems']);
const ROOT_KEYS_V4 = new Set([...ROOT_KEYS, 'eventLog', 'missionContext', 'perceptionLog', 'groundItems']);
const ROOT_KEYS_V5 = new Set([...ROOT_KEYS_V4, 'terrain']);
const TERRAIN_KEYS_VERBOSE = new Set(['memoryNote', 'tiles', 'semantics']);
const TERRAIN_KEYS_PACKED = new Set(['memoryNote', 'encoding', 'recordCount', 'data', 'semantics']);
const TERRAIN_SEMANTICS_KEYS = new Set(['encoding', 'recordCount', 'data']);
const TERRAIN_TILE_KEYS = new Set(['p', 'disc', 'inLos', 'body', 'west', 'north', 'sem']);
const TERRAIN_TILE_SEM_KEYS = new Set(['body', 'west', 'north']);
const MISSION_CONTEXT_KEYS = new Set([
  'schemaVersion',
  'missionType',
  'missionClass',
  'turnLimit',
  'siteKind',
]);
const ALLOWED_MISSION_CLASSES = new Set([
  'base_defense',
  'terror',
  'cydonia',
  'alien_base',
  'ufo_crash',
  'ufo_ground',
  'ufo_mission',
  'other',
]);
const ALLOWED_SITE_KINDS = new Set(['xcom_base', 'ufo_site']);
const ALLOWED_SEM_CATEGORY_IDS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
const TERRAIN_BODY_KEYS = new Set(['air', 'noFloor', 'elev', 'walkF', 'walkO', 'blockSightF', 'blockSightO']);
const TERRAIN_WALL_KEYS = new Set(['walk', 'blockSight']);
const MIN_WALK_TU = 0;
const MAX_WALK_TU = 255;
const DISC_WEST = 1;
const DISC_NORTH = 2;
const DISC_BODY = 4;
const MAP_KEYS = new Set(['width', 'height', 'depth']);
const UNIT_BASE_KEYS = new Set(['id', 'faction', 'originalFaction', 'position']);
const UNIT_FRIENDLY_V2_KEYS = new Set(['name', 'health', 'timeUnits']);
const UNIT_FRIENDLY_V3_KEYS = new Set([
  'kneeled',
  'activeHand',
  'hands',
  'inventory',
  'groundInventory',
  'actionCosts',
  'carriedWeight',
  'strength',
  'encumbranceRatio',
]);
const UNIT_FRIENDLY_WP2_KEYS = new Set(['facing', 'condition', 'readiness']);
const UNIT_OBSERVATION_KEYS = new Set(['observedUnitType', 'displayLabel']);
const UNIT_FACING_KEYS = new Set(['direction', 'label', 'vector', 'turning']);
const UNIT_FACING_VECTOR_KEYS = new Set(['dx', 'dy']);
const ALLOWED_FACING_LABELS = new Set([
  'north',
  'northeast',
  'east',
  'southeast',
  'south',
  'southwest',
  'west',
  'northwest',
]);
const UNIT_CONDITION_KEYS = new Set([
  'energy',
  'maxEnergy',
  'morale',
  'stunLevel',
  'alive',
  'conscious',
  'engineStatus',
  'engineStatusId',
  'floating',
  'movementTypeId',
  'movementType',
]);
const ALLOWED_ENGINE_STATUS = new Set([
  'standing',
  'walking',
  'flying',
  'turning',
  'aiming',
  'collapsing',
  'dead',
  'unconscious',
  'panicking',
  'berserk',
  'ignore',
  'unknown',
]);
const ALLOWED_MOVEMENT_TYPES = new Set(['walk', 'fly', 'slide', 'float', 'sink', 'unknown']);
const UNIT_READINESS_KEYS = new Set([
  'summary',
  'engineStatus',
  'liveRosterSoldier',
  'engineActingUnitAvailable',
  'observationNote',
]);
const ALLOWED_READINESS_SUMMARY = new Set([
  'ready_to_act',
  'dead',
  'unconscious',
  'panicking',
  'berserk',
  'collapsing',
  'battle_animation',
  'incapacitated',
  'unknown',
]);
const HANDS_KEYS = new Set(['right', 'left']);
const ACTION_COSTS_KEYS = new Set(['posture', 'hands']);
const POSTURE_KEYS = new Set(['kneelDownTu', 'standUpTu']);
const HAND_ACTION_COST_KEYS = new Set(['itemType', 'actions']);
const ACTION_ENTRY_KEYS = new Set(['id', 'actionType', 'tuCost', 'canAffordTu', 'usable']);
const ALLOWED_ACTION_IDS = new Set(['snap', 'aimed', 'auto', 'launch', 'throw', 'prime', 'melee']);
const ALLOWED_ACTION_TYPES = new Set([3, 4, 5, 6, 7, 8, 10]); // BA_* companion actions
const MAX_ACTIONS_PER_HAND = 16;
const EQUIPMENT_ITEM_KEYS = new Set([
  'battleItemId',
  'itemType',
  'battleType',
  'slot',
  'inventorySlotType',
  'hand',
  'inventoryX',
  'inventoryY',
  'loaded',
  'empty',
  'noMagazineInserted',
  'nestedAmmo',
  'primed',
  'fuseTimer',
  'explosiveKind',
  'medikitCharges',
]);
const LOADED_KEYS = new Set(['ammoType', 'rounds', 'battleItemId']);
const NESTED_AMMO_KEYS = new Set(['battleItemId', 'ammoType', 'rounds']);
const MEDIKIT_CHARGES_KEYS = new Set(['heal', 'painKiller', 'stimulant']);
const INVENTORY_SLOT_TYPES = new Set(['slot', 'hand', 'ground']);
const HAND_IDENTITY = new Set(['right', 'left']);
const INVENTORY_ENTRY_KEYS = new Set([
  'battleItemId',
  'slot',
  'inventorySlotType',
  'inventoryX',
  'inventoryY',
  'itemType',
  'battleType',
  'loaded',
  'empty',
  'noMagazineInserted',
  'nestedAmmo',
  'primed',
  'fuseTimer',
  'explosiveKind',
  'medikitCharges',
]);
const MAX_EVENT_LOG_EVENTS = 256;
const MAX_SESSION_ID_LENGTH = 32;
const EVENT_LOG_KEYS = new Set(['sessionId', 'oldestSeq', 'latestSeq', 'droppedCount', 'events']);
const EVENT_ENTRY_KEYS = new Set([
  'seq',
  'type',
  'turn',
  'actorUnitId',
  'weaponItemType',
  'actionType',
  'target',
  'autoShotIndex',
]);
const ALLOWED_EVENT_TYPES = new Set(['weapon_fired']);
const ALLOWED_WEAPON_FIRE_ACTION_TYPES = new Set(['snap', 'aimed', 'auto', 'launch']);

const MAX_PERCEPTION_LOG_EVENTS = 256;
const PERCEPTION_LOG_REQUIRED_KEYS = new Set([
  'sessionId',
  'oldestSeq',
  'latestSeq',
  'droppedCount',
  'events',
]);
const PERCEPTION_LOG_ALLOWED_KEYS = new Set([
  ...PERCEPTION_LOG_REQUIRED_KEYS,
  'rosterCasualtySummary',
]);
const ROSTER_CASUALTY_LEDGER_STATUSES = new Set(['unconscious', 'dead', 'standing']);
const MAX_ROSTER_CASUALTY_LEDGER_ENTRIES = 32;
const MAX_GROUND_ITEM_OBSERVATIONS = 64;
const MAX_GROUND_ITEMS_PER_TILE = 16;
const GROUND_ITEMS_KEYS = new Set(['schemaVersion', 'sessionId', 'memoryNote', 'droppedCount', 'observations']);
const GROUND_ITEM_OBS_KEYS = new Set(['position', 'observationStatus', 'items']);
const GROUND_ITEM_POSITION_KEYS = new Set(['x', 'y', 'z']);
const GROUND_ITEM_ENTRY_KEYS = new Set([
  'itemCategory',
  'battleType',
  'itemType',
  'quantity',
  'primed',
  'concealedOnTile',
]);
const ALLOWED_GROUND_OBS_STATUS = new Set(['CONFIRMED_IN_LOS', 'REMEMBERED_OFF_LOS']);
const ALLOWED_GROUND_ITEM_CATEGORIES = new Set([
  'firearm',
  'ammunition',
  'melee',
  'grenade',
  'proximity_grenade',
  'medikit',
  'scanner',
  'mind_probe',
  'psi_amp',
  'flare',
  'corpse',
  'unknown',
  'unidentified_firearm',
  'unidentified_ammunition',
  'unidentified_melee',
  'unidentified_grenade',
  'unidentified_proximity_grenade',
  'unidentified_medikit',
  'unidentified_scanner',
  'unidentified_mind_probe',
  'unidentified_psi_amp',
  'unidentified_flare',
  'unidentified_corpse',
  'unidentified_equipment',
  'additional_ground_item',
]);
const PERCEPTION_EVENT_KEYS = new Set([
  'seq',
  'type',
  'turn',
  'perceptionChannel',
  'confidence',
  'positionKnown',
  'position',
  'observerUnitId',
  'subjectUnitId',
  'subjectName',
  'compassDirection',
  'travelDirection',
  'incomingBearing',
]);
const PSYCHOLOGICAL_PERCEPTION_EVENT_TYPES = new Set([
  'soldier_panicked_observed',
  'soldier_berserk_observed',
  'alien_panicked_observed',
  'alien_berserk_observed',
  'soldier_mind_controlled_observed',
  'alien_mind_controlled_observed',
  'psi_morale_attack_observed',
]);
const ALIEN_PANIC_PSYCH_EVENT_TYPES = new Set(['alien_panicked_observed', 'alien_berserk_observed']);
const SOLDIER_CASUALTY_PERCEPTION_EVENT_TYPES = new Set(['soldier_down', 'soldier_recovered']);
const ALLOWED_PERCEPTION_EVENT_TYPES = new Set([
  'gunfire_observed',
  'impact_observed',
  'door_sound_heard',
  'unit_last_seen',
  'hostile_casualty_tile_observed',
  'explosion_observed_or_heard',
  'projectile_direction_observed',
  ...SOLDIER_CASUALTY_PERCEPTION_EVENT_TYPES,
  ...PSYCHOLOGICAL_PERCEPTION_EVENT_TYPES,
]);
const ALLOWED_PERCEPTION_CHANNELS = new Set(['heard', 'seen', 'seen_and_heard', 'notification']);
const ALLOWED_PERCEPTION_CONFIDENCE = new Set([
  'source_visible',
  'audio_only',
  'impact_visible',
  'visible_unit_hit',
  'visible_terrain_hit',
  'visible_impact_unclassified',
  'blast_visible',
  'door_visible',
  'sighted',
  'last_seen',
  'possible_ground_equipment',
  'alien_casualty_tile',
  'trajectory_observed',
  'trajectory_unavailable',
  'unit_visible',
  'message_notification',
  'unconscious',
  'dead',
  'standing',
]);

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

function assert(condition, message) {
  if (!condition) throw new ValidationError(message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireInt(value, label, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER, allowNegative = true } = {}) {
  assert(typeof value === 'number' && Number.isInteger(value), `${label} must be an integer`);
  if (!allowNegative) assert(value >= min, `${label} must be >= ${min}`);
  else assert(value >= min, `${label} out of range`);
  assert(value <= max, `${label} must be <= ${max}`);
  return value;
}

function requireFaction(value, label) {
  requireInt(value, label);
  assert(value === FACTION_PLAYER || value === FACTION_HOSTILE || value === FACTION_NEUTRAL, `${label} invalid`);
  return value;
}

function requireString(value, label, { maxLength = 256, allowEmpty = false } = {}) {
  assert(typeof value === 'string', `${label} must be a string`);
  assert(allowEmpty || value.length > 0, `${label} required`);
  assert(value.length <= maxLength, `${label} exceeds max length`);
  return value;
}

function requireBool(value, label) {
  assert(typeof value === 'boolean', `${label} must be a boolean`);
  return value;
}

function normalizePosition(value, label) {
  if (Array.isArray(value)) {
    assert(value.length === 3, `${label} must have three coordinates`);
    return [
      requireInt(value[0], `${label}[0]`, { min: 0, allowNegative: false }),
      requireInt(value[1], `${label}[1]`, { min: 0, allowNegative: false }),
      requireInt(value[2], `${label}[2]`, { min: 0, allowNegative: false }),
    ];
  }
  if (isPlainObject(value)) {
    return [
      requireInt(value.x, `${label}.x`, { min: 0, allowNegative: false }),
      requireInt(value.y, `${label}.y`, { min: 0, allowNegative: false }),
      requireInt(value.z, `${label}.z`, { min: 0, allowNegative: false }),
    ];
  }
  throw new ValidationError(`${label} must be a sequence or mapping`);
}

function isFriendlyPlayerControlled(unit) {
  return unit.originalFaction === FACTION_PLAYER && unit.faction === FACTION_PLAYER;
}

/**
 * Engine records weapon_fired only for deliberate player-ordered roster soldier fire.
 * Actors may be absent from units[] when dead, IGNORE_ME, or removed after firing.
 * Allow roster soldier ids from the log unless they are known hostile units in units[].
 */
function buildWeaponFireActorAllowlist(units, rawEvents) {
  const unitById = new Map(units.map((unit) => [unit.id, unit]));
  const allow = new Set(
    units.filter((unit) => isFriendlyPlayerControlled(unit)).map((unit) => unit.id),
  );
  for (const event of rawEvents) {
    if (!event || event.type !== 'weapon_fired') {
      continue;
    }
    const actorId = event.actorUnitId;
    if (!isRosterSoldierUnitId(actorId)) {
      continue;
    }
    const unitRow = unitById.get(actorId);
    if (unitRow && unitRow.originalFaction !== FACTION_PLAYER && unitRow.faction !== FACTION_PLAYER) {
      continue;
    }
    allow.add(actorId);
  }
  return allow;
}

/**
 * Psychological notifications may name roster soldiers even when units[] omits them
 * (dead, removed) or lists them under alien control (originalFaction still player).
 */
function isRosterSoldierPsychSubjectNameAllowed(subjectUnitId, units) {
  if (!isRosterSoldierUnitId(subjectUnitId)) {
    return false;
  }
  const unitById = new Map(units.map((unit) => [unit.id, unit]));
  const unitRow = unitById.get(subjectUnitId);
  if (!unitRow) {
    return true;
  }
  return unitRow.originalFaction === FACTION_PLAYER;
}

/** soldier_down / ledger: same rule as psych — KIA rows are absent from units[] after export. */
function isRosterSoldierCasualtySubjectNameAllowed(subjectUnitId, units) {
  return isRosterSoldierPsychSubjectNameAllowed(subjectUnitId, units);
}

function allowedUnitKeys(schemaVersion) {
  const keys = new Set(UNIT_BASE_KEYS);
  for (const k of UNIT_OBSERVATION_KEYS) keys.add(k);
  if (schemaVersion === 2) {
    for (const k of UNIT_FRIENDLY_V2_KEYS) keys.add(k);
    return keys;
  }
  for (const k of UNIT_FRIENDLY_V2_KEYS) keys.add(k);
  for (const k of UNIT_FRIENDLY_V3_KEYS) keys.add(k);
  for (const k of UNIT_FRIENDLY_WP2_KEYS) keys.add(k);
  return keys;
}

function validateFacing(raw, label) {
  assert(isPlainObject(raw), `${label} must be an object`);
  for (const key of Object.keys(raw)) {
    if (!UNIT_FACING_KEYS.has(key)) throw new ValidationError(`${label} unknown field: ${key}`);
  }
  assert(Object.prototype.hasOwnProperty.call(raw, 'direction'), `${label}.direction required`);
  const direction = requireInt(raw.direction, `${label}.direction`, { min: 0, max: 7, allowNegative: false });
  if (Object.prototype.hasOwnProperty.call(raw, 'label')) {
    const facingLabel = requireString(raw.label, `${label}.label`, { maxLength: 32 });
    assert(ALLOWED_FACING_LABELS.has(facingLabel), `${label}.label invalid`);
  }
  assert(Object.prototype.hasOwnProperty.call(raw, 'vector'), `${label}.vector required`);
  assert(isPlainObject(raw.vector), `${label}.vector must be an object`);
  for (const key of Object.keys(raw.vector)) {
    if (!UNIT_FACING_VECTOR_KEYS.has(key)) throw new ValidationError(`${label}.vector unknown field: ${key}`);
  }
  const dx = requireInt(raw.vector.dx, `${label}.vector.dx`, { min: -1, max: 1 });
  const dy = requireInt(raw.vector.dy, `${label}.vector.dy`, { min: -1, max: 1 });
  if (Object.prototype.hasOwnProperty.call(raw, 'turning')) {
    requireBool(raw.turning, `${label}.turning`);
  }
  return {
    direction,
    ...(Object.prototype.hasOwnProperty.call(raw, 'label') ? { label: raw.label } : {}),
    vector: { dx, dy },
    ...(Object.prototype.hasOwnProperty.call(raw, 'turning') ? { turning: raw.turning } : {}),
  };
}

function validateCondition(raw, label) {
  assert(isPlainObject(raw), `${label} must be an object`);
  for (const key of Object.keys(raw)) {
    if (!UNIT_CONDITION_KEYS.has(key)) throw new ValidationError(`${label} unknown field: ${key}`);
  }
  const condition = {
    energy: requireInt(raw.energy, `${label}.energy`, { min: 0, allowNegative: false }),
    morale: requireInt(raw.morale, `${label}.morale`, { min: 0, allowNegative: false }),
    stunLevel: requireInt(raw.stunLevel, `${label}.stunLevel`, { min: 0, allowNegative: false }),
    alive: requireBool(raw.alive, `${label}.alive`),
    conscious: requireBool(raw.conscious, `${label}.conscious`),
    engineStatus: requireString(raw.engineStatus, `${label}.engineStatus`, { maxLength: 32 }),
    engineStatusId: requireInt(raw.engineStatusId, `${label}.engineStatusId`, { min: 0, max: 10, allowNegative: false }),
    floating: requireBool(raw.floating, `${label}.floating`),
    movementTypeId: requireInt(raw.movementTypeId, `${label}.movementTypeId`, { min: 0, max: 4, allowNegative: false }),
    movementType: requireString(raw.movementType, `${label}.movementType`, { maxLength: 16 }),
  };
  assert(ALLOWED_ENGINE_STATUS.has(condition.engineStatus), `${label}.engineStatus invalid`);
  assert(ALLOWED_MOVEMENT_TYPES.has(condition.movementType), `${label}.movementType invalid`);
  if (Object.prototype.hasOwnProperty.call(raw, 'maxEnergy')) {
    condition.maxEnergy = requireInt(raw.maxEnergy, `${label}.maxEnergy`, { min: 0, allowNegative: false });
  }
  return condition;
}

function validateReadiness(raw, label) {
  assert(isPlainObject(raw), `${label} must be an object`);
  for (const key of Object.keys(raw)) {
    if (!UNIT_READINESS_KEYS.has(key) && key !== 'companionCommandActorEligible' && key !== 'note') {
      throw new ValidationError(`${label} unknown field: ${key}`);
    }
  }
  let engineActingUnitAvailable;
  if (Object.prototype.hasOwnProperty.call(raw, 'engineActingUnitAvailable')) {
    engineActingUnitAvailable = requireBool(raw.engineActingUnitAvailable, `${label}.engineActingUnitAvailable`);
  } else if (Object.prototype.hasOwnProperty.call(raw, 'companionCommandActorEligible')) {
    engineActingUnitAvailable = requireBool(
      raw.companionCommandActorEligible,
      `${label}.companionCommandActorEligible (legacy)`
    );
  } else {
    assert(false, `${label}.engineActingUnitAvailable required`);
  }
  let observationNote;
  if (Object.prototype.hasOwnProperty.call(raw, 'observationNote')) {
    observationNote = requireString(raw.observationNote, `${label}.observationNote`, { maxLength: 512 });
  } else if (Object.prototype.hasOwnProperty.call(raw, 'note')) {
    observationNote = requireString(raw.note, `${label}.note (legacy)`, { maxLength: 512 });
  } else {
    assert(false, `${label}.observationNote required`);
  }
  const readiness = {
    summary: requireString(raw.summary, `${label}.summary`, { maxLength: 32 }),
    engineStatus: requireString(raw.engineStatus, `${label}.engineStatus`, { maxLength: 32 }),
    liveRosterSoldier: requireBool(raw.liveRosterSoldier, `${label}.liveRosterSoldier`),
    engineActingUnitAvailable,
    observationNote,
  };
  assert(ALLOWED_READINESS_SUMMARY.has(readiness.summary), `${label}.summary invalid`);
  assert(ALLOWED_ENGINE_STATUS.has(readiness.engineStatus), `${label}.engineStatus invalid`);
  return readiness;
}

function validateActionEntry(raw, label) {
  assert(isPlainObject(raw), `${label} must be an object`);
  for (const key of Object.keys(raw)) {
    if (!ACTION_ENTRY_KEYS.has(key)) throw new ValidationError(`${label} unknown field: ${key}`);
  }
  for (const key of ACTION_ENTRY_KEYS) {
    assert(Object.prototype.hasOwnProperty.call(raw, key), `${label}.${key} required`);
  }
  const id = requireString(raw.id, `${label}.id`, { maxLength: 32 });
  assert(ALLOWED_ACTION_IDS.has(id), `${label}.id invalid`);
  const actionType = requireInt(raw.actionType, `${label}.actionType`, { min: 0, allowNegative: false });
  assert(ALLOWED_ACTION_TYPES.has(actionType), `${label}.actionType invalid`);
  const tuCost = requireInt(raw.tuCost, `${label}.tuCost`, { min: 0, allowNegative: false });
  const canAffordTu = requireBool(raw.canAffordTu, `${label}.canAffordTu`);
  const usable = requireBool(raw.usable, `${label}.usable`);
  return { id, actionType, tuCost, canAffordTu, usable };
}

function validateHandActionCosts(raw, label) {
  assert(isPlainObject(raw), `${label} must be an object`);
  for (const key of Object.keys(raw)) {
    if (!HAND_ACTION_COST_KEYS.has(key)) throw new ValidationError(`${label} unknown field: ${key}`);
  }
  assert(Object.prototype.hasOwnProperty.call(raw, 'actions'), `${label}.actions required`);
  assert(Array.isArray(raw.actions), `${label}.actions must be an array`);
  assert(raw.actions.length <= MAX_ACTIONS_PER_HAND, `${label}.actions exceeds ${MAX_ACTIONS_PER_HAND} entries`);
  const hand = {
    actions: raw.actions.map((entry, index) => validateActionEntry(entry, `${label}.actions[${index}]`)),
  };
  if (Object.prototype.hasOwnProperty.call(raw, 'itemType')) {
    hand.itemType = requireString(raw.itemType, `${label}.itemType`, { maxLength: MAX_ITEM_TYPE_LENGTH });
  }
  return hand;
}

function validateActionCosts(raw, label) {
  assert(isPlainObject(raw), `${label} must be an object`);
  for (const key of Object.keys(raw)) {
    if (!ACTION_COSTS_KEYS.has(key)) throw new ValidationError(`${label} unknown field: ${key}`);
  }
  assert(Object.prototype.hasOwnProperty.call(raw, 'posture'), `${label}.posture required`);
  assert(Object.prototype.hasOwnProperty.call(raw, 'hands'), `${label}.hands required`);
  assert(isPlainObject(raw.posture), `${label}.posture must be an object`);
  for (const key of Object.keys(raw.posture)) {
    if (!POSTURE_KEYS.has(key)) throw new ValidationError(`${label}.posture unknown field: ${key}`);
  }
  for (const key of POSTURE_KEYS) {
    assert(Object.prototype.hasOwnProperty.call(raw.posture, key), `${label}.posture.${key} required`);
  }
  const posture = {
    kneelDownTu: requireInt(raw.posture.kneelDownTu, `${label}.posture.kneelDownTu`, { min: 0, allowNegative: false }),
    standUpTu: requireInt(raw.posture.standUpTu, `${label}.posture.standUpTu`, { min: 0, allowNegative: false }),
  };
  assert(isPlainObject(raw.hands), `${label}.hands must be an object`);
  for (const key of Object.keys(raw.hands)) {
    if (!HANDS_KEYS.has(key)) throw new ValidationError(`${label}.hands unknown field: ${key}`);
  }
  for (const key of HANDS_KEYS) {
    assert(Object.prototype.hasOwnProperty.call(raw.hands, key), `${label}.hands.${key} required`);
  }
  return {
    posture,
    hands: {
      right: validateHandActionCosts(raw.hands.right, `${label}.hands.right`),
      left: validateHandActionCosts(raw.hands.left, `${label}.hands.left`),
    },
  };
}

function validateLoaded(raw, label) {
  assert(isPlainObject(raw), `${label} must be an object`);
  for (const key of Object.keys(raw)) {
    if (!LOADED_KEYS.has(key)) throw new ValidationError(`${label} unknown field: ${key}`);
  }
  assert(Object.prototype.hasOwnProperty.call(raw, 'ammoType'), `${label}.ammoType required`);
  assert(Object.prototype.hasOwnProperty.call(raw, 'rounds'), `${label}.rounds required`);
  const loaded = {
    ammoType: requireString(raw.ammoType, `${label}.ammoType`, { maxLength: MAX_ITEM_TYPE_LENGTH }),
    rounds: requireInt(raw.rounds, `${label}.rounds`, { min: 0, allowNegative: false }),
  };
  if (Object.prototype.hasOwnProperty.call(raw, 'battleItemId')) {
    loaded.battleItemId = requireInt(raw.battleItemId, `${label}.battleItemId`, {
      min: 0,
      max: MAX_BATTLE_ITEM_ID,
      allowNegative: false,
    });
  }
  return loaded;
}

function validateNestedAmmo(raw, label) {
  assert(isPlainObject(raw), `${label} must be an object`);
  for (const key of Object.keys(raw)) {
    if (!NESTED_AMMO_KEYS.has(key)) throw new ValidationError(`${label} unknown field: ${key}`);
  }
  assert(Object.prototype.hasOwnProperty.call(raw, 'battleItemId'), `${label}.battleItemId required`);
  assert(Object.prototype.hasOwnProperty.call(raw, 'ammoType'), `${label}.ammoType required`);
  assert(Object.prototype.hasOwnProperty.call(raw, 'rounds'), `${label}.rounds required`);
  return {
    battleItemId: requireInt(raw.battleItemId, `${label}.battleItemId`, {
      min: 0,
      max: MAX_BATTLE_ITEM_ID,
      allowNegative: false,
    }),
    ammoType: requireString(raw.ammoType, `${label}.ammoType`, { maxLength: MAX_ITEM_TYPE_LENGTH }),
    rounds: requireInt(raw.rounds, `${label}.rounds`, { min: 0, allowNegative: false }),
  };
}

function validateMedikitCharges(raw, label) {
  assert(isPlainObject(raw), `${label} must be an object`);
  for (const key of Object.keys(raw)) {
    if (!MEDIKIT_CHARGES_KEYS.has(key)) throw new ValidationError(`${label} unknown field: ${key}`);
  }
  const out = {};
  for (const key of MEDIKIT_CHARGES_KEYS) {
    assert(Object.prototype.hasOwnProperty.call(raw, key), `${label}.${key} required`);
    out[key] = requireInt(raw[key], `${label}.${key}`, { min: 0, allowNegative: false });
  }
  return out;
}

function assertEquipmentFieldSemantics(item, label, raw) {
  const bt = item.battleType;
  const isGrenade = bt === BT_GRENADE || bt === BT_PROXIMITYGRENADE;
  const slotType = item.inventorySlotType;

  if (bt === BT_AMMO) {
    assert(!Object.prototype.hasOwnProperty.call(raw, 'empty'), `${label} must not include empty`);
    assert(!Object.prototype.hasOwnProperty.call(raw, 'loaded'), `${label} must not include loaded`);
    assert(!Object.prototype.hasOwnProperty.call(raw, 'primed'), `${label} must not include primed`);
    assert(!Object.prototype.hasOwnProperty.call(raw, 'nestedAmmo'), `${label} must not include nestedAmmo`);
    assert(!Object.prototype.hasOwnProperty.call(raw, 'noMagazineInserted'), `${label} must not include noMagazineInserted`);
    return;
  }
  if (isGrenade) {
    assert(!Object.prototype.hasOwnProperty.call(raw, 'empty'), `${label} must not include empty`);
    assert(!Object.prototype.hasOwnProperty.call(raw, 'loaded'), `${label} must not include loaded`);
    assert(!Object.prototype.hasOwnProperty.call(raw, 'nestedAmmo'), `${label} must not include nestedAmmo`);
    assert(!Object.prototype.hasOwnProperty.call(raw, 'noMagazineInserted'), `${label} must not include noMagazineInserted`);
  }
  if (bt === BT_FIREARM) {
    assert(!Object.prototype.hasOwnProperty.call(raw, 'primed'), `${label} must not include primed`);
    assert(!Object.prototype.hasOwnProperty.call(raw, 'medikitCharges'), `${label} must not include medikitCharges`);
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'empty')) {
    assert(bt === BT_FIREARM, `${label}.empty is only valid on firearms`);
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'noMagazineInserted')) {
    assert(bt === BT_FIREARM, `${label}.noMagazineInserted is only valid on firearms`);
    assert(!Object.prototype.hasOwnProperty.call(raw, 'loaded'), `${label} must not combine loaded with noMagazineInserted`);
    assert(!Object.prototype.hasOwnProperty.call(raw, 'nestedAmmo'), `${label} must not combine nestedAmmo with noMagazineInserted`);
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'nestedAmmo')) {
    assert(bt === BT_FIREARM, `${label}.nestedAmmo is only valid on firearms`);
    assert(!Object.prototype.hasOwnProperty.call(raw, 'noMagazineInserted'), `${label} must not combine nestedAmmo with noMagazineInserted`);
    if (Object.prototype.hasOwnProperty.call(raw, 'empty') && raw.empty === true) {
      assert(
        raw.nestedAmmo && raw.nestedAmmo.rounds === 0,
        `${label}.empty true with nestedAmmo requires a dry magazine (nestedAmmo.rounds 0)`,
      );
    }
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'empty') && raw.empty === true && bt === BT_FIREARM) {
    assert(
      Object.prototype.hasOwnProperty.call(raw, 'loaded'),
      `${label}.empty true requires loaded (include rounds 0 for dry magazine) or use noMagazineInserted for no magazine`,
    );
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'loaded')) {
    assert(bt === BT_FIREARM, `${label}.loaded is only valid on firearms`);
    if (raw.loaded && raw.loaded.rounds === 0) {
      assert(Object.prototype.hasOwnProperty.call(raw, 'empty') && raw.empty === true,
        `${label}.loaded with 0 rounds requires empty true`);
    }
    if (raw.loaded && raw.loaded.rounds > 0) {
      assert(!Object.prototype.hasOwnProperty.call(raw, 'empty'), `${label} must not include empty when loaded has rounds`);
    }
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'primed')) {
    assert(isGrenade, `${label}.primed is only valid on grenades`);
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'fuseTimer')) {
    assert(isGrenade, `${label}.fuseTimer is only valid on grenades`);
    assert(Object.prototype.hasOwnProperty.call(raw, 'primed') && raw.primed === true,
      `${label}.fuseTimer requires primed true`);
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'explosiveKind')) {
    assert(isGrenade, `${label}.explosiveKind is only valid on grenades`);
    assert(
      raw.explosiveKind === 'timed' || raw.explosiveKind === 'proximity',
      `${label}.explosiveKind must be timed or proximity`,
    );
    if (bt === BT_GRENADE) {
      assert(raw.explosiveKind === 'timed', `${label}.explosiveKind must be timed for battleType grenade`);
    }
    if (bt === BT_PROXIMITYGRENADE) {
      assert(raw.explosiveKind === 'proximity', `${label}.explosiveKind must be proximity for battleType proximity_grenade`);
    }
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'medikitCharges')) {
    assert(bt === BT_MEDIKIT, `${label}.medikitCharges is only valid on medikits`);
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'inventoryX') || Object.prototype.hasOwnProperty.call(raw, 'inventoryY')) {
    assert(
      slotType === 'slot' || slotType === 'ground',
      `${label}.inventory coordinates require inventorySlotType slot or ground`,
    );
    assert(
      Object.prototype.hasOwnProperty.call(raw, 'inventoryX') && Object.prototype.hasOwnProperty.call(raw, 'inventoryY'),
      `${label} inventoryX and inventoryY must appear together`,
    );
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'hand')) {
    assert(slotType === 'hand', `${label}.hand requires inventorySlotType hand`);
    assert(HAND_IDENTITY.has(raw.hand), `${label}.hand invalid`);
  }
}

function validateEquipmentItem(raw, label) {
  if (raw === null) {
    return null;
  }
  assert(isPlainObject(raw), `${label} must be an object or null`);
  for (const key of Object.keys(raw)) {
    if (!EQUIPMENT_ITEM_KEYS.has(key)) {
      throw new ValidationError(`${label} unknown field: ${key}`);
    }
  }
  assert(Object.prototype.hasOwnProperty.call(raw, 'itemType'), `${label}.itemType required`);
  assert(Object.prototype.hasOwnProperty.call(raw, 'battleType'), `${label}.battleType required`);

  const item = {
    itemType: requireString(raw.itemType, `${label}.itemType`, { maxLength: MAX_ITEM_TYPE_LENGTH }),
    battleType: requireInt(raw.battleType, `${label}.battleType`, {
      min: MIN_BATTLE_TYPE,
      allowNegative: false,
    }),
  };
  assert(item.battleType <= MAX_BATTLE_TYPE, `${label}.battleType out of range`);

  if (Object.prototype.hasOwnProperty.call(raw, 'battleItemId')) {
    item.battleItemId = requireInt(raw.battleItemId, `${label}.battleItemId`, {
      min: 0,
      max: MAX_BATTLE_ITEM_ID,
      allowNegative: false,
    });
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'slot')) {
    item.slot = requireString(raw.slot, `${label}.slot`, { maxLength: MAX_SLOT_ID_LENGTH });
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'inventorySlotType')) {
    const st = requireString(raw.inventorySlotType, `${label}.inventorySlotType`, { maxLength: 16 });
    assert(INVENTORY_SLOT_TYPES.has(st), `${label}.inventorySlotType invalid`);
    item.inventorySlotType = st;
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'hand')) {
    assert(HAND_IDENTITY.has(raw.hand), `${label}.hand invalid`);
    item.hand = raw.hand;
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'inventoryX')) {
    item.inventoryX = requireInt(raw.inventoryX, `${label}.inventoryX`, {
      min: 0,
      max: MAX_INVENTORY_GRID,
      allowNegative: false,
    });
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'inventoryY')) {
    item.inventoryY = requireInt(raw.inventoryY, `${label}.inventoryY`, {
      min: 0,
      max: MAX_INVENTORY_GRID,
      allowNegative: false,
    });
  }

  if (Object.prototype.hasOwnProperty.call(raw, 'loaded')) {
    item.loaded = validateLoaded(raw.loaded, `${label}.loaded`);
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'empty')) {
    item.empty = requireBool(raw.empty, `${label}.empty`);
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'noMagazineInserted')) {
    item.noMagazineInserted = requireBool(raw.noMagazineInserted, `${label}.noMagazineInserted`);
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'nestedAmmo')) {
    item.nestedAmmo = validateNestedAmmo(raw.nestedAmmo, `${label}.nestedAmmo`);
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'primed')) {
    item.primed = requireBool(raw.primed, `${label}.primed`);
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'fuseTimer')) {
    item.fuseTimer = requireInt(raw.fuseTimer, `${label}.fuseTimer`, { min: 0, max: 23, allowNegative: false });
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'explosiveKind')) {
    item.explosiveKind = requireString(raw.explosiveKind, `${label}.explosiveKind`, { maxLength: 16 });
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'medikitCharges')) {
    item.medikitCharges = validateMedikitCharges(raw.medikitCharges, `${label}.medikitCharges`);
  }
  assertEquipmentFieldSemantics(item, label, raw);
  return item;
}

function validateHands(raw, label) {
  assert(isPlainObject(raw), `${label} must be an object`);
  for (const key of Object.keys(raw)) {
    if (!HANDS_KEYS.has(key)) throw new ValidationError(`${label} unknown field: ${key}`);
  }
  assert(Object.prototype.hasOwnProperty.call(raw, 'right'), `${label}.right required`);
  assert(Object.prototype.hasOwnProperty.call(raw, 'left'), `${label}.left required`);
  return {
    right: validateEquipmentItem(raw.right, `${label}.right`),
    left: validateEquipmentItem(raw.left, `${label}.left`),
  };
}

function validateGroundInventory(raw, label) {
  assert(Array.isArray(raw), `${label} must be an array`);
  assert(raw.length <= MAX_GROUND_INVENTORY_ENTRIES_PER_UNIT,
    `${label} exceeds ${MAX_GROUND_INVENTORY_ENTRIES_PER_UNIT} entries`);
  return raw.map((entry, index) => {
    const entryLabel = `${label}[${index}]`;
    assert(isPlainObject(entry), `${entryLabel} must be an object`);
    for (const key of Object.keys(entry)) {
      if (!INVENTORY_ENTRY_KEYS.has(key)) {
        throw new ValidationError(`${entryLabel} unknown field: ${key}`);
      }
    }
    assert(Object.prototype.hasOwnProperty.call(entry, 'slot'), `${entryLabel}.slot required`);
    assert(entry.slot === 'STR_GROUND', `${entryLabel}.slot must be STR_GROUND`);
    assert(Object.prototype.hasOwnProperty.call(entry, 'inventorySlotType'), `${entryLabel}.inventorySlotType required`);
    assert(entry.inventorySlotType === 'ground', `${entryLabel}.inventorySlotType must be ground`);
    assert(Object.prototype.hasOwnProperty.call(entry, 'itemType'), `${entryLabel}.itemType required`);
    assert(Object.prototype.hasOwnProperty.call(entry, 'battleType'), `${entryLabel}.battleType required`);
    const row = {
      slot: 'STR_GROUND',
      inventorySlotType: 'ground',
      itemType: requireString(entry.itemType, `${entryLabel}.itemType`, { maxLength: MAX_ITEM_TYPE_LENGTH }),
      battleType: requireInt(entry.battleType, `${entryLabel}.battleType`, {
        min: MIN_BATTLE_TYPE,
        allowNegative: false,
      }),
    };
    assert(row.battleType <= MAX_BATTLE_TYPE, `${entryLabel}.battleType out of range`);
    if (Object.prototype.hasOwnProperty.call(entry, 'battleItemId')) {
      row.battleItemId = requireInt(entry.battleItemId, `${entryLabel}.battleItemId`, {
        min: 0,
        max: MAX_BATTLE_ITEM_ID,
        allowNegative: false,
      });
    }
    row.inventoryX = requireInt(entry.inventoryX, `${entryLabel}.inventoryX`, {
      min: 0,
      max: MAX_INVENTORY_GRID,
      allowNegative: false,
    });
    row.inventoryY = requireInt(entry.inventoryY, `${entryLabel}.inventoryY`, {
      min: 0,
      max: MAX_INVENTORY_GRID,
      allowNegative: false,
    });
    if (Object.prototype.hasOwnProperty.call(entry, 'loaded')) {
      row.loaded = validateLoaded(entry.loaded, `${entryLabel}.loaded`);
    }
    if (Object.prototype.hasOwnProperty.call(entry, 'empty')) {
      row.empty = requireBool(entry.empty, `${entryLabel}.empty`);
    }
    if (Object.prototype.hasOwnProperty.call(entry, 'noMagazineInserted')) {
      row.noMagazineInserted = requireBool(entry.noMagazineInserted, `${entryLabel}.noMagazineInserted`);
    }
    if (Object.prototype.hasOwnProperty.call(entry, 'nestedAmmo')) {
      row.nestedAmmo = validateNestedAmmo(entry.nestedAmmo, `${entryLabel}.nestedAmmo`);
    }
    if (Object.prototype.hasOwnProperty.call(entry, 'primed')) {
      row.primed = requireBool(entry.primed, `${entryLabel}.primed`);
    }
    if (Object.prototype.hasOwnProperty.call(entry, 'fuseTimer')) {
      row.fuseTimer = requireInt(entry.fuseTimer, `${entryLabel}.fuseTimer`, { min: 0, max: 23, allowNegative: false });
    }
    if (Object.prototype.hasOwnProperty.call(entry, 'explosiveKind')) {
      row.explosiveKind = requireString(entry.explosiveKind, `${entryLabel}.explosiveKind`, { maxLength: 16 });
    }
    if (Object.prototype.hasOwnProperty.call(entry, 'medikitCharges')) {
      row.medikitCharges = validateMedikitCharges(entry.medikitCharges, `${entryLabel}.medikitCharges`);
    }
    assertEquipmentFieldSemantics(row, entryLabel, entry);
    return row;
  });
}

function validateInventory(raw, label) {
  assert(Array.isArray(raw), `${label} must be an array`);
  assert(raw.length <= MAX_INVENTORY_ENTRIES, `${label} exceeds ${MAX_INVENTORY_ENTRIES} entries`);
  return raw.map((entry, index) => {
    const entryLabel = `${label}[${index}]`;
    assert(isPlainObject(entry), `${entryLabel} must be an object`);
    for (const key of Object.keys(entry)) {
      if (!INVENTORY_ENTRY_KEYS.has(key)) {
        throw new ValidationError(`${entryLabel} unknown field: ${key}`);
      }
    }
    assert(Object.prototype.hasOwnProperty.call(entry, 'slot'), `${entryLabel}.slot required`);
    assert(Object.prototype.hasOwnProperty.call(entry, 'itemType'), `${entryLabel}.itemType required`);
    assert(Object.prototype.hasOwnProperty.call(entry, 'battleType'), `${entryLabel}.battleType required`);
    const row = {
      slot: requireString(entry.slot, `${entryLabel}.slot`, { maxLength: MAX_SLOT_ID_LENGTH }),
      itemType: requireString(entry.itemType, `${entryLabel}.itemType`, { maxLength: MAX_ITEM_TYPE_LENGTH }),
      battleType: requireInt(entry.battleType, `${entryLabel}.battleType`, {
        min: MIN_BATTLE_TYPE,
        allowNegative: false,
      }),
    };
    assert(row.battleType <= MAX_BATTLE_TYPE, `${entryLabel}.battleType out of range`);
    if (Object.prototype.hasOwnProperty.call(entry, 'battleItemId')) {
      row.battleItemId = requireInt(entry.battleItemId, `${entryLabel}.battleItemId`, {
        min: 0,
        max: MAX_BATTLE_ITEM_ID,
        allowNegative: false,
      });
    }
    if (Object.prototype.hasOwnProperty.call(entry, 'inventorySlotType')) {
      const st = requireString(entry.inventorySlotType, `${entryLabel}.inventorySlotType`, { maxLength: 16 });
      assert(INVENTORY_SLOT_TYPES.has(st), `${entryLabel}.inventorySlotType invalid`);
      row.inventorySlotType = st;
    }
    if (Object.prototype.hasOwnProperty.call(entry, 'inventoryX')) {
      row.inventoryX = requireInt(entry.inventoryX, `${entryLabel}.inventoryX`, {
        min: 0,
        max: MAX_INVENTORY_GRID,
        allowNegative: false,
      });
    }
    if (Object.prototype.hasOwnProperty.call(entry, 'inventoryY')) {
      row.inventoryY = requireInt(entry.inventoryY, `${entryLabel}.inventoryY`, {
        min: 0,
        max: MAX_INVENTORY_GRID,
        allowNegative: false,
      });
    }
    if (Object.prototype.hasOwnProperty.call(entry, 'loaded')) {
      row.loaded = validateLoaded(entry.loaded, `${entryLabel}.loaded`);
    }
    if (Object.prototype.hasOwnProperty.call(entry, 'empty')) {
      row.empty = requireBool(entry.empty, `${entryLabel}.empty`);
    }
    if (Object.prototype.hasOwnProperty.call(entry, 'noMagazineInserted')) {
      row.noMagazineInserted = requireBool(entry.noMagazineInserted, `${entryLabel}.noMagazineInserted`);
    }
    if (Object.prototype.hasOwnProperty.call(entry, 'nestedAmmo')) {
      row.nestedAmmo = validateNestedAmmo(entry.nestedAmmo, `${entryLabel}.nestedAmmo`);
    }
    if (Object.prototype.hasOwnProperty.call(entry, 'primed')) {
      row.primed = requireBool(entry.primed, `${entryLabel}.primed`);
    }
    if (Object.prototype.hasOwnProperty.call(entry, 'fuseTimer')) {
      row.fuseTimer = requireInt(entry.fuseTimer, `${entryLabel}.fuseTimer`, { min: 0, max: 23, allowNegative: false });
    }
    if (Object.prototype.hasOwnProperty.call(entry, 'explosiveKind')) {
      row.explosiveKind = requireString(entry.explosiveKind, `${entryLabel}.explosiveKind`, { maxLength: 16 });
    }
    if (Object.prototype.hasOwnProperty.call(entry, 'medikitCharges')) {
      row.medikitCharges = validateMedikitCharges(entry.medikitCharges, `${entryLabel}.medikitCharges`);
    }
    assertEquipmentFieldSemantics(row, entryLabel, entry);
    return row;
  });
}

function validateUnit(raw, index, schemaVersion = 2) {
  assert(isPlainObject(raw), `units[${index}] must be an object`);
  const allowed = allowedUnitKeys(schemaVersion);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw new ValidationError(`units[${index}] unknown field: ${key}`);
    }
  }

  const unit = {
    id: requireInt(raw.id, `units[${index}].id`),
    faction: requireFaction(raw.faction, `units[${index}].faction`),
    originalFaction: requireFaction(raw.originalFaction, `units[${index}].originalFaction`),
    position: normalizePosition(raw.position, `units[${index}].position`),
  };

  const friendly = isFriendlyPlayerControlled(unit);
  const friendlyRosterSoldier = isFriendlyRosterSoldier(unit);
  const mindControlledRoster = isMindControlledRosterSoldier(unit);
  const neutralCivilian = isNeutralCivilianUnit(unit);
  const genuineHostile = isGenuineHostileUnit(unit);
  const xcomControlledHostile = isXcomControlledHostileUnit(unit);
  const v2Extras = ['name', 'health', 'timeUnits'];
  const v3Extras = [...UNIT_FRIENDLY_V3_KEYS];
  const wp2FriendlyOnlyExtras = ['condition', 'readiness'];
  const schemaSupportsV3UnitFields = schemaVersion >= 3;

  for (const key of v2Extras) {
    if (key === 'name' && mindControlledRoster) {
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(raw, key) && !friendlyRosterSoldier) {
      throw new ValidationError(`units[${index}] must not include ${key}`);
    }
  }
  for (const key of v3Extras) {
    if (key === 'kneeled' && !friendly && Object.prototype.hasOwnProperty.call(raw, 'kneeled')) {
      continue;
    }
    if (schemaSupportsV3UnitFields && Object.prototype.hasOwnProperty.call(raw, key) && !friendlyRosterSoldier) {
      throw new ValidationError(`units[${index}] must not include ${key}`);
    }
    if (schemaVersion === 2 && Object.prototype.hasOwnProperty.call(raw, key)) {
      throw new ValidationError(`units[${index}] must not include ${key}`);
    }
  }
  for (const key of wp2FriendlyOnlyExtras) {
    if (Object.prototype.hasOwnProperty.call(raw, key) && !friendlyRosterSoldier) {
      throw new ValidationError(`units[${index}] must not include ${key}`);
    }
    if (schemaVersion === 2 && Object.prototype.hasOwnProperty.call(raw, key)) {
      throw new ValidationError(`units[${index}] must not include ${key}`);
    }
  }
  if (schemaVersion === 2 && Object.prototype.hasOwnProperty.call(raw, 'facing')) {
    throw new ValidationError(`units[${index}] must not include facing`);
  }
  if (!friendly && Object.prototype.hasOwnProperty.call(raw, 'facing')) {
    unit.facing = validateFacing(raw.facing, `units[${index}].facing`);
  }
  if (!friendly && Object.prototype.hasOwnProperty.call(raw, 'kneeled')) {
    unit.kneeled = requireBool(raw.kneeled, `units[${index}].kneeled`);
  }

  if (friendlyRosterSoldier) {
    if (Object.prototype.hasOwnProperty.call(raw, 'observedUnitType')
      || Object.prototype.hasOwnProperty.call(raw, 'displayLabel')) {
      throw new ValidationError(`units[${index}] must not include observed unit identity fields`);
    }
    assert(typeof raw.name === 'string' && raw.name.length > 0, `units[${index}].name required`);
    unit.name = raw.name;
    unit.health = requireInt(raw.health, `units[${index}].health`, { min: 0, allowNegative: false });
    unit.timeUnits = requireInt(raw.timeUnits, `units[${index}].timeUnits`, { min: 0, allowNegative: false });

    if (schemaSupportsV3UnitFields) {
      assert(Object.prototype.hasOwnProperty.call(raw, 'kneeled'), `units[${index}].kneeled required`);
      assert(Object.prototype.hasOwnProperty.call(raw, 'activeHand'), `units[${index}].activeHand required`);
      assert(Object.prototype.hasOwnProperty.call(raw, 'hands'), `units[${index}].hands required`);
      assert(Object.prototype.hasOwnProperty.call(raw, 'inventory'), `units[${index}].inventory required`);
      unit.kneeled = requireBool(raw.kneeled, `units[${index}].kneeled`);
      unit.activeHand = requireString(raw.activeHand, `units[${index}].activeHand`, {
        maxLength: MAX_ACTIVE_HAND_LENGTH,
      });
      unit.hands = validateHands(raw.hands, `units[${index}].hands`);
      unit.inventory = validateInventory(raw.inventory, `units[${index}].inventory`);
      if (Object.prototype.hasOwnProperty.call(raw, 'groundInventory')) {
        unit.groundInventory = validateGroundInventory(raw.groundInventory, `units[${index}].groundInventory`);
      }
      if (Object.prototype.hasOwnProperty.call(raw, 'carriedWeight')) {
        unit.carriedWeight = requireInt(raw.carriedWeight, `units[${index}].carriedWeight`, {
          min: 0,
          allowNegative: false,
        });
      }
      if (Object.prototype.hasOwnProperty.call(raw, 'strength')) {
        unit.strength = requireInt(raw.strength, `units[${index}].strength`, {
          min: 0,
          allowNegative: false,
        });
      }
      if (Object.prototype.hasOwnProperty.call(raw, 'encumbranceRatio')) {
        const ratio = raw.encumbranceRatio;
        assert(typeof ratio === 'number' && Number.isFinite(ratio), `units[${index}].encumbranceRatio must be a number`);
        unit.encumbranceRatio = ratio;
      }
      if (Object.prototype.hasOwnProperty.call(raw, 'actionCosts')) {
        unit.actionCosts = validateActionCosts(raw.actionCosts, `units[${index}].actionCosts`);
      }
      if (Object.prototype.hasOwnProperty.call(raw, 'facing')) {
        unit.facing = validateFacing(raw.facing, `units[${index}].facing`);
      }
      if (Object.prototype.hasOwnProperty.call(raw, 'condition')) {
        unit.condition = validateCondition(raw.condition, `units[${index}].condition`);
      }
      if (Object.prototype.hasOwnProperty.call(raw, 'readiness')) {
        unit.readiness = validateReadiness(raw.readiness, `units[${index}].readiness`);
      }
    }
  } else {
    for (const key of [...v2Extras, ...(schemaSupportsV3UnitFields ? v3Extras : []), ...wp2FriendlyOnlyExtras]) {
      if ((key === 'kneeled' || key === 'facing') && !friendly && Object.prototype.hasOwnProperty.call(raw, key)) {
        continue;
      }
      if (key === 'name' && mindControlledRoster) {
        continue;
      }
      assert(!Object.prototype.hasOwnProperty.call(raw, key), `units[${index}] must not include ${key}`);
    }
    if (schemaVersion === 2 && Object.prototype.hasOwnProperty.call(raw, 'actionCosts')) {
      throw new ValidationError(`units[${index}] must not include actionCosts`);
    }
    if (mindControlledRoster && Object.prototype.hasOwnProperty.call(raw, 'name')) {
      unit.name = requireString(raw.name, `units[${index}].name`, { maxLength: 96 });
    } else if (Object.prototype.hasOwnProperty.call(raw, 'name')) {
      throw new ValidationError(`units[${index}] must not include name`);
    }
    if (Object.prototype.hasOwnProperty.call(raw, 'observedUnitType')) {
      if (mindControlledRoster || neutralCivilian || friendly) {
        throw new ValidationError(`units[${index}] must not include observedUnitType`);
      }
      if (!genuineHostile && !xcomControlledHostile) {
        throw new ValidationError(`units[${index}] must not include observedUnitType`);
      }
      unit.observedUnitType = requireString(raw.observedUnitType, `units[${index}].observedUnitType`, {
        maxLength: 64,
      });
      assert(
        unit.observedUnitType.startsWith('STR_'),
        `units[${index}].observedUnitType must be a mod unit type id`,
      );
    }
    if (Object.prototype.hasOwnProperty.call(raw, 'displayLabel')) {
      if (!Object.prototype.hasOwnProperty.call(unit, 'observedUnitType')) {
        throw new ValidationError(`units[${index}].displayLabel requires observedUnitType`);
      }
      unit.displayLabel = requireString(raw.displayLabel, `units[${index}].displayLabel`, { maxLength: 96 });
    }
  }

  return unit;
}

function allowedRootKeys(schemaVersion) {
  if (schemaVersion === 5) return ROOT_KEYS_V5;
  if (schemaVersion === 4) return ROOT_KEYS_V4;
  return ROOT_KEYS;
}

function requireWalkTu(value, label) {
  return requireInt(value, label, { min: MIN_WALK_TU, max: MAX_WALK_TU, allowNegative: false });
}

function validateTerrainWall(raw, label) {
  assert(isPlainObject(raw), `${label} must be a mapping`);
  for (const key of Object.keys(raw)) {
    if (!TERRAIN_WALL_KEYS.has(key)) throw new ValidationError(`${label} unknown field: ${key}`);
  }
  assert(Object.prototype.hasOwnProperty.call(raw, 'walk'), `${label}.walk required`);
  requireWalkTu(raw.walk, `${label}.walk`);
  if (Object.prototype.hasOwnProperty.call(raw, 'blockSight')) {
    requireBool(raw.blockSight, `${label}.blockSight`);
  }
  return raw;
}

function validateTerrainBody(raw, label) {
  assert(isPlainObject(raw), `${label} must be a mapping`);
  for (const key of Object.keys(raw)) {
    if (!TERRAIN_BODY_KEYS.has(key)) throw new ValidationError(`${label} unknown field: ${key}`);
  }
  const hasAir = Object.prototype.hasOwnProperty.call(raw, 'air');
  if (hasAir) {
    requireBool(raw.air, `${label}.air`);
    assert(raw.air === true, `${label}.air must be true when present`);
    assert(Object.prototype.hasOwnProperty.call(raw, 'noFloor'), `${label}.noFloor required for air`);
    requireBool(raw.noFloor, `${label}.noFloor`);
    assert(
      !Object.prototype.hasOwnProperty.call(raw, 'walkF')
        && !Object.prototype.hasOwnProperty.call(raw, 'walkO')
        && !Object.prototype.hasOwnProperty.call(raw, 'elev'),
      `${label} air tiles must not include walkF, walkO, or elev`
    );
    return raw;
  }
  assert(Object.prototype.hasOwnProperty.call(raw, 'noFloor'), `${label}.noFloor required`);
  requireBool(raw.noFloor, `${label}.noFloor`);
  assert(Object.prototype.hasOwnProperty.call(raw, 'elev'), `${label}.elev required`);
  requireInt(raw.elev, `${label}.elev`);
  if (Object.prototype.hasOwnProperty.call(raw, 'walkF')) {
    requireWalkTu(raw.walkF, `${label}.walkF`);
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'walkO')) {
    requireWalkTu(raw.walkO, `${label}.walkO`);
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'blockSightF')) {
    requireBool(raw.blockSightF, `${label}.blockSightF`);
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'blockSightO')) {
    requireBool(raw.blockSightO, `${label}.blockSightO`);
  }
  return raw;
}

function validateTerrainTileSem(raw, label) {
  assert(isPlainObject(raw), `${label} must be a mapping`);
  for (const key of Object.keys(raw)) {
    if (!TERRAIN_TILE_SEM_KEYS.has(key)) throw new ValidationError(`${label} unknown field: ${key}`);
  }
  const out = {};
  for (const key of TERRAIN_TILE_SEM_KEYS) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      const id = requireInt(raw[key], `${label}.${key}`, { min: 1, max: 10, allowNegative: false });
      assert(ALLOWED_SEM_CATEGORY_IDS.has(id), `${label}.${key} invalid semantics category`);
      out[key] = id;
    }
  }
  assert(Object.keys(out).length > 0, `${label} must include at least one part`);
  return out;
}

function validateTerrainSemanticsBlock(raw, label) {
  assert(isPlainObject(raw), `${label} must be a mapping`);
  for (const key of Object.keys(raw)) {
    if (!TERRAIN_SEMANTICS_KEYS.has(key)) throw new ValidationError(`${label} unknown field: ${key}`);
  }
  for (const key of TERRAIN_SEMANTICS_KEYS) {
    assert(Object.prototype.hasOwnProperty.call(raw, key), `${label}.${key} required`);
  }
  const encoding = requireString(raw.encoding, `${label}.encoding`, { maxLength: 32 });
  assert(encoding === 'sparse-v1' || encoding === 'sparse-v2', `${label}.encoding must be sparse-v1 or sparse-v2`);
  const recordCount = requireInt(raw.recordCount, `${label}.recordCount`, { min: 0, allowNegative: false });
  const data = requireString(raw.data, `${label}.data`, { maxLength: 512 * 1024 });
  decodeSparseSemanticsBase64(data, encoding, { expectedRecordCount: recordCount });
  return { encoding, recordCount, data };
}

function validateMissionContext(raw) {
  assert(isPlainObject(raw), 'missionContext must be a mapping');
  for (const key of Object.keys(raw)) {
    if (!MISSION_CONTEXT_KEYS.has(key)) throw new ValidationError(`missionContext unknown field: ${key}`);
  }
  requireInt(raw.schemaVersion, 'missionContext.schemaVersion', { min: 1, max: 1, allowNegative: false });
  requireString(raw.missionType, 'missionContext.missionType', { maxLength: 128 });
  const missionClass = requireString(raw.missionClass, 'missionContext.missionClass', { maxLength: 64 });
  assert(ALLOWED_MISSION_CLASSES.has(missionClass), 'missionContext.missionClass invalid');
  const out = {
    schemaVersion: 1,
    missionType: raw.missionType,
    missionClass,
  };
  if (Object.prototype.hasOwnProperty.call(raw, 'turnLimit')) {
    out.turnLimit = requireInt(raw.turnLimit, 'missionContext.turnLimit', { min: 1, allowNegative: false });
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'siteKind')) {
    const siteKind = requireString(raw.siteKind, 'missionContext.siteKind', { maxLength: 32 });
    assert(ALLOWED_SITE_KINDS.has(siteKind), 'missionContext.siteKind invalid');
    out.siteKind = siteKind;
  }
  return out;
}

function validateTerrainTile(raw, index, map) {
  assert(isPlainObject(raw), `terrain.tiles[${index}] must be a mapping`);
  for (const key of Object.keys(raw)) {
    if (!TERRAIN_TILE_KEYS.has(key)) throw new ValidationError(`terrain.tiles[${index}] unknown field: ${key}`);
  }
  for (const key of ['p', 'disc', 'inLos']) {
    assert(Object.prototype.hasOwnProperty.call(raw, key), `terrain.tiles[${index}].${key} required`);
  }
  const p = normalizePosition(raw.p, `terrain.tiles[${index}].p`);
  assert(p[0] < map.width, `terrain.tiles[${index}].p.x out of map bounds`);
  assert(p[1] < map.height, `terrain.tiles[${index}].p.y out of map bounds`);
  assert(p[2] < map.depth, `terrain.tiles[${index}].p.z out of map bounds`);
  const disc = requireInt(raw.disc, `terrain.tiles[${index}].disc`, { min: 1, max: 7, allowNegative: false });
  const inLos = requireBool(raw.inLos, `terrain.tiles[${index}].inLos`);
  if ((disc & DISC_BODY) !== 0) {
    assert(Object.prototype.hasOwnProperty.call(raw, 'body'), `terrain.tiles[${index}].body required when disc includes body`);
    validateTerrainBody(raw.body, `terrain.tiles[${index}].body`);
  } else {
    assert(!Object.prototype.hasOwnProperty.call(raw, 'body'), `terrain.tiles[${index}] must not include body without body discovery`);
  }
  if ((disc & DISC_WEST) !== 0 && Object.prototype.hasOwnProperty.call(raw, 'west')) {
    validateTerrainWall(raw.west, `terrain.tiles[${index}].west`);
  }
  if ((disc & DISC_NORTH) !== 0 && Object.prototype.hasOwnProperty.call(raw, 'north')) {
    validateTerrainWall(raw.north, `terrain.tiles[${index}].north`);
  }
  if ((disc & DISC_WEST) === 0) {
    assert(!Object.prototype.hasOwnProperty.call(raw, 'west'), `terrain.tiles[${index}] must not include west without west discovery`);
  }
  if ((disc & DISC_NORTH) === 0) {
    assert(!Object.prototype.hasOwnProperty.call(raw, 'north'), `terrain.tiles[${index}] must not include north without north discovery`);
  }
  let sem;
  if (Object.prototype.hasOwnProperty.call(raw, 'sem')) {
    sem = validateTerrainTileSem(raw.sem, `terrain.tiles[${index}].sem`);
  }
  return { p, disc, inLos, body: raw.body, west: raw.west, north: raw.north, ...(sem ? { sem } : {}) };
}

function validateTerrainVerbose(terrain, map) {
  assert(isPlainObject(terrain), 'terrain must be a mapping');
  for (const key of Object.keys(terrain)) {
    if (!TERRAIN_KEYS_VERBOSE.has(key)) throw new ValidationError(`terrain unknown field: ${key}`);
  }
  for (const key of TERRAIN_KEYS_VERBOSE) {
    if (key === 'semantics') {
      continue;
    }
    assert(Object.prototype.hasOwnProperty.call(terrain, key), `terrain.${key} required`);
  }
  const memoryNote = requireString(terrain.memoryNote, 'terrain.memoryNote', { maxLength: 512 });
  assert(Array.isArray(terrain.tiles), 'terrain.tiles must be an array');
  const maxTiles = map.width * map.height * map.depth;
  assert(terrain.tiles.length <= maxTiles, 'terrain.tiles exceeds map volume');
  const seen = new Set();
  let prevKey = null;
  const tiles = terrain.tiles.map((tile, index) => {
    const parsed = validateTerrainTile(tile, index, map);
    const key = `${parsed.p[0]},${parsed.p[1]},${parsed.p[2]}`;
    assert(!seen.has(key), `terrain.tiles[${index}] duplicate position`);
    seen.add(key);
    const sortKey = parsed.p[2] * map.width * map.height + parsed.p[1] * map.width + parsed.p[0];
    if (prevKey !== null) {
      assert(sortKey >= prevKey, 'terrain.tiles must be sorted by z, then y, then x');
    }
    prevKey = sortKey;
    return parsed;
  });
  let semantics;
  if (Object.prototype.hasOwnProperty.call(terrain, 'semantics')) {
    semantics = validateTerrainSemanticsBlock(terrain.semantics, 'terrain.semantics');
  }
  return { memoryNote, tiles, ...(semantics ? { semantics } : {}) };
}

function validateTerrainPacked(terrain, map) {
  assert(isPlainObject(terrain), 'terrain must be a mapping');
  for (const key of Object.keys(terrain)) {
    if (!TERRAIN_KEYS_PACKED.has(key)) throw new ValidationError(`terrain unknown field: ${key}`);
  }
  for (const key of ['memoryNote', 'encoding', 'recordCount', 'data']) {
    assert(Object.prototype.hasOwnProperty.call(terrain, key), `terrain.${key} required`);
  }
  const memoryNote = requireString(terrain.memoryNote, 'terrain.memoryNote', { maxLength: 512 });
  const encoding = requireString(terrain.encoding, 'terrain.encoding', { maxLength: 32 });
  assert(encoding === 'packed-v1', 'terrain.encoding must be packed-v1');
  const recordCount = requireInt(terrain.recordCount, 'terrain.recordCount', { min: 0, allowNegative: false });
  const maxDataLength = maxPackedTerrainDataBase64Length(map);
  const data = requireString(terrain.data, 'terrain.data', { maxLength: maxDataLength });
  const maxTiles = map.width * map.height * map.depth;
  assert(recordCount <= maxTiles, 'terrain.recordCount exceeds map volume');
  decodePackedV1Base64(data, map, { expectedRecordCount: recordCount });
  let semantics;
  if (Object.prototype.hasOwnProperty.call(terrain, 'semantics')) {
    semantics = validateTerrainSemanticsBlock(terrain.semantics, 'terrain.semantics');
  }
  return { memoryNote, encoding, recordCount, data, ...(semantics ? { semantics } : {}) };
}

function validateTerrain(root, map, schemaVersion) {
  if (schemaVersion < 5) {
    assert(!Object.prototype.hasOwnProperty.call(root, 'terrain'), 'terrain must not appear before schemaVersion 5');
    return undefined;
  }
  assert(Object.prototype.hasOwnProperty.call(root, 'terrain'), 'terrain required');
  const terrain = root.terrain;
  const hasTiles = Object.prototype.hasOwnProperty.call(terrain, 'tiles');
  const hasPacked = Object.prototype.hasOwnProperty.call(terrain, 'encoding')
    || Object.prototype.hasOwnProperty.call(terrain, 'recordCount')
    || Object.prototype.hasOwnProperty.call(terrain, 'data');
  assert(!(hasTiles && hasPacked), 'terrain.tiles and packed-v1 fields are mutually exclusive');
  if (hasPacked) {
    return validateTerrainPacked(terrain, map);
  }
  return validateTerrainVerbose(terrain, map);
}

function validateWeaponFireEvent(raw, index, friendlyUnitIds) {
  assert(isPlainObject(raw), `eventLog.events[${index}] must be an object`);
  for (const key of Object.keys(raw)) {
    if (!EVENT_ENTRY_KEYS.has(key)) {
      throw new ValidationError(`eventLog.events[${index}] unknown field: ${key}`);
    }
  }
  for (const key of ['seq', 'type', 'turn', 'actorUnitId', 'weaponItemType', 'actionType', 'target']) {
    assert(Object.prototype.hasOwnProperty.call(raw, key), `eventLog.events[${index}].${key} required`);
  }
  const seq = requireInt(raw.seq, `eventLog.events[${index}].seq`, { min: 1, allowNegative: false });
  const type = requireString(raw.type, `eventLog.events[${index}].type`, { maxLength: 64 });
  assert(ALLOWED_EVENT_TYPES.has(type), `eventLog.events[${index}].type invalid`);
  requireInt(raw.turn, `eventLog.events[${index}].turn`, { min: 1, allowNegative: false });
  const actorUnitId = requireInt(raw.actorUnitId, `eventLog.events[${index}].actorUnitId`);
  assert(
    friendlyUnitIds.has(actorUnitId),
    `eventLog.events[${index}].actorUnitId must be a friendly soldier or recorded roster combatant`,
  );
  requireString(raw.weaponItemType, `eventLog.events[${index}].weaponItemType`, {
    maxLength: MAX_ITEM_TYPE_LENGTH,
  });
  const actionType = requireString(raw.actionType, `eventLog.events[${index}].actionType`, { maxLength: 16 });
  assert(
    ALLOWED_WEAPON_FIRE_ACTION_TYPES.has(actionType),
    `eventLog.events[${index}].actionType invalid`
  );
  const target = normalizePosition(raw.target, `eventLog.events[${index}].target`);
  let autoShotIndex;
  if (actionType === 'auto') {
    assert(
      Object.prototype.hasOwnProperty.call(raw, 'autoShotIndex'),
      `eventLog.events[${index}].autoShotIndex required for auto fire`
    );
    autoShotIndex = requireInt(raw.autoShotIndex, `eventLog.events[${index}].autoShotIndex`, {
      min: 1,
      allowNegative: false,
    });
  } else {
    assert(
      !Object.prototype.hasOwnProperty.call(raw, 'autoShotIndex'),
      `eventLog.events[${index}] must not include autoShotIndex`
    );
  }
  return {
    seq,
    type,
    turn: raw.turn,
    actorUnitId,
    weaponItemType: raw.weaponItemType,
    actionType,
    target,
    ...(autoShotIndex !== undefined ? { autoShotIndex } : {}),
  };
}

function validatePerceptionEvent(raw, index, friendlyUnitIds, units) {
  assert(isPlainObject(raw), `perceptionLog.events[${index}] must be an object`);
  for (const key of Object.keys(raw)) {
    if (!PERCEPTION_EVENT_KEYS.has(key)) {
      throw new ValidationError(`perceptionLog.events[${index}] unknown field: ${key}`);
    }
  }
  for (const key of ['seq', 'type', 'turn', 'perceptionChannel', 'confidence', 'positionKnown']) {
    assert(Object.prototype.hasOwnProperty.call(raw, key), `perceptionLog.events[${index}].${key} required`);
  }
  const seq = requireInt(raw.seq, `perceptionLog.events[${index}].seq`, { min: 1, allowNegative: false });
  const type = requireString(raw.type, `perceptionLog.events[${index}].type`, { maxLength: 64 });
  assert(ALLOWED_PERCEPTION_EVENT_TYPES.has(type), `perceptionLog.events[${index}].type invalid`);
  requireInt(raw.turn, `perceptionLog.events[${index}].turn`, { min: 1, allowNegative: false });
  const perceptionChannel = requireString(raw.perceptionChannel, `perceptionLog.events[${index}].perceptionChannel`, {
    maxLength: 32,
  });
  assert(ALLOWED_PERCEPTION_CHANNELS.has(perceptionChannel), `perceptionLog.events[${index}].perceptionChannel invalid`);
  const confidence = requireString(raw.confidence, `perceptionLog.events[${index}].confidence`, { maxLength: 32 });
  assert(ALLOWED_PERCEPTION_CONFIDENCE.has(confidence), `perceptionLog.events[${index}].confidence invalid`);
  const positionKnown = requireBool(raw.positionKnown, `perceptionLog.events[${index}].positionKnown`);
  let position;
  if (positionKnown) {
    assert(Object.prototype.hasOwnProperty.call(raw, 'position'), `perceptionLog.events[${index}].position required when positionKnown`);
    position = normalizePosition(raw.position, `perceptionLog.events[${index}].position`);
  } else {
    assert(!Object.prototype.hasOwnProperty.call(raw, 'position'), `perceptionLog.events[${index}] must not include position when unknown`);
    assert(!Object.prototype.hasOwnProperty.call(raw, 'compassDirection'), `perceptionLog.events[${index}] must not include compassDirection without position`);
  }
  let observerUnitId;
  if (Object.prototype.hasOwnProperty.call(raw, 'observerUnitId')) {
    observerUnitId = requireInt(raw.observerUnitId, `perceptionLog.events[${index}].observerUnitId`);
    assert(friendlyUnitIds.has(observerUnitId), `perceptionLog.events[${index}].observerUnitId must be a friendly soldier`);
  }
  let subjectUnitId;
  if (Object.prototype.hasOwnProperty.call(raw, 'subjectUnitId')) {
    subjectUnitId = requireInt(raw.subjectUnitId, `perceptionLog.events[${index}].subjectUnitId`);
  }
  let compassDirection;
  if (Object.prototype.hasOwnProperty.call(raw, 'compassDirection')) {
    compassDirection = requireString(raw.compassDirection, `perceptionLog.events[${index}].compassDirection`, {
      maxLength: 16,
    });
    assert(positionKnown, `perceptionLog.events[${index}].compassDirection requires positionKnown`);
  }
  if (perceptionChannel === 'heard' && positionKnown) {
    throw new ValidationError(`perceptionLog.events[${index}] heard-only events must not expose coordinates`);
  }
  let travelDirection;
  let incomingBearing;
  if (Object.prototype.hasOwnProperty.call(raw, 'travelDirection')) {
    travelDirection = requireString(raw.travelDirection, `perceptionLog.events[${index}].travelDirection`, {
      maxLength: 16,
    });
    assert(ALLOWED_FACING_LABELS.has(travelDirection), `perceptionLog.events[${index}].travelDirection invalid`);
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'incomingBearing')) {
    incomingBearing = requireString(raw.incomingBearing, `perceptionLog.events[${index}].incomingBearing`, {
      maxLength: 16,
    });
    assert(ALLOWED_FACING_LABELS.has(incomingBearing), `perceptionLog.events[${index}].incomingBearing invalid`);
  }
  let subjectName;
  if (Object.prototype.hasOwnProperty.call(raw, 'subjectName')) {
    subjectName = requireString(raw.subjectName, `perceptionLog.events[${index}].subjectName`, { maxLength: 80 });
  }
  const isPsychEvent = PSYCHOLOGICAL_PERCEPTION_EVENT_TYPES.has(type);
  const isSoldierCasualtyEvent = SOLDIER_CASUALTY_PERCEPTION_EVENT_TYPES.has(type);
  if (isPsychEvent) {
    assert(perceptionChannel === 'notification', `perceptionLog.events[${index}] psychological events use notification channel`);
    assert(!positionKnown, `perceptionLog.events[${index}] psychological events must not expose positionKnown`);
    assert(!Object.prototype.hasOwnProperty.call(raw, 'position'), `perceptionLog.events[${index}] psychological events must not include position`);
    assert(!Object.prototype.hasOwnProperty.call(raw, 'observerUnitId'), `perceptionLog.events[${index}] psychological events must not include observerUnitId`);
    assert(
      confidence === 'unit_visible' || confidence === 'message_notification',
      `perceptionLog.events[${index}] psychological confidence invalid`,
    );
    const alienPanicWithoutIdentity =
      ALIEN_PANIC_PSYCH_EVENT_TYPES.has(type) && confidence === 'message_notification';
    if (!alienPanicWithoutIdentity) {
      assert(Object.prototype.hasOwnProperty.call(raw, 'subjectUnitId'), `perceptionLog.events[${index}].subjectUnitId required for psychological events`);
      assert(subjectUnitId !== undefined && subjectUnitId > 0, `perceptionLog.events[${index}].subjectUnitId required`);
    } else {
      assert(!Object.prototype.hasOwnProperty.call(raw, 'subjectUnitId'), `perceptionLog.events[${index}] hidden alien panic must not expose subjectUnitId`);
      assert(!subjectName, `perceptionLog.events[${index}] hidden alien panic must not expose subjectName`);
    }
    if (subjectName !== undefined) {
      assert(
        isRosterSoldierPsychSubjectNameAllowed(subjectUnitId, units),
        `perceptionLog.events[${index}].subjectName only allowed for roster soldiers`,
      );
    }
  } else if (isSoldierCasualtyEvent) {
    assert(
      perceptionChannel === 'notification' || perceptionChannel === 'seen',
      `perceptionLog.events[${index}] soldier casualty channel invalid`,
    );
    assert(!Object.prototype.hasOwnProperty.call(raw, 'observerUnitId'), `perceptionLog.events[${index}] soldier casualty must not include observerUnitId`);
    assert(Object.prototype.hasOwnProperty.call(raw, 'subjectUnitId'), `perceptionLog.events[${index}].subjectUnitId required for soldier casualty events`);
    assert(subjectUnitId !== undefined && subjectUnitId > 0, `perceptionLog.events[${index}].subjectUnitId required`);
    assert(isRosterSoldierUnitId(subjectUnitId), `perceptionLog.events[${index}].subjectUnitId must be a roster soldier`);
    if (type === 'soldier_down') {
      assert(confidence === 'unconscious' || confidence === 'dead', `perceptionLog.events[${index}] soldier_down confidence invalid`);
    } else {
      assert(confidence === 'standing', `perceptionLog.events[${index}] soldier_recovered confidence invalid`);
    }
    if (positionKnown) {
      assert(position, `perceptionLog.events[${index}] soldier casualty requires position when positionKnown`);
    }
    if (subjectName !== undefined) {
      assert(
        isRosterSoldierCasualtySubjectNameAllowed(subjectUnitId, units),
        `perceptionLog.events[${index}].subjectName only allowed for roster soldiers`,
      );
    }
  } else if (subjectName !== undefined) {
    throw new ValidationError(`perceptionLog.events[${index}] subjectName invalid for type`);
  }
  if (type === 'impact_observed') {
    const allowedImpact = confidence === 'audio_only'
      || confidence === 'impact_visible'
      || confidence === 'visible_unit_hit'
      || confidence === 'visible_terrain_hit'
      || confidence === 'visible_impact_unclassified';
    assert(allowedImpact, `perceptionLog.events[${index}] impact_observed confidence invalid`);
    if (confidence === 'visible_unit_hit' || confidence === 'visible_terrain_hit'
      || confidence === 'visible_impact_unclassified' || confidence === 'impact_visible') {
      assert(positionKnown, `perceptionLog.events[${index}] visible impacts require positionKnown`);
      assert(position, `perceptionLog.events[${index}] visible impacts require position`);
    }
    if (confidence === 'audio_only') {
      assert(!positionKnown, `perceptionLog.events[${index}] audio_only impact must not expose coordinates`);
    }
    assert(!Object.prototype.hasOwnProperty.call(raw, 'subjectUnitId'), `perceptionLog.events[${index}] impact must not identify victim`);
  } else if (type === 'projectile_direction_observed') {
    assert(perceptionChannel === 'seen', `perceptionLog.events[${index}] projectile direction must be seen-only`);
    assert(!Object.prototype.hasOwnProperty.call(raw, 'subjectUnitId'), `perceptionLog.events[${index}] must not identify shooter`);
    if (confidence === 'trajectory_observed') {
      assert(travelDirection, `perceptionLog.events[${index}].travelDirection required`);
      assert(incomingBearing, `perceptionLog.events[${index}].incomingBearing required`);
    }
    if (confidence === 'trajectory_unavailable') {
      assert(!travelDirection, `perceptionLog.events[${index}] must not include travelDirection when unavailable`);
      assert(!incomingBearing, `perceptionLog.events[${index}] must not include incomingBearing when unavailable`);
    }
    if (travelDirection || incomingBearing) {
      assert(confidence === 'trajectory_observed', `perceptionLog.events[${index}] direction fields require trajectory_observed`);
      assert(travelDirection && incomingBearing, `perceptionLog.events[${index}] travel and incoming bearings must appear together`);
    }
  } else if (type === 'hostile_casualty_tile_observed') {
    assert(perceptionChannel === 'seen', `perceptionLog.events[${index}] hostile casualty must be seen channel`);
    assert(positionKnown, `perceptionLog.events[${index}] hostile casualty requires positionKnown`);
    assert(position, `perceptionLog.events[${index}] hostile casualty requires position`);
    assert(
      confidence === 'possible_ground_equipment' || confidence === 'alien_casualty_tile',
      `perceptionLog.events[${index}] hostile casualty confidence invalid`,
    );
    assert(!Object.prototype.hasOwnProperty.call(raw, 'subjectUnitId'), `perceptionLog.events[${index}] must not include subjectUnitId`);
  } else if (!isPsychEvent) {
    assert(!travelDirection, `perceptionLog.events[${index}] travelDirection invalid for type`);
    assert(!incomingBearing, `perceptionLog.events[${index}] incomingBearing invalid for type`);
  } else {
    assert(!travelDirection, `perceptionLog.events[${index}] travelDirection invalid for type`);
    assert(!incomingBearing, `perceptionLog.events[${index}] incomingBearing invalid for type`);
  }
  return {
    seq,
    type,
    turn: raw.turn,
    perceptionChannel,
    confidence,
    positionKnown,
    ...(position ? { position } : {}),
    ...(observerUnitId !== undefined ? { observerUnitId } : {}),
    ...(subjectUnitId !== undefined ? { subjectUnitId } : {}),
    ...(subjectName ? { subjectName } : {}),
    ...(compassDirection ? { compassDirection } : {}),
    ...(travelDirection ? { travelDirection } : {}),
    ...(incomingBearing ? { incomingBearing } : {}),
  };
}

function validateRosterCasualtySummary(raw, units) {
  assert(isPlainObject(raw), 'perceptionLog.rosterCasualtySummary must be a mapping');
  const schemaVersion = requireInt(raw.schemaVersion, 'perceptionLog.rosterCasualtySummary.schemaVersion', {
    min: 1,
    allowNegative: false,
  });
  assert(schemaVersion === 1, 'perceptionLog.rosterCasualtySummary.schemaVersion must be 1');
  assert(Array.isArray(raw.entries), 'perceptionLog.rosterCasualtySummary.entries must be an array');
  assert(
    raw.entries.length <= MAX_ROSTER_CASUALTY_LEDGER_ENTRIES,
    'perceptionLog.rosterCasualtySummary.entries exceeds 32 entry limit',
  );
  const unitById = new Map(units.map((unit) => [unit.id, unit]));
  return raw.entries.map((entry, index) => {
    assert(isPlainObject(entry), `perceptionLog.rosterCasualtySummary.entries[${index}] must be an object`);
    const subjectUnitId = requireInt(
      entry.subjectUnitId,
      `perceptionLog.rosterCasualtySummary.entries[${index}].subjectUnitId`,
    );
    assert(isRosterSoldierUnitId(subjectUnitId), `perceptionLog.rosterCasualtySummary.entries[${index}] subjectUnitId invalid`);
    const episodeSerial = requireInt(
      entry.episodeSerial,
      `perceptionLog.rosterCasualtySummary.entries[${index}].episodeSerial`,
      { min: 1, allowNegative: false },
    );
    const status = requireString(
      entry.status,
      `perceptionLog.rosterCasualtySummary.entries[${index}].status`,
      { maxLength: 16 },
    );
    assert(ROSTER_CASUALTY_LEDGER_STATUSES.has(status), `perceptionLog.rosterCasualtySummary.entries[${index}].status invalid`);
    const turn = requireInt(
      entry.turn,
      `perceptionLog.rosterCasualtySummary.entries[${index}].turn`,
      { min: 1, allowNegative: false },
    );
    const positionKnown = requireBool(
      entry.positionKnown,
      `perceptionLog.rosterCasualtySummary.entries[${index}].positionKnown`,
    );
    let position;
    if (positionKnown) {
      position = normalizePosition(
        entry.position,
        `perceptionLog.rosterCasualtySummary.entries[${index}].position`,
      );
    }
    let subjectName;
    if (Object.prototype.hasOwnProperty.call(entry, 'subjectName')) {
      subjectName = requireString(
        entry.subjectName,
        `perceptionLog.rosterCasualtySummary.entries[${index}].subjectName`,
        { maxLength: 80 },
      );
      assert(
        isRosterSoldierCasualtySubjectNameAllowed(subjectUnitId, units),
        `perceptionLog.rosterCasualtySummary.entries[${index}].subjectName only allowed for roster soldiers`,
      );
    }
    if (unitById.has(subjectUnitId) && subjectName === undefined) {
      const live = unitById.get(subjectUnitId);
      if (typeof live?.name === 'string' && live.name.length > 0) {
        // names optional in ledger; live units[] may still carry name
      }
    }
    return {
      subjectUnitId,
      episodeSerial,
      status,
      turn,
      positionKnown,
      ...(position ? { position } : {}),
      ...(subjectName ? { subjectName } : {}),
    };
  });
}

function validatePerceptionLog(root, units, schemaVersion) {
  if (schemaVersion < 4) {
    assert(!Object.prototype.hasOwnProperty.call(root, 'perceptionLog'), 'perceptionLog must not appear before schemaVersion 4');
    return undefined;
  }
  if (!Object.prototype.hasOwnProperty.call(root, 'perceptionLog')) {
    return undefined;
  }
  const raw = root.perceptionLog;
  assert(isPlainObject(raw), 'perceptionLog must be a mapping');
  for (const key of Object.keys(raw)) {
    if (!PERCEPTION_LOG_ALLOWED_KEYS.has(key)) throw new ValidationError(`perceptionLog unknown field: ${key}`);
  }
  for (const key of PERCEPTION_LOG_REQUIRED_KEYS) {
    assert(Object.prototype.hasOwnProperty.call(raw, key), `perceptionLog.${key} required`);
  }
  const sessionId = requireString(raw.sessionId, 'perceptionLog.sessionId', { maxLength: MAX_SESSION_ID_LENGTH });
  assert(/^[0-9a-f]{32}$/.test(sessionId), 'perceptionLog.sessionId must be 32 lowercase hex characters');
  const oldestSeq = requireInt(raw.oldestSeq, 'perceptionLog.oldestSeq', { min: 0, allowNegative: false });
  const latestSeq = requireInt(raw.latestSeq, 'perceptionLog.latestSeq', { min: 0, allowNegative: false });
  const droppedCount = requireInt(raw.droppedCount, 'perceptionLog.droppedCount', { min: 0, allowNegative: false });
  assert(Array.isArray(raw.events), 'perceptionLog.events must be an array');
  assert(raw.events.length <= MAX_PERCEPTION_LOG_EVENTS, 'perceptionLog.events exceeds 256 event limit');
  if (raw.events.length === 0) {
    assert(oldestSeq === 0 && latestSeq === 0, 'perceptionLog oldestSeq/latestSeq must be 0 when events is empty');
  } else {
    assert(oldestSeq >= 1, 'perceptionLog.oldestSeq must be >= 1 when events is non-empty');
    assert(latestSeq >= oldestSeq, 'perceptionLog.latestSeq must be >= oldestSeq');
  }
  const friendlyUnitIds = new Set(
    units.filter((unit) => isFriendlyPlayerControlled(unit)).map((unit) => unit.id)
  );
  const events = raw.events.map((event, index) => validatePerceptionEvent(event, index, friendlyUnitIds, units));
  let prevSeq = 0;
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (i === 0) {
      assert(event.seq === oldestSeq, 'perceptionLog.events[0].seq must equal oldestSeq');
    } else {
      assert(event.seq === prevSeq + 1, `perceptionLog.events[${i}].seq must increase by 1`);
    }
    if (i === events.length - 1) {
      assert(event.seq === latestSeq, 'perceptionLog.events last seq must equal latestSeq');
    }
    prevSeq = event.seq;
  }
  const rosterCasualtySummaryEntries = Object.prototype.hasOwnProperty.call(raw, 'rosterCasualtySummary')
    ? validateRosterCasualtySummary(raw.rosterCasualtySummary, units)
    : undefined;
  return {
    sessionId,
    oldestSeq,
    latestSeq,
    droppedCount,
    events,
    ...(rosterCasualtySummaryEntries !== undefined
      ? { rosterCasualtySummary: { schemaVersion: 1, entries: rosterCasualtySummaryEntries } }
      : {}),
  };
}

function terrainVerboseTileIndex(terrain) {
  if (!terrain || !Array.isArray(terrain.tiles)) {
    return null;
  }
  const index = new Map();
  for (let i = 0; i < terrain.tiles.length; i += 1) {
    const tile = terrain.tiles[i];
    if (!tile || !Array.isArray(tile.p) || tile.p.length !== 3) {
      continue;
    }
    index.set(`${tile.p[0]},${tile.p[1]},${tile.p[2]}`, tile);
  }
  return index;
}

function validateGroundItemEntry(raw, obsIndex, itemIndex) {
  const label = `groundItems.observations[${obsIndex}].items[${itemIndex}]`;
  assert(isPlainObject(raw), `${label} must be a mapping`);
  for (const key of Object.keys(raw)) {
    if (!GROUND_ITEM_ENTRY_KEYS.has(key)) throw new ValidationError(`${label} unknown field: ${key}`);
  }
  assert(Object.prototype.hasOwnProperty.call(raw, 'itemCategory'), `${label}.itemCategory required`);
  assert(Object.prototype.hasOwnProperty.call(raw, 'battleType'), `${label}.battleType required`);
  const itemCategory = requireString(raw.itemCategory, `${label}.itemCategory`, { maxLength: 64 });
  assert(ALLOWED_GROUND_ITEM_CATEGORIES.has(itemCategory), `${label}.itemCategory invalid`);
  const battleType = requireInt(raw.battleType, `${label}.battleType`, {
    min: MIN_BATTLE_TYPE,
    max: MAX_BATTLE_TYPE,
    allowNegative: false,
  });
  const out = { itemCategory, battleType };
  if (Object.prototype.hasOwnProperty.call(raw, 'itemType')) {
    assert(
      !itemCategory.startsWith('unidentified_') && itemCategory !== 'additional_ground_item',
      `${label} must not include itemType for unidentified or concealed categories`,
    );
    out.itemType = requireString(raw.itemType, `${label}.itemType`, { maxLength: MAX_ITEM_TYPE_LENGTH });
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'quantity')) {
    assert(battleType === BT_AMMO, `${label}.quantity only valid for ammunition`);
    out.quantity = requireInt(raw.quantity, `${label}.quantity`, { min: 1, allowNegative: false });
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'primed')) {
    assert(
      battleType === BT_GRENADE || battleType === BT_PROXIMITYGRENADE,
      `${label}.primed only valid for grenades`,
    );
    out.primed = requireBool(raw.primed, `${label}.primed`);
    assert(!Object.prototype.hasOwnProperty.call(raw, 'fuseTimer'), `${label} must not expose fuseTimer`);
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'concealedOnTile')) {
    out.concealedOnTile = requireBool(raw.concealedOnTile, `${label}.concealedOnTile`);
  }
  return out;
}

function validateGroundItemObservation(raw, index, map, terrainTileIndex) {
  const label = `groundItems.observations[${index}]`;
  assert(isPlainObject(raw), `${label} must be a mapping`);
  for (const key of Object.keys(raw)) {
    if (!GROUND_ITEM_OBS_KEYS.has(key)) throw new ValidationError(`${label} unknown field: ${key}`);
  }
  for (const key of GROUND_ITEM_OBS_KEYS) {
    assert(Object.prototype.hasOwnProperty.call(raw, key), `${label}.${key} required`);
  }
  const positionRaw = raw.position;
  assert(isPlainObject(positionRaw), `${label}.position must be a mapping`);
  for (const key of Object.keys(positionRaw)) {
    if (!GROUND_ITEM_POSITION_KEYS.has(key)) throw new ValidationError(`${label}.position unknown field: ${key}`);
  }
  for (const key of GROUND_ITEM_POSITION_KEYS) {
    assert(Object.prototype.hasOwnProperty.call(positionRaw, key), `${label}.position.${key} required`);
  }
  const position = {
    x: requireInt(positionRaw.x, `${label}.position.x`, { min: 0, allowNegative: false }),
    y: requireInt(positionRaw.y, `${label}.position.y`, { min: 0, allowNegative: false }),
    z: requireInt(positionRaw.z, `${label}.position.z`, { min: 0, allowNegative: false }),
  };
  assert(position.x < map.width && position.y < map.height && position.z < map.depth, `${label} position out of map bounds`);
  const observationStatus = requireString(raw.observationStatus, `${label}.observationStatus`, { maxLength: 32 });
  assert(ALLOWED_GROUND_OBS_STATUS.has(observationStatus), `${label}.observationStatus invalid`);
  assert(Array.isArray(raw.items), `${label}.items must be an array`);
  assert(raw.items.length >= 1, `${label}.items must not be empty`);
  assert(raw.items.length <= MAX_GROUND_ITEMS_PER_TILE, `${label}.items exceeds per-tile limit`);
  const items = raw.items.map((item, itemIndex) => validateGroundItemEntry(item, index, itemIndex));
  if (terrainTileIndex) {
    const tile = terrainTileIndex.get(`${position.x},${position.y},${position.z}`);
    assert(tile, `${label} references tile absent from terrain (undiscovered or omitted)`);
    assert((tile.disc & DISC_BODY) !== 0, `${label} requires discovered body on terrain tile`);
    if (observationStatus === 'CONFIRMED_IN_LOS') {
      assert(tile.inLos === true, `${label} CONFIRMED_IN_LOS requires terrain inLos`);
    }
    if (observationStatus === 'REMEMBERED_OFF_LOS') {
      assert(tile.inLos !== true, `${label} REMEMBERED_OFF_LOS must not claim current inLos`);
    }
  }
  return { position, observationStatus, items };
}

function validateGroundItems(root, map, schemaVersion, terrain) {
  if (schemaVersion < 4) {
    assert(!Object.prototype.hasOwnProperty.call(root, 'groundItems'), 'groundItems must not appear before schemaVersion 4');
    return undefined;
  }
  if (!Object.prototype.hasOwnProperty.call(root, 'groundItems')) {
    return undefined;
  }
  const raw = root.groundItems;
  assert(isPlainObject(raw), 'groundItems must be a mapping');
  for (const key of Object.keys(raw)) {
    if (!GROUND_ITEMS_KEYS.has(key)) throw new ValidationError(`groundItems unknown field: ${key}`);
  }
  for (const key of GROUND_ITEMS_KEYS) {
    assert(Object.prototype.hasOwnProperty.call(raw, key), `groundItems.${key} required`);
  }
  requireInt(raw.schemaVersion, 'groundItems.schemaVersion', { min: 1, max: 1, allowNegative: false });
  const sessionId = requireString(raw.sessionId, 'groundItems.sessionId', { maxLength: MAX_SESSION_ID_LENGTH });
  assert(/^[0-9a-f]{32}$/.test(sessionId), 'groundItems.sessionId must be 32 lowercase hex characters');
  requireString(raw.memoryNote, 'groundItems.memoryNote', { maxLength: 512 });
  const droppedCount = requireInt(raw.droppedCount, 'groundItems.droppedCount', { min: 0, allowNegative: false });
  assert(Array.isArray(raw.observations), 'groundItems.observations must be an array');
  assert(raw.observations.length <= MAX_GROUND_ITEM_OBSERVATIONS, 'groundItems.observations exceeds export cap');
  const terrainTileIndex = terrainVerboseTileIndex(terrain);
  const observations = raw.observations.map((obs, index) =>
    validateGroundItemObservation(obs, index, map, terrainTileIndex),
  );
  return { schemaVersion: 1, sessionId, droppedCount, observations };
}

function validateEventLog(root, units, schemaVersion) {
  if (schemaVersion < 4) {
    assert(!Object.prototype.hasOwnProperty.call(root, 'eventLog'), 'eventLog must not appear before schemaVersion 4');
    return undefined;
  }
  assert(Object.prototype.hasOwnProperty.call(root, 'eventLog'), 'eventLog required');
  const raw = root.eventLog;
  assert(isPlainObject(raw), 'eventLog must be a mapping');
  for (const key of Object.keys(raw)) {
    if (!EVENT_LOG_KEYS.has(key)) throw new ValidationError(`eventLog unknown field: ${key}`);
  }
  for (const key of EVENT_LOG_KEYS) {
    assert(Object.prototype.hasOwnProperty.call(raw, key), `eventLog.${key} required`);
  }
  const sessionId = requireString(raw.sessionId, 'eventLog.sessionId', { maxLength: MAX_SESSION_ID_LENGTH });
  assert(/^[0-9a-f]{32}$/.test(sessionId), 'eventLog.sessionId must be 32 lowercase hex characters');
  const oldestSeq = requireInt(raw.oldestSeq, 'eventLog.oldestSeq', { min: 0, allowNegative: false });
  const latestSeq = requireInt(raw.latestSeq, 'eventLog.latestSeq', { min: 0, allowNegative: false });
  const droppedCount = requireInt(raw.droppedCount, 'eventLog.droppedCount', { min: 0, allowNegative: false });
  assert(Array.isArray(raw.events), 'eventLog.events must be an array');
  assert(raw.events.length <= MAX_EVENT_LOG_EVENTS, 'eventLog.events exceeds 256 event limit');
  if (raw.events.length === 0) {
    assert(oldestSeq === 0 && latestSeq === 0, 'eventLog oldestSeq/latestSeq must be 0 when events is empty');
  } else {
    assert(oldestSeq >= 1, 'eventLog.oldestSeq must be >= 1 when events is non-empty');
    assert(latestSeq >= oldestSeq, 'eventLog.latestSeq must be >= oldestSeq');
  }

  const weaponFireActorIds = buildWeaponFireActorAllowlist(units, raw.events);
  const events = raw.events.map((event, index) => validateWeaponFireEvent(event, index, weaponFireActorIds));
  let prevSeq = 0;
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (i === 0) {
      assert(event.seq === oldestSeq, 'eventLog.events[0].seq must equal oldestSeq');
    } else {
      assert(event.seq === prevSeq + 1, `eventLog.events[${i}].seq must increase by 1`);
    }
    prevSeq = event.seq;
    if (i === events.length - 1) {
      assert(event.seq === latestSeq, 'eventLog.events last seq must equal latestSeq');
    }
  }
  return {
    sessionId,
    oldestSeq,
    latestSeq,
    droppedCount,
    events,
  };
}

function parseAndValidate(raw) {
  assert(isPlainObject(raw), 'root must be a mapping');

  assert(Object.prototype.hasOwnProperty.call(raw, 'schemaVersion'), 'schemaVersion required');
  const schemaVersion = requireInt(raw.schemaVersion, 'schemaVersion', { min: 2, allowNegative: false });
  assert(
    schemaVersion === 2 || schemaVersion === 3 || schemaVersion === 4 || schemaVersion === 5,
    'schemaVersion must be 2, 3, 4, or 5'
  );

  const allowedRoot = allowedRootKeys(schemaVersion);
  for (const key of Object.keys(raw)) {
    if (!allowedRoot.has(key)) {
      throw new ValidationError(`unknown root field: ${key}`);
    }
  }

  const turn = requireInt(raw.turn, 'turn', { min: 1, allowNegative: false });
  const side = requireFaction(raw.side, 'side');
  const selectedUnitId = requireInt(raw.selectedUnitId, 'selectedUnitId');

  assert(isPlainObject(raw.map), 'map must be a mapping');
  for (const key of Object.keys(raw.map)) {
    if (!MAP_KEYS.has(key)) throw new ValidationError(`unknown map field: ${key}`);
  }
  for (const key of MAP_KEYS) {
    assert(Object.prototype.hasOwnProperty.call(raw.map, key), `map.${key} required`);
  }
  const map = {
    width: requireInt(raw.map.width, 'map.width', { min: 1, allowNegative: false }),
    height: requireInt(raw.map.height, 'map.height', { min: 1, allowNegative: false }),
    depth: requireInt(raw.map.depth, 'map.depth', { min: 1, allowNegative: false }),
  };

  assert(Array.isArray(raw.units), 'units must be an array');
  const units = raw.units.map((u, i) => validateUnit(u, i, schemaVersion));
  const eventLog = validateEventLog(raw, units, schemaVersion);
  const perceptionLog = validatePerceptionLog(raw, units, schemaVersion);
  const terrain = validateTerrain(raw, map, schemaVersion);
  let missionContext;
  if (Object.prototype.hasOwnProperty.call(raw, 'missionContext')) {
    assert(schemaVersion >= 4, 'missionContext requires schemaVersion >= 4');
    missionContext = validateMissionContext(raw.missionContext);
  }
  const groundItems = validateGroundItems(raw, map, schemaVersion, terrain);

  return {
    schemaVersion,
    turn,
    side,
    selectedUnitId,
    map,
    units,
    ...(eventLog !== undefined ? { eventLog } : {}),
    ...(perceptionLog !== undefined ? { perceptionLog } : {}),
    ...(terrain !== undefined ? { terrain } : {}),
    ...(missionContext !== undefined ? { missionContext } : {}),
    ...(groundItems !== undefined ? { groundItems } : {}),
  };
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeysDeep(value[key]);
    }
    return out;
  }
  return value;
}

function canonicalTacticalJson(tactical) {
  return JSON.stringify(sortKeysDeep(tactical));
}

function computeSnapshotId(tactical) {
  return crypto.createHash('sha256').update(canonicalTacticalJson(tactical), 'utf8').digest('hex');
}

function buildRelayPayload(tactical, publishedAt, briefingMeta = null, options = {}) {
  const snapshotId = computeSnapshotId(tactical);
  const payload = {
    schema_version: 1,
    type: 'tactical_snapshot',
    snapshot_id: snapshotId,
    published_at: publishedAt,
    source: {
      companion_schema: tactical.schemaVersion,
      turn: tactical.turn,
      side: tactical.side,
    },
    tactical,
  };
  if (briefingMeta) {
    payload.request_id = briefingMeta.request_id;
    payload.session_id = briefingMeta.session_id;
    payload.turn = briefingMeta.turn;
  }
  if (options.terrainBrief !== undefined && options.terrainBrief !== null) {
    payload.terrainBrief = options.terrainBrief;
  } else if (tactical.schemaVersion >= 5 && tactical.terrain) {
    payload.terrainBrief = buildTerrainBrief(tactical);
  }
  if (options.terrainMapBrief !== undefined && options.terrainMapBrief !== null) {
    payload.terrainMapBrief = options.terrainMapBrief;
  } else if (tactical.schemaVersion >= 5 && tactical.terrain) {
    const terrainMapBrief = buildTerrainMapBrief(tactical, options.terrainMapBriefOptions);
    if (terrainMapBrief && !terrainMapBrief.omitted) {
      payload.terrainMapBrief = terrainMapBrief;
    }
  }
  if (options.unitStateBrief !== undefined && options.unitStateBrief !== null) {
    payload.unitStateBrief = options.unitStateBrief;
  } else if (tactical.schemaVersion >= 3) {
    payload.unitStateBrief = buildUnitStateBrief(tactical);
  }
  if (options.snapshotSha256 && tactical.eventLog && typeof tactical.eventLog.sessionId === 'string') {
    payload.commandBinding = buildCommandBinding(tactical, options.snapshotSha256);
  }
  return payload;
}

function parseYamlDocument(yaml, text) {
  let doc;
  try {
    doc = yaml.parse(text);
  } catch (error) {
    throw new ValidationError(`malformed YAML: ${error.message}`);
  }
  if (doc === undefined || doc === null) {
    throw new ValidationError('YAML document is empty');
  }
  return doc;
}

function loadAndValidateSnapshotFromText(text, yaml) {
  assert(Buffer.byteLength(text, 'utf8') <= MAX_INPUT_BYTES, 'input exceeds 256 KiB limit');
  const raw = parseYamlDocument(yaml, text);
  return parseAndValidate(raw);
}

module.exports = {
  FACTION_PLAYER,
  FACTION_HOSTILE,
  FACTION_NEUTRAL,
  PSYCHOLOGICAL_PERCEPTION_EVENT_TYPES,
  MAX_INPUT_BYTES,
  MAX_INVENTORY_ENTRIES,
  MAX_GROUND_ITEM_OBSERVATIONS,
  MAX_GROUND_ITEMS_PER_TILE,
  MAX_EVENT_LOG_EVENTS,
  BT_FIREARM,
  BT_AMMO,
  BT_GRENADE,
  BT_PROXIMITYGRENADE,
  BT_MEDIKIT,
  ValidationError,
  parseAndValidate,
  validateActionCosts,
  validateFacing,
  validateCondition,
  validateReadiness,
  validateUnit,
  validateEquipmentItem,
  validateEventLog,
  validateTerrain,
  isFriendlyPlayerControlled,
  buildWeaponFireActorAllowlist,
  canonicalTacticalJson,
  computeSnapshotId,
  buildRelayPayload,
  loadAndValidateSnapshotFromText,
  maxPackedTerrainDataBase64Length,
};
