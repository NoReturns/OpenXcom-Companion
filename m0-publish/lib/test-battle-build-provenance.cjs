'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BUILD_DIR_NAME = 'build-isolated-m1-h1-provenance';
const BUILD_CONFIG = 'Release|Win32';
const MANIFEST_SCHEMA = 2;

/** Source files whose presence/content defines WP6–WP9 engine export surface. */
const SOURCE_FINGERPRINTS = [
  'src/Engine/CompanionPerceptionLog.cpp',
  'src/Engine/CompanionPerceptionLogCore.cpp',
  'src/Engine/CompanionSnapshotTerrainSemanticsSparse.cpp',
  'src/Engine/CompanionSnapshotTerrain.cpp',
  'src/Engine/CompanionSnapshotGroundItems.cpp',
  'src/Engine/CompanionGroundItemMemory.cpp',
  'src/test/companion_ground_item_test.cpp',
  'src/test/companion_snapshot_serialization_test.cpp',
];

const EXECUTABLE_STRING_MARKERS = [
  'groundItems',
  'sparse-v2',
  'projectile_direction_observed',
  'perceptionLog',
  'soldier_panicked_observed',
  'psi_morale_attack_observed',
];

function resolveRepoRoot(fromDir = __dirname) {
  return path.resolve(fromDir, '../../..');
}

function openXcomRoot(repoRoot = resolveRepoRoot()) {
  return path.join(repoRoot, 'engine', 'OpenXcom');
}

function provenanceBuildLayout(repoRoot = resolveRepoRoot()) {
  const ox = openXcomRoot(repoRoot);
  const dataDir = path.join(ox, BUILD_DIR_NAME, 'bin');
  return {
    repoRoot: path.resolve(repoRoot),
    openXcomRoot: ox,
    buildDirectory: path.join(ox, BUILD_DIR_NAME),
    dataDirectory: dataDir,
    executablePath: path.join(dataDir, 'Release', 'openxcom.exe'),
    testBinaryDirectory: path.join(dataDir, 'Release'),
  };
}

function sha256FileHex(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toLowerCase();
}

function sha256Utf8(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').toLowerCase();
}

function collectSourceFingerprints(openXcomRootPath) {
  const files = [];
  for (const rel of SOURCE_FINGERPRINTS) {
    const abs = path.join(openXcomRootPath, rel);
    if (!fs.existsSync(abs)) {
      files.push({ relativePath: rel, exists: false, sha256: null });
      continue;
    }
    files.push({
      relativePath: rel,
      exists: true,
      sha256: sha256FileHex(abs),
      sizeBytes: fs.statSync(abs).size,
      mtimeMs: fs.statSync(abs).mtimeMs,
    });
  }
  const composite = sha256Utf8(
    files
      .map((f) => `${f.relativePath}:${f.exists ? f.sha256 : 'MISSING'}`)
      .join('\n'),
  );
  return { files, compositeSha256: composite };
}

function readGitProvenance(cwd) {
  const run = (args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.status !== 0) {
      return { ok: false, value: (r.stderr || r.stdout || '').trim() };
    }
    return { ok: true, value: (r.stdout || '').trim() };
  };
  const head = run(['rev-parse', 'HEAD']);
  const describe = run(['describe', '--always', '--dirty']);
  const status = run(['status', '--porcelain']);
  const dirtyLines = head.ok && status.ok ? status.value.split('\n').filter(Boolean) : [];
  return {
    available: head.ok,
    head: head.ok ? head.value : null,
    describe: describe.ok ? describe.value : null,
    dirty: dirtyLines.length > 0,
    dirtyLineCount: dirtyLines.length,
    dirtyPathsSample: dirtyLines.slice(0, 20),
  };
}

function probeExecutableMarkers(executablePath) {
  if (!fs.existsSync(executablePath)) {
    return { ok: false, markers: {}, error: 'executable missing' };
  }
  const ascii = fs.readFileSync(executablePath).toString('latin1');
  const markers = {};
  for (const m of EXECUTABLE_STRING_MARKERS) {
    markers[m] = ascii.includes(m);
  }
  const ok = Object.values(markers).every(Boolean);
  return { ok, markers };
}

function listCompanionCppTests(testBinaryDirectory) {
  if (!fs.existsSync(testBinaryDirectory)) {
    return [];
  }
  return fs
    .readdirSync(testBinaryDirectory)
    .filter((name) => /^companion_.*_test\.exe$/i.test(name))
    .sort();
}

function runCompanionCppTests(testBinaryDirectory) {
  const names = listCompanionCppTests(testBinaryDirectory);
  const results = [];
  for (const name of names) {
    const exe = path.join(testBinaryDirectory, name);
    const started = Date.now();
    const proc = spawnSync(exe, [], { encoding: 'utf8', cwd: testBinaryDirectory });
    results.push({
      name,
      ok: proc.status === 0,
      exitCode: proc.status ?? -1,
      durationMs: Date.now() - started,
      tail: (proc.stdout || proc.stderr || '').trim().split('\n').slice(-1)[0] ?? '',
    });
  }
  const passed = results.filter((r) => r.ok).length;
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    ok: passed === results.length && results.length > 0,
    results,
  };
}

function buildProvenanceManifest(repoRoot, options = {}) {
  const layout = provenanceBuildLayout(repoRoot);
  const fingerprints = collectSourceFingerprints(layout.openXcomRoot);
  const git = readGitProvenance(layout.openXcomRoot);
  const exeProbe = probeExecutableMarkers(layout.executablePath);
  const cppTests = options.cppTests
    ?? (options.runCppTests ? runCompanionCppTests(layout.testBinaryDirectory) : null);

  let executableSha256 = null;
  let executableMtime = null;
  if (fs.existsSync(layout.executablePath)) {
    executableSha256 = sha256FileHex(layout.executablePath);
    executableMtime = fs.statSync(layout.executablePath).mtime.toISOString();
  }

  return {
    schemaVersion: MANIFEST_SCHEMA,
    purpose: 'M1-H1A New Battle harness build provenance (WP1–WP9)',
    buildDirectoryName: BUILD_DIR_NAME,
    buildConfiguration: BUILD_CONFIG,
    recordedAt: new Date().toISOString(),
    executablePath: layout.executablePath,
    dataDirectory: layout.dataDirectory,
    executableSha256,
    executableMtime,
    executableMarkerProbe: exeProbe,
    sourceFingerprints: fingerprints,
    git,
    cppTests,
    nodeTests: options.nodeTests ?? null,
    priorHarnessExecutable: options.priorHarnessExecutable ?? {
      path: path.join(layout.openXcomRoot, 'build-isolated-m1-23e', 'bin', 'Release', 'openxcom.exe'),
      note: 'Legacy directory name; do not trust without fingerprint match.',
    },
  };
}

function verifyManifestAgainstWorkspace(manifest, repoRoot = resolveRepoRoot()) {
  const errors = [];
  const warnings = [];
  const layout = provenanceBuildLayout(repoRoot);
  const current = collectSourceFingerprints(layout.openXcomRoot);

  if (!manifest) {
    errors.push('Build provenance manifest is missing.');
    return { ok: false, errors, warnings };
  }

  if (manifest.sourceFingerprints?.compositeSha256 !== current.compositeSha256) {
    errors.push(
      'Source fingerprint composite mismatch: executable was built from different engine sources than the current tree.',
    );
  }

  if (!fs.existsSync(layout.executablePath)) {
    errors.push(`Verified executable not found: ${layout.executablePath}`);
  } else if (manifest.executableSha256) {
    const liveSha = sha256FileHex(layout.executablePath);
    if (liveSha !== manifest.executableSha256) {
      errors.push(`Executable SHA-256 mismatch (manifest ${manifest.executableSha256} vs disk ${liveSha}).`);
    }
  }

  const probe = probeExecutableMarkers(layout.executablePath);
  if (!probe.ok) {
    errors.push(`Executable missing WP6–WP9 string markers: ${JSON.stringify(probe.markers)}`);
  }

  if (manifest.cppTests && !manifest.cppTests.ok) {
    warnings.push('Manifest records failing C++ companion tests; rebuild and re-record provenance.');
  }

  if (manifest.git?.dirty) {
    warnings.push(`Engine git tree was dirty when manifest was recorded (${manifest.git.dirtyLineCount} paths).`);
  }

  return { ok: errors.length === 0, errors, warnings, currentSourceComposite: current.compositeSha256 };
}

module.exports = {
  BUILD_DIR_NAME,
  BUILD_CONFIG,
  SOURCE_FINGERPRINTS,
  EXECUTABLE_STRING_MARKERS,
  provenanceBuildLayout,
  collectSourceFingerprints,
  buildProvenanceManifest,
  verifyManifestAgainstWorkspace,
  probeExecutableMarkers,
  runCompanionCppTests,
  sha256FileHex,
};
