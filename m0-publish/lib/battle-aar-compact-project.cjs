'use strict';

/** GitHub-visible debrief-equivalent payload (not tactical archive). */
const COMPACT_SCHEMA_VERSION = 1;
const COMPACT_TYPE = 'battle_aar_compact';

const LOCAL_ONLY_TOP_LEVEL = [
  'tactical_terminal',
  'tactical_timeline',
  'mission_summary',
  'attribution_policy',
];

const LOCAL_ONLY_DEBRIEF_KEYS = ['soldiers', 'injury_list', 'promotions_ui_scheduled'];

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function mapLostInService(postDebrief) {
  const explicit = asArray(postDebrief?.lost_in_service);
  if (explicit.length > 0) {
    return explicit.map((row) => ({
      display_name: row.display_name,
      rank: row.rank,
      career_kills: row.career_kills,
      kia: row.kia === true,
      mia: row.mia === true,
    }));
  }
  return asArray(postDebrief?.soldiers)
    .filter((s) => s && (s.kia === true || s.mia === true))
    .map((s) => ({
      display_name: s.display_name,
      rank: s.rank,
      career_kills: typeof s.career_kills === 'number' ? s.career_kills : null,
      kia: s.kia === true,
      mia: s.mia === true,
    }));
}

function mapWounded(postDebrief) {
  const explicit = asArray(postDebrief?.wounded);
  if (explicit.length > 0) {
    return explicit.map((row) => ({
      display_name: row.display_name,
      rank: row.rank,
      recovery_days: row.recovery_days,
    }));
  }
  return asArray(postDebrief?.soldiers)
    .filter((s) => s && !s.kia && !s.mia && typeof s.wound_recovery_days === 'number' && s.wound_recovery_days > 0)
    .map((s) => ({
      display_name: s.display_name,
      rank: s.rank,
      recovery_days: s.wound_recovery_days,
    }));
}

function mapPromotions(postDebrief) {
  return asArray(postDebrief?.promotions_applied).map((p) => ({
    display_name: p.display_name,
    rank_before: p.rank_before,
    rank_after: p.rank_after,
  }));
}

function mapCommendations(postDebrief) {
  return asArray(postDebrief?.commendations_awarded_this_debrief).map((c) => ({
    display_name: c.display_name,
    commendation_type: c.commendation_type,
    noun: c.noun,
    decoration_level: c.decoration_level,
  }));
}

function slimIdentity(identity) {
  if (!identity || typeof identity !== 'object') {
    return {};
  }
  return {
    campaign_id: identity.campaign_id,
    tactical_battle_id: identity.tactical_battle_id,
    tactical_session_id: identity.tactical_session_id,
    mission_statistics_id: identity.mission_statistics_id,
    mission_type: identity.mission_type,
    region: identity.region,
    country: identity.country,
    game_time: identity.game_time,
    mission_start_time: identity.mission_start_time ?? null,
  };
}

function assertNoLeakedTacticalFields(obj, path = '') {
  if (!obj || typeof obj !== 'object') {
    return;
  }
  for (const key of Object.keys(obj)) {
    const nextPath = path ? `${path}.${key}` : key;
    if (
      key === 'tactical_terminal'
      || key === 'tactical_timeline'
      || key === 'terminal_payload'
      || key === 'perceptionLog'
      || key === 'perception_log'
      || key === 'engine_kills'
      || key === 'eventLog'
    ) {
      throw new Error(`compact projection must not include tactical field: ${nextPath}`);
    }
    const value = obj[key];
    if (value && typeof value === 'object') {
      assertNoLeakedTacticalFields(value, nextPath);
    }
  }
}

/**
 * @param {object} fullDoc — local finalized battle_aar from engine (may include tactical_terminal).
 */
function projectBattleAarForRelay(fullDoc) {
  const postDebrief = fullDoc.post_debrief || {};
  const compact = {
    schema_version: COMPACT_SCHEMA_VERSION,
    type: COMPACT_TYPE,
    status: fullDoc.status,
    report_id: fullDoc.report_id,
    generation_id: fullDoc.generation_id,
    finalized_at_ms: fullDoc.finalized_at_ms,
    identity: slimIdentity(fullDoc.identity),
    outcome: {
      ...fullDoc.outcome,
      score_breakdown: asArray(fullDoc.outcome?.score_breakdown).filter(
        (row) => row && typeof row.quantity === 'number' && row.quantity !== 0,
      ),
    },
    debrief: {
      lost_in_service: mapLostInService(postDebrief),
      promotions: mapPromotions(postDebrief),
      wounded: mapWounded(postDebrief),
      commendations: mapCommendations(postDebrief),
      stat_increases: asArray(postDebrief.soldier_stat_increases),
    },
    data_quality: {
      projection: 'debrief_screens_v1',
      omitted_local_only: [...LOCAL_ONLY_TOP_LEVEL, ...LOCAL_ONLY_DEBRIEF_KEYS.map((k) => `post_debrief.${k}`)],
      missing_fields: asArray(fullDoc.data_quality?.missing_fields),
    },
  };
  assertNoLeakedTacticalFields(compact);
  return compact;
}

function validateCompactBattleAar(doc) {
  const errors = [];
  if (!doc || typeof doc !== 'object') {
    errors.push('document must be object');
  } else {
    if (doc.schema_version !== COMPACT_SCHEMA_VERSION) {
      errors.push(`schema_version must be ${COMPACT_SCHEMA_VERSION}`);
    }
    if (doc.type !== COMPACT_TYPE) {
      errors.push(`type must be ${COMPACT_TYPE}`);
    }
    if (doc.status !== 'finalized') {
      errors.push('status must be finalized');
    }
    if (!doc.outcome || typeof doc.outcome.score !== 'number') {
      errors.push('outcome.score required');
    }
    if (!doc.outcome?.rating) {
      errors.push('outcome.rating required');
    }
    if (!Array.isArray(doc.outcome?.score_breakdown)) {
      errors.push('outcome.score_breakdown array required');
    }
    const debrief = doc.debrief;
    if (!debrief || typeof debrief !== 'object') {
      errors.push('debrief object required');
    } else {
      for (const key of ['lost_in_service', 'promotions', 'wounded', 'commendations', 'stat_increases']) {
        if (!Array.isArray(debrief[key])) {
          errors.push(`debrief.${key} must be array`);
        }
      }
      for (const lost of asArray(debrief.lost_in_service)) {
        if (lost && (lost.kia || lost.mia) && typeof lost.career_kills !== 'number') {
          errors.push('debrief.lost_in_service[].career_kills required for KIA/MIA');
        }
      }
    }
  }
  if (errors.length > 0) {
    const err = new Error(errors.join('; '));
    err.code = 'compact_invalid';
    throw err;
  }
  try {
    assertNoLeakedTacticalFields(doc);
  } catch (leakErr) {
    const err = new Error(leakErr.message);
    err.code = 'compact_tactical_leak';
    throw err;
  }
  return { ok: true };
}

module.exports = {
  COMPACT_SCHEMA_VERSION,
  COMPACT_TYPE,
  projectBattleAarForRelay,
  validateCompactBattleAar,
  assertNoLeakedTacticalFields,
};