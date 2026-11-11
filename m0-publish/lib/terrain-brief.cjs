'use strict';

const { decodePackedV1Base64 } = require('./terrain-packed-v1.cjs');
const {
  categoryLabel,
} = require('./terrain-semantics-sparse-v1.cjs');
const {
  decodeSparseSemanticsBase64,
  attachSemanticsToTiles,
} = require('./terrain-semantics-sparse-v2.cjs');
const {
  collectStructureFacets,
  buildStructureObservations,
  OBS_REMEMBERED,
} = require('./terrain-structure-wp8.cjs');

const DEFAULT_MAX_BYTES = 16 * 1024;
const FACTION_PLAYER = 0;
const WALK_IMPASSABLE = 255;

const VIS_CURRENT = 'CURRENTLY_VISIBLE';
const VIS_DISCOVERED_OFF_LOS = 'DISCOVERED_NOT_CURRENTLY_VISIBLE';

const DISC_WEST = 1;
const DISC_NORTH = 2;
const DISC_BODY = 4;

function isFriendlyPlayerControlled(unit) {
  return unit.originalFaction === FACTION_PLAYER && unit.faction === FACTION_PLAYER;
}

function manhattan3(a, b) {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}

function tileSortKey(p) {
  return p[2] * 1_000_000 + p[1] * 1_000 + p[0];
}

function comparePositions(a, b) {
  return tileSortKey(a) - tileSortKey(b);
}

function visibilityLabel(tile) {
  return tile.inLos ? VIS_CURRENT : VIS_DISCOVERED_OFF_LOS;
}

function stripLegacyOffLosSemantics(tile) {
  if (tile.inLos || !tile.sem) {
    return tile;
  }
  const { sem, ...rest } = tile;
  return rest;
}

function redactOffLosStructureMeta(tile) {
  if (tile.inLos || !tile.structureMeta) {
    return tile;
  }
  const { doorState, ...restMeta } = tile.structureMeta;
  return {
    ...tile,
    structureMeta: Object.keys(restMeta).length ? restMeta : undefined,
  };
}

function decodeTerrainTiles(tactical) {
  if (!tactical.terrain) {
    return [];
  }
  let tiles;
  if (tactical.terrain.encoding === 'packed-v1') {
    const { tiles: decoded } = decodePackedV1Base64(tactical.terrain.data, tactical.map, {
      expectedRecordCount: tactical.terrain.recordCount,
    });
    tiles = decoded;
    if (tactical.terrain.semantics) {
      const semanticsEncoding = tactical.terrain.semantics.encoding;
      const { byPos } = decodeSparseSemanticsBase64(
        tactical.terrain.semantics.data,
        semanticsEncoding,
        { expectedRecordCount: tactical.terrain.semantics.recordCount },
      );
      tiles = attachSemanticsToTiles(tiles, byPos);
      tiles = tiles.map(redactOffLosStructureMeta);
      if (semanticsEncoding === 'sparse-v1') {
        tiles = tiles.map(stripLegacyOffLosSemantics);
      }
      return tiles;
    }
    return tiles;
  }
  tiles = tactical.terrain.tiles ?? [];
  return tiles.map(redactOffLosStructureMeta);
}

/**
 * Classify one discovered terrain record using only packed/verbose export fields.
 * Does not infer object identity (doors, lifts, stairs).
 */
function semPartLabel(tile, part) {
  const id = tile.sem?.[part];
  if (id === undefined) {
    return null;
  }
  return categoryLabel(id);
}

function classifyDiscoveredTile(tile) {
  const visibility = visibilityLabel(tile);
  const p = tile.p;
  const sightObstruction = [];
  const movementObstruction = [];
  const knownBarriers = [];
  const elevationNotes = [];
  const terrainSemantics = [];
  let openTerrain = null;

  const pushSemantic = (part, edge) => {
    const label = semPartLabel(tile, part);
    if (!label || label === 'UNKNOWN') {
      return;
    }
    terrainSemantics.push({
      ...(edge ? { edge } : { p }),
      visibility: tile.inLos ? VIS_CURRENT : OBS_REMEMBERED,
      category: label,
      certainty: tile.inLos ? 'current_observation' : 'discovered_structure_identity',
    });
  };

  pushSemantic('west', 'west');
  pushSemantic('north', 'north');
  pushSemantic('body');

  const structureFacets = collectStructureFacets(tile);

  if ((tile.disc & DISC_WEST) !== 0 && !tile.west) {
    knownBarriers.push({
      edge: 'west',
      visibility,
      note: 'west edge discovered; no emittable wall geometry in export',
    });
  }
  if ((tile.disc & DISC_NORTH) !== 0 && !tile.north) {
    knownBarriers.push({
      edge: 'north',
      visibility,
      note: 'north edge discovered; no emittable wall geometry in export',
    });
  }

  if (tile.west) {
    const entry = { p, edge: 'west', visibility, walk: tile.west.walk };
    if (tile.west.blockSight) {
      entry.sightBlocking = true;
      sightObstruction.push({ ...entry, source: 'west_wall' });
    }
    if (tile.west.walk === WALK_IMPASSABLE) {
      movementObstruction.push({ ...entry, source: 'west_wall' });
    }
    knownBarriers.push(entry);
  }

  if (tile.north) {
    const entry = { p, edge: 'north', visibility, walk: tile.north.walk };
    if (tile.north.blockSight) {
      entry.sightBlocking = true;
      sightObstruction.push({ ...entry, source: 'north_wall' });
    }
    if (tile.north.walk === WALK_IMPASSABLE) {
      movementObstruction.push({ ...entry, source: 'north_wall' });
    }
    knownBarriers.push(entry);
  }

  if ((tile.disc & DISC_BODY) !== 0 && tile.body) {
    if (tile.body.air) {
      openTerrain = { kind: 'open_air', visibility };
    } else {
      openTerrain = {
        kind: 'floor_or_ground',
        visibility,
        elev: tile.body.elev,
        noFloor: tile.body.noFloor === true,
      };
      if (typeof tile.body.elev === 'number' && Math.abs(tile.body.elev) >= 2) {
        elevationNotes.push({
          p,
          visibility,
          elev: tile.body.elev,
          certainty: 'definitive',
          note: 'terrain level from export (not guaranteed full stair/lift semantics)',
        });
      }
      if (tile.body.walkF !== undefined) {
        if (tile.body.walkF === WALK_IMPASSABLE) {
          movementObstruction.push({
            p,
            visibility,
            source: 'floor',
            walk: tile.body.walkF,
          });
        }
        if (tile.body.blockSightF) {
          sightObstruction.push({
            p,
            visibility,
            source: 'floor',
            walk: tile.body.walkF,
          });
        }
      }
      if (tile.body.walkO !== undefined) {
        if (tile.body.walkO === WALK_IMPASSABLE) {
          movementObstruction.push({
            p,
            visibility,
            source: 'object',
            walk: tile.body.walkO,
            objectIdentity: 'unknown',
          });
        }
        if (tile.body.blockSightO) {
          sightObstruction.push({
            p,
            visibility,
            source: 'object',
            walk: tile.body.walkO,
            objectIdentity: 'unknown',
          });
        }
        if (
          tile.body.walkO !== WALK_IMPASSABLE
          && (tile.body.blockSightO || tile.body.walkO >= 8)
          && !tile.sem?.body
        ) {
          knownBarriers.push({
            p,
            visibility,
            source: 'object',
            walk: tile.body.walkO,
            certainty: 'inferred',
            note: 'freestanding obstacle or door-like geometry; type not exported',
          });
        }
      }
    }
  }

  return {
    p,
    visibility,
    disc: tile.disc,
    openTerrain,
    sightObstruction,
    movementObstruction,
    knownBarriers,
    elevationNotes,
    terrainSemantics,
    structureFacets,
  };
}

function aggregateClassifications(tiles) {
  const sightObstruction = [];
  const movementObstruction = [];
  const knownBarriers = [];
  const elevationChanges = [];
  const knownOpen = [];
  const terrainSemantics = [];
  const structureFacets = [];

  for (const tile of tiles) {
    const c = classifyDiscoveredTile(tile);
    sightObstruction.push(...c.sightObstruction);
    movementObstruction.push(...c.movementObstruction);
    knownBarriers.push(...c.knownBarriers);
    elevationChanges.push(...c.elevationNotes);
    if (c.terrainSemantics?.length) {
      for (const sem of c.terrainSemantics) {
        terrainSemantics.push(sem);
      }
    }
    if (c.structureFacets?.length) {
      structureFacets.push(...c.structureFacets);
    }
    if (c.openTerrain) {
      knownOpen.push({ p: c.p, ...c.openTerrain });
    }
  }

  const sortByP = (a, b) => comparePositions(a.p, b.p);
  sightObstruction.sort(sortByP);
  movementObstruction.sort(sortByP);
  knownBarriers.sort((a, b) => {
    const pa = a.p ?? [0, 0, a.edge ? -1 : 0];
    const pb = b.p ?? [0, 0, b.edge ? -1 : 0];
    return comparePositions(pa, pb);
  });
  elevationChanges.sort(sortByP);
  knownOpen.sort(sortByP);

  return {
    sightObstruction,
    movementObstruction,
    knownBarriers,
    elevationChanges,
    knownOpen,
    terrainSemantics,
    structureFacets,
  };
}

function buildNearFocusEntries(tiles, focus, radius) {
  if (!focus) {
    return [];
  }
  const entries = [];
  for (const tile of tiles) {
    const pos = tile.p;
    if (manhattan3(pos, focus) > radius) {
      continue;
    }
    const classified = classifyDiscoveredTile(tile);
    const primarySem = classified.terrainSemantics[0];
    entries.push({
      p: pos,
      visibility: classified.visibility,
      disc: tile.disc,
      distance: manhattan3(pos, focus),
      ...(classified.openTerrain ? { open: classified.openTerrain.kind } : {}),
      ...(primarySem ? { terrainCategory: primarySem.category } : {}),
      ...(classified.structureFacets[0]
        ? {
          structureKind: classified.structureFacets[0].structureKind,
          observationStatus: classified.structureFacets[0].observationStatus,
        }
        : {}),
      ...(tile.body && !tile.body.air && tile.body.elev !== undefined ? { elev: tile.body.elev } : {}),
      ...(tile.body?.walkF !== undefined ? { walkF: tile.body.walkF } : {}),
      ...(tile.body?.walkO !== undefined ? { walkO: tile.body.walkO } : {}),
      ...(classified.sightObstruction.length ? { sightBlocks: classified.sightObstruction.length } : {}),
      ...(classified.movementObstruction.length ? { moveBlocks: classified.movementObstruction.length } : {}),
    });
  }
  entries.sort((a, b) => a.distance - b.distance || comparePositions(a.p, b.p));
  return entries;
}

function buildTerrainBrief(tactical, options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const tiles = decodeTerrainTiles(tactical);
  const { map, units, selectedUnitId } = tactical;
  const mapVolume = map.width * map.height * map.depth;

  const friendlyOnMap = units.filter(
    (unit) => isFriendlyPlayerControlled(unit)
      && Array.isArray(unit.position)
      && unit.position.length === 3,
  );
  const selected = friendlyOnMap.find((unit) => unit.id === selectedUnitId) ?? friendlyOnMap[0] ?? null;
  const focus = selected ? selected.position : null;
  const nearRadius = options.nearFocusRadius ?? 10;
  const clusterRadius = options.friendlyClusterRadius ?? 14;

  const perLevel = [];
  for (let z = 0; z < map.depth; z += 1) {
    const levelTiles = tiles.filter((tile) => tile.p[2] === z);
    perLevel.push({
      z,
      discoveredRecords: levelTiles.length,
      currentlyVisible: levelTiles.filter((tile) => tile.inLos).length,
      discoveredOffLos: levelTiles.filter((tile) => !tile.inLos).length,
    });
  }

  const visibilityTotals = {
    currentlyVisibleRecords: tiles.filter((t) => t.inLos).length,
    discoveredOffLosRecords: tiles.filter((t) => !t.inLos).length,
    undiscoveredMapCells: Math.max(0, mapVolume - tiles.length),
    undiscoveredLabel: 'UNKNOWN',
  };

  const aggregated = aggregateClassifications(tiles);
  const nearFocusAll = buildNearFocusEntries(tiles, focus, nearRadius);

  const nearbyFriendlies = friendlyOnMap
    .filter((u) => u.id !== (selected?.id))
    .map((u) => ({
      id: u.id,
      p: u.position,
      ...(focus ? { distanceFromFocus: manhattan3(u.position, focus) } : {}),
      inLosToFocus: focus ? manhattan3(u.position, focus) <= nearRadius : undefined,
    }))
    .filter((u) => !focus || u.distanceFromFocus <= clusterRadius)
    .sort((a, b) => (a.distanceFromFocus ?? 0) - (b.distanceFromFocus ?? 0));

  const shrinkTiers = [
    { nearFocusTiles: 80, sightObstruction: 60, movementObstruction: 40, knownBarriers: 40, elevationChanges: 40, knownOpen: 30, terrainSemantics: 40, structureFacets: 40, compactMeta: false },
    { nearFocusTiles: 50, sightObstruction: 35, movementObstruction: 25, knownBarriers: 25, elevationChanges: 25, knownOpen: 20, terrainSemantics: 25, structureFacets: 25, compactMeta: false },
    { nearFocusTiles: 30, sightObstruction: 20, movementObstruction: 15, knownBarriers: 15, elevationChanges: 15, knownOpen: 10, terrainSemantics: 15, structureFacets: 15, compactMeta: true },
    { nearFocusTiles: 15, sightObstruction: 10, movementObstruction: 8, knownBarriers: 8, elevationChanges: 8, knownOpen: 5, terrainSemantics: 8, structureFacets: 8, compactMeta: true },
  ];

  const baseWarnings = [
    'Derived summary only; packed terrain blob is the lossless source of truth.',
    'Full terrain.memoryNote is on the snapshot YAML, not duplicated here.',
    'Off-LOS structure identity uses MapData on discovered tiles; door open/closed is disclosed only in current LOS.',
    'This summary never labels paths safe or shots clear.',
  ];

  const fullSemanticLimits = {
    notExported: [
      'Undiscovered tile parts and map volumes',
      'Guaranteed cover quality or shot clearance',
      'Historical last-seen geometry for off-LOS tiles',
      'Raw MapData / MCD identifiers',
    ],
    exportedWhenReliable: [
      'Engine-derived terrain categories on discovered parts (sparse-v2 / tile.sem)',
      'UFO dataset association via mod UFO battlescape terrain map sets',
      'Door open/closed on classified doors when tile is in player LOS at export',
    ],
    offLosGeometryNote:
      'DISCOVERED_NOT_CURRENTLY_VISIBLE records reflect live engine tiles at export time, not a separate memory snapshot.',
    movementTu255Note:
      'walk TU 255 marks that map part impassable for walking; other directions or movement modes may differ.',
    sightBlockNote:
      'blockSight flags mark sight-blocking geometry for that part; semantic category names structure when engine can classify reliably.',
  };

  const compactSemanticLimits = {
    notExported: fullSemanticLimits.notExported,
    offLosGeometryNote: fullSemanticLimits.offLosGeometryNote,
  };

  const futureEngineExtensionProposal = {
    name: 'packed-v2-memory-semantics',
    optionalFields: [
      'lastDirectlyObservedTurn per record for true off-LOS memory semantics',
      'destructionGeneration flag when tile part is damaged replacement geometry',
    ],
    wireRule: 'Future packed-v2 tail; sparse-v1 categories remain compatible.',
  };

  const semanticSummary = {};
  for (const entry of aggregated.terrainSemantics) {
    semanticSummary[entry.category] = (semanticSummary[entry.category] ?? 0) + 1;
  }

  const buildBriefForTier = (tier, truncated) => {
    const structureObservations = buildStructureObservations(tiles, { focusPosition: focus, maxLines: 12 });
    const brief = {
      schemaVersion: 4,
      ...(tactical.missionContext ? { missionContext: tactical.missionContext } : {}),
      visibilityLabels: {
        inPlayerLosNow: VIS_CURRENT,
        discoveredNotInLosNow: VIS_DISCOVERED_OFF_LOS,
        neverDiscovered: 'UNKNOWN',
      },
      totalDiscoveredRecords: tiles.length,
      visibilityTotals,
      perLevel,
      focusSoldierId: selected ? selected.id : null,
      focusPosition: focus,
      nearbyFriendlies,
      nearFocusRadius: nearRadius,
      nearFocusCandidateCount: nearFocusAll.length,
      nearFocusTiles: nearFocusAll.slice(0, tier.nearFocusTiles),
      sightObstruction: aggregated.sightObstruction.slice(0, tier.sightObstruction),
      movementObstruction: aggregated.movementObstruction.slice(0, tier.movementObstruction),
      knownBarriers: aggregated.knownBarriers.slice(0, tier.knownBarriers),
      elevationChanges: aggregated.elevationChanges.slice(0, tier.elevationChanges),
      knownOpenTerrain: aggregated.knownOpen.slice(0, tier.knownOpen),
      terrainSemantics: aggregated.terrainSemantics.slice(0, tier.terrainSemantics),
      structureFacets: aggregated.structureFacets.slice(0, tier.structureFacets),
      structureObservations,
      semanticSummary,
      semanticLimits: tier.compactMeta ? compactSemanticLimits : fullSemanticLimits,
      warnings: baseWarnings,
      omittedDueToBudget: {},
    };
    if (!tier.compactMeta) {
      brief.futureEngineExtensionProposal = futureEngineExtensionProposal;
    }
    if (truncated) {
      brief.truncated = true;
    }
    const o = {};
    if (nearFocusAll.length > brief.nearFocusTiles.length) {
      o.nearFocusTiles = nearFocusAll.length - brief.nearFocusTiles.length;
    }
    if (aggregated.sightObstruction.length > brief.sightObstruction.length) {
      o.sightObstruction = aggregated.sightObstruction.length - brief.sightObstruction.length;
    }
    if (aggregated.movementObstruction.length > brief.movementObstruction.length) {
      o.movementObstruction = aggregated.movementObstruction.length - brief.movementObstruction.length;
    }
    if (aggregated.knownBarriers.length > brief.knownBarriers.length) {
      o.knownBarriers = aggregated.knownBarriers.length - brief.knownBarriers.length;
    }
    if (aggregated.elevationChanges.length > brief.elevationChanges.length) {
      o.elevationChanges = aggregated.elevationChanges.length - brief.elevationChanges.length;
    }
    if (aggregated.knownOpen.length > brief.knownOpenTerrain.length) {
      o.knownOpenTerrain = aggregated.knownOpen.length - brief.knownOpenTerrain.length;
    }
    if (aggregated.structureFacets.length > brief.structureFacets.length) {
      o.structureFacets = aggregated.structureFacets.length - brief.structureFacets.length;
    }
    if (aggregated.terrainSemantics.length > brief.terrainSemantics.length) {
      o.terrainSemantics = aggregated.terrainSemantics.length - brief.terrainSemantics.length;
    }
    brief.omittedDueToBudget = o;
    return brief;
  };

  for (let i = 0; i < shrinkTiers.length; i += 1) {
    const truncated = i > 0;
    const brief = buildBriefForTier(shrinkTiers[i], truncated);
    if (Buffer.byteLength(JSON.stringify(brief), 'utf8') <= maxBytes) {
      return brief;
    }
  }

  return {
    schemaVersion: 4,
    ...(tactical.missionContext ? { missionContext: tactical.missionContext } : {}),
    visibilityLabels: {
      inPlayerLosNow: VIS_CURRENT,
      discoveredNotInLosNow: VIS_DISCOVERED_OFF_LOS,
      neverDiscovered: 'UNKNOWN',
    },
    totalDiscoveredRecords: tiles.length,
    visibilityTotals,
    perLevel,
    focusSoldierId: selected ? selected.id : null,
    focusPosition: focus,
    nearFocusCandidateCount: nearFocusAll.length,
    warnings: baseWarnings,
    truncated: true,
    omittedDueToBudget: {
      detailSections: 'omitted after progressive shrink tiers exhausted',
      nearFocusTilesRemaining: nearFocusAll.length,
    },
  };
}

module.exports = {
  DEFAULT_MAX_BYTES,
  VIS_CURRENT,
  VIS_DISCOVERED_OFF_LOS,
  WALK_IMPASSABLE,
  visibilityLabel,
  classifyDiscoveredTile,
  decodeTerrainTiles,
  buildTerrainBrief,
};
