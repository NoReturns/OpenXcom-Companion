'use strict';

const RESPONSE_SCHEMA_VERSION = 2;
const PROFILE_VERBOSE = 'verbose';
const PROFILE_COMPACT = 'compact';

const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024;
const LEGACY_MAX_RESPONSE_BYTES = 8 * 1024;
const HARD_MAX_RESPONSE_BYTES = 64 * 1024;

const SIZE_ERROR_CODE = 'RESPONSE_BUDGET_EXHAUSTED';

const WARNINGS = Object.freeze([
  'Query uses authorized snapshot terrain only.',
  'UNKNOWN cells were not discovered in the snapshot.',
  'Off-LOS discovered cells reflect export-time engine state, not historical memory.',
  'Walk costs and blockSight do not guarantee movement or clear shots.',
]);

function responseByteLength(obj) {
  return Buffer.byteLength(JSON.stringify(obj), 'utf8');
}

function manhattan3FromCenter(p, center) {
  return Math.abs(p[0] - center.x) + Math.abs(p[1] - center.y) + Math.abs(p[2] - center.z);
}

function sortCellsForTruncation(discovered, unknown, center) {
  const disc = [...discovered].sort((a, b) => {
    const da = manhattan3FromCenter(a.p, center);
    const db = manhattan3FromCenter(b.p, center);
    return da - db || a.p[2] - b.p[2] || a.p[1] - b.p[1] || a.p[0] - b.p[0];
  });
  const unk = [...unknown].sort((a, b) => {
    const da = manhattan3FromCenter(a.p, center);
    const db = manhattan3FromCenter(b.p, center);
    return da - db || a.p[2] - b.p[2] || a.p[1] - b.p[1] || a.p[0] - b.p[0];
  });
  return { discovered: disc, unknown: unk };
}

function compactDiscoveredCell(cell) {
  const out = {
    p: cell.p,
    visibility: cell.visibility,
    disc: cell.disc,
  };
  if (cell.body) {
    const b = {};
    if (cell.body.air) b.air = true;
    if (cell.body.noFloor) b.nf = true;
    if (cell.body.elev !== undefined) b.e = cell.body.elev;
    if (cell.body.walkF !== undefined) b.wf = cell.body.walkF;
    if (cell.body.walkO !== undefined) b.wo = cell.body.walkO;
    if (cell.body.blockSightF) b.bsf = true;
    if (cell.body.blockSightO) b.bso = true;
    if (Object.keys(b).length) out.b = b;
  }
  if (cell.west) out.w = cell.west.walk;
  if (cell.north) out.n = cell.north.walk;
  const cat = cell.terrainSemantics?.[0]?.category ?? cell.structureFacets?.[0]?.structureKind;
  if (cat) out.cat = cat;
  return out;
}

function compactUnknownCell(cell) {
  return { p: cell.p, visibility: cell.visibility };
}

function stripCellDetail(cell) {
  const out = {
    p: cell.p,
    visibility: cell.visibility,
    disc: cell.disc,
  };
  if (cell.body) {
    out.body = {
      ...(cell.body.air ? { air: true } : {}),
      ...(cell.body.noFloor ? { noFloor: true } : {}),
      ...(cell.body.elev !== undefined ? { elev: cell.body.elev } : {}),
      ...(cell.body.walkF !== undefined ? { walkF: cell.body.walkF } : {}),
      ...(cell.body.walkO !== undefined ? { walkO: cell.body.walkO } : {}),
      ...(cell.body.blockSightF ? { blockSightF: true } : {}),
      ...(cell.body.blockSightO ? { blockSightO: true } : {}),
    };
  }
  if (cell.west) out.west = { walk: cell.west.walk, ...(cell.west.blockSight ? { blockSight: true } : {}) };
  if (cell.north) out.north = { walk: cell.north.walk, ...(cell.north.blockSight ? { blockSight: true } : {}) };
  return out;
}

function buildResponseEnvelope(base, extra = {}) {
  return {
    schemaVersion: RESPONSE_SCHEMA_VERSION,
    ...base,
    ...extra,
    warnings: [...WARNINGS],
  };
}

function buildMinSkeleton(base) {
  return buildResponseEnvelope(base, {
    discovered: [],
    unknown: [],
    truncated: true,
    omittedDueToBudget: {},
    budget: {
      maxBytes: base.budget?.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      usedBytes: 0,
      profile: base.profile ?? PROFILE_VERBOSE,
      steps: [],
    },
  });
}

/**
 * Deterministic progressive fitting. Never emits partial JSON — builds object then validates size.
 */
function fitTerrainQueryResponse(params) {
  const {
    snapshotId,
    query,
    visibilityLabels,
    discoveredFull,
    unknownFull,
    maxBytes,
    profileRequested,
    center,
  } = params;

  const maxBudget = Math.min(Math.max(512, maxBytes), HARD_MAX_RESPONSE_BYTES);
  const { discovered: discSorted, unknown: unkSorted } = sortCellsForTruncation(
    discoveredFull,
    unknownFull,
    query.center,
  );

  const baseFields = {
    snapshot_id: snapshotId,
    query,
    visibilityLabels,
    profile: profileRequested === PROFILE_COMPACT ? PROFILE_COMPACT : PROFILE_VERBOSE,
    budget: {
      maxBytes: maxBudget,
      usedBytes: 0,
      profile: profileRequested === PROFILE_COMPACT ? PROFILE_COMPACT : PROFILE_VERBOSE,
      steps: [],
    },
  };

  const totalDisc = discSorted.length;
  const totalUnk = unkSorted.length;

  const attempts = [];

  const encodeStrategies = [
    { step: 'verbose_full', mapDisc: (c) => c, mapUnk: (c) => c },
    { step: 'verbose_strip_notes', mapDisc: (c) => stripCellDetail(c), mapUnk: (c) => c },
    { step: 'compact_full', mapDisc: (c) => compactDiscoveredCell(c), mapUnk: (c) => compactUnknownCell(c) },
  ];

  for (const strategy of encodeStrategies) {
    if (profileRequested === PROFILE_COMPACT && strategy.step.startsWith('verbose')) {
      continue;
    }
    let lo = 0;
    let hi = totalDisc;
    let best = null;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      let unkKeep = totalUnk;
      if (mid < totalDisc) {
        unkKeep = Math.min(totalUnk, Math.max(0, Math.floor((mid / Math.max(totalDisc, 1)) * totalUnk)));
      }
      const envelope = buildResponseEnvelope({
        ...baseFields,
        profile: strategy.step.startsWith('compact') ? PROFILE_COMPACT : PROFILE_VERBOSE,
        discovered: discSorted.slice(0, mid).map(strategy.mapDisc),
        unknown: unkSorted.slice(0, unkKeep).map(strategy.mapUnk),
        truncated: mid < totalDisc || unkKeep < totalUnk,
        omittedDueToBudget: {
          discovered: totalDisc - mid,
          unknown: totalUnk - unkKeep,
        },
        budget: {
          ...baseFields.budget,
          profile: strategy.step.startsWith('compact') ? PROFILE_COMPACT : PROFILE_VERBOSE,
          steps: [strategy.step],
        },
      });
      const bytes = responseByteLength(envelope);
      envelope.budget.usedBytes = bytes;
      if (bytes <= maxBudget) {
        best = envelope;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (best) {
      best.budget.steps = [strategy.step];
      attempts.push(best);
    }
  }

  const strategyPriority = {
    verbose_full: 30,
    verbose_strip_notes: 20,
    compact_full: 10,
  };

  attempts.sort((a, b) => {
    const aCells = a.discovered.length + a.unknown.length;
    const bCells = b.discovered.length + b.unknown.length;
    const stepA = a.budget?.steps?.[0] ?? '';
    const stepB = b.budget?.steps?.[0] ?? '';
    const priA = strategyPriority[stepA] ?? 0;
    const priB = strategyPriority[stepB] ?? 0;
    if (profileRequested !== PROFILE_COMPACT && priA !== priB) {
      return priB - priA;
    }
    return bCells - aCells || a.budget.usedBytes - b.budget.usedBytes;
  });

  if (attempts.length > 0) {
    return attempts[0];
  }

  const skeleton = buildMinSkeleton({
    snapshot_id: snapshotId,
    query,
    visibilityLabels,
    profile: profileRequested,
    budget: {
      maxBytes: maxBudget,
      usedBytes: 0,
      profile: profileRequested,
      steps: ['budget_exhausted'],
    },
    sizeError: {
      code: SIZE_ERROR_CODE,
      maxBytes: maxBudget,
      minEnvelopeBytes: responseByteLength(buildMinSkeleton({
        snapshot_id: snapshotId,
        query,
        visibilityLabels,
        profile: profileRequested,
        budget: { maxBytes: maxBudget, usedBytes: 0, profile: profileRequested, steps: [] },
      })),
      candidateDiscovered: totalDisc,
      candidateUnknown: totalUnk,
      center,
      note: 'Reduce radius, z-span, or use compact profile; minimum metadata envelope could not include cells.',
    },
    omittedDueToBudget: {
      discovered: totalDisc,
      unknown: totalUnk,
    },
  });
  skeleton.budget.usedBytes = responseByteLength(skeleton);
  return skeleton;
}

function resolveMaxResponseBytes(request, options = {}) {
  const cap = options.maxResponseBytes ?? options.responseMaxBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (request.maxResponseBytes !== undefined) {
    return Math.min(Math.max(512, request.maxResponseBytes), HARD_MAX_RESPONSE_BYTES, cap);
  }
  return Math.min(cap, HARD_MAX_RESPONSE_BYTES);
}

function resolveQueryProfile(request) {
  const p = request.profile ?? request.responseProfile;
  if (p === PROFILE_COMPACT) return PROFILE_COMPACT;
  if (p === PROFILE_VERBOSE || p === undefined || p === null) return PROFILE_VERBOSE;
  return PROFILE_VERBOSE;
}

module.exports = {
  RESPONSE_SCHEMA_VERSION,
  PROFILE_VERBOSE,
  PROFILE_COMPACT,
  DEFAULT_MAX_RESPONSE_BYTES,
  LEGACY_MAX_RESPONSE_BYTES,
  HARD_MAX_RESPONSE_BYTES,
  SIZE_ERROR_CODE,
  WARNINGS,
  responseByteLength,
  sortCellsForTruncation,
  compactDiscoveredCell,
  compactUnknownCell,
  stripCellDetail,
  fitTerrainQueryResponse,
  resolveMaxResponseBytes,
  resolveQueryProfile,
};
