'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  startOnDemandDaemonVerified,
  ensureOnDemandDaemonRunning,
  stopProcessTree,
  removeDaemonReady,
  removeDaemonPid,
  readDaemonPid,
  isProcessRunning,
} = require('../lib/on-demand-daemon-process.cjs');
const {
  assessOnDemandDaemonHealth,
  writeDaemonHealth,
  readDaemonHealth,
  DAEMON_STATE,
  listVerifiedDaemonsForSnapshot,
  verifyDaemonStartupLive,
} = require('../lib/on-demand-daemon-health.cjs');
const {
  canonicalSnapshotPath,
  snapshotPathMatchesCommandLine,
  claimDaemonOwnership,
  readOwnershipRecord,
  releaseOwnershipIfTokenMatches,
  findAllDaemonsForSnapshot,
  discoverLiveDaemonForSnapshot,
  isEstablishedDaemonContender,
} = require('../lib/on-demand-daemon-ownership.cjs');
const { writeTextAtomic, uniqueAtomicTempPath } = require('../lib/local-atomic.cjs');
const {
  resolveDiagnosticsPath,
} = require('../lib/on-demand-daemon-diagnostics.cjs');
const {
  createOnDemandRelayContext,
  processPendingRequest,
  createGhApiCallLog,
} = require('../lib/companion-on-demand-relay.cjs');
const {
  isolatedCommandRelayStateDir,
  fingerprintProductionCommandRelayJournal,
  assertProductionCommandRelayJournalUnchanged,
  assertSubprocessRelayStateDirIsolated,
} = require('../lib/relay-test-isolation.cjs');

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'm1-31e-'));
}

function listLivePids(snapshotDir) {
  const pid = readDaemonPid(snapshotDir);
  return pid && isProcessRunning(pid) ? [pid] : [];
}

describe('M1-31E daemon split-brain correction', () => {
  let root;
  let snapshotPath;
  let snapshotDir;
  let daemonScript;
  let relayStateDir;
  let productionBefore;

  beforeEach(() => {
    productionBefore = fingerprintProductionCommandRelayJournal();
    root = makeRoot();
    snapshotPath = path.join(root, 'tactical-live.yaml');
    snapshotDir = path.dirname(snapshotPath);
    fs.writeFileSync(snapshotPath, 'tactical: {}\n', 'utf8');
    daemonScript = path.join(__dirname, '..', 'companion-on-demand-relay-daemon.cjs');
    relayStateDir = isolatedCommandRelayStateDir(root, 'relay-state');
    assertSubprocessRelayStateDirIsolated(relayStateDir);
  });

  afterEach(() => {
    for (const proc of findAllDaemonsForSnapshot(snapshotPath)) {
      if (isProcessRunning(proc.pid)) {
        stopProcessTree(proc.pid);
      }
    }
    const pid = readDaemonPid(snapshotDir);
    if (pid && isProcessRunning(pid)) {
      stopProcessTree(pid);
    }
    removeDaemonReady(snapshotDir);
    removeDaemonPid(snapshotDir);
    const productionAfter = fingerprintProductionCommandRelayJournal();
    assertProductionCommandRelayJournalUnchanged(productionBefore, productionAfter);
    assert.equal(listLivePids(snapshotDir).length, 0, 'test-created daemon still running');
  });

  it('1. one daemon starts normally with ownership record', () => {
    const start = startOnDemandDaemonVerified({
      snapshotPath,
      daemonScript,
      cwd: path.dirname(daemonScript),
      commandRelayStateDir: relayStateDir,
      extraArgs: ['--dry-run'],
    });
    assert.equal(start.ok, true, start.error || 'startup failed');
    const ownership = readOwnershipRecord(snapshotDir);
    assert.ok(ownership && ownership.ownership_token);
    assert.equal(ownership.pid, start.pid);
    stopProcessTree(start.pid);
  });

  it('2. second launcher reuses first daemon', () => {
    const first = startOnDemandDaemonVerified({
      snapshotPath,
      daemonScript,
      cwd: path.dirname(daemonScript),
      commandRelayStateDir: relayStateDir,
      extraArgs: ['--dry-run'],
    });
    const second = startOnDemandDaemonVerified({
      snapshotPath,
      daemonScript,
      cwd: path.dirname(daemonScript),
      commandRelayStateDir: relayStateDir,
      extraArgs: ['--dry-run'],
    });
    assert.equal(second.reused, true);
    assert.equal(second.pid, first.pid);
    stopProcessTree(first.pid);
  });

  it('3. concurrent startups yield one owner', async () => {
    const outcomes = await Promise.all([
      ensureOnDemandDaemonRunning({
        snapshotPath,
        daemonScript,
        commandRelayStateDir: relayStateDir,
        extraArgs: ['--dry-run'],
        singleFlight: false,
      }),
      ensureOnDemandDaemonRunning({
        snapshotPath,
        daemonScript,
        commandRelayStateDir: relayStateDir,
        extraArgs: ['--dry-run'],
        singleFlight: false,
      }),
    ]);
    const ok = outcomes.filter((item) => item.ok);
    assert.ok(ok.length >= 1);
    const pids = new Set(ok.map((item) => item.pid));
    assert.equal(pids.size, 1);
    stopProcessTree([...pids][0]);
  });

  it('4. concurrent recoveries yield one owner', async () => {
    const outcomes = await Promise.all([
      ensureOnDemandDaemonRunning({
        snapshotPath,
        daemonScript,
        owner: 'request_recovery',
        commandRelayStateDir: relayStateDir,
        extraArgs: ['--dry-run'],
        singleFlight: false,
      }),
      ensureOnDemandDaemonRunning({
        snapshotPath,
        daemonScript,
        owner: 'request_recovery',
        commandRelayStateDir: relayStateDir,
        extraArgs: ['--dry-run'],
        singleFlight: false,
      }),
    ]);
    const ok = outcomes.filter((item) => item.ok);
    assert.ok(ok.length >= 1);
    const pids = new Set(ok.map((item) => item.pid));
    assert.equal(pids.size, 1);
    stopProcessTree([...pids][0]);
  });

  it('5. backslash and forward-slash paths normalize for command-line match', () => {
    const canonical = canonicalSnapshotPath(snapshotPath);
    const forward = canonical.replace(/\\/g, '/');
    assert.equal(
      snapshotPathMatchesCommandLine(`node daemon.cjs --snapshot-path ${forward}`, snapshotPath),
      true,
    );
    assert.equal(
      snapshotPathMatchesCommandLine(`node daemon.cjs --snapshot-path ${canonical}`, snapshotPath),
      true,
    );
  });

  it('6. stale pid is detected', () => {
    fs.writeFileSync(path.join(snapshotDir, '.companion-on-demand-daemon.pid'), `${JSON.stringify({ pid: 999999 })}\n`);
    const health = assessOnDemandDaemonHealth({
      snapshotPath,
      deps: { listProcesses: () => [] },
    });
    assert.equal(health.healthy, false);
  });

  it('7. dead owner can be replaced', () => {
    const claim = claimDaemonOwnership({ snapshotPath, pid: 888001, owner: 'test' });
    assert.equal(claim.ok, true);
    releaseOwnershipIfTokenMatches(snapshotDir, claim.ownershipToken);
    const next = claimDaemonOwnership({ snapshotPath, pid: 888002, owner: 'test' });
    assert.equal(next.ok, true);
  });

  it('8. healthy live owner cannot be replaced by claim', () => {
    const start = startOnDemandDaemonVerified({
      snapshotPath,
      daemonScript,
      cwd: path.dirname(daemonScript),
      commandRelayStateDir: relayStateDir,
      extraArgs: ['--dry-run'],
    });
    assert.equal(start.ok, true);
    const blocked = claimDaemonOwnership({
      snapshotPath,
      pid: process.pid + 10000,
      owner: 'intruder',
      deps: { listProcesses: () => [{ pid: start.pid, commandLine: `${daemonScript} --snapshot-path ${snapshotPath}` }] },
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.reason, 'existing_live_owner');
    stopProcessTree(start.pid);
  });

  it('9. unknown process is never killed without owned pid record', () => {
    const ok = stopProcessTree(999999, {
      requireOwnedPidRecord: true,
      snapshotDir,
    });
    assert.equal(ok, false);
  });

  it('10. concurrent health writes use unique temp files and succeed', () => {
    const healthPath = path.join(snapshotDir, '.companion-on-demand-daemon-health.json');
    const tmpA = uniqueAtomicTempPath(healthPath);
    const tmpB = uniqueAtomicTempPath(healthPath);
    assert.notEqual(tmpA, tmpB);
    writeTextAtomic(healthPath, `${JSON.stringify({ a: 1 })}\n`);
    writeTextAtomic(healthPath, `${JSON.stringify({ b: 2 })}\n`);
    const parsed = JSON.parse(fs.readFileSync(healthPath, 'utf8'));
    assert.equal(parsed.b, 2);
  });

  it('11. old owner token cannot erase new owner pid record', () => {
    const first = claimDaemonOwnership({ snapshotPath, pid: 700001, owner: 'test' });
    releaseOwnershipIfTokenMatches(snapshotDir, first.ownershipToken);
    const second = claimDaemonOwnership({ snapshotPath, pid: 700002, owner: 'test' });
    assert.equal(second.ok, true);
    const { writeDaemonPid } = require('../lib/on-demand-daemon-process.cjs');
    writeDaemonPid(snapshotDir, 700002, {}, { ownershipToken: second.ownershipToken, owner: 'test' });
    writeDaemonHealth(snapshotDir, { pid: 700002, state: DAEMON_STATE.READY }, { ownershipToken: second.ownershipToken });
    const removed = removeDaemonPid(snapshotDir, {}, { ownershipToken: first.ownershipToken });
    assert.equal(removed, false);
    assert.equal(readDaemonPid(snapshotDir), 700002);
    releaseOwnershipIfTokenMatches(snapshotDir, second.ownershipToken);
  });

  it('12. crash recovery preserves isolated journal through ensure failure', async () => {
    const { journalPath } = require('../lib/command-journal.cjs');
    const isolatedJournalPath = journalPath(relayStateDir);
    fs.mkdirSync(relayStateDir, { recursive: true });
    fs.writeFileSync(isolatedJournalPath, `${JSON.stringify({
      version: 1,
      active: null,
      records: { cmd1: { command_id: 'cmd1', phase: 'delivered_local', status: 'COMPLETED' } },
    })}\n`);
    const before = fs.readFileSync(isolatedJournalPath, 'utf8');
    const outcome = await ensureOnDemandDaemonRunning({
      snapshotPath,
      daemonScript: path.join(root, 'missing-daemon.cjs'),
      commandRelayStateDir: relayStateDir,
    });
    assert.equal(outcome.ok, false);
    assert.equal(fs.readFileSync(isolatedJournalPath, 'utf8'), before);
  });

  it('13. SEND and RETRIEVE recovery paths share ensure helper', async () => {
    const send = await ensureOnDemandDaemonRunning({
      snapshotPath,
      daemonScript,
      owner: 'request_recovery',
      commandRelayStateDir: relayStateDir,
      extraArgs: ['--dry-run'],
    });
    const retrieve = await ensureOnDemandDaemonRunning({
      snapshotPath,
      daemonScript,
      owner: 'request_recovery',
      commandRelayStateDir: relayStateDir,
      extraArgs: ['--dry-run'],
    });
    assert.equal(send.ok, true);
    assert.equal(retrieve.ok, true);
    assert.equal(send.pid, retrieve.pid);
    stopProcessTree(send.pid);
  });

  it('14. live process discovery reuses instead of respawning when health stale', () => {
    const first = startOnDemandDaemonVerified({
      snapshotPath,
      daemonScript,
      cwd: path.dirname(daemonScript),
      commandRelayStateDir: relayStateDir,
      extraArgs: ['--dry-run'],
    });
    writeDaemonHealth(snapshotDir, {
      pid: first.pid,
      state: DAEMON_STATE.UNRESPONSIVE,
      updated_at_ms: Date.now() - 60000,
    });
    const second = startOnDemandDaemonVerified({
      snapshotPath,
      daemonScript,
      cwd: path.dirname(daemonScript),
      commandRelayStateDir: relayStateDir,
      extraArgs: ['--dry-run'],
      deps: {
        listProcesses: () => [{ pid: first.pid, commandLine: `${daemonScript} --snapshot-path ${snapshotPath}` }],
      },
    });
    assert.equal(second.ok, true);
    assert.equal(second.pid, first.pid);
    assert.equal(second.reused, true);
    stopProcessTree(first.pid);
  });

  it('15. idle daemon tick performs zero GitHub API calls', async () => {
    const apiCallLog = createGhApiCallLog();
    const ctx = createOnDemandRelayContext({
      snapshotPath,
      commandRelayStateDir: relayStateDir,
      dryRun: true,
      apiCallLog,
    });
    await processPendingRequest(ctx, {
      existsSync: fs.existsSync,
      readFileSync: fs.readFileSync,
      writeFileSync: fs.writeFileSync,
      renameSync: fs.renameSync,
      unlinkSync: fs.unlinkSync,
    });
    assert.equal(apiCallLog.entries.length, 0);
  });

  it('16. ownership-guarded health write rejects stale token', () => {
    const claim = claimDaemonOwnership({ snapshotPath, pid: 123456, owner: 'test' });
    const ok = writeDaemonHealth(snapshotDir, { pid: 123456, state: DAEMON_STATE.READY }, {
      ownershipToken: claim.ownershipToken,
    });
    assert.equal(ok, true);
    const rejected = writeDaemonHealth(snapshotDir, { pid: 1, state: DAEMON_STATE.STOPPED }, {
      ownershipToken: 'wrong-token',
    });
    assert.equal(rejected, false);
    assert.equal(readDaemonHealth(snapshotDir).state, DAEMON_STATE.READY);
    releaseOwnershipIfTokenMatches(snapshotDir, claim.ownershipToken);
  });

  it('17c. startup success requires verifyDaemonStartupLive not spawn_pid alone', () => {
    const line = `"${process.execPath}" "${daemonScript}" --snapshot-path "${snapshotPath}"`;
    const spawnPid = 55502;
    const root = snapshotDir;
    const readyPath = path.join(root, '.companion-on-demand-daemon-ready.json');
    fs.writeFileSync(readyPath, `${JSON.stringify({
      pid: spawnPid,
      ready_at_ms: Date.now(),
      script: 'companion-on-demand-relay-daemon.cjs',
    })}\n`);
    writeDaemonHealth(snapshotDir, {
      pid: spawnPid,
      state: DAEMON_STATE.READY,
      updated_at_ms: Date.now(),
    });
    const deps = {
      platform: 'win32',
      isProcessRunning: (pid) => pid === spawnPid,
      listProcesses: () => [],
      childProcess: {
        spawn: () => {
          const emitter = new (require('node:events').EventEmitter)();
          emitter.pid = spawnPid;
          emitter.unref = () => {};
          process.nextTick(() => emitter.emit('exit', 0));
          return emitter;
        },
      },
    };
    const outcome = startOnDemandDaemonVerified({
      snapshotPath,
      daemonScript,
      cwd: path.dirname(daemonScript),
      commandRelayStateDir: relayStateDir,
      extraArgs: ['--dry-run'],
      timeoutMs: 800,
      deps,
    });
    assert.equal(outcome.ok, false, outcome.error || 'expected startup failure without verified identity');
    const verify = require('../lib/on-demand-daemon-health.cjs').verifyDaemonStartupLive(snapshotPath, spawnPid, deps);
    assert.equal(verify.ok, false);
    assert.equal(verify.reason, 'pid_not_verified_live');
  });

  it('17b. unclaimed command-line match is ignored for live discovery', () => {
    const line = `"${process.execPath}" "${daemonScript}" --snapshot-path "${snapshotPath}"`;
    const deps = {
      platform: 'win32',
      isProcessRunning: (pid) => pid === 55501,
      listProcesses: () => [{ pid: 55501, commandLine: line }],
      getProcessCreationIdentity: () => ({
        ok: true,
        creationMs: Date.now(),
        executablePath: process.execPath,
        commandLine: line,
      }),
    };
    assert.equal(isEstablishedDaemonContender(snapshotPath, 55501, snapshotDir, deps), false);
    const live = discoverLiveDaemonForSnapshot(snapshotPath, deps);
    assert.equal(live.found, false);
  });

  it('17b2. transient listVerified splitBrain is not production split brain with two CLI-only matches', () => {
    const line = `"${process.execPath}" "${daemonScript}" --snapshot-path "${snapshotPath}"`;
    const deps = {
      platform: 'win32',
      isProcessRunning: (pid) => pid === 55503 || pid === 55504,
      listProcesses: () => [
        { pid: 55503, commandLine: line },
        { pid: 55504, commandLine: line },
      ],
      getProcessCreationIdentity: (pid) => ({
        ok: true,
        creationMs: Date.now(),
        executablePath: process.execPath,
        commandLine: line,
      }),
    };
    const inventory = listVerifiedDaemonsForSnapshot(snapshotPath, deps);
    assert.equal(inventory.splitBrain, true);
    assert.deepEqual(inventory.verified.map((row) => row.pid).sort(), [55503, 55504]);
    const established = discoverLiveDaemonForSnapshot(snapshotPath, deps);
    assert.equal(established.splitBrain, false);
    assert.equal(established.found, false);
    for (const pid of [55503, 55504]) {
      const verify = verifyDaemonStartupLive(snapshotPath, pid, deps);
      assert.equal(verify.ok, false);
      assert.notEqual(verify.splitBrain, true);
    }
  });

  it('17. diagnostics file is created on spawn', () => {
    const start = startOnDemandDaemonVerified({
      snapshotPath,
      daemonScript,
      cwd: path.dirname(daemonScript),
      commandRelayStateDir: relayStateDir,
      extraArgs: ['--dry-run'],
    });
    assert.equal(start.ok, true);
    assert.ok(fs.existsSync(resolveDiagnosticsPath(snapshotDir)));
    stopProcessTree(start.pid);
  });
});
