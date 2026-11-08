'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createOnDemandRelayContext,
  runRetrieveOnce,
  RETRIEVE_PHASE,
} = require('../lib/companion-on-demand-relay.cjs');
const { writeTextAtomic } = require('../lib/local-atomic.cjs');
const {
  loadCommandJournal,
  persistCommandJournal,
  markCommandRecord,
} = require('../lib/command-journal.cjs');
const {
  fingerprintProductionCommandRelayJournal,
  assertProductionCommandRelayJournalUnchanged,
  isolatedCommandRelayStateDir,
  classifyProductionJournalActive,
} = require('../lib/relay-test-isolation.cjs');

const PENDING_COMMAND_ID = '2b737d8422bef12932d4586140b9abf7';
const PENDING_REMOTE_SHA = 'e1f2fb54b86d38183922de0cba2aaeb722882860';

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'm1-34d-'));
}

function seedPendingJournal(stateDir) {
  const journal = loadCommandJournal(stateDir);
  markCommandRecord(journal, PENDING_COMMAND_ID, {
    phase: 'delivered_local',
    remote_sha256: PENDING_REMOTE_SHA,
    delivered_at: '2026-11-04T22:05:15.225Z',
    delivered_command_snapshot_sha256: '89740bc122d294ac875a5c56222591f6296e43889bfed70ac5704996fc01306d',
    delivered_command_state_version: 14,
  });
  journal.active = {
    command_id: PENDING_COMMAND_ID,
    remote_sha256: PENDING_REMOTE_SHA,
    delivered_at: '2026-11-04T22:05:15.225Z',
  };
  persistCommandJournal(stateDir, journal);
}

describe('M1-34D pending transaction resume (fixture-isolated)', () => {
  let root;
  let snapshotPath;
  let relayStateDir;
  let productionBefore;

  beforeEach(() => {
    productionBefore = fingerprintProductionCommandRelayJournal();
    root = makeRoot();
    snapshotPath = path.join(root, 'tactical-live.yaml');
    fs.writeFileSync(
      snapshotPath,
      fs.readFileSync(path.join(__dirname, 'fixtures', 'valid-v5.yaml'), 'utf8'),
      'utf8',
    );
    relayStateDir = isolatedCommandRelayStateDir(root, 'relay-state');
  });

  afterEach(() => {
    assertProductionCommandRelayJournalUnchanged(
      productionBefore,
      fingerprintProductionCommandRelayJournal(),
    );
  });

  it('classifies live-style pending active as pending_relay_completion', () => {
    const journal = {
      active: {
        command_id: PENDING_COMMAND_ID,
        remote_sha256: PENDING_REMOTE_SHA,
        delivered_at: '2026-11-04T22:05:15.225Z',
      },
      records: {
        [PENDING_COMMAND_ID]: {
          command_id: PENDING_COMMAND_ID,
          phase: 'delivered_local',
          remote_sha256: PENDING_REMOTE_SHA,
        },
      },
    };
    const classification = classifyProductionJournalActive(journal);
    assert.equal(classification.kind, 'pending_relay_completion');
  });

  it('resumes publish without second deliverLocal and preserves FAILED status', async () => {
    const paths = require('../lib/companion-on-demand-relay.cjs').resolveOnDemandPaths(snapshotPath);
    const command = JSON.parse(fs.readFileSync(
      path.join(__dirname, 'fixtures', 'm1-34d-pending-command.json'),
      'utf8',
    ));
    const resultFixture = JSON.parse(fs.readFileSync(
      path.join(__dirname, 'fixtures', 'm1-34d-pending-result.json'),
      'utf8',
    ));

    seedPendingJournal(relayStateDir);
    writeTextAtomic(
      paths.localRelay.command,
      `${JSON.stringify(command, null, 2)}\n`,
      fs.writeFileSync,
      fs.renameSync,
    );
    writeTextAtomic(
      paths.localRelay.result,
      `${JSON.stringify(resultFixture, null, 2)}\n`,
      fs.writeFileSync,
      fs.renameSync,
    );

    let deliverCount = 0;
    let publishedPayload = null;
    let remoteCommand = {
      text: `${JSON.stringify(command, null, 2)}\n`,
      sha: PENDING_REMOTE_SHA,
    };

    const ctx = createOnDemandRelayContext({
      snapshotPath,
      commandRelayStateDir: relayStateDir,
      dryRun: false,
      contentClient: {
        paths: {},
        readFile: () => null,
        publishFile: async () => {},
        deleteFile: async () => {},
      },
    });
    const deliverOrig = ctx.commandWatcher.deliverLocal.bind(ctx.commandWatcher);
    ctx.commandWatcher.deliverLocal = (...args) => {
      deliverCount += 1;
      deliverOrig(...args);
    };
    ctx.commandWatcher.readRemoteCommand = async () => remoteCommand;
    ctx.commandWatcher.fetchRemoteResult = async () => null;
    ctx.commandWatcher.publishRemoteResult = async (result) => {
      publishedPayload = result;
    };
    ctx.commandWatcher.retireRemoteCommand = async () => {
      remoteCommand = null;
    };

    const outcome = await runRetrieveOnce(ctx, {
      transactionId: 'tx-m1-34d-resume-fixture',
      localWaitMs: 100,
      localPollMs: 5,
      followUpPollMs: 10,
      maxFollowUpPolls: 8,
    });

    assert.equal(outcome.phase, RETRIEVE_PHASE.COMPLETED);
    assert.equal(deliverCount, 0, 'must not deliverLocal again for pending delivered_local');
    assert.ok(publishedPayload, 'must publish terminal result');
    assert.equal(publishedPayload.command_id, PENDING_COMMAND_ID);
    assert.equal(publishedPayload.status, 'FAILED');
    assert.equal(publishedPayload.destination_reached, true);

    const tx = ctx.commandWatcher.getRetrieveTransactionState();
    assert.equal(tx.publishedResult, true);
    assert.equal(tx.retiredRemote, true);
    assert.equal(tx.completionKind, 'engine_reported');
    assert.equal(tx.deliveredCommandId, null, 'resume path publishes without new delivery in tx');
  });
});
