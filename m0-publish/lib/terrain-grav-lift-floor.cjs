'use strict';

const DISC_BODY = 4;

/**
 * sparse-v2 (and verbose) export with decoded meta — floorGravLift bit is authoritative when false/absent.
 */
function hasReliableFloorGravExport(tile) {
  return (
    tile?.structureMeta
    && Object.prototype.hasOwnProperty.call(tile.structureMeta, 'inLosAtExport')
  );
}

/**
 * Movement-relevant grav-lift floor (engine Pathfinding::validateUpDown uses O_FLOOR isGravLift()).
 * Requires structureMeta.floorGravLift from sparse-v2 meta bit4 or verbose YAML export — not sem.body alone.
 */
function isFloorGravLiftTile(tile) {
  if (!tile || (tile.disc & DISC_BODY) === 0 || !tile.body) {
    return false;
  }
  return tile.structureMeta?.floorGravLift === true;
}

/**
 * Discovered tile with reliable export showing this is not a grav-lift floor (boundary evidence).
 */
function isVerifiedNonGravLiftBoundary(tile) {
  if (!tile || (tile.disc & DISC_BODY) === 0 || !tile.body) {
    return false;
  }
  if (!hasReliableFloorGravExport(tile)) {
    return false;
  }
  return !isFloorGravLiftTile(tile);
}

module.exports = {
  DISC_BODY,
  hasReliableFloorGravExport,
  isFloorGravLiftTile,
  isVerifiedNonGravLiftBoundary,
};
