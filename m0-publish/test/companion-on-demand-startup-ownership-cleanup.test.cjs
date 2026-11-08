'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  claimDaemonOwnership,
  readOwnershipRecord,
  writeOwnershipRecord,
  canonicalSnapshotPath,
} = require('../lib/on-demand-daemon-ownership.cjs');
const { clearStaleOwnershipIfSafe } = require('../lib/on-demand-daemon-ownership.cjs');

describe('startup ownership cleanup after dead spawn', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm0-ownership-cleanup-'));
  const snapshotDir = path.join(root, 'snap');
  fs.mkdirSync(snapshotDir, { recursive: true });
  const snapshotPath = path.join(snapshotDir, 'tactical.yaml');
  fs.writeFileSync(snapshotPath, 'x: 1\n');

  it('clearStaleOwnershipIfSafe removes record when owner pid is not running', () => {
    const deadPid = 99123;
    writeOwnershipRecord(snapshotDir, {
      snapshot_path: snapshotPath,
      pid: deadPid,
      ownership_token: 'abc',
      started_at_ms: Date.now(),
      owner: 'daemon',
    });
    const deps = {
      platform: 'win32',
      isProcessRunning: () => false,
      listProcesses: () => [],
    };
    assert.equal(clearStaleOwnershipIfSafe(snapshotDir, snapshotPath, deps), true);
    assert.equal(readOwnershipRecord(snapshotDir, deps), null);
  });

  it('clearStaleOwnershipIfSafe refuses while recorded owner pid is still running', () => {
    const livePid = 99125;
    writeOwnershipRecord(snapshotDir, {
      snapshot_path: snapshotPath,
      pid: livePid,
      ownership_token: 'live',
      started_at_ms: Date.now(),
      owner: 'daemon',
    });
    const deps = {
      platform: 'win32',
      isProcessRunning: (pid) => pid === livePid,
      listProcesses: () => [],
    };
    assert.equal(clearStaleOwnershipIfSafe(snapshotDir, snapshotPath, deps), false);
    assert.equal(readOwnershipRecord(snapshotDir, deps)?.pid, livePid);
  });

  it('clearStaleOwnershipIfSafe removes dead record even when another live daemon exists', () => {
    const deadRecordPid = 99126;
    const canonical = canonicalSnapshotPath(snapshotPath);
    writeOwnershipRecord(snapshotDir, {
      snapshot_path: snapshotPath,
      pid: deadRecordPid,
      ownership_token: 'stale',
      started_at_ms: Date.now(),
      owner: 'daemon',
    });
    const deps = {
      platform: 'win32',
      isProcessRunning: () => false,
      listProcesses: () => [],
    };
    assert.equal(clearStaleOwnershipIfSafe(snapshotDir, snapshotPath, deps), true);
    assert.equal(readOwnershipRecord(snapshotDir, deps), null);
  });

  it('clearStaleOwnershipIfSafe refuses when record pid still passes identity verification', () => {
    const livePid = 99128;
    const canonical = canonicalSnapshotPath(snapshotPath);
    const line = `"${process.execPath}" "E:\\\\repo\\\\companion-on-demand-relay-daemon.cjs" --snapshot-path "${canonical}"`;
    writeOwnershipRecord(snapshotDir, {
      snapshot_path: canonical,
      pid: livePid,
      ownership_token: 'live',
      started_at_ms: Date.now(),
      owner: 'daemon',
    });
    const deps = {
      platform: 'win32',
      isProcessRunning: (pid) => pid === livePid,
      listProcesses: () => [{ pid: livePid, commandLine: line }],
      getProcessCreationIdentity: () => ({
        ok: true,
        creationMs: Date.now(),
        executablePath: process.execPath,
        commandLine: line,
      }),
    };
    const { writeDaemonReady } = require('../lib/on-demand-daemon-process.cjs');
    const { writeDaemonHealth, DAEMON_STATE } = require('../lib/on-demand-daemon-health.cjs');
    writeDaemonReady(snapshotDir, { pid: livePid, ready_at_ms: Date.now(), script: 'companion-on-demand-relay-daemon.cjs' });
    writeDaemonHealth(snapshotDir, { pid: livePid, state: DAEMON_STATE.READY });
    assert.equal(clearStaleOwnershipIfSafe(snapshotDir, snapshotPath, deps), false);
    assert.equal(readOwnershipRecord(snapshotDir, deps)?.pid, livePid);
  });

  it('claim after stale cleanup can proceed', () => {
    const deps = {
      platform: 'win32',
      isProcessRunning: () => false,
      listProcesses: () => [],
    };
    const claim = claimDaemonOwnership({
      snapshotPath,
      pid: 99124,
      owner: 'daemon',
      deps,
    });
    assert.equal(claim.ok, true);
    assert.equal(readOwnershipRecord(snapshotDir, deps)?.pid, 99124);
  });
});
