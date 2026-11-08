'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { companionRuntimeLayout } = require('./companion-canonical-runtime.cjs');

function assertPathNotEqual(label, left, right) {
  const a = path.resolve(String(left));
  const b = path.resolve(String(right));
  if (a.toLowerCase() === b.toLowerCase()) {
    throw new Error(`${label} must not equal production path: ${a}`);
  }
}

function prepareIsolatedUserDir(sourceUserDir, destUserDir) {
  const src = path.resolve(sourceUserDir);
  const dest = path.resolve(destUserDir);
  if (!fs.existsSync(src)) {
    throw new Error(`Isolated user seed missing: ${src}`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
  }
  fs.cpSync(src, dest, { recursive: true });
  return dest;
}

function assertEngineRuntimeIsolation({
  repoRoot,
  isolatedRoot,
  isolatedSnapshotPath,
  isolatedUserDir,
}) {
  const layout = companionRuntimeLayout(repoRoot);
  assertPathNotEqual('isolated snapshot', isolatedSnapshotPath, layout.snapshotYaml);
  assertPathNotEqual('isolated user dir', isolatedUserDir, layout.userDir);

  const resolvedUser = path.resolve(isolatedUserDir);
  const resolvedSnapshotDir = path.resolve(path.dirname(isolatedSnapshotPath));
  if (resolvedSnapshotDir.toLowerCase() === path.resolve(layout.snapshotDir).toLowerCase()) {
    throw new Error('isolated snapshot directory must not be production local/m0');
  }
  if (path.resolve(isolatedRoot).toLowerCase() === path.resolve(layout.snapshotDir).toLowerCase()) {
    throw new Error('isolated workspace root must not be production local/m0');
  }

  return {
    runtimeExe: layout.runtimeExe,
    runtimeBin: layout.runtimeBin,
    productionUserDir: layout.userDir,
    productionSnapshotPath: layout.snapshotYaml,
    isolatedUserDir: resolvedUser,
    isolatedSnapshotPath: path.resolve(isolatedSnapshotPath),
    openXcomArgs: [
      '-data', layout.runtimeBin,
      '-user', resolvedUser,
      '-config', resolvedUser,
    ],
  };
}

module.exports = {
  assertPathNotEqual,
  prepareIsolatedUserDir,
  assertEngineRuntimeIsolation,
};
