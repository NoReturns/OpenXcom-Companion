'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createOnDemandRelayContext,
  runRetrieveOnce,
  createGhApiCallLog,
} = require('../lib/companion-on-demand-relay.cjs');
const { createGhApiExec } = require('../lib/github-relay.cjs');
const { writeTextAtomic } = require('../lib/local-atomic.cjs');
const { loadCommandJournal, persistCommandJournal, markCommandRecord } = require('../lib/command-journal.cjs');
const {
  fingerprintProductionCommandRelayJournal,
  assertProductionCommandRelayJournalUnchanged,
  isolatedCommandRelayStateDir,
  auditProductionCommandRelayJournal,
  getProductionCommandRelayJournalPath,
} = require('../lib/relay-test-isolation.cjs');
const { DEFAULT_COMMAND_RELAY_STATE_DIR } = require('../lib/companion-relay-launcher.cjs');

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'm1-25g4-'));
}

function seedStaleJournal(stateDir, commandIds) {
  fs.mkdirSync(stateDir, { recursive: true });
  const journal = loadCommandJournal(stateDir);
  for (const id of commandIds) {
    markCommandRecord(journal, id, {
      phase: 'published_terminal',
      status: 'COMPLETED',
      remote_sha256: `sha-${id.slice(0, 8)}`,
      published_at: new Date().toISOString(),
    });
  }
  persistCommandJournal(stateDir, journal);
}

describe('M1-25G4 node test isolation and instrumentation correction', () => {
  let root;
  let snapshotPath;
  let productionBefore;

  beforeEach(() => {
    root = makeRoot();
    snapshotPath = path.join(root, 'tactical-live.yaml');
    fs.writeFileSync(
      snapshotPath,
      fs.readFileSync(path.join(__dirname, 'fixtures', 'valid-v5.yaml'), 'utf8'),
      'utf8',
    );
    productionBefore = fingerprintProductionCommandRelayJournal();
  });

  it('traces M1-25G2 pollution path to default command relay state dir', () => {
    const expectedJournal = path.join(DEFAULT_COMMAND_RELAY_STATE_DIR, 'command-relay-journal.json');
    assert.equal(getProductionCommandRelayJournalPath(), expectedJournal);
    assert.match(
      expectedJournal,
      /\.command-relay-sidecar-state[\\/]command-relay-journal\.json$/,
    );
    const audit = auditProductionCommandRelayJournal();
    const syntheticIds = audit.synthetic.map((record) => record.command_id).sort();
    assert.ok(syntheticIds.length >= 4, 'production journal should retain prior synthetic audit evidence');
    assert.ok(syntheticIds.includes('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));
    assert.ok(syntheticIds.includes('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'));
  });

  it('refuses createOnDemandRelayContext without isolated commandRelayStateDir under node:test', () => {
    assert.throws(
      () => createOnDemandRelayContext({ snapshotPath, dryRun: true }),
      /commandRelayStateDir/,
    );
  });

  it('production command-relay journal stays byte-for-byte identical across isolated retrieve work', async () => {
    const { resolveOnDemandPaths } = require('../lib/companion-on-demand-relay.cjs');
    const paths = resolveOnDemandPaths(snapshotPath);
    const stateDir = isolatedCommandRelayStateDir(root, 'relay-state-regression');
    const staleId = 'dddddddddddddddddddddddddddddddd';
    seedStaleJournal(stateDir, [staleId]);
    writeTextAtomic(
      paths.localRelay.result,
      `${JSON.stringify({ command_id: '99999999999999999999999999999999', status: 'COMPLETED' }, null, 2)}\n`,
      fs.writeFileSync,
      fs.renameSync,
    );

    const ctx = createOnDemandRelayContext({
      snapshotPath,
      commandRelayStateDir: stateDir,
      dryRun: true,
      contentClient: {
        paths: {},
        readFile: () => null,
        publishFile: async () => {},
        deleteFile: async () => {},
      },
    });
    ctx.commandWatcher.readRemoteCommand = async () => null;
    ctx.commandWatcher.fetchRemoteResult = async () => null;

    await runRetrieveOnce(ctx, { transactionId: 'tx-g4-isolated' });

    const journal = loadCommandJournal(stateDir);
    assert.equal(journal.records[staleId].phase, 'retirement_closed');

    const productionAfter = fingerprintProductionCommandRelayJournal();
    assertProductionCommandRelayJournalUnchanged(productionBefore, productionAfter);
  });

  it('createGhApiExec with apiCallLog records exactly one entry per gh api invocation', () => {
    const log = createGhApiCallLog({ transactionId: 'instrument-ghapi-tx' });
    const ghApi = createGhApiExec({
      apiCallLog: log,
      transactionId: 'instrument-ghapi-tx',
      execFileSync: () => 'HTTP/1.1 200 OK\n\n{}',
    });
    ghApi('GET', 'repos/o/r/contents/m0/tactical-command.json');
    assert.equal(log.countApiCalls(), 1);
    assert.equal(log.entries[0].method, 'GET');
    assert.equal(log.entries[0].endpoint, 'repos/o/r/contents/m0/tactical-command.json');
    assert.equal(log.entries[0].transaction_id, 'instrument-ghapi-tx');
  });

  it('read-only audit flags synthetic records and inconsistent retirement metadata', () => {
    const audit = auditProductionCommandRelayJournal();
    assert.ok(audit.synthetic.length > 0);
    const nonSyntheticInconsistent = audit.inconsistent.filter(
      (record) => !audit.synthetic.some((s) => s.command_id === record.command_id),
    );
    assert.equal(
      nonSyntheticInconsistent.length,
      0,
      `unexpected inconsistent non-synthetic records: ${nonSyntheticInconsistent.map((r) => r.command_id).join(', ')}`,
    );
    const cc2 = audit.records.find((record) => record.command_id === 'cc2f9bd224cd44105264d5aa19cb563f');
    assert.ok(cc2, 'cc2f9bd2 record must remain present for operator review');
    assert.equal(cc2.phase, 'delivered_local');

    const { activeClassification } = audit;
    assert.ok(activeClassification, 'audit must classify journal.active');
    if (activeClassification.kind === 'none') {
      assert.equal(audit.journal.active, null);
    } else if (activeClassification.kind === 'pending_relay_completion') {
      assert.ok(audit.journal.active);
      assert.equal(activeClassification.record.phase, 'delivered_local');
      assert.equal(activeClassification.active.command_id, activeClassification.record.command_id);
      assert.match(activeClassification.active.remote_sha256, /^[0-9a-f]{40}$/i);
    } else if (activeClassification.kind === 'pending_remote_retirement') {
      assert.equal(activeClassification.record.phase, 'published_terminal');
    } else {
      assert.fail(`production journal active classification not allowed in audit: ${activeClassification.kind}`);
    }
  });
});
