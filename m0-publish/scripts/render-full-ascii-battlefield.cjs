#!/usr/bin/env node
'use strict';

/**
 * Render full-map ASCII battlefield JSON from a tactical YAML snapshot (local only).
 * Usage: node scripts/render-full-ascii-battlefield.cjs <tactical-live.yaml> [--out path] [--pretty]
 */

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const { loadAndValidateSnapshotFromText } = require('../lib/tactical-publish.cjs');
const {
  buildFullAsciiBattlefieldMap,
  serializeFullAsciiBattlefieldMap,
  measureFullAsciiBattlefieldMapBytes,
  estimateRelayBytesWithFullAscii,
} = require('../lib/terrain-full-ascii-battlefield.cjs');

function main() {
  const args = process.argv.slice(2);
  const yamlPath = args.find((a) => !a.startsWith('--'));
  if (!yamlPath) {
    console.error('Usage: node scripts/render-full-ascii-battlefield.cjs <tactical-live.yaml> [--out path] [--pretty]');
    process.exit(1);
  }
  const outIdx = args.indexOf('--out');
  const outPath = outIdx >= 0 ? args[outIdx + 1] : null;
  const pretty = args.includes('--pretty');

  const text = fs.readFileSync(path.resolve(yamlPath), 'utf8');
  const tactical = loadAndValidateSnapshotFromText(text, YAML);
  const map = buildFullAsciiBattlefieldMap(tactical);
  const serialized = serializeFullAsciiBattlefieldMap(map, { pretty });
  const bytes = measureFullAsciiBattlefieldMapBytes(map, { pretty: false });
  const est = estimateRelayBytesWithFullAscii(tactical, map);

  if (outPath) {
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(path.resolve(outPath), `${serialized}\n`, 'utf8');
  } else {
    process.stdout.write(serialized);
    if (!serialized.endsWith('\n')) process.stdout.write('\n');
  }

  process.stderr.write(
    `full-ascii-battlefield: ${bytes} bytes compact; hypothetical relay with full map: ${est.withFullAsciiBytes} bytes (shrink-only base ${est.relayAfterShrinkBytes})\n`,
  );
}

main();
