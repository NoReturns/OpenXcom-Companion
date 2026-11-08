'use strict';

const { categoryLabel } = require('./terrain-semantics-sparse-v1.cjs');
const { isDoorCategory } = require('./terrain-semantics-sparse-v2.cjs');

const OBS_CURRENT = 'CURRENTLY_VISIBLE';
const OBS_REMEMBERED = 'DISCOVERED_REMEMBERED_STRUCTURE';
const OBS_UNKNOWN = 'UNKNOWN';

const DOOR_DISCLOSED = new Set(['open', 'closed']);
const DOOR_REDACTED = 'not_disclosed';

const STRUCTURE_KIND_BY_CATEGORY = Object.freeze({
  ORDINARY: 'ordinary_ground',
  ORDINARY_IMPASSABLE: 'conventional_wall',
  UFO_STRUCTURE: 'ufo_hull',
  UFO_INTERIOR: 'ufo_interior_floor',
  UFO_DOOR: 'ufo_door',
  ORDINARY_DOOR: 'building_door',
  ENTRANCE: 'mission_entrance',
  GRAV_LIFT: 'vertical_passage',
  XCOM_CRAFT: 'xcom_craft_surface',
  XCOM_BASE_MODULE: 'xcom_base_module',
});

const TERRAIN_FEATURE_BY_CATEGORY = Object.freeze({
  UFO_STRUCTURE: 'ufo_boundary_wall',
  UFO_INTERIOR: 'ufo_interior_floor',
  UFO_DOOR: 'ufo_doorway',
  ORDINARY_DOOR: 'building_doorway',
  ENTRANCE: 'deployment_entrance',
  GRAV_LIFT: 'grav_lift',
});

function observationStatus(tile) {
  if (tile.inLos) {
    return OBS_CURRENT;
  }
  if (tile.disc) {
    return OBS_REMEMBERED;
  }
  return OBS_UNKNOWN;
}

function structureKindForCategoryId(categoryId) {
  const label = categoryLabel(categoryId);
  return STRUCTURE_KIND_BY_CATEGORY[label] ?? 'unknown_structure';
}

function terrainFeatureForCategoryId(categoryId) {
  const label = categoryLabel(categoryId);
  return TERRAIN_FEATURE_BY_CATEGORY[label] ?? null;
}

function doorStateForPart(tile, part) {
  const categoryId = tile.sem?.[part];
  if (categoryId === undefined || !isDoorCategory(categoryId)) {
    return undefined;
  }
  if (!tile.inLos) {
    return DOOR_REDACTED;
  }
  const fromMeta = tile.structureMeta?.doorState?.[part];
  if (fromMeta && DOOR_DISCLOSED.has(fromMeta)) {
    return fromMeta;
  }
  return DOOR_REDACTED;
}

function buildStructureFacet(tile, part, edge) {
  const categoryId = tile.sem?.[part];
  if (categoryId === undefined) {
    return null;
  }
  const label = categoryLabel(categoryId);
  if (label === 'UNKNOWN') {
    return null;
  }
  const facet = {
    ...(edge ? { edge } : { p: tile.p }),
    structureKind: structureKindForCategoryId(categoryId),
    terrainFeature: terrainFeatureForCategoryId(categoryId) ?? label.toLowerCase(),
    observationStatus: observationStatus(tile),
    engineCategory: label,
  };
  const doorState = doorStateForPart(tile, part);
  if (doorState !== undefined) {
    facet.doorState = doorState;
  }
  return facet;
}

function collectStructureFacets(tile) {
  const facets = [];
  const push = (part, edge) => {
    const facet = buildStructureFacet(tile, part, edge);
    if (facet) {
      facets.push(facet);
    }
  };
  push('west', 'west');
  push('north', 'north');
  push('body');
  return facets;
}

function describeStructureFacet(facet, focus) {
  const pos = facet.p ? `(${facet.p.join(',')})` : facet.edge;
  if (facet.structureKind === 'ufo_hull') {
    return `Discovered UFO hull boundary${facet.edge ? ` on ${facet.edge} edge at ${pos}` : ` at ${pos}`}.`;
  }
  if (facet.structureKind === 'ufo_door' || facet.structureKind === 'building_door') {
    if (facet.doorState === 'open' || facet.doorState === 'closed') {
      return `Visible ${facet.structureKind === 'ufo_door' ? 'UFO' : 'building'} door at ${pos}, ${facet.doorState}.`;
    }
    if (facet.observationStatus === OBS_REMEMBERED) {
      return `Discovered ${facet.structureKind === 'ufo_door' ? 'UFO' : 'building'} doorway at ${pos}; live open/closed state not disclosed off-screen.`;
    }
    return `Discovered ${facet.structureKind === 'ufo_door' ? 'UFO' : 'building'} doorway at ${pos}.`;
  }
  if (facet.structureKind === 'vertical_passage') {
    return `Discovered vertical passage between levels at ${pos}.`;
  }
  if (facet.structureKind === 'ufo_interior_floor' && facet.observationStatus === OBS_REMEMBERED) {
    return `Discovered UFO interior floor at ${pos}; layout beyond observed tiles not exported.`;
  }
  if (facet.structureKind === 'mission_entrance') {
    return `Discovered mission entrance at ${pos}.`;
  }
  if (focus && facet.p) {
    const dx = facet.p[0] - focus[0];
    const dy = facet.p[1] - focus[1];
    if (Math.abs(dx) + Math.abs(dy) <= 2 && facet.structureKind === 'ufo_hull') {
      return 'Discovered UFO hull boundary near focus.';
    }
  }
  return null;
}

function buildStructureObservations(tiles, options = {}) {
  const focus = options.focusPosition ?? null;
  const lines = [];
  const seen = new Set();
  for (const tile of tiles) {
    for (const facet of collectStructureFacets(tile)) {
      const line = describeStructureFacet(facet, focus);
      if (!line || seen.has(line)) {
        continue;
      }
      seen.add(line);
      lines.push(line);
    }
  }
  if (lines.some((l) => l.includes('interior')) && !lines.some((l) => l.includes('beyond'))) {
    lines.push('Unexplored interior beyond the observed entrance may exist; complete UFO floor plans are not inferred.');
  }
  return lines.slice(0, options.maxLines ?? 24);
}

module.exports = {
  OBS_CURRENT,
  OBS_REMEMBERED,
  OBS_UNKNOWN,
  DOOR_REDACTED,
  observationStatus,
  structureKindForCategoryId,
  collectStructureFacets,
  buildStructureObservations,
};
