'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  testBattleHarnessLayout,
  resolveStage,
  assertProductionIsolation,
  ensureHarnessDirectories,
  sha256FileHex,
} = require('../lib/test-battle-harness-layout.cjs');
const { verifySnapshotFile } = require('../lib/test-battle-snapshot-verifier.cjs');

function parseArgs(argv) {
  const out = { repoRoot: null, stage: null, label: null, force: false, maxStaleSec: 3600 };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--repo' && argv[i + 1]) {
      out.repoRoot = argv[++i];
    } else if (arg === '--stage' && argv[i + 1]) {
      out.stage = argv[++i];
    } else if (arg === '--label' && argv[i + 1]) {
      out.label = argv[++i];
    } else if (arg === '--force') {
      out.force = true;
    } else if (arg === '--max-stale-sec' && argv[i + 1]) {
      out.maxStaleSec = Number(argv[++i]);
    } else if (arg === '--help' || arg === '-h') {
      out.help = true;
    }
  }
  return out;
}

function usage() {
  return `Usage: node capture-test-battle-stage.cjs --stage A|B|C|D|E [--label name] [--force]

Captures the current harness tactical-live.yaml after validating a successful export.
Does not assume F6 succeeded — rejects missing, empty, invalid, or stale snapshots.

Stages:
  A  Initial deployment
  B  Hull observed
  C  Entrance observed
  D  Interior explored
  E  Multiple levels explored
`;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.stage) {
    console.log(usage());
    process.exit(args.stage ? 0 : 1);
  }

  const layout = testBattleHarnessLayout(args.repoRoot ?? undefined);
  assertProductionIsolation(layout, { snapshotPath: layout.liveSnapshotYaml });
  ensureHarnessDirectories(layout);

  const stage = resolveStage(args.stage);
  const livePath = layout.liveSnapshotYaml;

  if (!fs.existsSync(livePath)) {
    console.error(`No live snapshot at ${livePath}. Press F6 in battlescape after a successful export.`);
    process.exit(2);
  }

  const stat = fs.statSync(livePath);
  if (stat.size === 0) {
    console.error('Live snapshot file is empty.');
    process.exit(2);
  }

  const ageSec = (Date.now() - stat.mtimeMs) / 1000;
  if (ageSec > args.maxStaleSec) {
    console.error(
      `Live snapshot is ${Math.round(ageSec)}s old (max ${args.maxStaleSec}s). Export again with F6 before capture.`,
    );
    process.exit(2);
  }

  const verify = verifySnapshotFile(livePath);
  if (!verify.ok) {
    console.error('Live snapshot failed validation; F6 export did not produce a usable tactical snapshot.');
    for (const e of verify.errors) console.error(`  - ${e}`);
    process.exit(2);
  }

  const captureId = new Date().toISOString().replace(/[:.]/g, '-');
  const stageDirName = `${stage.id}-${stage.slug}`;
  const captureRoot = path.join(layout.capturesDir, stageDirName, captureId);
  const labelPath = args.label
    ? path.join(layout.capturesDir, stageDirName, `.label-${args.label}`)
    : null;

  if (labelPath && fs.existsSync(labelPath) && !args.force) {
    console.error(`Duplicate capture label "${args.label}" for stage ${stage.id}. Use --force to allow.`);
    process.exit(3);
  }

  fs.mkdirSync(captureRoot, { recursive: true });

  const yamlDest = path.join(captureRoot, 'tactical.yaml');
  fs.copyFileSync(livePath, yamlDest);
  const yamlSha256 = sha256FileHex(yamlDest);
  const yamlSize = fs.statSync(yamlDest).size;

  const meta = {
    schemaVersion: 1,
    stageId: stage.id,
    stageSlug: stage.slug,
    stageTitle: stage.title,
    captureId,
    label: args.label ?? null,
    capturedAt: new Date().toISOString(),
    sourceLiveSnapshot: livePath,
    sourceLiveMtime: stat.mtime.toISOString(),
    file: {
      name: 'tactical.yaml',
      sizeBytes: yamlSize,
      sha256: yamlSha256,
    },
    tactical: verify.tactical,
    sessionId: verify.sessionIdentity?.unifiedSessionId ?? null,
    validation: { ok: verify.ok, warnings: verify.warnings },
  };

  fs.writeFileSync(path.join(captureRoot, 'capture-meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  if (labelPath) {
    fs.writeFileSync(labelPath, `${captureId}\n`, 'utf8');
  }

  console.log(JSON.stringify({ ok: true, captureDir: captureRoot, meta }, null, 2));
}

if (require.main === module) {
  main();
}
