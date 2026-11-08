'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  verifyDaemonProcessIdentityForPid,
  verifyDaemonStartupLive,
  writeDaemonHealth,
  DAEMON_STATE,
} = require('../lib/on-demand-daemon-health.cjs');
const {
  writeOwnershipRecord,
  canonicalSnapshotPath,
} = require('../lib/on-demand-daemon-ownership.cjs');
const { writeDaemonReady } = require('../lib/on-demand-daemon-process.cjs');

describe('daemon PID creation binding', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm0-pid-creation-bind-'));
  const snapshotDir = path.join(root, 'snap');
  fs.mkdirSync(snapshotDir, { recursive: true });
  const snapshotPath = path.join(snapshotDir, 'tactical.yaml');
  fs.writeFileSync(snapshotPath, 'x: 1\n');
  const canonical = canonicalSnapshotPath(snapshotPath);

  function daemonLine() {
  const script = 'companion-on-demand-relay-daemon.cjs';
    return `"${process.execPath}" "${script}" --snapshot-path "${canonical}"`;
  }

  function baseDeps(creationMs) {
    return {
      platform: 'win32',
      isProcessRunning: (pid) => pid === 91001,
      listProcesses: () => [{ pid: 91001, commandLine: daemonLine() }],
      getProcessCreationIdentity: () => ({
        ok: true,
        creationMs,
        executablePath: process.execPath,
        commandLine: daemonLine(),
      }),
    };
  }

  it('accepts identity when ownership lags process by 15s but bound creation matches', () => {
    const processCreationMs = Date.now() - 15_000;
    const ownershipStartedMs = Date.now();
    writeOwnershipRecord(snapshotDir, {
      snapshot_path: canonical,
      pid: 91001,
      ownership_token: 'slow-claim',
      started_at_ms: ownershipStartedMs,
      process_creation_ms: processCreationMs,
      owner: 'daemon',
    });
    const identity = verifyDaemonProcessIdentityForPid(canonical, 91001, baseDeps(processCreationMs));
    assert.equal(identity.ok, true, identity.reason || 'expected pass');
  });

  it('rejects genuine PID reuse when bound creation differs from live WMI creation', () => {
    writeOwnershipRecord(snapshotDir, {
      snapshot_path: canonical,
      pid: 91001,
      ownership_token: 'reuse',
      started_at_ms: Date.now(),
      process_creation_ms: Date.now() - 120_000,
      owner: 'daemon',
    });
    const identity = verifyDaemonProcessIdentityForPid(canonical, 91001, baseDeps(Date.now()));
    assert.equal(identity.ok, false);
    assert.equal(identity.reason, 'pid_reuse_creation_mismatch');
  });

  it('strict startup verify agrees after slow simulated auth before bound claim', () => {
    const processCreationMs = Date.now() - 11_337;
    writeOwnershipRecord(snapshotDir, {
      snapshot_path: canonical,
      pid: 91001,
      ownership_token: '27932-class',
      started_at_ms: Date.now(),
      process_creation_ms: processCreationMs,
      owner: 'daemon',
    });
    writeDaemonReady(snapshotDir, { pid: 91001, ready_at_ms: Date.now(), script: 'companion-on-demand-relay-daemon.cjs' });
    writeDaemonHealth(snapshotDir, { pid: 91001, state: DAEMON_STATE.READY });
    const verify = verifyDaemonStartupLive(canonical, 91001, baseDeps(processCreationMs));
    assert.equal(verify.ok, true, verify.reason || 'expected verify pass');
  });

  it('rejects strict verify when ownership lacks process_creation_ms', () => {
    writeOwnershipRecord(snapshotDir, {
      snapshot_path: canonical,
      pid: 91001,
      ownership_token: 'legacy',
      started_at_ms: Date.now(),
      owner: 'daemon',
    });
    writeDaemonReady(snapshotDir, { pid: 91001, ready_at_ms: Date.now(), script: 'companion-on-demand-relay-daemon.cjs' });
    writeDaemonHealth(snapshotDir, { pid: 91001, state: DAEMON_STATE.READY });
    const creationMs = Date.now();
    const identity = verifyDaemonProcessIdentityForPid(canonical, 91001, baseDeps(creationMs));
    assert.equal(identity.ok, false);
    assert.equal(identity.reason, 'process_creation_binding_missing');
  });

  it('rejects mismatched snapshot in command line', () => {
    const creationMs = Date.now();
    writeOwnershipRecord(snapshotDir, {
      snapshot_path: canonical,
      pid: 91001,
      ownership_token: 'snap',
      started_at_ms: Date.now(),
      process_creation_ms: creationMs,
      owner: 'daemon',
    });
    const badLine = `"${process.execPath}" "companion-on-demand-relay-daemon.cjs" --snapshot-path "C:\\wrong\\tactical.yaml"`;
    const deps = {
      ...baseDeps(creationMs),
      listProcesses: () => [{ pid: 91001, commandLine: badLine }],
    };
    const identity = verifyDaemonProcessIdentityForPid(canonical, 91001, deps);
    assert.equal(identity.ok, false);
    assert.equal(identity.reason, 'daemon_command_line_not_found');
  });
});
