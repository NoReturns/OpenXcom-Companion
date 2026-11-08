'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  validateRulesReferenceDocument,
  isRulesReferenceStale,
  RulesReferenceValidationError,
} = require('../lib/rules-reference-export.cjs');

const campaignId = 'a'.repeat(32);
const digest = 'b'.repeat(64);

function minimalDoc(overrides = {}) {
  return {
    schema_version: 1,
    artifact: 'companion-rules-reference',
    exported_at_ms: 1700000000000,
    identity: {
      campaign_id: campaignId,
      save_name: 'Test',
      game_date: { year: 1999, month: 1, day: 1, hour: 0, minute: 0 },
      research_revision_sha256: digest,
      ruleset_revision_sha256: digest,
      content_revision_sha256: digest,
    },
    ruleset: { mods: ['xcom2 ver: 1.0'] },
    limitations: {},
    items: [],
    ...overrides,
  };
}

describe('rules-reference-export (M1-WP5)', () => {
  it('accepts vanilla firearm and ammo items', () => {
    const doc = minimalDoc({
      items: [
        {
          type: 'STR_RIFLE',
          battleType: 'firearm',
          weaponCategory: 'rifle',
          projectileDamageSource: 'loaded_ammo',
          clipSize: 20,
          flatRate: false,
          firingModes: {
            snap: { accuracy: 55, tuRule: 33, tuUnit: 'percent' },
          },
          compatibleAmmo: ['STR_RIFLE_CLIP'],
        },
        {
          type: 'STR_RIFLE_CLIP',
          battleType: 'ammo',
          weaponCategory: 'ammunition',
          damagePower: 40,
          damageType: 'ap',
        },
      ],
    });
    const summary = validateRulesReferenceDocument(doc);
    assert.equal(summary.itemCount, 2);
  });

  it('rejects unsorted items', () => {
    const doc = minimalDoc({
      items: [
        { type: 'STR_Z', battleType: 'ammo', damagePower: 1, damageType: 'ap' },
        { type: 'STR_A', battleType: 'ammo', damagePower: 1, damageType: 'ap' },
      ],
    });
    assert.throws(
      () => validateRulesReferenceDocument(doc),
      (err) => err instanceof RulesReferenceValidationError && err.code === 'items_not_sorted',
    );
  });

  it('rejects duplicate item types', () => {
    const doc = minimalDoc({
      items: [
        { type: 'STR_A', battleType: 'ammo', damagePower: 1, damageType: 'ap' },
        { type: 'STR_A', battleType: 'ammo', damagePower: 2, damageType: 'ap' },
      ],
    });
    assert.throws(
      () => validateRulesReferenceDocument(doc),
      (err) => err instanceof RulesReferenceValidationError && err.code === 'duplicate_item_type',
    );
  });

  it('accepts schema_version 2 with inventorySections', () => {
    const doc = minimalDoc({
      schema_version: 2,
      inventorySections: [
        {
          id: 'STR_BELT',
          type: 'slot',
          transferCosts: [{ destinationSlotId: 'STR_BACK_PACK', tu: 16 }],
        },
      ],
    });
    validateRulesReferenceDocument(doc);
  });

  it('rejects malformed schema version', () => {
    assert.throws(
      () => validateRulesReferenceDocument(minimalDoc({ schema_version: 3 })),
      (err) => err.code === 'invalid_schema_version',
    );
  });

  it('rejects schema_version 2 without inventorySections', () => {
    assert.throws(
      () => validateRulesReferenceDocument(minimalDoc({ schema_version: 2 })),
      (err) => err.code === 'invalid_inventory_sections',
    );
  });

  it('rejects ammo without damage fields', () => {
    const doc = minimalDoc({
      items: [{ type: 'STR_A', battleType: 'ammo', weaponCategory: 'ammunition' }],
    });
    assert.throws(
      () => validateRulesReferenceDocument(doc),
      (err) => err.code === 'ammo_damage_required',
    );
  });

  it('detects stale campaign binding', () => {
    const doc = minimalDoc();
    const stale = isRulesReferenceStale(doc, { campaign_id: 'c'.repeat(32) });
    assert.equal(stale.stale, true);
    assert.equal(stale.reason, 'campaign_mismatch');
  });

  it('detects content revision mismatch', () => {
    const doc = minimalDoc();
    const fresh = isRulesReferenceStale(doc, {
      campaign_id: campaignId,
      rules_content_revision_sha256: digest,
    });
    assert.equal(fresh.stale, false);
    const stale = isRulesReferenceStale(doc, {
      campaign_id: campaignId,
      rules_content_revision_sha256: 'c'.repeat(64),
    });
    assert.equal(stale.stale, true);
    assert.equal(stale.reason, 'content_revision_mismatch');
  });
});
