'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_EXE = path.resolve(
  __dirname,
  '../../../engine/OpenXcom/build-isolated-m1-h1-provenance/bin/Release/openxcom.exe',
);

/** Strings that must appear in the isolated Release game binary for WP6 + WP6-PSY-1. */
const REQUIRED_MARKERS = [
  'perceptionLog',
  'projectile_direction_observed',
  'soldier_panicked_observed',
  'psi_morale_attack_observed',
];

function probeExecutable(executablePath) {
  if (!fs.existsSync(executablePath)) {
    return { ok: false, executablePath, error: 'executable missing', markers: {} };
  }
  const ascii = fs.readFileSync(executablePath).toString('latin1');
  const markers = {};
  for (const m of REQUIRED_MARKERS) {
    markers[m] = ascii.includes(m);
  }
  const ok = Object.values(markers).every(Boolean);
  return {
    ok,
    executablePath,
    executableMtime: fs.statSync(executablePath).mtime.toISOString(),
    markers,
  };
}

function main() {
  const exeArg = process.argv.find((a) => a.startsWith('--exe='));
  const executablePath = exeArg ? exeArg.slice('--exe='.length) : DEFAULT_EXE;
  const result = probeExecutable(path.resolve(executablePath));
  if (result.error) {
    console.error(result.error, result.executablePath);
    process.exit(2);
  }
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    const missing = Object.entries(result.markers)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    console.error(
      `Executable is missing WP6-PSY-1 markers: ${missing.join(', ')}. Rebuild openxcom.vcxproj Release (not only companion_*_test.exe).`,
    );
    process.exit(1);
  }
}

main();
