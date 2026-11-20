'use strict';

const path = require('node:path');
const {
  validateRulesReferenceDocument,
  isRulesReferenceStale,
  RulesReferenceValidationError,
} = require('./rules-reference-export.cjs');

const RULES_REFERENCE_FILENAME = 'companion-rules-reference.json';
const SOLDIER_CONTROL_FILENAME = 'companion-soldier-control.json';
const COMMAND_TYPE_GUIDED_LAUNCH = 'GUIDED_LAUNCH';
const COMMAND_TYPE_HWP_GUIDED_LAUNCH = 'HWP_GUIDED_LAUNCH';

const RULES_REFERENCE_STATUS = Object.freeze({
  OK: 'ok',
  MISSING: 'missing',
  MALFORMED: 'malformed',
  CAMPAIGN_BINDING_UNAVAILABLE: 'campaign_binding_unavailable',
  CAMPAIGN_MISMATCH: 'campaign_mismatch',
  CONTENT_REVISION_MISMATCH: 'content_revision_mismatch',
  INVALID: 'invalid',
});

function resolveCompanionDirFromSnapshot(snapshotPath) {
  return path.dirname(path.resolve(snapshotPath));
}

function resolveRulesReferencePath(snapshotPath) {
  return path.join(resolveCompanionDirFromSnapshot(snapshotPath), RULES_REFERENCE_FILENAME);
}

function readJsonObjectIfExists(filePath, existsSync, readFileSync) {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
    return { __parseError: true };
  } catch {
    return { __parseError: true };
  }
}

function loadCampaignBindingFromCompanionDir(companionDir, existsSync, readFileSync) {
  const controlPath = path.join(companionDir, SOLDIER_CONTROL_FILENAME);
  const doc = readJsonObjectIfExists(controlPath, existsSync, readFileSync);
  if (!doc || doc.__parseError) {
    return { campaign_id: null, rules_content_revision_sha256: null };
  }
  const campaignId = typeof doc.campaign_id === 'string' ? doc.campaign_id.trim() : null;
  const contentRevision = typeof doc.rules_content_revision_sha256 === 'string'
    ? doc.rules_content_revision_sha256.trim()
    : null;
  return {
    campaign_id: campaignId,
    rules_content_revision_sha256: contentRevision,
  };
}

function publicReasonForRulesReferenceStatus(status, detail = null) {
  switch (status) {
    case RULES_REFERENCE_STATUS.MISSING:
      return 'Local rules reference required (refresh with F6 tactical snapshot or Ctrl+Shift+R in the current campaign).';
    case RULES_REFERENCE_STATUS.CAMPAIGN_BINDING_UNAVAILABLE:
      return 'Active campaign binding unavailable; cannot verify rules reference for guided launch.';
    case RULES_REFERENCE_STATUS.CAMPAIGN_MISMATCH:
      return 'Rules reference campaign_id does not match active campaign.';
    case RULES_REFERENCE_STATUS.CONTENT_REVISION_MISMATCH:
      return 'Rules reference content revision is stale for this campaign.';
    case RULES_REFERENCE_STATUS.MALFORMED:
      return 'Local rules reference is malformed JSON.';
    case RULES_REFERENCE_STATUS.INVALID:
      return detail || 'Local rules reference failed validation.';
    default:
      return detail || 'Local rules reference unavailable for guided launch validation.';
  }
}

/**
 * Resolve validated rules reference for sidecar tactical command validation.
 * @returns {{ status: string, rulesReference: object|null, publicReason: string|null, summary: object|null }}
 */
function resolveSidecarRulesReferenceValidation(snapshotPath, io = {}) {
  const existsSync = io.existsSync ?? require('node:fs').existsSync;
  const readFileSync = io.readFileSync ?? require('node:fs').readFileSync;
  const companionDir = resolveCompanionDirFromSnapshot(snapshotPath);
  const rulesPath = path.join(companionDir, RULES_REFERENCE_FILENAME);

  if (!existsSync(rulesPath)) {
    return {
      status: RULES_REFERENCE_STATUS.MISSING,
      rulesReference: null,
      publicReason: publicReasonForRulesReferenceStatus(RULES_REFERENCE_STATUS.MISSING),
      summary: null,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(rulesPath, 'utf8'));
  } catch {
    return {
      status: RULES_REFERENCE_STATUS.MALFORMED,
      rulesReference: null,
      publicReason: publicReasonForRulesReferenceStatus(RULES_REFERENCE_STATUS.MALFORMED),
      summary: null,
    };
  }

  try {
    const summary = validateRulesReferenceDocument(parsed);
    const binding = loadCampaignBindingFromCompanionDir(companionDir, existsSync, readFileSync);
    if (!binding.campaign_id) {
      return {
        status: RULES_REFERENCE_STATUS.CAMPAIGN_BINDING_UNAVAILABLE,
        rulesReference: null,
        publicReason: publicReasonForRulesReferenceStatus(RULES_REFERENCE_STATUS.CAMPAIGN_BINDING_UNAVAILABLE),
        summary,
      };
    }
    const stale = isRulesReferenceStale(parsed, binding);
    if (stale.stale) {
      const status = stale.reason === 'campaign_mismatch'
        ? RULES_REFERENCE_STATUS.CAMPAIGN_MISMATCH
        : (stale.reason === 'content_revision_mismatch'
          ? RULES_REFERENCE_STATUS.CONTENT_REVISION_MISMATCH
          : RULES_REFERENCE_STATUS.INVALID);
      return {
        status,
        rulesReference: null,
        publicReason: publicReasonForRulesReferenceStatus(status),
        summary,
      };
    }
    return {
      status: RULES_REFERENCE_STATUS.OK,
      rulesReference: parsed,
      publicReason: null,
      summary,
    };
  } catch (err) {
    const detail = err instanceof RulesReferenceValidationError
      ? err.message
      : (err && err.message ? err.message : String(err));
    return {
      status: RULES_REFERENCE_STATUS.INVALID,
      rulesReference: null,
      publicReason: publicReasonForRulesReferenceStatus(RULES_REFERENCE_STATUS.INVALID, detail),
      summary: null,
    };
  }
}

function buildSidecarTacticalValidationOptions(snapshotPath, command, io = {}) {
  const rules = resolveSidecarRulesReferenceValidation(snapshotPath, io);
  const needsRules = command && (
    command.command_type === COMMAND_TYPE_GUIDED_LAUNCH
    || command.command_type === COMMAND_TYPE_HWP_GUIDED_LAUNCH
  );
  if (needsRules && rules.status !== RULES_REFERENCE_STATUS.OK) {
    return {
      blocked: true,
      rules,
      validationOptions: {},
    };
  }
  return {
    blocked: false,
    rules,
    validationOptions: rules.rulesReference
      ? { rulesReference: rules.rulesReference }
      : {},
  };
}

module.exports = {
  RULES_REFERENCE_FILENAME,
  SOLDIER_CONTROL_FILENAME,
  COMMAND_TYPE_GUIDED_LAUNCH,
  COMMAND_TYPE_HWP_GUIDED_LAUNCH,
  RULES_REFERENCE_STATUS,
  resolveRulesReferencePath,
  resolveSidecarRulesReferenceValidation,
  buildSidecarTacticalValidationOptions,
  publicReasonForRulesReferenceStatus,
  loadCampaignBindingFromCompanionDir,
};