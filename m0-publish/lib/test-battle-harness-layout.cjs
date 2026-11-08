'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  provenanceBuildLayout,
  verifyManifestAgainstWorkspace,
  BUILD_DIR_NAME,
} = require('./test-battle-build-provenance.cjs');

const STAGE_DEFINITIONS = Object.freeze({
  A: { id: 'A', slug: 'initial-deployment', title: 'Initial deployment' },
  B: { id: 'B', slug: 'hull-observed', title: 'Hull observed' },
  C: { id: 'C', slug: 'entrance-observed', title: 'Entrance observed' },
  D: { id: 'D', slug: 'interior-explored', title: 'Interior explored' },
  E: { id: 'E', slug: 'multi-level-explored', title: 'Multiple levels explored' },
});

const REQUIRED_RUNTIME_DLLS = [
  'SDL.dll',
  'SDL_image.dll',
  'SDL_mixer.dll',
  'SDL_gfx.dll',
  'yaml-cpp.dll',
  'zlib1.dll',
];

function resolveRepoRoot(fromDir = __dirname) {
  return path.resolve(fromDir, '../../..');
}

function testBattleHarnessLayout(repoRoot = resolveRepoRoot()) {
  const root = path.resolve(repoRoot);
  const harnessRoot = path.join(root, 'local', 'm0', 'test-battle-harness');
  const provenance = provenanceBuildLayout(root);
  return {
    repoRoot: root,
    harnessRoot,
    userDir: path.join(harnessRoot, 'user'),
    configDir: path.join(harnessRoot, 'config'),
    snapshotsDir: path.join(harnessRoot, 'snapshots'),
    liveSnapshotYaml: path.join(harnessRoot, 'snapshots', 'tactical-live.yaml'),
    capturesDir: path.join(harnessRoot, 'captures'),
    reportsDir: path.join(harnessRoot, 'reports'),
    logsDir: path.join(harnessRoot, 'logs'),
    battleCfgPath: path.join(harnessRoot, 'user', 'battle.cfg'),
    buildProvenanceManifestPath: path.join(harnessRoot, 'config', 'build-provenance-manifest.json'),
    buildDirectoryName: BUILD_DIR_NAME,
    buildDataDir: provenance.dataDirectory,
    buildExe: provenance.executablePath,
    production: {
      userDir: path.join(root, 'local', 'm0', 'user'),
      snapshotYaml: path.join(root, 'local', 'm0', 'tactical-live.yaml'),
      snapshotDir: path.join(root, 'local', 'm0'),
    },
  };
}

function sha256FileHex(filePath, readFileSync = fs.readFileSync) {
  const data = readFileSync(filePath);
  return crypto.createHash('sha256').update(data).digest('hex').toLowerCase();
}

function normalizePathForCompare(p) {
  return path.resolve(p).replace(/\\/g, '/').toLowerCase();
}

function pathsEqual(a, b) {
  return normalizePathForCompare(a) === normalizePathForCompare(b);
}

function pathIsInside(child, parent) {
  const c = normalizePathForCompare(child);
  const p = normalizePathForCompare(parent);
  return c === p || c.startsWith(`${p}/`);
}

/**
 * Refuse launch when harness paths overlap production companion directories.
 */
function assertProductionIsolation(layout, options = {}) {
  const errors = [];
  const { userDir, liveSnapshotYaml, harnessRoot } = layout;
  const prod = layout.production;

  if (pathsEqual(userDir, prod.userDir)) {
    errors.push('Harness user directory equals production user directory.');
  }
  if (pathsEqual(liveSnapshotYaml, prod.snapshotYaml)) {
    errors.push('Harness snapshot path equals production tactical-live.yaml.');
  }
  if (pathIsInside(userDir, prod.userDir) || pathIsInside(prod.userDir, userDir)) {
    errors.push('Harness user directory overlaps production user directory.');
  }
  if (pathIsInside(liveSnapshotYaml, prod.snapshotDir) && !pathIsInside(harnessRoot, prod.snapshotDir)) {
    errors.push('Harness snapshot path is under production local/m0 without harness containment.');
  }
  if (pathIsInside(harnessRoot, prod.userDir)) {
    errors.push('Harness root is inside production user directory.');
  }

  if (options.snapshotPath) {
    const snap = path.resolve(options.snapshotPath);
    if (pathsEqual(snap, prod.snapshotYaml)) {
      errors.push('Requested snapshot path is the production tactical-live.yaml.');
    }
  }

  if (errors.length) {
    const err = new Error(errors.join(' '));
    err.code = 'PRODUCTION_PATH_OVERLAP';
    err.details = errors;
    throw err;
  }
}

function checkBuildExecutable(layout, existsSync = fs.existsSync) {
  const missing = [];
  if (!existsSync(layout.buildExe)) {
    missing.push(`Missing executable: ${layout.buildExe}`);
  }
  for (const dll of REQUIRED_RUNTIME_DLLS) {
    const full = path.join(layout.buildDataDir, dll);
    if (!existsSync(full)) {
      missing.push(`Missing runtime DLL: ${full}`);
    }
  }
  return missing;
}

function readBuildProvenanceManifest(layout, existsSync = fs.existsSync, readFileSync = fs.readFileSync) {
  if (!existsSync(layout.buildProvenanceManifestPath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(layout.buildProvenanceManifestPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Require a recorded build provenance manifest that matches current engine fingerprints and exe hash.
 */
function assertBuildProvenanceVerified(layout, repoRoot = layout.repoRoot) {
  const manifest = readBuildProvenanceManifest(layout);
  if (!manifest) {
    const err = new Error(
      `Missing ${layout.buildProvenanceManifestPath}. Run: node companion/m0-publish/scripts/record-test-battle-build-provenance.cjs`,
    );
    err.code = 'BUILD_PROVENANCE_MISSING';
    throw err;
  }
  const verification = verifyManifestAgainstWorkspace(manifest, repoRoot);
  if (!verification.ok) {
    const err = new Error(verification.errors.join(' '));
    err.code = 'BUILD_PROVENANCE_STALE';
    err.details = verification;
    throw err;
  }
  return { manifest, verification };
}

function resolveStage(stageArg) {
  const key = String(stageArg || '').trim().toUpperCase();
  const stage = STAGE_DEFINITIONS[key];
  if (!stage) {
    const err = new Error(`Unknown stage "${stageArg}". Use A, B, C, D, or E.`);
    err.code = 'UNKNOWN_STAGE';
    throw err;
  }
  return stage;
}

function ensureHarnessDirectories(layout, mkdirSync = fs.mkdirSync) {
  for (const dir of [
    layout.harnessRoot,
    layout.userDir,
    layout.configDir,
    layout.snapshotsDir,
    layout.capturesDir,
    layout.reportsDir,
    layout.logsDir,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}

module.exports = {
  STAGE_DEFINITIONS,
  REQUIRED_RUNTIME_DLLS,
  resolveRepoRoot,
  testBattleHarnessLayout,
  sha256FileHex,
  assertProductionIsolation,
  checkBuildExecutable,
  readBuildProvenanceManifest,
  assertBuildProvenanceVerified,
  resolveStage,
  ensureHarnessDirectories,
  pathsEqual,
  pathIsInside,
};
