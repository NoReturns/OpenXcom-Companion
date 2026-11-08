'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  startOnDemandDaemonVerified,
  CANONICAL_STARTUP_TIMEOUT_MS,
  STARTUP_POST_DEADLINE_VERIFY_MS,
  writeDaemonPid,
  writeDaemonReady,
} = require('../lib/on-demand-daemon-process.cjs');
const { writeOwnershipRecord, canonicalSnapshotPath } = require('../lib/on-demand-daemon-ownership.cjs');
const { writeDaemonHealth, DAEMON_STATE } = require('../lib/on-demand-daemon-health.cjs');
const { resolveDiagnosticsPath } = require('../lib/on-demand-daemon-diagnostics.cjs');

describe('startup poll timing and strict verify ordering', () => {
  function freshSnapshot(label) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `m0-startup-poll-${label}-`));
    const snapshotDir = path.join(root, 'snap');
    fs.mkdirSync(snapshotDir, { recursive: true });
    const snapshotPath = path.join(snapshotDir, 'tactical.yaml');
    const canonical = canonicalSnapshotPath(snapshotPath);
    fs.writeFileSync(snapshotPath, 'x: 1\n');
    const daemonScript = path.join(root, 'companion-on-demand-relay-daemon.cjs');
    fs.writeFileSync(daemonScript, 'setInterval(() => {}, 60000);\n');
    return { root, snapshotDir, snapshotPath, canonical, daemonScript };
  }

  const spawnPid = 99200;

  function writeEstablishedReadyMarkers(snapshotDir, canonical, creationMs) {
    writeOwnershipRecord(snapshotDir, {
      snapshot_path: canonical,
      pid: spawnPid,
      ownership_token: 'poll-test',
      started_at_ms: Date.now(),
      process_creation_ms: creationMs,
      owner: 'daemon',
    });
    writeDaemonPid(snapshotDir, spawnPid, {}, { owner: 'daemon', snapshotPath: canonical });
    writeDaemonReady(snapshotDir, {
      pid: spawnPid,
      ready_at_ms: Date.now(),
      script: 'companion-on-demand-relay-daemon.cjs',
    });
    writeDaemonHealth(snapshotDir, { pid: spawnPid, state: DAEMON_STATE.READY });
  }

  function baseDeps(snapshotDir, daemonScript, canonical, creationMs, extra = {}) {
    const line = `"${process.execPath}" "${daemonScript}" --snapshot-path "${canonical}"`;
    return {
      platform: 'win32',
      isProcessRunning: (pid) => pid === spawnPid,
      listProcesses: () => [{ pid: spawnPid, commandLine: line }],
      getProcessCreationIdentity: () => ({
        ok: true,
        creationMs,
        executablePath: process.execPath,
        commandLine: line,
      }),
      childProcess: {
        spawn: () => {
          writeEstablishedReadyMarkers(snapshotDir, canonical, creationMs);
          const emitter = new (require('node:events').EventEmitter)();
          emitter.pid = spawnPid;
          emitter.unref = () => {};
          return emitter;
        },
      },
      ...extra,
    };
  }

  it('exposes canonical startup budget constants', () => {
    assert.equal(CANONICAL_STARTUP_TIMEOUT_MS, 30000);
    assert.equal(STARTUP_POST_DEADLINE_VERIFY_MS, 5000);
  });

  it('succeeds when READY is on disk before deadline despite slow strict verify (WMI-shaped)', () => {
    const { snapshotDir, snapshotPath, canonical, daemonScript, root } = freshSnapshot('slow-verify');
    const creationMs = Date.now() - 12_900;
    const line = `"${process.execPath}" "${daemonScript}" --snapshot-path "${canonical}"`;

    let verifyCalls = 0;
    const deps = baseDeps(snapshotDir, daemonScript, canonical, creationMs, {
      getProcessCreationIdentity: () => {
        verifyCalls += 1;
        if (verifyCalls === 1) {
          const blockUntil = Date.now() + 350;
          while (Date.now() < blockUntil) {
            // synchronous WMI-shaped stall inside strict verify
          }
        }
        return {
          ok: true,
          creationMs,
          executablePath: process.execPath,
          commandLine: line,
        };
      },
    });

    const started = Date.now();
    const start = startOnDemandDaemonVerified({
      snapshotPath,
      daemonScript,
      cwd: root,
      timeoutMs: 2000,
      pollMs: 25,
      disableLiveDaemonReuse: true,
      bindTestSupervisor: false,
      deps,
    });
    const elapsed = Date.now() - started;
    assert.equal(start.ok, true, start.error || 'expected startup success');
    assert.ok(elapsed < 2000, `expected success before 2s deadline, took ${elapsed}ms`);
    const log = fs.readFileSync(resolveDiagnosticsPath(snapshotDir), 'utf8');
    assert.match(log, /startup_poll_verify/);
    assert.doesNotMatch(log, /"kind":"startup_timeout"/);
  });

  it('post-deadline grace verifies READY when main loop expires during a slow verify', () => {
    const { snapshotDir, snapshotPath, canonical, daemonScript, root } = freshSnapshot('grace');
    const creationMs = Date.now() - 12_900;
    const line = `"${process.execPath}" "${daemonScript}" --snapshot-path "${canonical}"`;

    let verifyCalls = 0;
    const deps = baseDeps(snapshotDir, daemonScript, canonical, creationMs, {
      getProcessCreationIdentity: () => {
        verifyCalls += 1;
        if (verifyCalls <= 5) {
          const blockUntil = Date.now() + 90;
          while (Date.now() < blockUntil) {
            // stall inside verify
          }
          return { ok: false, reason: 'simulated_wmi_stall' };
        }
        return {
          ok: true,
          creationMs,
          executablePath: process.execPath,
          commandLine: line,
        };
      },
    });

    const start = startOnDemandDaemonVerified({
      snapshotPath,
      daemonScript,
      cwd: root,
      timeoutMs: 350,
      pollMs: 15,
      disableLiveDaemonReuse: true,
      bindTestSupervisor: false,
      deps,
    });
    assert.equal(start.ok, true, start.error || 'expected post-deadline verify success');
    const log = fs.readFileSync(resolveDiagnosticsPath(snapshotDir), 'utf8');
    assert.ok(
      /post_deadline_grace/.test(log)
        || /"kind":"startup_poll_verify"[^\n]*"ok":true[^\n]*"deadline_ms_remaining":-\d+/.test(log),
      'expected grace phase or in-flight verify succeeding after deadline',
    );
  });
});
