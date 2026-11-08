'use strict';

/**
 * M1 P4 Step 3 — Experimental full-map ASCII on relay (opt-in, not default).
 */

const {
  ENCODING,
  SCHEMA_VERSION,
  buildFullAsciiBattlefieldMap,
  measureFullAsciiBattlefieldMapBytes,
} = require('./terrain-full-ascii-battlefield.cjs');

/** Local copy avoids circular import with relay-payload-adaptive-shrink.cjs */
function publishedByteLength(relay) {
  return Buffer.byteLength(`${JSON.stringify(relay, null, 2)}\n`, 'utf8');
}

const RELAY_WIRE_FORMAT = 'joined_rows_v1';
const LEGEND_ID = 'full-ascii-battlefield-v1';

function resolveFullAsciiRelayEnabled(options = {}) {
  if (options.includeTerrainFullAsciiBattlefield === true) {
    return true;
  }
  if (options.includeTerrainFullAsciiBattlefield === false) {
    return false;
  }
  return process.env.OPENXCOM_COMPANION_RELAY_TERRAIN_FULL_ASCII === '1';
}

function joinChannelRows(rows) {
  return rows.join('\n');
}

/**
 * Relay-sized attachment: joined row strings + legend by reference (smaller under pretty JSON).
 */
function buildFullAsciiBattlefieldRelayAttachment(tactical) {
  const full = buildFullAsciiBattlefieldMap(tactical);
  return {
    schemaVersion: SCHEMA_VERSION,
    encoding: ENCODING,
    wireFormat: RELAY_WIRE_FORMAT,
    role: full.role,
    authoritativeNote: full.authoritativeNote,
    map: full.map,
    memoryNote: full.memoryNote,
    legendId: LEGEND_ID,
    presentationOmissions: full.presentationOmissions,
    levels: full.levels.map((level) => ({
      z: level.z,
      channels: {
        visibility: joinChannelRows(level.channels.visibility),
        floor: joinChannelRows(level.channels.floor),
        edgeNorth: joinChannelRows(level.channels.edgeNorth),
        edgeWest: joinChannelRows(level.channels.edgeWest),
      },
    })),
    hints: full.hints,
  };
}

function canBuildFullAsciiFromRelay(relay) {
  const tactical = relay?.tactical;
  if (!tactical || tactical.schemaVersion < 5 || !tactical.terrain) {
    return { ok: false, reason: 'no_v5_terrain' };
  }
  return { ok: true };
}

/**
 * Explain standalone compact vs pretty relay incremental size.
 */
function measureRelayAsciiSizeAccounting(relayBefore, relayAfter, compactStandaloneBytes) {
  const beforeBytes = publishedByteLength(relayBefore);
  const afterBytes = publishedByteLength(relayAfter);
  return {
    compactStandaloneAsciiBytes: compactStandaloneBytes,
    relayPrettyBeforeBytes: beforeBytes,
    relayPrettyAfterBytes: afterBytes,
    relayIncrementalBytes: afterBytes - beforeBytes,
    overheadVersusCompactStandalone: (afterBytes - beforeBytes) - compactStandaloneBytes,
    note:
      'Relay JSON uses JSON.stringify(relay, null, 2). Incremental cost exceeds compact standalone '
      + 'because each grid row is pretty-printed as a separate string line with indentation; '
      + 'joined_rows_v1 and legendId reduce but do not remove pretty-print expansion.',
  };
}

/**
 * After adaptive shrink: optionally attach full ASCII; omit if over target or max cap.
 */
function tacticalForAsciiBuild(relay, terrainSourceForAscii) {
  if (!relay?.tactical?.map) {
    return null;
  }
  const terrain = terrainSourceForAscii ?? relay.tactical.terrain;
  if (!terrain || relay.tactical.schemaVersion < 5) {
    return null;
  }
  return {
    ...relay.tactical,
    terrain,
  };
}

function applyExperimentalTerrainFullAsciiRelay(relay, options = {}) {
  if (!resolveFullAsciiRelayEnabled(options)) {
    delete relay.terrainFullAsciiBattlefield;
    delete relay.terrainFullAsciiBattlefieldMeta;
    delete relay.terrainFullAsciiBattlefieldOmitted;
    return { relay, applied: false, reason: 'flag_disabled' };
  }

  delete relay.terrainFullAsciiBattlefield;
  delete relay.terrainFullAsciiBattlefieldOmitted;

  const tacticalForAscii = tacticalForAsciiBuild(relay, options.terrainSourceForAscii);
  const eligibility = tacticalForAscii ? { ok: true } : canBuildFullAsciiFromRelay(relay);
  if (!eligibility.ok) {
    relay.terrainFullAsciiBattlefieldOmitted = {
      schema_version: 1,
      reason: eligibility.reason,
      note: 'Full ASCII is derived from v5 terrain only; not generated for v4 or terrain-less snapshots.',
    };
    return { relay, applied: false, reason: eligibility.reason };
  }

  const attachment = buildFullAsciiBattlefieldRelayAttachment(tacticalForAscii);
  const compactStandalone = measureFullAsciiBattlefieldMapBytes(
    buildFullAsciiBattlefieldMap(tacticalForAscii),
  );

  const maxBytes = options.maxBytes ?? undefined;
  const targetBytes = options.targetBytes ?? undefined;

  const relayBytesBeforeAttach = publishedByteLength(relay);
  const probe = JSON.parse(JSON.stringify(relay));
  probe.terrainFullAsciiBattlefield = attachment;
  const withAsciiBytes = publishedByteLength(probe);

  if (maxBytes !== undefined && withAsciiBytes > maxBytes) {
    relay.terrainFullAsciiBattlefieldOmitted = {
      schema_version: 1,
      reason: 'exceeds_relay_max_bytes',
      maxBytes,
      projectedBytes: withAsciiBytes,
      compactStandaloneAsciiBytes: compactStandalone,
      sizeAccounting: measureRelayAsciiSizeAccounting(relay, probe, compactStandalone),
    };
    return { relay, applied: false, reason: 'exceeds_relay_max_bytes', projectedBytes: withAsciiBytes };
  }

  if (targetBytes !== undefined && withAsciiBytes > targetBytes) {
    relay.terrainFullAsciiBattlefieldOmitted = {
      schema_version: 1,
      reason: 'exceeds_relay_target_bytes',
      targetBytes,
      projectedBytes: withAsciiBytes,
      compactStandaloneAsciiBytes: compactStandalone,
      sizeAccounting: measureRelayAsciiSizeAccounting(relay, probe, compactStandalone),
    };
    return { relay, applied: false, reason: 'exceeds_relay_target_bytes', projectedBytes: withAsciiBytes };
  }

  relay.terrainFullAsciiBattlefield = attachment;
  relay.terrainFullAsciiBattlefieldMeta = {
    schema_version: 1,
    included: true,
    wireFormat: RELAY_WIRE_FORMAT,
    legendId: LEGEND_ID,
    compactStandaloneAsciiBytes: compactStandalone,
    relayIncrementalBytes: withAsciiBytes - relayBytesBeforeAttach,
    relayPrettyOverheadVersusCompactAscii: (withAsciiBytes - relayBytesBeforeAttach) - compactStandalone,
    projectedRelayBytes: withAsciiBytes,
  };
  return {
    relay,
    applied: true,
    projectedBytes: withAsciiBytes,
    sizeAccounting: measureRelayAsciiSizeAccounting(relay, probe, compactStandalone),
  };
}

module.exports = {
  LEGEND_ID,
  RELAY_WIRE_FORMAT,
  resolveFullAsciiRelayEnabled,
  buildFullAsciiBattlefieldRelayAttachment,
  applyExperimentalTerrainFullAsciiRelay,
  measureRelayAsciiSizeAccounting,
  canBuildFullAsciiFromRelay,
};
