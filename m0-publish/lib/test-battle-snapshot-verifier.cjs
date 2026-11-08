'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const YAML = require('yaml');
const {
  MAX_INPUT_BYTES,
  ValidationError,
  loadAndValidateSnapshotFromText,
} = require('./tactical-publish.cjs');
const { buildTerrainBrief, decodeTerrainTiles } = require('./terrain-brief.cjs');
const { collectStructureFacets, DOOR_REDACTED } = require('./terrain-structure-wp8.cjs');

const FAIRNESS_NOTE =
  'Verifier checks export consistency and documented fairness invariants only; it does not prove absence of undiscovered-map leakage without independent ground truth.';

function sha256Utf8(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').toLowerCase();
}

function countBy(values, keyFn) {
  const out = {};
  for (const value of values) {
    const key = keyFn(value);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function analyzeStructures(tiles) {
  const facets = [];
  for (const tile of tiles) {
    facets.push(...collectStructureFacets(tile));
  }
  const byKind = countBy(facets, (f) => f.structureKind ?? 'unknown');
  const ufoDoors = facets.filter((f) => f.structureKind === 'ufo_door');
  const buildingDoors = facets.filter((f) => f.structureKind === 'building_door');
  const gravLifts = facets.filter((f) => f.structureKind === 'vertical_passage');
  const entrances = facets.filter((f) => f.structureKind === 'mission_entrance');
  const unknownStructures = facets.filter((f) => f.structureKind === 'unknown_structure');
  const doorStates = countBy(
    [...ufoDoors, ...buildingDoors].filter((f) => f.doorState),
    (f) => f.doorState,
  );
  const disclosedDoors = [...ufoDoors, ...buildingDoors].filter(
    (f) => f.doorState && f.doorState !== DOOR_REDACTED,
  );
  return {
    totalStructureFacets: facets.length,
    byStructureKind: byKind,
    ufoHullCount: byKind.ufo_hull ?? 0,
    ufoInteriorCount: byKind.ufo_interior_floor ?? 0,
    ufoDoorCount: ufoDoors.length,
    buildingDoorCount: buildingDoors.length,
    gravLiftCount: gravLifts.length,
    entranceCount: entrances.length,
    unknownStructureCount: unknownStructures.length,
    doorStateCounts: doorStates,
    disclosedDoorCount: disclosedDoors.length,
    redactedDoorCount: (doorStates[DOOR_REDACTED] ?? 0),
  };
}

function analyzePerception(tactical) {
  const log = tactical.perceptionLog;
  if (!log) {
    return {
      present: false,
      sessionId: null,
      eventCount: 0,
      droppedCount: 0,
      byType: {},
      projectileDirectionCount: 0,
      note: 'Optional block absent (no perception events exported).',
    };
  }
  const events = log.events ?? [];
  const byType = countBy(events, (e) => e.type ?? 'unknown');
  return {
    present: true,
    sessionId: log.sessionId ?? null,
    eventCount: events.length,
    droppedCount: log.droppedCount ?? 0,
    oldestSeq: log.oldestSeq,
    latestSeq: log.latestSeq,
    byType,
    projectileDirectionCount: byType.projectile_direction_observed ?? 0,
  };
}

function analyzeGroundItems(tactical) {
  const block = tactical.groundItems;
  if (!block) {
    return {
      present: false,
      observationCount: 0,
      droppedCount: 0,
      sessionId: null,
      note: 'Optional block absent (no ground-item observations exported).',
    };
  }
  return {
    present: true,
    sessionId: block.sessionId ?? null,
    observationCount: (block.observations ?? []).length,
    droppedCount: block.droppedCount ?? 0,
    memoryNote: block.memoryNote ?? null,
  };
}

function collectSessionIds(tactical) {
  const ids = [];
  if (tactical.eventLog?.sessionId) ids.push({ source: 'eventLog', sessionId: tactical.eventLog.sessionId });
  if (tactical.perceptionLog?.sessionId) {
    ids.push({ source: 'perceptionLog', sessionId: tactical.perceptionLog.sessionId });
  }
  if (tactical.groundItems?.sessionId) {
    ids.push({ source: 'groundItems', sessionId: tactical.groundItems.sessionId });
  }
  return ids;
}

function checkSessionIdentity(tactical, warnings, errors) {
  const ids = collectSessionIds(tactical);
  const unique = [...new Set(ids.map((i) => i.sessionId).filter(Boolean))];
  if (unique.length === 0) {
    warnings.push('No sessionId found on eventLog, perceptionLog, or groundItems.');
  } else if (unique.length > 1) {
    errors.push(`Session ID mismatch across blocks: ${unique.join(', ')}`);
  }
  return { sessionIds: ids, unifiedSessionId: unique.length === 1 ? unique[0] : null };
}

function checkFairnessInvariants(tactical, tiles, warnings, errors) {
  const mapVolume = tactical.map.width * tactical.map.height * tactical.map.depth;
  if (tiles.length > mapVolume) {
    errors.push('Discovered terrain record count exceeds map volume.');
  }
  for (const tile of tiles) {
    if (!tile.disc || tile.disc === 0) {
      errors.push(`Terrain record at ${tile.p?.join(',')} has invalid disc (undiscovered leak).`);
    }
  }
  if (tactical.schemaVersion >= 5 && !tactical.terrain) {
    warnings.push('schemaVersion 5 without terrain block (possible v4-style fallback export).');
  }
  if (tactical.schemaVersion === 4 && tactical.turn >= 1) {
    warnings.push('schemaVersion 4 export: terrain omitted (size cap fallback or legacy export).');
  }
}

function verifySnapshotText(text, options = {}) {
  const sizeBytes = Buffer.byteLength(text, 'utf8');
  const fileSha256 = sha256Utf8(text);
  const warnings = [];
  const errors = [];
  const validationErrors = [];

  const headroomBytes = MAX_INPUT_BYTES - sizeBytes;
  const overCap = sizeBytes > MAX_INPUT_BYTES;

  let tactical = null;
  let parseStage = 'ok';

  if (overCap && !options.allowOverCapParse) {
    parseStage = 'over_cap';
    errors.push(`Snapshot exceeds ${MAX_INPUT_BYTES} byte (256 KiB) cap (${sizeBytes} bytes).`);
  } else {
    try {
      tactical = loadAndValidateSnapshotFromText(text, YAML);
    } catch (error) {
      parseStage = 'invalid';
      if (error instanceof ValidationError) {
        validationErrors.push(error.message);
        errors.push(error.message);
      } else {
        errors.push(String(error.message || error));
      }
    }
  }

  let terrainBrief = null;
  let tiles = [];
  let structures = null;
  let perception = null;
  let groundItems = null;
  let sessionIdentity = null;

  if (tactical) {
    tiles = decodeTerrainTiles(tactical);
    structures = analyzeStructures(tiles);
    perception = analyzePerception(tactical);
    groundItems = analyzeGroundItems(tactical);
    sessionIdentity = checkSessionIdentity(tactical, warnings, errors);
    checkFairnessInvariants(tactical, tiles, warnings, errors);

    if (tactical.schemaVersion >= 5 && tactical.terrain) {
      try {
        terrainBrief = buildTerrainBrief(tactical);
      } catch (error) {
        warnings.push(`terrainBrief build failed: ${error.message}`);
      }
    }

    const mapVolume = tactical.map.width * tactical.map.height * tactical.map.depth;
    if (tiles.length === 0 && tactical.schemaVersion >= 5 && tactical.terrain) {
      warnings.push('Terrain block present but zero decoded discovered tiles.');
    }
    if (terrainBrief?.visibilityTotals?.undiscoveredMapCells < 0) {
      errors.push('visibilityTotals.undiscoveredMapCells is negative.');
    }
    if (tiles.length + (terrainBrief?.visibilityTotals?.undiscoveredMapCells ?? mapVolume - tiles.length) !== mapVolume) {
      // informational only when brief missing
    }
  }

  const perLevel = terrainBrief?.perLevel ?? tiles.reduce((acc, tile) => {
    const z = tile.p[2];
    acc[z] = acc[z] ?? { z, discoveredRecords: 0, currentlyVisible: 0, discoveredOffLos: 0 };
    acc[z].discoveredRecords += 1;
    if (tile.inLos) acc[z].currentlyVisible += 1;
    else acc[z].discoveredOffLos += 1;
    return acc;
  }, {});

  const perLevelList = Array.isArray(perLevel)
    ? perLevel
    : Object.values(perLevel ?? {}).sort((a, b) => a.z - b.z);

  const ok = errors.length === 0;

  return {
    ok,
    fairnessDisclaimer: FAIRNESS_NOTE,
    file: {
      sizeBytes,
      maxBytes: MAX_INPUT_BYTES,
      headroomBytes,
      overCap,
      sha256: fileSha256,
    },
    parseStage,
    validationErrors,
    tactical: tactical
      ? {
          schemaVersion: tactical.schemaVersion,
          turn: tactical.turn,
          side: tactical.side,
          missionContext: tactical.missionContext ?? null,
          terrainAvailable: Boolean(tactical.terrain),
          terrainEncoding: tactical.terrain?.encoding ?? (tactical.terrain?.tiles ? 'verbose' : null),
          semanticsEncoding: tactical.terrain?.semantics?.encoding ?? null,
        }
      : null,
    discovery: terrainBrief
      ? {
          totalDiscoveredRecords: terrainBrief.totalDiscoveredRecords,
          visibilityTotals: terrainBrief.visibilityTotals,
          perLevel: terrainBrief.perLevelDiscovered ?? perLevelList,
        }
      : {
          totalDiscoveredRecords: tiles.length,
          visibilityTotals: {
            currentlyVisibleRecords: tiles.filter((t) => t.inLos).length,
            discoveredOffLosRecords: tiles.filter((t) => !t.inLos).length,
            undiscoveredMapCells: tactical
              ? tactical.map.width * tactical.map.height * tactical.map.depth - tiles.length
              : null,
          },
          perLevel: perLevelList,
        },
    structures,
    perception,
    groundItems,
    sessionIdentity,
    warnings,
    errors,
  };
}

function verifySnapshotFile(filePath, options = {}) {
  if (!fs.existsSync(filePath)) {
    return {
      ok: false,
      fairnessDisclaimer: FAIRNESS_NOTE,
      file: { path: filePath, exists: false },
      errors: [`Snapshot file not found: ${filePath}`],
      warnings: [],
    };
  }
  const text = fs.readFileSync(filePath, 'utf8');
  const report = verifySnapshotText(text, options);
  report.file.path = filePath;
  report.file.exists = true;
  return report;
}

function reportToMarkdown(report, meta = {}) {
  const lines = [];
  lines.push('# Test battle snapshot verification');
  if (meta.stageLabel) lines.push(`- **Stage:** ${meta.stageLabel}`);
  if (meta.captureId) lines.push(`- **Capture ID:** ${meta.captureId}`);
  if (meta.capturedAt) lines.push(`- **Captured at:** ${meta.capturedAt}`);
  lines.push(`- **Verified at:** ${new Date().toISOString()}`);
  lines.push(`- **Result:** ${report.ok ? 'PASS' : 'FAIL'}`);
  lines.push('');
  lines.push('> ' + FAIRNESS_NOTE);
  lines.push('');

  if (report.file?.path) {
    lines.push('## File');
    lines.push(`- Path: \`${report.file.path}\``);
    if (report.file.sizeBytes != null) {
      lines.push(`- Size: ${report.file.sizeBytes} bytes (${report.file.headroomBytes} bytes headroom under 256 KiB)`);
    }
    if (report.file.sha256) lines.push(`- SHA-256: \`${report.file.sha256}\``);
    lines.push('');
  }

  if (report.tactical) {
    lines.push('## Tactical');
    lines.push(`- schemaVersion: **v${report.tactical.schemaVersion}**`);
    lines.push(`- Terrain in export: ${report.tactical.terrainAvailable ? 'yes' : 'no'}`);
    if (report.tactical.terrainEncoding) lines.push(`- Terrain encoding: ${report.tactical.terrainEncoding}`);
    if (report.tactical.semanticsEncoding) lines.push(`- Semantics: ${report.tactical.semanticsEncoding}`);
    if (report.tactical.missionContext) {
      lines.push(`- Mission: ${report.tactical.missionContext.missionType} (${report.tactical.missionContext.missionClass})`);
    }
    lines.push('');
  }

  if (report.discovery) {
    lines.push('## Discovery');
    lines.push(`- Discovered records: ${report.discovery.totalDiscoveredRecords}`);
    const vt = report.discovery.visibilityTotals;
    if (vt) {
      lines.push(`- Currently visible: ${vt.currentlyVisibleRecords ?? 'n/a'}`);
      lines.push(`- Discovered off-LOS: ${vt.discoveredOffLosRecords ?? 'n/a'}`);
      lines.push(`- Undiscovered map cells (UNKNOWN): ${vt.undiscoveredMapCells ?? 'n/a'}`);
    }
    if (report.discovery.perLevel?.length) {
      lines.push('');
      lines.push('| Level (z) | Discovered | Visible now | Off-LOS |');
      lines.push('|-----------|------------|-------------|---------|');
      for (const row of report.discovery.perLevel) {
        lines.push(`| ${row.z} | ${row.discoveredRecords} | ${row.currentlyVisible} | ${row.discoveredOffLos ?? row.discoveredOffLosRecords ?? '—'} |`);
      }
    }
    lines.push('');
  }

  if (report.structures) {
    lines.push('## Structures (export-derived)');
    lines.push(`- UFO hull facets: ${report.structures.ufoHullCount}`);
    lines.push(`- UFO interior facets: ${report.structures.ufoInteriorCount}`);
    lines.push(`- UFO doors: ${report.structures.ufoDoorCount}`);
    lines.push(`- Disclosed door states: ${report.structures.disclosedDoorCount}`);
    lines.push(`- Redacted door states: ${report.structures.redactedDoorCount}`);
    lines.push(`- Grav lifts / vertical passages: ${report.structures.gravLiftCount}`);
    lines.push(`- Unknown structures: ${report.structures.unknownStructureCount}`);
    lines.push('');
  }

  if (report.perception) {
    lines.push('## Perception log');
    lines.push(`- Events: ${report.perception.eventCount}`);
    lines.push(`- Dropped: ${report.perception.droppedCount}`);
    lines.push(`- Projectile direction observations: ${report.perception.projectileDirectionCount}`);
    if (Object.keys(report.perception.byType ?? {}).length) {
      lines.push('- By type:');
      for (const [type, count] of Object.entries(report.perception.byType).sort()) {
        lines.push(`  - ${type}: ${count}`);
      }
    }
    lines.push('');
  }

  if (report.groundItems) {
    lines.push('## Ground items');
    lines.push(`- Observations: ${report.groundItems.observationCount}`);
    lines.push(`- Dropped from memory: ${report.groundItems.droppedCount}`);
    lines.push('');
  }

  if (report.warnings?.length) {
    lines.push('## Warnings');
    for (const w of report.warnings) lines.push(`- ${w}`);
    lines.push('');
  }
  if (report.errors?.length) {
    lines.push('## Errors');
    for (const e of report.errors) lines.push(`- ${e}`);
    lines.push('');
  }

  return lines.join('\n');
}

module.exports = {
  FAIRNESS_NOTE,
  verifySnapshotText,
  verifySnapshotFile,
  reportToMarkdown,
  analyzeStructures,
  analyzePerception,
};
