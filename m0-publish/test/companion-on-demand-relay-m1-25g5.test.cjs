'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createOnDemandRelayContext } = require('../lib/companion-on-demand-relay.cjs');
const { startOnDemandDaemonVerified } = require('../lib/on-demand-daemon-process.cjs');
const {
  isolatedCommandRelayStateDir,
  fingerprintProductionCommandRelayJournal,
  assertProductionCommandRelayJournalUnchanged,
  assertSubprocessRelayStateDirIsolated,
  getProductionCommandRelayJournalPath,
  isDirectNodeTestEntrypoint,
} = require('../lib/relay-test-isolation.cjs');
const { journalPath } = require('../lib/command-journal.cjs');

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'm1-25g5-'));
}

describe('M1-25G5 daemon subprocess test isolation', () => {
  let suiteProductionBefore;
  let root;
  let snapshotPath;
  let daemonScript;

  before(() => {
    suiteProductionBefore = fingerprintProductionCommandRelayJournal();
  });

  after(() => {
    const suiteProductionAfter = fingerprintProductionCommandRelayJournal();
    assertProductionCommandRelayJournalUnchanged(suiteProductionBefore, suiteProductionAfter);
  });

  beforeEach(() => {
    root = makeRoot();
    snapshotPath = path.join(root, 'tactical-live.yaml');
    fs.writeFileSync(snapshotPath, 'tactical: {}\n', 'utf8');
    daemonScript = path.join(__dirname, '..', 'companion-on-demand-relay-daemon.cjs');
  });

  it('preserves G4 direct-test guard for createOnDemandRelayContext', () => {
    assert.equal(isDirectNodeTestEntrypoint(), true);
    assert.throws(
      () => createOnDemandRelayContext({ snapshotPath, dryRun: true }),
      /commandRelayStateDir/,
    );
  });

  it('daemon subprocess refuses production relay journal when node:test lacks override', () => {
    const result = spawnSync(process.execPath, [
      daemonScript,
      '--snapshot-path',
      snapshotPath,
      '--dry-run',
    ], {
      encoding: 'utf8',
      env: { ...process.env, NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT || 'child-v8' },
      windowsHide: true,
    });
    assert.notEqual(result.status, 0, 'daemon must exit when node:test has no --command-relay-state-dir');
    assert.match(result.stderr, /command-relay-state-dir|command-relay journal/i);
  });

  it('startOnDemandDaemonVerified uses isolated journal path and leaves production bytes unchanged', () => {
    const relayStateDir = isolatedCommandRelayStateDir(root, 'relay-state-subprocess');
    assertSubprocessRelayStateDirIsolated(relayStateDir);
    const productionBefore = fingerprintProductionCommandRelayJournal();

    const start = startOnDemandDaemonVerified({
      snapshotPath,
      daemonScript,
      cwd: path.dirname(daemonScript),
      commandRelayStateDir: relayStateDir,
      extraArgs: ['--dry-run'],
      timeoutMs: 15000,
    });
    assert.equal(start.ok, true, start.error || 'daemon startup failed');
    assert.equal(
      path.resolve(journalPath(relayStateDir)),
      path.resolve(relayStateDir, 'command-relay-journal.json'),
    );
    assert.notEqual(path.resolve(journalPath(relayStateDir)), path.resolve(getProductionCommandRelayJournalPath()));

    const { stopProcessTree, removeDaemonReady } = require('../lib/on-demand-daemon-process.cjs');
    stopProcessTree(start.pid);
    removeDaemonReady(path.dirname(snapshotPath));

    const productionAfter = fingerprintProductionCommandRelayJournal();
    assertProductionCommandRelayJournalUnchanged(productionBefore, productionAfter);
  });

  it('production daemon options omit override when flag not passed (parse smoke)', () => {
    const daemonSource = fs.readFileSync(daemonScript, 'utf8');
    assert.match(daemonSource, /commandRelayStateDir/);
    assert.match(daemonSource, /if \(args\.commandRelayStateDir\)/);
    assert.doesNotMatch(
      daemonSource,
      /commandRelayStateDir:\s*args\.commandRelayStateDir\s*,/,
    );
  });
});
