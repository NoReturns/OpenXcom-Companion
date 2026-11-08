'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { testBattleHarnessLayout, ensureHarnessDirectories } = require('../lib/test-battle-harness-layout.cjs');
const { verifySnapshotFile, reportToMarkdown } = require('../lib/test-battle-snapshot-verifier.cjs');

function parseArgs(argv) {
  const out = { input: null, repoRoot: null, jsonOut: null, mdOut: null };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input' && argv[i + 1]) out.input = argv[++i];
    else if (arg === '--repo' && argv[i + 1]) out.repoRoot = argv[++i];
    else if (arg === '--json-out' && argv[i + 1]) out.jsonOut = argv[++i];
    else if (arg === '--md-out' && argv[i + 1]) out.mdOut = argv[++i];
    else if (arg === '--help' || arg === '-h') out.help = true;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.input) {
    console.log('Usage: node verify-test-battle-snapshot.cjs --input <tactical.yaml> [--json-out report.json] [--md-out report.md]');
    process.exit(args.input ? 0 : 1);
  }

  const layout = testBattleHarnessLayout(args.repoRoot ?? undefined);
  ensureHarnessDirectories(layout);

  const report = verifySnapshotFile(path.resolve(args.input));
  const jsonPath = args.jsonOut
    ? path.resolve(args.jsonOut)
    : path.join(layout.reportsDir, `verify-${path.basename(args.input, path.extname(args.input))}.json`);
  const mdPath = args.mdOut
    ? path.resolve(args.mdOut)
    : path.join(layout.reportsDir, `verify-${path.basename(args.input, path.extname(args.input))}.md`);

  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(mdPath, `${reportToMarkdown(report)}\n`, 'utf8');

  console.log(JSON.stringify({ ok: report.ok, jsonPath, mdPath }, null, 2));
  process.exit(report.ok ? 0 : 1);
}

if (require.main === module) {
  main();
}
