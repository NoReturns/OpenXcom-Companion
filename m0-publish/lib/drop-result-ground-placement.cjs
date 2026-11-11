'use strict';

/**
 * DROP tactical-result ground placement (P1-C).
 * Engine immediate evidence vs independent tactical snapshot confirmation.
 */

const TERMINAL_DROP_STATUSES = new Set(['COMPLETED', 'FAILED', 'INTERRUPTED', 'REJECTED']);

function classifyDropResult(result) {
  if (!result || typeof result !== 'object') {
    return { category: 'invalid', canClaimPlacement: false };
  }
  if (result.command_type !== 'DROP') {
    return { category: 'not_drop', canClaimPlacement: false };
  }
  const status = result.status;
  if (!TERMINAL_DROP_STATUSES.has(status)) {
    return { category: 'non_terminal', canClaimPlacement: false };
  }
  if (status === 'REJECTED') {
    return { category: 'drop_rejected', canClaimPlacement: false };
  }
  if (status === 'FAILED' || status === 'INTERRUPTED') {
    return { category: 'drop_failed_or_interrupted', canClaimPlacement: false };
  }
  const gp = result.ground_placement;
  if (!gp || typeof gp !== 'object') {
    return { category: 'drop_completed_placement_unverified', canClaimPlacement: false };
  }
  if (gp.verification_status === 'engine_postcondition_verified') {
    return { category: 'drop_executed_placement_verified', canClaimPlacement: true };
  }
  return { category: 'drop_executed_placement_unverified', canClaimPlacement: false };
}

function positionsEqual(snapshotPos, tile) {
  if (!snapshotPos || !tile) return false;
  const sx = Array.isArray(snapshotPos) ? snapshotPos[0] : snapshotPos.x;
  const sy = Array.isArray(snapshotPos) ? snapshotPos[1] : snapshotPos.y;
  const sz = Array.isArray(snapshotPos) ? snapshotPos[2] : snapshotPos.z;
  return sx === tile.x && sy === tile.y && sz === tile.z;
}

/**
 * Pre-command binding: command.snapshot_sha256 + command.state_version at delivery.
 * DROP result.state_version mirrors that binding; result.snapshot_sha256 is the
 * engine-reported export digest after DROP (post-command), not the pre-command hash.
 * Post-command / F6 tactical: eventLog.latestSeq and digest move forward together.
 */
function assessDropSnapshotFreshness(result, tactical, options = {}) {
  const snapshotSessionId = tactical?.eventLog?.sessionId;
  if (typeof result.session_id === 'string' && typeof snapshotSessionId === 'string'
    && result.session_id !== snapshotSessionId) {
    return { ok: false, reason: 'session_id_mismatch' };
  }

  if (Number.isInteger(result.turn) && Number.isInteger(tactical?.turn)
    && result.turn !== tactical.turn) {
    return { ok: false, reason: 'turn_mismatch' };
  }

  const preCommandSha = options.preCommandSnapshotSha256
    ?? options.deliveredCommandSnapshotSha256;
  const postDigest = options.snapshotSha256Lower;

  if (typeof postDigest === 'string' && typeof preCommandSha === 'string'
    && postDigest === preCommandSha) {
    return { ok: false, reason: 'snapshot_is_pre_command_binding' };
  }

  const latestSeq = tactical?.eventLog?.latestSeq;
  const bindingSeq = result.state_version;

  if (Number.isInteger(latestSeq) && Number.isInteger(bindingSeq)) {
    if (latestSeq < bindingSeq) {
      return { ok: false, reason: 'snapshot_older_than_command_binding' };
    }
    const digestMatchesEngineResult = typeof postDigest === 'string'
      && typeof result.snapshot_sha256 === 'string'
      && postDigest === result.snapshot_sha256;
    const seqAdvanced = latestSeq > bindingSeq;
    if (!digestMatchesEngineResult && !seqAdvanced) {
      return { ok: false, reason: 'snapshot_not_observably_after_command' };
    }
  }

  return { ok: true };
}

/**
 * Compare terminal DROP ground_placement to a tactical snapshot groundInventory row.
 */
function compareDropGroundPlacementToSnapshot(result, tactical, options = {}) {
  const classification = classifyDropResult(result);
  const actorId = result?.actor_unit_id;
  const gp = result?.ground_placement;
  const actor = tactical?.units?.find((u) => u.id === actorId) ?? null;

  const out = {
    ...classification,
    engineVerified: gp?.verification_status === 'engine_postcondition_verified',
    independentSnapshotConfirmed: false,
    snapshotMatch: null,
    limitation: null,
    freshnessVerified: false,
    freshnessReason: null,
  };

  if (classification.category !== 'drop_executed_placement_verified') {
    if (classification.category === 'drop_rejected') {
      out.limitation = 'Rejected DROP must not claim ground placement.';
    }
    return out;
  }

  const freshness = assessDropSnapshotFreshness(result, tactical, options);
  if (!freshness.ok) {
    out.limitation = `Snapshot freshness check failed (${freshness.reason}).`;
    out.freshnessReason = freshness.reason;
    return out;
  }

  out.freshnessVerified = true;

  if (!actor || !Array.isArray(actor.groundInventory)) {
    out.limitation = 'Actor or groundInventory missing from snapshot; F6 confirmation unavailable.';
    return out;
  }

  if (!positionsEqual(actor.position, gp.tile)) {
    out.limitation = 'Snapshot actor tile does not match ground_placement.tile.';
    return out;
  }

  const row = actor.groundInventory.find((item) => item.battleItemId === gp.item_battle_item_id);
  if (!row) {
    out.limitation = 'battleItemId not found in snapshot groundInventory at actor tile.';
    return out;
  }

  if (Number.isInteger(result.item_battle_item_id)
    && result.item_battle_item_id !== gp.item_battle_item_id) {
    out.limitation = 'DROP result item_battle_item_id does not match ground_placement item id.';
    return out;
  }

  if (Number.isInteger(gp.item_battle_item_id) && row.battleItemId !== gp.item_battle_item_id) {
    out.limitation = 'Snapshot ground row battleItemId does not match ground_placement item id.';
    return out;
  }

  const ix = row.inventoryX;
  const iy = row.inventoryY;
  const cellMatch = ix === gp.inventory_x && iy === gp.inventory_y;
  out.snapshotMatch = {
    battleItemId: row.battleItemId,
    inventoryX: ix,
    inventoryY: iy,
    cellMatch,
    carriedRosterUnitId: row.carriedRosterUnitId ?? null,
  };

  if (cellMatch && result.item_battle_item_id === gp.item_battle_item_id) {
    out.independentSnapshotConfirmed = true;
  } else {
    out.limitation = 'Snapshot ground cell or top-level item id does not match engine ground_placement.';
    out.verification_class_hint = 'drop_verification_inconsistent';
  }
  return out;
}

function resolveDropVerificationClass(result, comparison, classification) {
  if (classification.category === 'drop_rejected') {
    return 'drop_rejected';
  }
  if (classification.category === 'drop_failed_or_interrupted') {
    return 'drop_failed_or_interrupted';
  }
  if (classification.category === 'drop_completed_placement_unverified'
    || classification.category === 'drop_executed_placement_unverified') {
    return 'drop_completed_placement_unverified';
  }
  if (!comparison) {
    return classification.category === 'drop_executed_placement_verified'
      ? 'drop_completed_engine_verified'
      : 'drop_verification_unavailable';
  }
  if (comparison.independentSnapshotConfirmed) {
    return 'drop_independently_confirmed';
  }
  if (comparison.engineVerified && comparison.freshnessVerified) {
    return 'drop_verification_inconsistent';
  }
  if (comparison.engineVerified) {
    return 'drop_completed_engine_verified';
  }
  return 'drop_verification_unavailable';
}

/**
 * Derived relay brief (does not alter engine tactical-result.json).
 */
function buildDropOutcomeBrief(result, command = null, context = {}) {
  if (!result || result.command_type !== 'DROP' || !TERMINAL_DROP_STATUSES.has(result.status)) {
    return null;
  }

  const classification = classifyDropResult(result);
  const gp = result.ground_placement ?? null;
  let comparison = null;

  if (context.tactical && context.snapshotSha256Lower) {
    comparison = compareDropGroundPlacementToSnapshot(result, context.tactical, {
      snapshotSha256Lower: context.snapshotSha256Lower,
      preCommandSnapshotSha256: context.preCommandSnapshotSha256,
      deliveredCommandSnapshotSha256: context.deliveredCommandSnapshotSha256,
    });
  }

  const verificationClass = resolveDropVerificationClass(result, comparison, classification);
  const evidenceSource = verificationClass === 'drop_independently_confirmed'
    ? 'tactical_snapshot'
    : (gp ? 'engine_result' : 'engine_result_only');

  let message = `DROP ${result.status}`;
  if (verificationClass === 'drop_independently_confirmed') {
    message = 'DROP completed; ground placement independently confirmed by tactical snapshot.';
  } else if (verificationClass === 'drop_completed_engine_verified') {
    message = 'DROP completed; engine verified ground placement (await F6 for independent confirmation).';
  } else if (verificationClass === 'drop_completed_placement_unverified') {
    message = 'DROP completed without verified ground placement evidence.';
  } else if (verificationClass === 'drop_verification_inconsistent') {
    message = 'DROP completed but tactical snapshot disagrees with engine placement evidence.';
  } else if (verificationClass === 'drop_rejected') {
    message = `DROP rejected (${result.public_reason || result.reject_code || 'unknown'}).`;
  }

  return {
    schema_version: 1,
    command_id: result.command_id,
    command_type: 'DROP',
    item_battle_item_id: result.item_battle_item_id,
    session_id: result.session_id,
    turn: result.turn,
    state_version: result.state_version,
    command_item_battle_item_id: command?.item_battle_item_id ?? result.item_battle_item_id,
    verification_class: verificationClass,
    evidence_source: evidenceSource,
    ground_tile: gp?.tile ?? null,
    inventory_cell: gp
      ? { x: gp.inventory_x, y: gp.inventory_y }
      : null,
    engine_ground_placement: gp,
    snapshot_observation: comparison?.snapshotMatch ?? null,
    snapshot_sha256_observed: context.snapshotSha256Lower ?? null,
    result_snapshot_sha256: result.snapshot_sha256 ?? null,
    limitation: comparison?.limitation ?? null,
    freshness_verified: comparison?.freshnessVerified ?? false,
    message,
  };
}

function dropVerificationGuidanceMarkdown() {
  return [
    'DROP COMPLETED confirms inventory mutation in-engine, not independent battlefield proof.',
    'Use `lastDropOutcomeBrief.verification_class` on m0/state.json after post-command or F6 publish.',
    'Pre-command binding uses command `snapshot_sha256` + `state_version`; post-command tactical uses a newer digest and/or higher `eventLog.latestSeq`.',
    'Never require post-command tactical digest to equal the pre-command command-binding hash.',
    'Claim `drop_independently_confirmed` only when ground_inventory row matches engine `ground_placement` on a fresh post-command snapshot.',
  ].join(' ');
}

const fs = require('node:fs');
const path = require('node:path');

/**
 * Attach derived DROP brief when F6 publishes and a terminal DROP result sits beside snapshot.
 */
function tryAttachDropOutcomeBriefToRelayOptions(relayOptions, input) {
  const {
    snapshotPath,
    tactical,
    digest,
    existsSync = fs.existsSync,
    readFileSync = fs.readFileSync,
    preCommandSnapshotSha256 = null,
  } = input;
  if (!snapshotPath || !tactical || !digest) {
    return null;
  }
  const resultPath = path.join(path.dirname(snapshotPath), 'tactical-result.json');
  if (!existsSync(resultPath)) {
    return null;
  }
  let result;
  try {
    result = JSON.parse(readFileSync(resultPath, 'utf8'));
  } catch {
    return null;
  }
  if (!result || result.command_type !== 'DROP') {
    return null;
  }
  if (typeof result.session_id === 'string' && tactical.eventLog?.sessionId
    && result.session_id !== tactical.eventLog.sessionId) {
    return null;
  }
  const brief = buildDropOutcomeBrief(result, null, {
    tactical,
    snapshotSha256Lower: digest,
    preCommandSnapshotSha256,
    deliveredCommandSnapshotSha256: preCommandSnapshotSha256,
  });
  if (brief) {
    relayOptions.lastDropOutcomeBrief = brief;
  }
  return brief;
}

module.exports = {
  classifyDropResult,
  assessDropSnapshotFreshness,
  compareDropGroundPlacementToSnapshot,
  buildDropOutcomeBrief,
  tryAttachDropOutcomeBriefToRelayOptions,
  dropVerificationGuidanceMarkdown,
};
