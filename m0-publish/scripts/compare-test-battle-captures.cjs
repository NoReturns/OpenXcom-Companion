'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { testBattleHarnessLayout, ensureHarnessDirectories } = require('../lib/test-battle-harness-layout.cjs');
const { compareCaptures, comparisonToMarkdown } = require('../lib/test-battle-capture-compare.cjs');

function parseArgs(argv) {
  const out = { repoRoot: null, jsonOut: null, mdOut: null, latestPerStage: true };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--repo' && argv[i + 1]) out.repoRoot = argv[++i];
    else if (arg === '--json-out' && argv[i + 1]) out.jsonOut = argv[++i];
    else if (arg === '--md-out' && argv[i + 1]) out.mdOut = argv[++i];
    else if (arg === '--all-captures') out.latestPerStage = false;
    else if (arg === '--help' || arg === '-h') out.help = true;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: node compare-test-battle-captures.cjs [--json-out path] [--md-out path] [--all-captures]');
    process.exit(0);
  }

  const layout = testBattleHarnessLayout(args.repoRoot ?? undefined);
  ensureHarnessDirectories(layout);

  const result = compareCaptures(layout.capturesDir, { latestPerStage: args.latestPerStage });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = args.jsonOut
    ? path.resolve(args.jsonOut)
    : path.join(layout.reportsDir, `compare-A-E-${stamp}.json`);
  const mdPath = args.mdOut
    ? path.resolve(args.mdOut)
    : path.join(layout.reportsDir, `compare-A-E-${stamp}.md`);

  fs.writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  fs.writeFileSync(mdPath, `${comparisonToMarkdown(result)}\n`, 'utf8');

  console.log(JSON.stringify({ ok: true, jsonPath, mdPath, highlightCount: result.highlights.length }, null, 2));
}

if (require.main === module) {
  main();
}
