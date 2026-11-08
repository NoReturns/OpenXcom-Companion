'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  buildProvenanceManifest,
  provenanceBuildLayout,
  runCompanionCppTests,
  probeExecutableMarkers,
} = require('../lib/test-battle-build-provenance.cjs');
const { testBattleHarnessLayout, ensureHarnessDirectories } = require('../lib/test-battle-harness-layout.cjs');

function parseArgs(argv) {
  const out = { repoRoot: null, skipNode: false };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--repo' && argv[i + 1]) out.repoRoot = argv[++i];
    else if (argv[i] === '--skip-node') out.skipNode = true;
    else if (argv[i] === '--help' || argv[i] === '-h') out.help = true;
  }
  return out;
}

function runNodeSuite(repoRoot) {
  const script = path.join(repoRoot, 'companion', 'm0-publish', 'scripts', 'run-all-node-tests.cjs');
  const started = Date.now();
  const proc = spawnSync(process.execPath, [script], {
    cwd: path.join(repoRoot, 'companion', 'm0-publish'),
    encoding: 'utf8',
  });
  const combined = `${proc.stdout || ''}\n${proc.stderr || ''}`;
  const passMatch = combined.match(/ℹ pass (\d+)/);
  const failMatch = combined.match(/ℹ fail (\d+)/);
  return {
    ok: proc.status === 0,
    exitCode: proc.status ?? -1,
    durationMs: Date.now() - started,
    pass: passMatch ? Number(passMatch[1]) : null,
    fail: failMatch ? Number(failMatch[1]) : null,
  };
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: node record-test-battle-build-provenance.cjs [--skip-node]');
    process.exit(0);
  }

  const repoRoot = args.repoRoot ?? path.resolve(__dirname, '../../..');
  const layout = provenanceBuildLayout(repoRoot);
  const harness = testBattleHarnessLayout(repoRoot);
  ensureHarnessDirectories(harness);

  const probe = probeExecutableMarkers(layout.executablePath);
  if (!probe.ok) {
    console.error(`Executable failed WP marker probe: ${JSON.stringify(probe)}`);
    console.error(`Build first: cmake --build ${layout.buildDirectory} --config Release --target openxcom`);
    process.exit(2);
  }

  const cppTests = runCompanionCppTests(layout.testBinaryDirectory);
  if (!cppTests.ok) {
    console.error('Companion C++ tests failed; manifest not recorded.');
    console.error(JSON.stringify(cppTests, null, 2));
    process.exit(2);
  }

  let nodeTests = null;
  if (!args.skipNode) {
    nodeTests = runNodeSuite(repoRoot);
    if (!nodeTests.ok) {
      console.error('Node test suite failed; manifest not recorded.');
      process.exit(2);
    }
  }

  const manifest = buildProvenanceManifest(repoRoot, { runCppTests: false, cppTests, nodeTests });
  const outPath = path.join(harness.configDir, 'build-provenance-manifest.json');
  fs.writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ ok: true, manifestPath: outPath, executableSha256: manifest.executableSha256 }, null, 2));
}

if (require.main === module) {
  main();
}
