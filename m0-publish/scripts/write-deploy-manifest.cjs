'use strict';

const fs = require('node:fs');
const {
  companionRuntimeLayout,
  sha256FileHex,
  buildDeployManifest,
} = require('../lib/companion-canonical-runtime.cjs');

function main() {
  const repoRoot = process.argv[2];
  const sourceExe = process.argv[3];
  if (!repoRoot || !sourceExe) {
    console.error('usage: write-deploy-manifest.cjs <repoRoot> <sourceExe>');
    process.exit(1);
  }
  const layout = companionRuntimeLayout(repoRoot);
  const stat = fs.statSync(layout.runtimeExe);
  // Records the post-copy runtime exe bytes; after a normal deploy that exe matches VERIFIED_BUILD_SHA256 in companion-canonical-runtime.cjs.
  const sha = sha256FileHex(layout.runtimeExe);
  const doc = buildDeployManifest({
    sha256: sha,
    sourceExe,
    sizeBytes: stat.size,
    deployedAtIso: new Date().toISOString(),
  });
  fs.writeFileSync(layout.deployManifest, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(doc));
}

if (require.main === module) {
  main();
}

module.exports = { main };
