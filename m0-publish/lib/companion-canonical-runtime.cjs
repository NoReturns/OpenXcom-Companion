'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 1;

/**
 * Single source of truth for deploy + launcher SHA-256 gate (`deploy-openxcom.ps1`,
 * `Start-CompanionOpenXcom.ps1`, `verify-deploy-hash-gate.cjs`). When promoting a new
 * verified isolated Win32 Release binary, set this to the lowercase SHA-256 of that
 * `openxcom.exe` and commit together with any doc updates — do not deploy a build whose
 * hash is not reflected here.
 *
 * Verified Win32 Release build (ASTER-M1-STRATEGIC-INTEL-RC-01: combined strategic export
 * corrections + purchasing catalog; built from 581b66428 + release checkpoint c059e23ab).
 */
const VERIFIED_BUILD_SHA256 = '3a92d0b0db7668e578fc406f30efcdbda74cbefc278ef1a9bc9dfd641a716476';

const TERMINAL_RESULT_STATUSES = new Set(['REJECTED', 'COMPLETED', 'INTERRUPTED', 'FAILED']);

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

function companionRuntimeLayout(repoRoot = resolveRepoRoot()) {
  const root = path.resolve(repoRoot);
  return {
    repoRoot: root,
    buildReleaseExe: path.join(
      root,
      'engine',
      'OpenXcom',
      'build-isolated-m1-23e',
      'bin',
      'Release',
      'openxcom.exe',
    ),
    buildReleaseExeAlt: path.join(
      root,
      'engine',
      'OpenXcom',
      'build-wp8-isolated',
      'bin',
      'Release',
      'openxcom.exe',
    ),
    runtimeBin: path.join(root, 'runtime', 'm0', 'bin'),
    runtimeExe: path.join(root, 'runtime', 'm0', 'bin', 'openxcom.exe'),
    deployManifest: path.join(root, 'runtime', 'm0', 'bin', 'openxcom.deploy-manifest.json'),
    userDir: path.join(root, 'local', 'm0', 'user'),
    snapshotYaml: path.join(root, 'local', 'm0', 'tactical-live.yaml'),
    snapshotDir: path.join(root, 'local', 'm0'),
    tacticalCommand: path.join(root, 'local', 'm0', 'tactical-command.json'),
    tacticalResult: path.join(root, 'local', 'm0', 'tactical-result.json'),
    tacticalBackupsDir: path.join(root, 'local', 'm0', 'backups'),
  };
}

function sha256FileHex(filePath, readFileSync = fs.readFileSync) {
  const data = readFileSync(filePath);
  return crypto.createHash('sha256').update(data).digest('hex').toLowerCase();
}

function resolveBuildReleaseExe(layout, existsSync = fs.existsSync) {
  if (existsSync(layout.buildReleaseExe)) {
    return layout.buildReleaseExe;
  }
  if (existsSync(layout.buildReleaseExeAlt)) {
    return layout.buildReleaseExeAlt;
  }
  return null;
}

function checkRuntimeDllDependencies(runtimeBin, existsSync = fs.existsSync) {
  const missing = [];
  for (const name of REQUIRED_RUNTIME_DLLS) {
    const full = path.join(runtimeBin, name);
    if (!existsSync(full)) {
      missing.push(name);
    }
  }
  return { ok: missing.length === 0, missing };
}

function parseJsonFileIfExists(filePath, existsSync = fs.existsSync, readFileSync = fs.readFileSync) {
  if (!existsSync(filePath)) {
    return { exists: false, value: null, parseError: false };
  }
  try {
    return { exists: true, value: JSON.parse(readFileSync(filePath, 'utf8')), parseError: false };
  } catch {
    return { exists: true, value: null, parseError: true };
  }
}

function inboxBindingMatchesSnapshot(inbox, snapshotBinding) {
  if (!inbox || !snapshotBinding) {
    return true;
  }
  return inbox.session_id === snapshotBinding.sessionId
    && inbox.snapshot_sha256 === snapshotBinding.snapshotSha256
    && inbox.turn === snapshotBinding.turn
    && inbox.state_version === snapshotBinding.stateVersion;
}

function readSnapshotExportBinding(snapshotYamlPath, readFileSync, existsSync, sha256FileHex) {
  if (!existsSync(snapshotYamlPath)) {
    return null;
  }
  const text = readFileSync(snapshotYamlPath, 'utf8');
  const sessionMatch = text.match(/sessionId:\s*([a-f0-9]{32})/);
  const turnMatch = text.match(/^turn:\s*(\d+)\s*$/m);
  const latestMatch = text.match(/latestSeq:\s*(\d+)/);
  if (!sessionMatch || !turnMatch || !latestMatch) {
    return null;
  }
  return {
    sessionId: sessionMatch[1],
    turn: Number(turnMatch[1]),
    stateVersion: Number(latestMatch[1]),
    snapshotSha256: sha256FileHex(snapshotYamlPath, readFileSync),
  };
}

/**
 * Decide whether the engine inbox file must be quarantined before launch.
 * Preserves terminal results and archived inbox JSON; never deletes journals.
 */
function evaluateInboxQuarantine({
  inboxExists,
  resultExists,
  resultStatus,
  resultParseError,
  inboxValue,
  resultCommandId,
  snapshotBinding,
}) {
  if (!inboxExists) {
    return { action: 'none', reason: 'no_inbox' };
  }
  if (resultExists && (resultStatus === 'EXECUTING' || resultStatus === 'ACCEPTED')) {
    const inboxCommandId = inboxValue && typeof inboxValue.command_id === 'string'
      ? inboxValue.command_id
      : '';
    if (
      inboxCommandId
      && resultCommandId
      && inboxCommandId === resultCommandId
    ) {
      return {
        action: 'warn',
        reason: 'orphan_executing_resume',
        message:
          'non-terminal EXECUTING result matches local inbox; engine may close orphaned command on launch',
      };
    }
    return {
      action: 'block_launch',
      reason: 'non_terminal_result',
      message: `tactical-result.json status ${resultStatus} is not terminal`,
    };
  }
  if (snapshotBinding && inboxValue && !inboxBindingMatchesSnapshot(inboxValue, snapshotBinding)) {
    return {
      action: 'quarantine',
      reason: 'stale_binding',
      message: 'inbox quarantined: command binding does not match current tactical-live.yaml export',
    };
  }
  if (!resultExists) {
    return { action: 'warn', reason: 'inbox_without_result', message: 'tactical-command.json present without tactical-result.json' };
  }
  if (resultParseError) {
    return { action: 'warn', reason: 'result_unparseable', message: 'tactical-result.json is not valid JSON' };
  }
  if (resultStatus === 'EXECUTING' || resultStatus === 'ACCEPTED') {
    return {
      action: 'block_launch',
      reason: 'non_terminal_result',
      message: `tactical-result.json status ${resultStatus} is not terminal`,
    };
  }
  if (TERMINAL_RESULT_STATUSES.has(resultStatus)) {
    return {
      action: 'quarantine',
      reason: 'terminal_result',
      message: `inbox quarantined while preserving terminal result (${resultStatus})`,
    };
  }
  return { action: 'warn', reason: 'unknown_result_status', message: `unexpected result status ${resultStatus}` };
}

function assessDeployReadiness({
  buildExePath,
  buildSha256,
  runtimeExePath,
  runtimeBin,
  openXcomRunning,
  existsSync = fs.existsSync,
}) {
  const errors = [];
  if (openXcomRunning) {
    errors.push('OpenXcom process is running');
  }
  if (!buildExePath || !existsSync(buildExePath)) {
    errors.push('verified build Release executable missing');
  }
  if (buildSha256 !== VERIFIED_BUILD_SHA256) {
    errors.push(`build SHA-256 mismatch (got ${buildSha256 || 'unknown'}, expected ${VERIFIED_BUILD_SHA256})`);
  }
  const dll = checkRuntimeDllDependencies(runtimeBin, existsSync);
  if (!dll.ok) {
    errors.push(`missing runtime DLL(s): ${dll.missing.join(', ')}`);
  }
  if (!existsSync(runtimeExePath)) {
    errors.push('canonical runtime executable missing');
  }
  return { ok: errors.length === 0, errors, dll };
}

function buildDeployManifest({ sha256, sourceExe, sizeBytes, deployedAtIso }) {
  return {
    schema_version: SCHEMA_VERSION,
    sha256: sha256.toLowerCase(),
    source_exe: sourceExe,
    size_bytes: sizeBytes,
    deployed_at: deployedAtIso,
  };
}

/**
 * Hash gate for deploy/launcher scripts — compare on Node to avoid PowerShell stdout capture quirks.
 */
function verifyExecutableHashAgainstPin(exePath, readFileSync = fs.readFileSync, existsSync = fs.existsSync) {
  if (!exePath || !existsSync(exePath)) {
    return {
      ok: false,
      runtimeSha256: null,
      expectedSha256: VERIFIED_BUILD_SHA256,
      reason: 'missing_executable',
    };
  }
  const runtimeSha256 = sha256FileHex(exePath, readFileSync);
  return {
    ok: runtimeSha256 === VERIFIED_BUILD_SHA256,
    runtimeSha256,
    expectedSha256: VERIFIED_BUILD_SHA256,
    reason: runtimeSha256 === VERIFIED_BUILD_SHA256 ? null : 'sha256_mismatch',
  };
}

function assessLauncherReadiness({
  runtimeExePath,
  runtimeSha256,
  manifestSha256,
  snapshotPath,
  userDirPath,
  inboxDecision,
  existsSync = fs.existsSync,
}) {
  const errors = [];
  const warnings = [];
  if (!existsSync(runtimeExePath)) {
    errors.push('canonical openxcom.exe missing (run deploy-openxcom.ps1)');
  }
  if (runtimeSha256 !== VERIFIED_BUILD_SHA256) {
    errors.push(`runtime executable SHA-256 mismatch (got ${runtimeSha256 || 'unknown'})`);
  }
  if (manifestSha256 && manifestSha256 !== runtimeSha256) {
    warnings.push('deploy manifest SHA-256 does not match runtime executable');
  }
  if (!existsSync(snapshotPath)) {
    warnings.push('snapshot YAML missing (export with F6 before commands)');
  }
  if (!existsSync(userDirPath)) {
    errors.push('user data directory missing');
  }
  if (inboxDecision.action === 'block_launch') {
    errors.push(inboxDecision.message);
  }
  if (inboxDecision.action === 'warn') {
    warnings.push(inboxDecision.message);
  }
  return { ok: errors.length === 0, errors, warnings };
}

module.exports = {
  SCHEMA_VERSION,
  VERIFIED_BUILD_SHA256,
  TERMINAL_RESULT_STATUSES,
  REQUIRED_RUNTIME_DLLS,
  resolveRepoRoot,
  companionRuntimeLayout,
  sha256FileHex,
  resolveBuildReleaseExe,
  checkRuntimeDllDependencies,
  parseJsonFileIfExists,
  evaluateInboxQuarantine,
  inboxBindingMatchesSnapshot,
  readSnapshotExportBinding,
  assessDeployReadiness,
  buildDeployManifest,
  verifyExecutableHashAgainstPin,
  assessLauncherReadiness,
};
