'use strict';

const crypto = require('node:crypto');

const FACTION_PLAYER = 0;
const FACTION_HOSTILE = 1;
const FACTION_NEUTRAL = 2;

const MAX_INPUT_BYTES = 256 * 1024;
const MAX_ITEM_TYPE_LENGTH = 128;
const MAX_SLOT_ID_LENGTH = 64;
const MAX_ACTIVE_HAND_LENGTH = 64;
const MAX_INVENTORY_ENTRIES = 24;
const MIN_BATTLE_TYPE = 0;
const MAX_BATTLE_TYPE = 11; // BT_CORPSE
const BT_FIREARM = 1;
const BT_AMMO = 2;
const BT_GRENADE = 4;
const BT_PROXIMITYGRENADE = 5;

const ROOT_KEYS = new Set(['schemaVersion', 'turn', 'side', 'selectedUnitId', 'map', 'units']);
const MAP_KEYS = new Set(['width', 'height', 'depth']);
const UNIT_BASE_KEYS = new Set(['id', 'faction', 'originalFaction', 'position']);
const UNIT_FRIENDLY_V2_KEYS = new Set(['name', 'health', 'timeUnits']);
const UNIT_FRIENDLY_V3_KEYS = new Set(['kneeled', 'activeHand', 'hands', 'inventory', 'actionCosts']);
const HANDS_KEYS = new Set(['right', 'left']);
const ACTION_COSTS_KEYS = new Set(['posture', 'hands']);
const POSTURE_KEYS = new Set(['kneelDownTu', 'standUpTu']);
const HAND_ACTION_COST_KEYS = new Set(['itemType', 'actions']);
const ACTION_ENTRY_KEYS = new Set(['id', 'actionType', 'tuCost', 'canAffordTu', 'usable']);
const ALLOWED_ACTION_IDS = new Set(['snap', 'aimed', 'auto', 'launch', 'throw', 'prime', 'melee']);
const ALLOWED_ACTION_TYPES = new Set([3, 4, 5, 6, 7, 8, 10]); // BA_* companion actions
const MAX_ACTIONS_PER_HAND = 16;
const EQUIPMENT_ITEM_KEYS = new Set(['itemType', 'battleType', 'loaded', 'empty', 'primed']);
const LOADED_KEYS = new Set(['ammoType', 'rounds']);
const INVENTORY_ENTRY_KEYS = new Set(['slot', 'itemType', 'battleType', 'loaded', 'empty', 'primed']);

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

function requireInt(value, label, { min = Number.MIN_SAFE_INTEGER, allowNegative = true } = {}) {
  assert(typeof value === 'number' && Number.isInteger(value), `${label} must be an integer`);
  if (!allowNegative) assert(value >= min, `${label} must be >= ${min}`);
  else assert(value >= min, `${label} out of range`);
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

function allowedUnitKeys(schemaVersion) {
  const keys = new Set(UNIT_BASE_KEYS);
  if (schemaVersion === 2) {
    for (const k of UNIT_FRIENDLY_V2_KEYS) keys.add(k);
    return keys;
  }
  for (const k of UNIT_FRIENDLY_V2_KEYS) keys.add(k);
  for (const k of UNIT_FRIENDLY_V3_KEYS) keys.add(k);
  return keys;
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
  return {
    ammoType: requireString(raw.ammoType, `${label}.ammoType`, { maxLength: MAX_ITEM_TYPE_LENGTH }),
    rounds: requireInt(raw.rounds, `${label}.rounds`, { min: 1, allowNegative: false }),
  };
}

function assertEquipmentFieldSemantics(item, label, raw) {
  const bt = item.battleType;
  const isGrenade = bt === BT_GRENADE || bt === BT_PROXIMITYGRENADE;

  if (bt === BT_AMMO) {
    assert(!Object.prototype.hasOwnProperty.call(raw, 'empty'), `${label} must not include empty`);
    assert(!Object.prototype.hasOwnProperty.call(raw, 'loaded'), `${label} must not include loaded`);
    assert(!Object.prototype.hasOwnProperty.call(raw, 'primed'), `${label} must not include primed`);
    return;
  }
  if (isGrenade) {
    assert(!Object.prototype.hasOwnProperty.call(raw, 'empty'), `${label} must not include empty`);
    assert(!Object.prototype.hasOwnProperty.call(raw, 'loaded'), `${label} must not include loaded`);
  }
  if (bt === BT_FIREARM) {
    assert(!Object.prototype.hasOwnProperty.call(raw, 'primed'), `${label} must not include primed`);
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'empty')) {
    assert(bt === BT_FIREARM, `${label}.empty is only valid on firearms`);
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'loaded')) {
    assert(bt === BT_FIREARM, `${label}.loaded is only valid on firearms`);
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'primed')) {
    assert(isGrenade, `${label}.primed is only valid on grenades`);
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

  if (Object.prototype.hasOwnProperty.call(raw, 'loaded')) {
    item.loaded = validateLoaded(raw.loaded, `${label}.loaded`);
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'empty')) {
    item.empty = requireBool(raw.empty, `${label}.empty`);
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'primed')) {
    item.primed = requireBool(raw.primed, `${label}.primed`);
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
    if (Object.prototype.hasOwnProperty.call(entry, 'loaded')) {
      row.loaded = validateLoaded(entry.loaded, `${entryLabel}.loaded`);
    }
    if (Object.prototype.hasOwnProperty.call(entry, 'empty')) {
      row.empty = requireBool(entry.empty, `${entryLabel}.empty`);
    }
    if (Object.prototype.hasOwnProperty.call(entry, 'primed')) {
      row.primed = requireBool(entry.primed, `${entryLabel}.primed`);
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
  const v2Extras = ['name', 'health', 'timeUnits'];
  const v3Extras = ['kneeled', 'activeHand', 'hands', 'inventory', 'actionCosts'];

  for (const key of v2Extras) {
    if (Object.prototype.hasOwnProperty.call(raw, key) && !friendly) {
      throw new ValidationError(`units[${index}] must not include ${key}`);
    }
  }
  for (const key of v3Extras) {
    if (schemaVersion === 3 && Object.prototype.hasOwnProperty.call(raw, key) && !friendly) {
      throw new ValidationError(`units[${index}] must not include ${key}`);
    }
    if (schemaVersion === 2 && Object.prototype.hasOwnProperty.call(raw, key)) {
      throw new ValidationError(`units[${index}] must not include ${key}`);
    }
  }

  if (friendly) {
    assert(typeof raw.name === 'string' && raw.name.length > 0, `units[${index}].name required`);
    unit.name = raw.name;
    unit.health = requireInt(raw.health, `units[${index}].health`, { min: 0, allowNegative: false });
    unit.timeUnits = requireInt(raw.timeUnits, `units[${index}].timeUnits`, { min: 0, allowNegative: false });

    if (schemaVersion === 3) {
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
      if (Object.prototype.hasOwnProperty.call(raw, 'actionCosts')) {
        unit.actionCosts = validateActionCosts(raw.actionCosts, `units[${index}].actionCosts`);
      }
    }
  } else {
    for (const key of [...v2Extras, ...(schemaVersion === 3 ? v3Extras : [])]) {
      assert(!Object.prototype.hasOwnProperty.call(raw, key), `units[${index}] must not include ${key}`);
    }
    if (schemaVersion === 2 && Object.prototype.hasOwnProperty.call(raw, 'actionCosts')) {
      throw new ValidationError(`units[${index}] must not include actionCosts`);
    }
  }

  return unit;
}

function parseAndValidate(raw) {
  assert(isPlainObject(raw), 'root must be a mapping');

  for (const key of Object.keys(raw)) {
    if (!ROOT_KEYS.has(key)) {
      throw new ValidationError(`unknown root field: ${key}`);
    }
  }

  const schemaVersion = requireInt(raw.schemaVersion, 'schemaVersion', { min: 2, allowNegative: false });
  assert(schemaVersion === 2 || schemaVersion === 3, 'schemaVersion must be 2 or 3');

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

  return {
    schemaVersion,
    turn,
    side,
    selectedUnitId,
    map,
    units,
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

function buildRelayPayload(tactical, publishedAt) {
  const snapshotId = computeSnapshotId(tactical);
  return {
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
  MAX_INPUT_BYTES,
  MAX_INVENTORY_ENTRIES,
  BT_FIREARM,
  BT_AMMO,
  BT_GRENADE,
  BT_PROXIMITYGRENADE,
  ValidationError,
  parseAndValidate,
  validateActionCosts,
  validateUnit,
  validateEquipmentItem,
  isFriendlyPlayerControlled,
  canonicalTacticalJson,
  computeSnapshotId,
  buildRelayPayload,
  loadAndValidateSnapshotFromText,
};
