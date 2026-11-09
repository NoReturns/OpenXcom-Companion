'use strict';

/**
 * Resolve isolated OpenXcom companion harness executables under engine/OpenXcom/build-*.
 * Matches MSVC OutDir layout (bin/<Configuration>/). Does not search PATH or runtime/m0.
 */

const fs = require('node:fs');
const path = require('node:path');

const BUILD_TREE_NAMES = [
  'build-wp8-isolated',
  'build-isolated-m1-23e',
];

/** Preferred first — matches operator MSBuild docs and companion-canonical-runtime.cjs */
const WIN32_CONFIGURATIONS = [
  'Release',
  'Debug',
  'RelWithDebInfo',
  'MinSizeRel',
];

function resolveRepoRootFromTestHelper() {
  return path.resolve(__dirname, '../../../..');
}

/**
 * @param {string} exeBaseName e.g. companion_command_test.exe
 * @param {{ repoRoot?: string }} [options]
 * @returns {string[]} ordered candidate absolute paths (may not exist)
 */
function listCompanionEngineHarnessCandidates(exeBaseName, options = {}) {
  if (typeof exeBaseName !== 'string' || !exeBaseName.endsWith('.exe')) {
    throw new Error('exeBaseName must end with .exe');
  }
  const repoRoot = path.resolve(options.repoRoot ?? resolveRepoRootFromTestHelper());
  const engineRoot = path.join(repoRoot, 'engine', 'OpenXcom');
  const out = [];
  for (const tree of BUILD_TREE_NAMES) {
    for (const config of WIN32_CONFIGURATIONS) {
      out.push(path.join(engineRoot, tree, 'bin', config, exeBaseName));
    }
  }
  return out;
}

/**
 * @param {string} exeBaseName
 * @param {{ repoRoot?: string }} [options]
 * @returns {{ executablePath: string, buildTree: string, configuration: string } | null}
 */
function resolveCompanionEngineHarness(exeBaseName, options = {}) {
  const candidates = listCompanionEngineHarnessCandidates(exeBaseName, options);
  for (const executablePath of candidates) {
    if (!fs.existsSync(executablePath)) {
      continue;
    }
    const stat = fs.statSync(executablePath);
    if (!stat.isFile()) {
      continue;
    }
    const parts = executablePath.split(path.sep);
    const config = parts[parts.length - 2];
    const buildTree = parts[parts.length - 4];
    return { executablePath, buildTree, configuration: config };
  }
  return null;
}

module.exports = {
  BUILD_TREE_NAMES,
  WIN32_CONFIGURATIONS,
  resolveRepoRootFromTestHelper,
  listCompanionEngineHarnessCandidates,
  resolveCompanionEngineHarness,
};
