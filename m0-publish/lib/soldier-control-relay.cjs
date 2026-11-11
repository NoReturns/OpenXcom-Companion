'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isFriendlyRosterSoldier } = require('./unit-state-brief.cjs');

const SOLDIER_CONTROL_SCHEMA_VERSION = 1;
const SESSION_ID_RE = /^[a-f0-9]{32}$/;
const DURABLE_ID_RE = /^[a-f0-9]{32}$/;

class SoldierControlParseError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'SoldierControlParseError';
    this.reason = reason;
  }
}

function parseSoldierControlDocument(jsonText) {
  if (typeof jsonText !== 'string' || jsonText.trim() === '') {
    throw new SoldierControlParseError('empty_control_file');
  }
  let value;
  try {
    value = JSON.parse(jsonText);
  } catch {
    throw new SoldierControlParseError('invalid_json');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SoldierControlParseError('invalid_root');
  }
  if (value.schema_version !== SOLDIER_CONTROL_SCHEMA_VERSION) {
    throw new SoldierControlParseError('unsupported_schema_version');
  }
  if (typeof value.session_id !== 'string' || !SESSION_ID_RE.test(value.session_id)) {
    throw new SoldierControlParseError('invalid_session_id');
  }
  const assignments = value.assignments;
  if (!assignments || typeof assignments !== 'object' || Array.isArray(assignments)) {
    throw new SoldierControlParseError('invalid_assignments');
  }
  const normalizedAssignments = {};
  for (const [key, mode] of Object.entries(assignments)) {
    const id = Number.parseInt(String(key), 10);
    if (!Number.isInteger(id) || id <= 0) {
      throw new SoldierControlParseError('invalid_assignment_soldier_id');
    }
    if (mode !== 'ai') {
      throw new SoldierControlParseError('invalid_assignment_mode');
    }
    normalizedAssignments[id] = 'ai';
  }
  let campaignId;
  let tacticalBattleId;
  if (Object.prototype.hasOwnProperty.call(value, 'campaign_id')) {
    if (typeof value.campaign_id !== 'string' || !DURABLE_ID_RE.test(value.campaign_id)) {
      throw new SoldierControlParseError('invalid_campaign_id');
    }
    campaignId = value.campaign_id;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'tactical_battle_id')) {
    if (typeof value.tactical_battle_id !== 'string' || !DURABLE_ID_RE.test(value.tactical_battle_id)) {
      throw new SoldierControlParseError('invalid_tactical_battle_id');
    }
    tacticalBattleId = value.tactical_battle_id;
  }
  return {
    schema_version: SOLDIER_CONTROL_SCHEMA_VERSION,
    session_id: value.session_id,
    campaign_id: campaignId,
    tactical_battle_id: tacticalBattleId,
    assignments: normalizedAssignments,
  };
}

/**
 * Mirrors engine CompanionSoldierOwnershipCore::relayBindingMatchesDocument with optional durable context.
 */
function relayControlBindingMatches(doc, bindingContext) {
  const ctx = bindingContext ?? {};
  const battleSessionId = ctx.session_id ?? ctx.battleSessionId ?? '';
  const campaignId = ctx.campaign_id ?? ctx.campaignId ?? '';
  const tacticalBattleId = ctx.tactical_battle_id ?? ctx.tacticalBattleId ?? '';

  const hasDurableDoc = Boolean(doc.campaign_id && doc.tactical_battle_id);
  if (hasDurableDoc) {
    if (campaignId && tacticalBattleId) {
      return doc.campaign_id === campaignId
        && doc.tactical_battle_id === tacticalBattleId
        && doc.session_id === battleSessionId;
    }
    return doc.session_id === battleSessionId;
  }
  if (!battleSessionId) {
    return false;
  }
  return doc.session_id === battleSessionId;
}

function listRosterSoldierIds(tactical) {
  return tactical.units
    .filter(isFriendlyRosterSoldier)
    .map((u) => u.id)
    .sort((a, b) => a - b);
}

function resolveControlFileJson(options = {}) {
  if (typeof options.soldierControlFileJson === 'string') {
    return options.soldierControlFileJson;
  }
  const filePath = options.soldierControlFilePath
    ?? (options.snapshotPath
      ? path.join(path.dirname(options.snapshotPath), 'companion-soldier-control.json')
      : null);
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }
  return fs.readFileSync(filePath, 'utf8');
}

function buildUnavailableSoldierControl({ capturedAt, reason, sessionId = null }) {
  return {
    schema_version: SOLDIER_CONTROL_SCHEMA_VERSION,
    availability: 'unavailable',
    unavailable_reason: reason,
    captured_at: capturedAt,
    source: 'companion-soldier-control.json',
    session_id: sessionId,
    note: 'Ownership assignments are local-only; this mirror is read-only at publish time.',
  };
}

/**
 * Read-only mirror of companion-soldier-control.json for relay consumers (P1-B).
 */
function buildSoldierControlMirror(tactical, options = {}) {
  const capturedAt = typeof options.capturedAt === 'string' ? options.capturedAt : new Date().toISOString();
  const battleSessionId = tactical?.eventLog?.sessionId;
  if (typeof battleSessionId !== 'string' || !SESSION_ID_RE.test(battleSessionId)) {
    return buildUnavailableSoldierControl({
      capturedAt,
      reason: 'missing_tactical_session_id',
    });
  }

  let controlText;
  try {
    controlText = resolveControlFileJson(options);
  } catch {
    return buildUnavailableSoldierControl({
      capturedAt,
      reason: 'control_file_read_error',
      sessionId: battleSessionId,
    });
  }
  if (controlText === null) {
    return buildUnavailableSoldierControl({
      capturedAt,
      reason: 'missing_control_file',
      sessionId: battleSessionId,
    });
  }

  let doc;
  try {
    doc = parseSoldierControlDocument(controlText);
  } catch (error) {
    const reason = error instanceof SoldierControlParseError ? error.reason : 'invalid_control_file';
    return buildUnavailableSoldierControl({
      capturedAt,
      reason,
      sessionId: battleSessionId,
    });
  }

  const rosterIds = new Set(listRosterSoldierIds(tactical));
  for (const assignedId of Object.keys(doc.assignments)) {
    const id = Number(assignedId);
    if (!rosterIds.has(id)) {
      return buildUnavailableSoldierControl({
        capturedAt,
        reason: 'unknown_assignment_soldier_id',
        sessionId: battleSessionId,
      });
    }
  }

  const bindingContext = {
    session_id: battleSessionId,
    ...(options.ownershipBindingContext ?? {}),
  };
  const bindingMatch = relayControlBindingMatches(doc, bindingContext);
  const durableIdentityVerified = Boolean(
    doc.campaign_id
    && doc.tactical_battle_id
    && bindingContext.campaign_id
    && bindingContext.tactical_battle_id
    && doc.campaign_id === bindingContext.campaign_id
    && doc.tactical_battle_id === bindingContext.tactical_battle_id,
  );

  if (!bindingMatch) {
    return buildUnavailableSoldierControl({
      capturedAt,
      reason: doc.session_id !== battleSessionId ? 'stale_session_id' : 'identity_mismatch',
      sessionId: battleSessionId,
    });
  }

  const soldiers = [...rosterIds]
    .sort((a, b) => a - b)
    .map((id) => ({
      id,
      controlMode: doc.assignments[id] === 'ai' ? 'ai' : 'human',
    }));

  const mirror = {
    schema_version: SOLDIER_CONTROL_SCHEMA_VERSION,
    availability: 'available',
    captured_at: capturedAt,
    source: 'companion-soldier-control.json',
    session_id: doc.session_id,
    session_match: true,
    binding_match: true,
    snapshot_session_id: battleSessionId,
    soldiers,
    note: 'Read-only mirror at publish time; remote relay cannot assign control.',
  };
  if (doc.campaign_id) {
    mirror.campaign_id = doc.campaign_id;
  }
  if (doc.tactical_battle_id) {
    mirror.tactical_battle_id = doc.tactical_battle_id;
  }
  if (bindingContext.campaign_id || bindingContext.tactical_battle_id) {
    mirror.durable_identity_match = durableIdentityVerified;
  }
  return mirror;
}

module.exports = {
  SOLDIER_CONTROL_SCHEMA_VERSION,
  SESSION_ID_RE,
  SoldierControlParseError,
  parseSoldierControlDocument,
  relayControlBindingMatches,
  listRosterSoldierIds,
  buildSoldierControlMirror,
  resolveControlFileJson,
};
