'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  verifyDaemonStartupLive,
  recordStartupVerificationFailure,
  DAEMON_STATE,
  writeDaemonHealth,
} = require('../lib/on-demand-daemon-health.cjs');
const { buildStartupVerificationFailureDetail } = require('../lib/on-demand-daemon-startup-verify-diagnostics.cjs');
const { writeDaemonReady } = require('../lib/on-demand-daemon-process.cjs');
const { resolveDiagnosticsPath } = require('../lib/on-demand-daemon-diagnostics.cjs');
const { canonicalSnapshotPath } = require('../lib/on-demand-daemon-ownership.cjs');

describe('startup verification failure diagnostics', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm0-startup-verify-diag-'));
  const snapshotDir = path.join(root, 'snap');
  fs.mkdirSync(snapshotDir, { recursive: true });
  const snapshotPath = path.join(snapshotDir, 'tactical.yaml');
  fs.writeFileSync(snapshotPath, 'snapshot: test\n');
  const canonical = canonicalSnapshotPath(snapshotPath);
  const daemonScript = 'companion-on-demand-relay-daemon.cjs';
  const line = `"${process.execPath}" "E:\\repo\\${daemonScript}" --snapshot-path "${canonical}"`;

  it('verifyDaemonStartupLive failure exposes predicate and rejected candidate', () => {
    const expectedPid = 44001;
    const otherPid = 44002;
    const deps = {
      platform: 'win32',
      isProcessRunning: (pid) => pid === expectedPid || pid === otherPid,
      listProcesses: () => [
        { pid: otherPid, commandLine: line },
        {
          pid: expectedPid,
          commandLine: `"${process.execPath}" "E:\\repo\\${daemonScript}" --snapshot-path "C:\\wrong\\tactical.yaml"`,
        },
      ],
      getProcessCreationIdentity: (pid) => ({
        ok: true,
        creationMs: Date.now(),
        executablePath: process.execPath,
        commandLine: pid === otherPid
          ? line
          : `"${process.execPath}" "E:\\repo\\${daemonScript}" --snapshot-path "C:\\wrong\\tactical.yaml"`,
      }),
    };
    writeDaemonReady(snapshotDir, {
      pid: expectedPid,
      ready_at_ms: Date.now(),
      script: daemonScript,
    });
    writeDaemonHealth(snapshotDir, {
      pid: expectedPid,
      state: DAEMON_STATE.READY,
      updated_at_ms: Date.now(),
    });

    const verify = verifyDaemonStartupLive(canonical, expectedPid, deps);
    assert.equal(verify.ok, false);
    assert.equal(verify.reason, 'pid_not_verified_live');
    assert.ok(verify.diagnostics);
    assert.equal(verify.diagnostics.failed_predicate, 'pid_not_verified_live');
    assert.equal(verify.diagnostics.process_running, true);
    assert.deepEqual(verify.diagnostics.verified_pids, [otherPid]);
    assert.equal(verify.diagnostics.identity.reason, 'daemon_command_line_not_found');
    assert.equal(verify.diagnostics.enumeration.expected_pid_in_snapshot_filtered, false);
    assert.equal(verify.diagnostics.enumeration.expected_pid_in_unfiltered, true);
    assert.equal(verify.diagnostics.ready_marker.matches_expected, true);
    assert.equal(verify.diagnostics.health_record.matches_expected, true);
  });

  it('recordStartupVerificationFailure appends startup_verify_failed to jsonl', () => {
    const failPid = 44003;
    const deps = {
      platform: 'win32',
      isProcessRunning: (pid) => pid === failPid,
      listProcesses: () => [],
    };
    writeDaemonReady(snapshotDir, {
      pid: failPid,
      ready_at_ms: Date.now(),
      script: daemonScript,
    });
    writeDaemonHealth(snapshotDir, {
      pid: failPid,
      state: DAEMON_STATE.READY,
      updated_at_ms: Date.now(),
    });
    const verify = verifyDaemonStartupLive(canonical, failPid, deps);
    const record = recordStartupVerificationFailure(canonical, failPid, deps, {
      source: 'test_harness',
      verifyResult: verify,
    });
    assert.equal(record.verify.reason, 'pid_not_verified_live');
    const logPath = resolveDiagnosticsPath(snapshotDir);
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1]);
    assert.equal(last.kind, 'startup_verify_failed');
    assert.equal(last.source, 'test_harness');
    assert.equal(last.failed_predicate, 'pid_not_verified_live');
    assert.equal(last.expected_pid, failPid);
    assert.ok(Array.isArray(last.rejected));
  });

  it('buildStartupVerificationFailureDetail bounds rejected list', () => {
    const detail = buildStartupVerificationFailureDetail(canonical, 1, 'pid_not_verified_live', {
      platform: 'win32',
      isProcessRunning: () => false,
      listProcesses: () => [],
    });
    assert.equal(detail.failed_predicate, 'pid_not_verified_live');
    assert.equal(detail.process_running, false);
    assert.equal(detail.creation_identity.reason, 'process_not_running');
    assert.ok(!('commandLine' in (detail.creation_identity || {})));
  });
});
