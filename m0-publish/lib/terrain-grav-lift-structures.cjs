'use strict';

const { isFloorGravLiftTile, isVerifiedNonGravLiftBoundary } = require('./terrain-grav-lift-floor.cjs');

const OBS_CURRENT = 'CURRENTLY_VISIBLE';
const OBS_REMEMBERED = 'DISCOVERED_NOT_CURRENTLY_VISIBLE';
const OBS_MIXED = 'MIXED_VISIBLE_AND_REMEMBERED';

function tileKey(x, y, z) {
  return `${x},${y},${z}`;
}

function neighbors4(x, y) {
  return [
    [x + 1, y],
    [x - 1, y],
    [x, y + 1],
    [x, y - 1],
  ];
}

function observationForCells(cells, byPos) {
  let anyLos = false;
  let anyOff = false;
  for (const [x, y, z] of cells) {
    const t = byPos.get(tileKey(x, y, z));
    if (!t) continue;
    if (t.inLos) anyLos = true;
    else anyOff = true;
  }
  if (anyLos && anyOff) return OBS_MIXED;
  if (anyLos) return OBS_CURRENT;
  if (anyOff) return OBS_REMEMBERED;
  return OBS_REMEMBERED;
}

function bboxForCells(cells) {
  const xs = cells.map((c) => c[0]);
  const ys = cells.map((c) => c[1]);
  return {
    x0: Math.min(...xs),
    y0: Math.min(...ys),
    x1: Math.max(...xs),
    y1: Math.max(...ys),
  };
}

function onMap(x, y, mapWidth, mapHeight) {
  return x >= 0 && y >= 0 && x < mapWidth && y < mapHeight;
}

/**
 * Complete only when every outward cardinal neighbor outside the component is either
 * map edge or a discovered non-grav-lift floor with reliable floorGravLift export.
 */
function footprintBoundaryComplete(component, byPos, mapWidth, mapHeight) {
  if (component.length === 0) return false;
  const z = component[0][2];
  const inSet = new Set(component.map(([x, y]) => `${x},${y}`));
  const checked = new Set();

  for (const [x, y] of component.map(([cx, cy]) => [cx, cy])) {
    for (const [nx, ny] of neighbors4(x, y)) {
      if (inSet.has(`${nx},${ny}`)) continue;
      const edgeKey = `${Math.min(x, nx)},${Math.min(y, ny)},${Math.max(x, nx)},${Math.max(y, ny)},${z}`;
      if (checked.has(edgeKey)) continue;
      checked.add(edgeKey);

      if (!onMap(nx, ny, mapWidth, mapHeight)) {
        continue;
      }
      const neighbor = byPos.get(tileKey(nx, ny, z));
      if (!neighbor) {
        return false;
      }
      if (!isVerifiedNonGravLiftBoundary(neighbor)) {
        return false;
      }
    }
  }
  return true;
}

/**
 * @returns {'complete'|'partial'|'unknown'}
 */
function footprintStatusForLevel(component, byPos, mapWidth, mapHeight) {
  if (component.length === 0) return 'unknown';
  return footprintBoundaryComplete(component, byPos, mapWidth, mapHeight) ? 'complete' : 'partial';
}

function floodComponentsOnLevel(cells) {
  const set = new Set(cells.map(([x, y, z]) => `${x},${y},${z}`));
  const seen = new Set();
  const groups = [];
  for (const key of set) {
    if (seen.has(key)) continue;
    const [sx, sy, sz] = key.split(',').map(Number);
    const stack = [[sx, sy, sz]];
    const component = [];
    seen.add(key);
    while (stack.length) {
      const [x, y, z] = stack.pop();
      component.push([x, y, z]);
      for (const [nx, ny] of neighbors4(x, y)) {
        const nk = `${nx},${ny},${z}`;
        if (set.has(nk) && !seen.has(nk)) {
          seen.add(nk);
          stack.push([nx, ny, z]);
        }
      }
    }
    groups.push(component);
  }
  return groups;
}

function buildVerifiedLinks(floorCells, byPos) {
  const cellSet = new Set(floorCells.map(([x, y, z]) => tileKey(x, y, z)));
  const links = [];
  const seen = new Set();
  for (const [x, y, z] of floorCells) {
    for (const dz of [-1, 1]) {
      const z2 = z + dz;
      const fromKey = tileKey(x, y, z);
      const toKey = tileKey(x, y, z2);
      if (!cellSet.has(toKey)) continue;
      const edgeKey = dz > 0 ? `${fromKey}|${toKey}` : `${toKey}|${fromKey}`;
      if (seen.has(edgeKey)) continue;
      seen.add(edgeKey);
      const fromTile = byPos.get(fromKey);
      const toTile = byPos.get(toKey);
      links.push({
        from: [x, y, z],
        to: [x, y, z2],
        rule: 'engine_same_xy_floor_grav',
        geometryVerified: true,
        pathfindingGuaranteed: false,
        note: 'Same (x,y) adjacent z with exported floorGravLift on both levels; unit size/occupancy not validated.',
        observation: observationForCells([[x, y, z], [x, y, z2]], byPos),
        ...(fromTile && toTile && fromTile.inLos && toTile.inLos ? {} : { mayBeStaleOffLos: true }),
      });
    }
  }
  links.sort((a, b) => {
    const ka = a.from.join(',');
    const kb = b.from.join(',');
    return ka.localeCompare(kb);
  });
  return links;
}

/**
 * @param {object[]} tiles — decodeTerrainTiles output
 * @param {{ width: number, height: number, depth?: number }} map
 */
function buildGravLiftStructures(tiles, map) {
  const floorCells = [];
  const byPos = new Map();
  for (const tile of tiles) {
    byPos.set(tileKey(tile.p[0], tile.p[1], tile.p[2]), tile);
    if (isFloorGravLiftTile(tile)) {
      floorCells.push([tile.p[0], tile.p[1], tile.p[2]]);
    }
  }

  const byZ = new Map();
  for (const cell of floorCells) {
    const z = cell[2];
    if (!byZ.has(z)) byZ.set(z, []);
    byZ.get(z).push(cell);
  }

  const components = [];
  let structureIndex = 0;
  for (const [z, levelCells] of [...byZ.entries()].sort((a, b) => a[0] - b[0])) {
    for (const component of floodComponentsOnLevel(levelCells)) {
      const bbox = bboxForCells(component);
      const rectW = bbox.x1 - bbox.x0 + 1;
      const rectH = bbox.y1 - bbox.y0 + 1;
      components.push({
        id: `glf-${structureIndex}`,
        z,
        cells: component.map(([x, y, cz]) => [x, y, cz]),
        cellCount: component.length,
        footprint: {
          bbox: [bbox.x0, bbox.y0, bbox.x1, bbox.y1],
          describedRect: `${rectW}x${rectH}`,
          status: footprintStatusForLevel(component, byPos, map.width, map.height),
        },
        observation: observationForCells(component, byPos),
      });
      structureIndex += 1;
    }
  }

  const links = buildVerifiedLinks(floorCells, byPos);

  return {
    schemaVersion: 1,
    floorCells,
    components,
    links,
  };
}

module.exports = {
  OBS_CURRENT,
  OBS_REMEMBERED,
  OBS_MIXED,
  buildGravLiftStructures,
  footprintStatusForLevel,
  footprintBoundaryComplete,
};
