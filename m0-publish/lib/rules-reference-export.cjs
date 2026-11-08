'use strict';

const CAMPAIGN_ID_RE = /^[0-9a-f]{32}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

class RulesReferenceValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RulesReferenceValidationError';
    this.code = code;
  }
}

function assertObject(value, code, message) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RulesReferenceValidationError(code, message);
  }
}

function validateRulesReferenceDocument(doc) {
  assertObject(doc, 'invalid_root', 'Rules reference root must be an object.');
  if (doc.schema_version !== 1 && doc.schema_version !== 2) {
    throw new RulesReferenceValidationError('invalid_schema_version', 'schema_version must be 1 or 2.');
  }
  if (doc.artifact !== 'companion-rules-reference') {
    throw new RulesReferenceValidationError('invalid_artifact', 'artifact must be companion-rules-reference.');
  }
  if (typeof doc.exported_at_ms !== 'number' || !Number.isFinite(doc.exported_at_ms)) {
    throw new RulesReferenceValidationError('invalid_exported_at', 'exported_at_ms must be a finite number.');
  }

  assertObject(doc.identity, 'invalid_identity', 'identity block required.');
  if (!CAMPAIGN_ID_RE.test(doc.identity.campaign_id || '')) {
    throw new RulesReferenceValidationError('invalid_campaign_id', 'identity.campaign_id must be 32 lowercase hex.');
  }
  for (const key of ['research_revision_sha256', 'ruleset_revision_sha256', 'content_revision_sha256']) {
    if (!SHA256_RE.test(doc.identity[key] || '')) {
      throw new RulesReferenceValidationError('invalid_identity_digest', `${key} must be 64 lowercase hex.`);
    }
  }

  assertObject(doc.ruleset, 'invalid_ruleset', 'ruleset block required.');
  if (!Array.isArray(doc.ruleset.mods)) {
    throw new RulesReferenceValidationError('invalid_mods', 'ruleset.mods must be an array.');
  }

  if (!Array.isArray(doc.items)) {
    throw new RulesReferenceValidationError('invalid_items', 'items must be an array.');
  }

  if (doc.schema_version === 2) {
    if (!Array.isArray(doc.inventorySections)) {
      throw new RulesReferenceValidationError('invalid_inventory_sections', 'inventorySections must be an array for schema_version 2.');
    }
    const seenInv = new Set();
    for (const sec of doc.inventorySections) {
      assertObject(sec, 'invalid_inventory_section', 'Each inventorySections entry must be an object.');
      if (typeof sec.id !== 'string' || sec.id.length === 0) {
        throw new RulesReferenceValidationError('invalid_inventory_section_id', 'inventory section id required.');
      }
      if (seenInv.has(sec.id)) {
        throw new RulesReferenceValidationError('duplicate_inventory_section', `duplicate inventory section ${sec.id}.`);
      }
      seenInv.add(sec.id);
      if (sec.type !== 'slot' && sec.type !== 'hand' && sec.type !== 'ground') {
        throw new RulesReferenceValidationError('invalid_inventory_section_type', 'inventory section type must be slot, hand, or ground.');
      }
      if (!Array.isArray(sec.transferCosts)) {
        throw new RulesReferenceValidationError('invalid_transfer_costs', 'transferCosts must be an array.');
      }
      for (const row of sec.transferCosts) {
        assertObject(row, 'invalid_transfer_cost', 'transferCosts rows must be objects.');
        if (typeof row.destinationSlotId !== 'string' || !row.destinationSlotId.length) {
          throw new RulesReferenceValidationError('invalid_transfer_dest', 'destinationSlotId required.');
        }
        if (typeof row.tu !== 'number' || !Number.isInteger(row.tu) || row.tu < 0) {
          throw new RulesReferenceValidationError('invalid_transfer_tu', 'tu must be a non-negative integer.');
        }
      }
    }
  }

  let previousType = null;
  const seenTypes = new Set();
  for (const item of doc.items) {
    assertObject(item, 'invalid_item', 'each item must be an object.');
    if (typeof item.type !== 'string' || item.type.length === 0) {
      throw new RulesReferenceValidationError('invalid_item_type', 'item.type must be a non-empty string.');
    }
    if (seenTypes.has(item.type)) {
      throw new RulesReferenceValidationError('duplicate_item_type', `duplicate item type ${item.type}.`);
    }
    seenTypes.add(item.type);
    if (previousType !== null && item.type < previousType) {
      throw new RulesReferenceValidationError('items_not_sorted', 'items must be sorted by type ascending.');
    }
    previousType = item.type;
    if (typeof item.battleType !== 'string' || item.battleType.length === 0) {
      throw new RulesReferenceValidationError('invalid_battle_type', 'item.battleType required.');
    }
    if (item.battleType === 'ammo') {
      if (typeof item.damagePower !== 'number' || typeof item.damageType !== 'string') {
        throw new RulesReferenceValidationError('ammo_damage_required', 'ammo items require damagePower and damageType.');
      }
    }
    if (item.battleType === 'firearm' && item.firingModes) {
      assertObject(item.firingModes, 'invalid_firing_modes', 'firingModes must be an object when present.');
      for (const mode of Object.values(item.firingModes)) {
        assertObject(mode, 'invalid_firing_mode', 'firing mode entries must be objects.');
        if (typeof mode.tuUnit !== 'string' || !['percent', 'absolute'].includes(mode.tuUnit)) {
          throw new RulesReferenceValidationError('invalid_tu_unit', 'firing mode tuUnit must be percent or absolute.');
        }
      }
    }
  }

  return {
    campaignId: doc.identity.campaign_id,
    contentRevisionSha256: doc.identity.content_revision_sha256,
    itemCount: doc.items.length,
  };
}

function isRulesReferenceStale(rulesReference, tacticalBinding) {
  if (!rulesReference || !tacticalBinding) {
    return { stale: true, reason: 'missing_context' };
  }
  try {
    const parsed = typeof rulesReference === 'string' ? JSON.parse(rulesReference) : rulesReference;
    const summary = validateRulesReferenceDocument(parsed);
    if (tacticalBinding.campaign_id && summary.campaignId !== tacticalBinding.campaign_id) {
      return { stale: true, reason: 'campaign_mismatch' };
    }
    if (tacticalBinding.rules_content_revision_sha256
      && summary.contentRevisionSha256 !== tacticalBinding.rules_content_revision_sha256) {
      return { stale: true, reason: 'content_revision_mismatch' };
    }
    return { stale: false, reason: null, summary };
  } catch (err) {
    return { stale: true, reason: err.code || 'invalid_rules_reference' };
  }
}

module.exports = {
  RulesReferenceValidationError,
  validateRulesReferenceDocument,
  isRulesReferenceStale,
};
