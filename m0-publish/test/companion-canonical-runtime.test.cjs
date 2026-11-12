'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  VERIFIED_BUILD_SHA256,
  companionRuntimeLayout,
  evaluateInboxQuarantine,
  assessDeployReadiness,
  assessLauncherReadiness,
  checkRuntimeDllDependencies,
  buildDeployManifest,
} = require('../lib/companion-canonical-runtime.cjs');

describe('companion canonical runtime (M1-25A)', () => {
  it('resolves canonical layout paths from repo root', () => {
    const repo = path.resolve(__dirname, '../../..');
    const layout = companionRuntimeLayout(repo);
    assert.match(layout.runtimeExe, /runtime[\\/]m0[\\/]bin[\\/]openxcom\.exe$/i);
    assert.match(layout.snapshotYaml, /local[\\/]m0[\\/]tactical-live\.yaml$/);
    assert.match(layout.userDir, /local[\\/]m0[\\/]user$/);
  });

  it('quarantines inbox when terminal result exists (failed KNEEL case)', () => {
    const decision = evaluateInboxQuarantine({
      inboxExists: true,
      resultExists: true,
      resultStatus: 'REJECTED',
      resultParseError: false,
    });
    assert.equal(decision.action, 'quarantine');
  });

  it('blocks launch on EXECUTING result when inbox command_id does not match', () => {
    const decision = evaluateInboxQuarantine({
      inboxExists: true,
      resultExists: true,
      resultStatus: 'EXECUTING',
      resultParseError: false,
      inboxValue: { command_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      resultCommandId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    });
    assert.equal(decision.action, 'block_launch');
  });

  it('allows launch for matching same-session orphan EXECUTING inbox (engine resume on first tick)', () => {
    const commandId = 'a7f0e2d51c9b4f8da65b30c192e74f06';
    const sessionId = 'c2c699950ddc838bfe4b37babc03967f';
    const decision = evaluateInboxQuarantine({
      inboxExists: true,
      resultExists: true,
      resultStatus: 'EXECUTING',
      resultParseError: false,
      inboxValue: { command_id: commandId, session_id: sessionId },
      resultCommandId: commandId,
      snapshotBinding: {
        sessionId,
        snapshotSha256: '223b701f353ebcaa309ece7a0be8a23fac33148b5a095dcc2f23fa11ee6cf',
        turn: 1,
        stateVersion: 0,
      },
    });
    assert.equal(decision.action, 'warn');
    assert.equal(decision.reason, 'orphan_executing_resume');
  });

  it('quarantines cross-session EXECUTING pair when snapshot session differs', () => {
    const commandId = 'aster-20261110-seppe-sectoid-auto-29';
    const decision = evaluateInboxQuarantine({
      inboxExists: true,
      resultExists: true,
      resultStatus: 'EXECUTING',
      resultParseError: false,
      inboxValue: {
        command_id: commandId,
        session_id: '112482ac508d5bc16dcde1470d197d09',
      },
      resultCommandId: commandId,
      snapshotBinding: {
        sessionId: 'c2c699950ddc838bfe4b37babc03967f',
        snapshotSha256: '223b701f353ebcaa309ece7a0be8a23fac33148b5a095dcc2f23fa11ee6cf',
        turn: 1,
        stateVersion: 0,
      },
    });
    assert.equal(decision.action, 'quarantine');
    assert.equal(decision.reason, 'stale_session_executing_orphan');
  });

  it('blocks launch when session identity for EXECUTING pair is ambiguous', () => {
    const commandId = 'a7f0e2d51c9b4f8da65b30c192e74f06';
    const decision = evaluateInboxQuarantine({
      inboxExists: true,
      resultExists: true,
      resultStatus: 'EXECUTING',
      resultParseError: false,
      inboxValue: { command_id: commandId, session_id: '112482ac508d5bc16dcde1470d197d09' },
      resultCommandId: commandId,
    });
    assert.equal(decision.action, 'block_launch');
    assert.equal(decision.reason, 'ambiguous_session_identity');
  });

  it('does not quarantine when inbox absent', () => {
    const decision = evaluateInboxQuarantine({
      inboxExists: false,
      resultExists: true,
      resultStatus: 'COMPLETED',
      resultParseError: false,
    });
    assert.equal(decision.action, 'none');
  });

  it('refuses deploy when OpenXcom is running', () => {
    const layout = companionRuntimeLayout(path.resolve(__dirname, '../../..'));
    const readiness = assessDeployReadiness({
      buildExePath: layout.buildReleaseExe,
      buildSha256: VERIFIED_BUILD_SHA256,
      runtimeExePath: layout.runtimeExe,
      runtimeBin: layout.runtimeBin,
      openXcomRunning: true,
      existsSync: () => true,
    });
    assert.equal(readiness.ok, false);
    assert.match(readiness.errors.join(' '), /running/i);
  });

  it('refuses deploy when build hash differs', () => {
    const layout = companionRuntimeLayout(path.resolve(__dirname, '../../..'));
    const readiness = assessDeployReadiness({
      buildExePath: layout.buildReleaseExe,
      buildSha256: 'deadbeef',
      runtimeExePath: layout.runtimeExe,
      runtimeBin: layout.runtimeBin,
      openXcomRunning: false,
      existsSync: () => true,
    });
    assert.equal(readiness.ok, false);
    assert.match(readiness.errors.join(' '), /SHA-256 mismatch/i);
  });

  it('launcher requires verified runtime hash', () => {
    const layout = companionRuntimeLayout(path.resolve(__dirname, '../../..'));
    const readiness = assessLauncherReadiness({
      runtimeExePath: layout.runtimeExe,
      runtimeSha256: 'bad',
      manifestSha256: VERIFIED_BUILD_SHA256,
      snapshotPath: layout.snapshotYaml,
      userDirPath: layout.userDir,
      inboxDecision: { action: 'none' },
      existsSync: () => true,
    });
    assert.equal(readiness.ok, false);
  });

  it('launcher accepts verified runtime hash and quarantined inbox', () => {
    const layout = companionRuntimeLayout(path.resolve(__dirname, '../../..'));
    const readiness = assessLauncherReadiness({
      runtimeExePath: layout.runtimeExe,
      runtimeSha256: VERIFIED_BUILD_SHA256,
      manifestSha256: VERIFIED_BUILD_SHA256,
      snapshotPath: layout.snapshotYaml,
      userDirPath: layout.userDir,
      inboxDecision: { action: 'none' },
      existsSync: (p) => p !== layout.snapshotYaml,
    });
    assert.equal(readiness.ok, true);
    assert.ok(readiness.warnings.length >= 1);
  });

  it('buildDeployManifest records schema and sha', () => {
    const doc = buildDeployManifest({
      sha256: VERIFIED_BUILD_SHA256,
      sourceExe: 'C:\\build\\openxcom.exe',
      sizeBytes: 3694080,
      deployedAtIso: '2026-11-04T10:00:00.000Z',
    });
    assert.equal(doc.schema_version, 1);
    assert.equal(doc.sha256, VERIFIED_BUILD_SHA256);
  });

  it('runtime DLL checklist includes SDL and yaml-cpp', () => {
    const layout = companionRuntimeLayout(path.resolve(__dirname, '../../..'));
    const check = checkRuntimeDllDependencies(layout.runtimeBin);
    assert.equal(check.ok, true);
  });
});
