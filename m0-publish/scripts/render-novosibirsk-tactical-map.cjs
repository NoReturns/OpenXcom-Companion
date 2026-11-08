#!/usr/bin/env node
'use strict';

/**
 * P0 inspection helper — prints human-readable tactical map for Novosibirsk live YAML.
 * Does not publish to GitHub relay.
 */

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const { loadAndValidateSnapshotFromText } = require('../lib/tactical-publish.cjs');
const {
  buildTacticalMapView,
  formatEdgeInterleavedForGitHub,
  measureInterleavedAsciiBytes,
  measureTacticalMapViewBytes,
} = require('../lib/terrain-tactical-map.cjs');

const LIVE = path.join(__dirname, '..', '..', '..', 'local', 'm0', 'tactical-live.yaml');

function main() {
  if (!fs.existsSync(LIVE)) {
    console.error('Missing', LIVE);
    process.exit(1);
  }
  const text = fs.readFileSync(LIVE, 'utf8');
  const tactical = loadAndValidateSnapshotFromText(text, YAML);
  const view = buildTacticalMapView(tactical, {
    levels: [0],
    crop: { x0: 10, y0: 22, x1: 19, y1: 35 },
  });
  const md = formatEdgeInterleavedForGitHub(view);
  console.log(md);
  console.error('');
  const il = view.levels[0].interleavedAscii;
  console.error('Interleaved text bytes:', measureInterleavedAsciiBytes(il));
  console.error('Full view JSON bytes (diagnostic):', measureTacticalMapViewBytes(view));
}

main();
