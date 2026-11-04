'use strict';

const path = require('node:path');
const {
  companionRuntimeLayout,
  resolveBuildReleaseExe,
  sha256FileHex,
  VERIFIED_BUILD_SHA256,
  assessDeployReadiness,
} = require('../lib/companion-canonical-runtime.cjs');

const repoRoot = path.resolve(__dirname, '../../..');
const layout = companionRuntimeLayout(repoRoot);
const buildExe = resolveBuildReleaseExe(layout);
const buildSha256 = buildExe ? sha256FileHex(buildExe) : null;
const readiness = assessDeployReadiness({
  buildExePath: buildExe,
  buildSha256,
  runtimeExePath: layout.runtimeExe,
  runtimeBin: layout.runtimeBin,
  openXcomRunning: false,
});

const result = {
  buildExe,
  buildSha256,
  verifiedBuildSha256: VERIFIED_BUILD_SHA256,
  deployScriptHashGateOk: buildSha256 === VERIFIED_BUILD_SHA256,
  assessDeployReadiness: readiness,
};

console.log(JSON.stringify(result, null, 2));
process.exit(result.deployScriptHashGateOk && buildExe ? 0 : 1);
