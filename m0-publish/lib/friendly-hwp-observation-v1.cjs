'use strict';

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

function requireInt(value, label, { min = -Infinity, max = Infinity, allowNegative = true } = {}) {
  assert(Number.isInteger(value), `${label} must be an integer`);
  if (!allowNegative) assert(value >= 0, `${label} must be non-negative`);
  if (value < min) throw new ValidationError(`${label} below minimum ${min}`);
  if (value > max) throw new ValidationError(`${label} above maximum ${max}`);
  return value;
}

function requireString(value, label, { maxLength = 512 } = {}) {
  assert(typeof value === 'string', `${label} must be a string`);
  assert(value.length > 0, `${label} required`);
  if (value.length > maxLength) throw new ValidationError(`${label} exceeds max length`);
  return value;
}

function requireBool(value, label) {
  assert(typeof value === 'boolean', `${label} must be boolean`);
  return value;
}

const FACING_LABELS = new Set([
  'north',
  'northeast',
  'east',
  'southeast',
  'south',
  'southwest',
  'west',
  'northwest',
]);

const BT_FIREARM = 1;
const BT_AMMO = 2;
/** Same upper bound as roster equipment in tactical-publish.cjs */
const MAX_BATTLE_ITEM_ID = 2147483647;

const BATTLE_ITEM_ID_BOUNDS = { min: 0, max: MAX_BATTLE_ITEM_ID, allowNegative: false };

const OBSERVATION_KEYS = new Set([
  'schemaVersion',
  'unitId',
  'hwpUnitType',
  'displayLabel',
  'position',
  'bodyFacing',
  'turretFacing',
  'turretTypeId',
  'timeUnits',
  'maxTimeUnits',
  'health',
  'maxHealth',
  'kneeled',
  'movementType',
  'capabilities',
  'fixedWeapons',
]);

const CAPABILITY_KEYS = new Set(['bodyTurn', 'turretTurn']);
const POSITION_KEYS = new Set(['x', 'y', 'z']);
const FACING_KEYS = new Set(['direction', 'label', 'vector', 'turning']);
const VECTOR_KEYS = new Set(['dx', 'dy']);

const WEAPON_KEYS = new Set([
  'battleItemId',
  'itemType',
  'battleType',
  'researchUsable',
  'inventorySlotType',
  'slot',
  'hand',
  'loaded',
  'noMagazineInserted',
  'empty',
  'nestedAmmo',
  'actionCosts',
]);

const LOADED_KEYS = new Set(['ammoType', 'rounds', 'battleItemId', 'researchUsable']);

function validateFacingBlock(raw, label) {
  assert(isPlainObject(raw), `${label} must be an object`);
  for (const key of Object.keys(raw)) {
    if (!FACING_KEYS.has(key)) throw new ValidationError(`${label} unknown field: ${key}`);
  }
  const direction = requireInt(raw.direction, `${label}.direction`, { min: 0, max: 7, allowNegative: false });
  if (Object.prototype.hasOwnProperty.call(raw, 'label')) {
    const facingLabel = requireString(raw.label, `${label}.label`, { maxLength: 16 });
    assert(FACING_LABELS.has(facingLabel), `${label}.label invalid`);
  }
  assert(isPlainObject(raw.vector), `${label}.vector required`);
  for (const key of Object.keys(raw.vector)) {
    if (!VECTOR_KEYS.has(key)) throw new ValidationError(`${label}.vector unknown field: ${key}`);
  }
  requireInt(raw.vector.dx, `${label}.vector.dx`, { min: -1, max: 1, allowNegative: true });
  requireInt(raw.vector.dy, `${label}.vector.dy`, { min: -1, max: 1, allowNegative: true });
  const out = { direction, vector: { dx: raw.vector.dx, dy: raw.vector.dy } };
  if (Object.prototype.hasOwnProperty.call(raw, 'label')) out.label = raw.label;
  if (Object.prototype.hasOwnProperty.call(raw, 'turning')) {
    out.turning = requireBool(raw.turning, `${label}.turning`);
  }
  return out;
}

function validateLoadedBlock(raw, label) {
  assert(isPlainObject(raw), `${label} must be an object`);
  for (const key of Object.keys(raw)) {
    if (!LOADED_KEYS.has(key)) throw new ValidationError(`${label} unknown field: ${key}`);
  }
  const loaded = {
    ammoType: requireString(raw.ammoType, `${label}.ammoType`, { maxLength: 128 }),
    rounds: requireInt(raw.rounds, `${label}.rounds`, { min: 0, allowNegative: false }),
  };
  if (Object.prototype.hasOwnProperty.call(raw, 'battleItemId')) {
    loaded.battleItemId = requireInt(raw.battleItemId, `${label}.battleItemId`, BATTLE_ITEM_ID_BOUNDS);
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'researchUsable')) {
    loaded.researchUsable = requireBool(raw.researchUsable, `${label}.researchUsable`);
  }
  return loaded;
}

function validateFixedWeapon(raw, label) {
  assert(isPlainObject(raw), `${label} must be an object`);
  for (const key of Object.keys(raw)) {
    if (!WEAPON_KEYS.has(key)) throw new ValidationError(`${label} unknown field: ${key}`);
  }
  const battleType = requireInt(raw.battleType, `${label}.battleType`, { min: 0, max: 11, allowNegative: false });
  assert(battleType === BT_FIREARM || battleType === BT_AMMO, `${label}.battleType must be firearm or HWP weapon type`);
  const weapon = {
    battleItemId: requireInt(raw.battleItemId, `${label}.battleItemId`, BATTLE_ITEM_ID_BOUNDS),
    itemType: requireString(raw.itemType, `${label}.itemType`, { maxLength: 128 }),
    battleType,
  };
  if (Object.prototype.hasOwnProperty.call(raw, 'researchUsable')) {
    weapon.researchUsable = requireBool(raw.researchUsable, `${label}.researchUsable`);
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'loaded')) {
    weapon.loaded = validateLoadedBlock(raw.loaded, `${label}.loaded`);
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'noMagazineInserted')) {
    weapon.noMagazineInserted = requireBool(raw.noMagazineInserted, `${label}.noMagazineInserted`);
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'empty')) {
    weapon.empty = requireBool(raw.empty, `${label}.empty`);
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'actionCosts')) {
    assert(Array.isArray(raw.actionCosts), `${label}.actionCosts must be an array`);
    weapon.actionCosts = raw.actionCosts;
  }
  return weapon;
}

/**
 * Validate engine-exported friendlyHwpObservationV1 block (additive HWP-S1 contract).
 */
function validateFriendlyHwpObservationV1(raw, unitIndex) {
  const label = `units[${unitIndex}].friendlyHwpObservationV1`;
  assert(isPlainObject(raw), `${label} must be an object`);
  for (const key of Object.keys(raw)) {
    if (!OBSERVATION_KEYS.has(key)) throw new ValidationError(`${label} unknown field: ${key}`);
  }
  assert(raw.schemaVersion === 1, `${label}.schemaVersion must be 1`);
  const unitId = requireInt(raw.unitId, `${label}.unitId`, { min: 1_000_000, allowNegative: false });

  const observation = {
    schemaVersion: 1,
    unitId,
    hwpUnitType: requireString(raw.hwpUnitType, `${label}.hwpUnitType`, { maxLength: 64 }),
    timeUnits: requireInt(raw.timeUnits, `${label}.timeUnits`, { min: 0, allowNegative: false }),
    kneeled: requireBool(raw.kneeled, `${label}.kneeled`),
  };

  if (Object.prototype.hasOwnProperty.call(raw, 'displayLabel')) {
    observation.displayLabel = requireString(raw.displayLabel, `${label}.displayLabel`, { maxLength: 96 });
  }
  assert(isPlainObject(raw.position), `${label}.position required`);
  for (const key of Object.keys(raw.position)) {
    if (!POSITION_KEYS.has(key)) throw new ValidationError(`${label}.position unknown field: ${key}`);
  }
  observation.position = {
    x: requireInt(raw.position.x, `${label}.position.x`, { min: 0, allowNegative: false }),
    y: requireInt(raw.position.y, `${label}.position.y`, { min: 0, allowNegative: false }),
    z: requireInt(raw.position.z, `${label}.position.z`, { min: 0, allowNegative: false }),
  };
  if (Object.prototype.hasOwnProperty.call(raw, 'bodyFacing')) {
    observation.bodyFacing = validateFacingBlock(raw.bodyFacing, `${label}.bodyFacing`);
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'turretFacing')) {
    observation.turretFacing = validateFacingBlock(raw.turretFacing, `${label}.turretFacing`);
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'turretTypeId')) {
    observation.turretTypeId = requireInt(raw.turretTypeId, `${label}.turretTypeId`, { min: 0, allowNegative: false });
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'maxTimeUnits')) {
    observation.maxTimeUnits = requireInt(raw.maxTimeUnits, `${label}.maxTimeUnits`, { min: 0, allowNegative: false });
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'health')) {
    observation.health = requireInt(raw.health, `${label}.health`, { min: 0, allowNegative: false });
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'maxHealth')) {
    observation.maxHealth = requireInt(raw.maxHealth, `${label}.maxHealth`, { min: 1, allowNegative: false });
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'movementType')) {
    observation.movementType = requireString(raw.movementType, `${label}.movementType`, { maxLength: 16 });
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'capabilities')) {
    assert(isPlainObject(raw.capabilities), `${label}.capabilities must be an object`);
    for (const key of Object.keys(raw.capabilities)) {
      if (!CAPABILITY_KEYS.has(key)) throw new ValidationError(`${label}.capabilities unknown field: ${key}`);
    }
    observation.capabilities = {
      bodyTurn: requireBool(raw.capabilities.bodyTurn, `${label}.capabilities.bodyTurn`),
      turretTurn: requireBool(raw.capabilities.turretTurn, `${label}.capabilities.turretTurn`),
    };
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'fixedWeapons')) {
    assert(Array.isArray(raw.fixedWeapons), `${label}.fixedWeapons must be an array`);
    observation.fixedWeapons = raw.fixedWeapons.map((w, i) => validateFixedWeapon(w, `${label}.fixedWeapons[${i}]`));
  }
  return observation;
}

/** List friendly HWP observation rows (never roster soldiers). */
function listFriendlyHwpObservations(tactical) {
  const out = [];
  for (const unit of tactical?.units ?? []) {
    if (!unit?.friendlyHwpObservationV1) continue;
    out.push({
      id: unit.id,
      ...unit.friendlyHwpObservationV1,
    });
  }
  return out;
}

module.exports = {
  ValidationError,
  validateFriendlyHwpObservationV1,
  listFriendlyHwpObservations,
};