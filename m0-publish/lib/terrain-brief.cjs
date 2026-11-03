'use strict';

const { decodePackedV1Base64 } = require('./terrain-packed-v1.cjs');

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

function decodeTerrainTiles(tactical) {
  if (!tactical.terrain) {
    return [];
  }
  if (tactical.terrain.encoding === 'packed-v1') {
    const { tiles } = decodePackedV1Base64(tactical.terrain.data, tactical.map, {
      expectedRecordCount: tactical.terrain.recordCount,
    });
    return tiles;
  }
  return tactical.terrain.tiles ?? [];
}

/**
 * Classify one discovered terrain record using only packed/verbose export fields.
 * Does not infer object identity (doors, lifts, stairs).
 */
function classifyDiscoveredTile(tile) {
  const visibility = visibilityLabel(tile);
  const p = tile.p;
  const sightObstruction = [];
  const movementObstruction = [];
  const knownBarriers = [];
  const elevationNotes = [];
  let openTerrain = null;

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
  };
}

function aggregateClassifications(tiles) {
  const sightObstruction = [];
  const movementObstruction = [];
  const knownBarriers = [];
  const elevationChanges = [];
  const knownOpen = [];

  for (const tile of tiles) {
    const c = classifyDiscoveredTile(tile);
    sightObstruction.push(...c.sightObstruction);
    movementObstruction.push(...c.movementObstruction);
    knownBarriers.push(...c.knownBarriers);
    elevationChanges.push(...c.elevationNotes);
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
    entries.push({
      p: pos,
      visibility: classified.visibility,
      disc: tile.disc,
      distance: manhattan3(pos, focus),
      ...(classified.openTerrain ? { open: classified.openTerrain.kind } : {}),
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

  const friendly = units.filter((unit) => isFriendlyPlayerControlled(unit));
  const selected = friendly.find((unit) => unit.id === selectedUnitId) ?? friendly[0] ?? null;
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

  const nearbyFriendlies = friendly
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
    { nearFocusTiles: 80, sightObstruction: 60, movementObstruction: 40, knownBarriers: 40, elevationChanges: 40, knownOpen: 30, compactMeta: false },
    { nearFocusTiles: 50, sightObstruction: 35, movementObstruction: 25, knownBarriers: 25, elevationChanges: 25, knownOpen: 20, compactMeta: false },
    { nearFocusTiles: 30, sightObstruction: 20, movementObstruction: 15, knownBarriers: 15, elevationChanges: 15, knownOpen: 10, compactMeta: true },
    { nearFocusTiles: 15, sightObstruction: 10, movementObstruction: 8, knownBarriers: 8, elevationChanges: 8, knownOpen: 5, compactMeta: true },
  ];

  const baseWarnings = [
    'Derived summary only; packed terrain blob is the lossless source of truth.',
    'Full terrain.memoryNote is on the snapshot YAML, not duplicated here.',
    'Off-LOS export is live engine state, not authoritative remembered history.',
    'This summary never labels paths safe or shots clear.',
  ];

  const fullSemanticLimits = {
    notExported: [
      'MapData object type (door vs wall vs UFO door vs grav lift vs stairs)',
      'MCD metadata for undiscovered tile parts',
      'Guaranteed cover quality or shot clearance',
      'Historical last-seen geometry for off-LOS tiles',
    ],
    offLosGeometryNote:
      'DISCOVERED_NOT_CURRENTLY_VISIBLE records reflect live engine tiles at export time, not a separate memory snapshot.',
    movementTu255Note:
      'walk TU 255 marks that map part impassable for walking; other directions or movement modes may differ.',
    sightBlockNote:
      'blockSight flags mark sight-blocking geometry for that part; does not by itself identify a solid wall.',
  };

  const compactSemanticLimits = {
    notExported: fullSemanticLimits.notExported,
    offLosGeometryNote: fullSemanticLimits.offLosGeometryNote,
  };

  const futureEngineExtensionProposal = {
    name: 'packed-v2-optional-semantics',
    optionalFields: [
      'objectSpecialType enum per body (door, ufoDoor, gravLift, stair, none) when body discovered',
      'destructionGeneration flag when tile part is damaged replacement geometry',
      'lastDirectlyObservedTurn per record for true memory semantics',
    ],
    wireRule: 'Add optional tail bytes after formatVersion bump; packed-v1 decoders ignore unknown versions.',
  };

  const buildBriefForTier = (tier, truncated) => {
    const brief = {
      schemaVersion: 2,
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
    schemaVersion: 2,
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
