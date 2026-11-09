'use strict';

const { MAX_INPUT_BYTES } = require('./tactical-publish.cjs');
const { compactTerrainBriefForRelay } = require('./terrain-map-brief.cjs');
const { applyExperimentalTerrainFullAsciiRelay } = require('./terrain-full-ascii-relay.cjs');

const RELAY_PUBLISH_MAX_BYTES = MAX_INPUT_BYTES;
/** Shrink proactively when published JSON would exceed this (32 KiB headroom under cap). */
const RELAY_PUBLISH_TARGET_BYTES = RELAY_PUBLISH_MAX_BYTES - 32 * 1024;

const RELAY_SHRINK_EXHAUSTED = 'RELAY_SHRINK_EXHAUSTED';

const RELAY_EXPORT_SHRINK_SCHEMA_VERSION = 1;

function cloneRelayPayload(relay) {
  return JSON.parse(JSON.stringify(relay));
}

function serializeRelayPayloadPretty(relay) {
  return `${JSON.stringify(relay, null, 2)}\n`;
}

function publishedByteLength(relay) {
  return Buffer.byteLength(serializeRelayPayloadPretty(relay), 'utf8');
}

function syncBoundedLogSeqBounds(log) {
  if (!log?.events) {
    return;
  }
  if (log.events.length === 0) {
    log.oldestSeq = 0;
    log.latestSeq = 0;
    return;
  }
  log.oldestSeq = log.events[0].seq;
  log.latestSeq = log.events[log.events.length - 1].seq;
}

function trimLogEventsBeforeTurn(log, currentTurn) {
  if (!log?.events?.length) {
    return null;
  }
  const kept = log.events.filter((event) => event.turn === currentTurn);
  const removed = log.events.length - kept.length;
  if (removed === 0) {
    return null;
  }
  log.events = kept;
  log.droppedCount = (log.droppedCount ?? 0) + removed;
  syncBoundedLogSeqBounds(log);
  return { removed, kept: kept.length, turn: currentTurn };
}

function trimLogEventsToRecentTail(log, maxKeep) {
  if (!log?.events?.length || log.events.length <= maxKeep) {
    return null;
  }
  const removed = log.events.length - maxKeep;
  log.events = log.events.slice(-maxKeep);
  log.droppedCount = (log.droppedCount ?? 0) + removed;
  syncBoundedLogSeqBounds(log);
  return { removed, kept: log.events.length };
}

function omitPackedTerrainWhenBriefPresent(relay) {
  const tactical = relay.tactical;
  const hasBrief = relay.terrainBrief || relay.terrainMapBrief || relay.tacticalMapWindowV2;
  if (!tactical?.terrain || !hasBrief) {
    return null;
  }
  const encoding = tactical.terrain.encoding ?? null;
  const recordCount = tactical.terrain.recordCount ?? null;
  delete tactical.terrain;
  tactical.terrainOmittedForRelay = {
    schema_version: 1,
    reason: relay.terrainMapBrief ? 'terrain_map_brief_authoritative' : 'terrain_brief_authoritative',
    encoding,
    recordCount,
    note: 'Packed terrain blob omitted from relay JSON; use tacticalMapWindowV2, terrainMapBrief, terrainBrief, or terrain-query. snapshot_id still hashes the full engine export.',
  };
  return { encoding, recordCount };
}

function compactTerrainBriefForRelaySize(relay) {
  if (!relay.terrainBrief || relay.terrainBrief?.compactedForRelay) {
    return null;
  }
  const compact = compactTerrainBriefForRelay(relay.terrainBrief);
  if (!compact) {
    return null;
  }
  const before = Buffer.byteLength(JSON.stringify(relay.terrainBrief), 'utf8');
  relay.terrainBrief = compact;
  const after = Buffer.byteLength(JSON.stringify(relay.terrainBrief), 'utf8');
  return { before, after, removed: before - after };
}

function omitTerrainMapBriefLastResort(relay) {
  if (!relay.terrainMapBrief) {
    return null;
  }
  const bytes = Buffer.byteLength(JSON.stringify(relay.terrainMapBrief), 'utf8');
  relay.terrainMapBriefOmitted = {
    schema_version: 1,
    reason: 'relay_shrink_last_resort',
    bytesRemoved: bytes,
    note: 'terrainMapBrief dropped to satisfy relay byte cap; commandBinding and snapshot_id unchanged.',
  };
  delete relay.terrainMapBrief;
  return { bytesRemoved: bytes };
}

function measureRelayPayloadContributions(relay) {
  const pretty = (value) => (value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value, null, 2), 'utf8'));
  const tactical = relay.tactical ?? {};
  const nested = {
    terrain: pretty(tactical.terrain),
    units: pretty(tactical.units),
    eventLog: pretty(tactical.eventLog),
    perceptionLog: pretty(tactical.perceptionLog),
    map: pretty(tactical.map),
    groundItems: pretty(tactical.groundItems),
    missionContext: pretty(tactical.missionContext),
  };
  return {
    publishedBytes: publishedByteLength(relay),
    topLevel: {
      tactical: pretty(relay.tactical),
      terrainBrief: pretty(relay.terrainBrief),
      terrainMapBrief: pretty(relay.terrainMapBrief),
      tacticalMapWindowV2: pretty(relay.tacticalMapWindowV2),
      unitStateBrief: pretty(relay.unitStateBrief),
      commandBinding: pretty(relay.commandBinding),
      envelope: pretty({
        schema_version: relay.schema_version,
        type: relay.type,
        snapshot_id: relay.snapshot_id,
        published_at: relay.published_at,
        source: relay.source,
        request_id: relay.request_id,
        session_id: relay.session_id,
        turn: relay.turn,
        relay_export_shrink: relay.relay_export_shrink,
      }),
    },
    tacticalNested: nested,
    eventCounts: {
      eventLog: tactical.eventLog?.events?.length ?? 0,
      perceptionLog: tactical.perceptionLog?.events?.length ?? 0,
    },
  };
}

/**
 * Adaptive relay JSON reduction before GitHub publish.
 * snapshot_id and commandBinding are computed from the full export earlier; this only trims relay copies.
 */
function prepareRelayPayloadForPublish(relay, options = {}) {
  const maxBytes = options.maxBytes ?? RELAY_PUBLISH_MAX_BYTES;
  const targetBytes = options.targetBytes
    ?? Math.min(maxBytes, options.targetHeadroomBytes
      ? maxBytes - options.targetHeadroomBytes
      : RELAY_PUBLISH_TARGET_BYTES);

  const working = cloneRelayPayload(relay);
  const terrainSourceForAscii = (
    options.includeTerrainFullAsciiBattlefield
    && working.tactical?.schemaVersion >= 5
    && working.tactical?.terrain
  ) ? JSON.parse(JSON.stringify(working.tactical.terrain)) : null;
  const initialBytes = publishedByteLength(working);
  const turn = working.turn ?? working.tactical?.turn ?? working.source?.turn;
  const steps = [];

  const tiers = [
    {
      name: 'perception_log_prior_turns',
      apply: () => {
        const log = working.tactical?.perceptionLog;
        if (!log || turn === undefined) return null;
        return trimLogEventsBeforeTurn(log, turn);
      },
    },
    {
      name: 'event_log_tail_cap_48',
      apply: () => trimLogEventsToRecentTail(working.tactical?.eventLog, 48),
    },
    {
      name: 'terrain_brief_compact_for_relay',
      apply: () => compactTerrainBriefForRelaySize(working),
    },
    {
      name: 'terrain_blob_omit_for_terrain_brief',
      apply: () => omitPackedTerrainWhenBriefPresent(working),
    },
    {
      name: 'event_log_tail_cap_16',
      apply: () => trimLogEventsToRecentTail(working.tactical?.eventLog, 16),
    },
    {
      name: 'perception_log_tail_cap_96',
      apply: () => trimLogEventsToRecentTail(working.tactical?.perceptionLog, 96),
    },
    {
      name: 'perception_log_tail_cap_48',
      apply: () => trimLogEventsToRecentTail(working.tactical?.perceptionLog, 48),
    },
    {
      name: 'event_log_clear_events_keep_session',
      apply: () => {
        const log = working.tactical?.eventLog;
        if (!log?.events?.length) return null;
        const removed = log.events.length;
        log.events = [];
        log.droppedCount = (log.droppedCount ?? 0) + removed;
        syncBoundedLogSeqBounds(log);
        return { removed, kept: 0, note: 'commandBinding.state_version remains authoritative' };
      },
    },
    {
      name: 'terrain_map_brief_omit_last_resort',
      apply: () => omitTerrainMapBriefLastResort(working),
    },
  ];

  if (initialBytes > targetBytes) {
    for (const tier of tiers) {
      let bytes = publishedByteLength(working);
      if (bytes <= targetBytes) {
        break;
      }
      const detail = tier.apply();
      if (!detail) {
        continue;
      }
      bytes = publishedByteLength(working);
      steps.push({ step: tier.name, bytesAfter: bytes, ...detail });
    }
  }

  const asciiResult = applyExperimentalTerrainFullAsciiRelay(working, {
    includeTerrainFullAsciiBattlefield: options.includeTerrainFullAsciiBattlefield,
    terrainSourceForAscii,
    maxBytes,
    targetBytes,
  });
  if (asciiResult.applied) {
    steps.push({
      step: 'terrain_full_ascii_experimental_attach',
      bytesAfter: asciiResult.projectedBytes,
      relayIncrementalBytes: asciiResult.sizeAccounting?.relayIncrementalBytes,
      overheadVersusCompactStandalone: asciiResult.sizeAccounting?.overheadVersusCompactStandalone,
    });
  } else if (asciiResult.reason && asciiResult.reason !== 'flag_disabled') {
    steps.push({
      step: 'terrain_full_ascii_experimental_omitted',
      reason: asciiResult.reason,
      projectedBytes: asciiResult.projectedBytes,
    });
  }

  let finalBytes = publishedByteLength(working);
  if (finalBytes > maxBytes) {
    const error = new Error(
      `Relay payload still exceeds ${maxBytes} byte cap after adaptive shrink (${finalBytes} bytes).`,
    );
    error.code = RELAY_SHRINK_EXHAUSTED;
    error.initialBytes = initialBytes;
    error.finalBytes = finalBytes;
    error.steps = steps;
    throw error;
  }

  if (steps.length > 0 || asciiResult.applied || asciiResult.reason === 'exceeds_relay_target_bytes' || asciiResult.reason === 'exceeds_relay_max_bytes') {
    working.relay_export_shrink = {
      schema_version: RELAY_EXPORT_SHRINK_SCHEMA_VERSION,
      initialBytes,
      finalBytes,
      targetBytes,
      maxBytes,
      steps,
      note: 'Relay tactical may be trimmed versus engine YAML; commandBinding and snapshot_id reflect the verified full export.',
    };
  }

  return {
    relay: working,
    serialized: serializeRelayPayloadPretty(working),
    bytes: finalBytes,
    initialBytes,
    targetBytes,
    maxBytes,
    steps,
    shrunk: steps.length > 0,
  };
}

module.exports = {
  RELAY_PUBLISH_MAX_BYTES,
  RELAY_PUBLISH_TARGET_BYTES,
  RELAY_SHRINK_EXHAUSTED,
  cloneRelayPayload,
  serializeRelayPayloadPretty,
  publishedByteLength,
  measureRelayPayloadContributions,
  trimLogEventsBeforeTurn,
  trimLogEventsToRecentTail,
  prepareRelayPayloadForPublish,
  compactTerrainBriefForRelaySize,
  omitTerrainMapBriefLastResort,
};
