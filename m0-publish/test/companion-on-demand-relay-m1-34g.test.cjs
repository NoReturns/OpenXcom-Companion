'use strict';

const { applySyntheticRelayEnv } = require('./helpers/synthetic-relay-env.cjs');
applySyntheticRelayEnv();

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createOnDemandRelayContext,
  runRetrieveOnce,
  processPendingRequest,
  isRetrieveEndToEndComplete,
  RETRIEVE_PHASE,
} = require('../lib/companion-on-demand-relay.cjs');
const { bindTransactionScopeToContext } = require('../lib/relay-transaction-trace.cjs');
const {
  buildRelayIsolationContract,
  buildRelayOptionsFromConfig,
  PRODUCTION_COOPERATIVE_RELAY,
} = require('../lib/relay-isolation-config.cjs');
const {
  publishRemoteContentFile,
  DEFAULTS,
  RELAY_CONTENT_PATHS,
} = require('../lib/github-relay.cjs');
const { writeTextAtomic } = require('../lib/local-atomic.cjs');
const {
  loadCommandJournal,
  persistCommandJournal,
  markCommandRecord,
  getCommandRecord,
} = require('../lib/command-journal.cjs');
const {
  fingerprintProductionCommandRelayJournal,
  assertProductionCommandRelayJournalUnchanged,
  isolatedCommandRelayStateDir,
} = require('../lib/relay-test-isolation.cjs');
const { createGhApiCallLog } = require('../lib/github-api-instrumentation.cjs');
const { createRelayTransactionTrace } = require('../lib/relay-transaction-trace.cjs');

const PENDING_COMMAND_ID = '2b737d8422bef12932d4586140b9abf7';
const PENDING_REMOTE_SHA = 'e1f2fb54b86d38183922de0cba2aaeb722882860';

const ISOLATED_CONFIG = {
  schema_version: 1,
  repo: 'ExampleOrg/OpenXcom-Relay-M134G-Test',
  branch: 'main',
  state_path: 'm0-g/state.json',
  content_paths: {
    tacticalCommand: 'm0-g/tactical-command.json',
    tacticalResult: 'm0-g/tactical-result.json',
    terrainQuery: 'm0-g/terrain-query.json',
    terrainQueryResult: 'm0-g/terrain-query-result.json',
  },
};

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'm1-34g-'));
}

function isolatedContractAndOptions() {
  const contract = buildRelayIsolationContract(ISOLATED_CONFIG);
  const relayOptions = buildRelayOptionsFromConfig(ISOLATED_CONFIG);
  return { contract, relayOptions };
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

function seedRecoveryFixture(root) {
  const snapshotPath = path.join(root, 'tactical-live.yaml');
  fs.writeFileSync(
    snapshotPath,
    fs.readFileSync(path.join(__dirname, 'fixtures', 'valid-v5.yaml'), 'utf8'),
    'utf8',
  );
  const paths = require('../lib/companion-on-demand-relay.cjs').resolveOnDemandPaths(snapshotPath);
  const relayStateDir = isolatedCommandRelayStateDir(root, 'relay-state');
  const resultFixture = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'fixtures', 'm1-34d-pending-result.json'),
    'utf8',
  ));

  seedPendingJournal(relayStateDir);
  writeTextAtomic(
    paths.localRelay.result,
    `${JSON.stringify(resultFixture, null, 2)}\n`,
    fs.writeFileSync,
    fs.renameSync,
  );

  return { snapshotPath, paths, relayStateDir, resultFixture };
}

function attachTrace(ctx) {
  const events = [];
  const trace = {
    record(phase, detail = {}) {
      events.push({ phase, ...detail });
    },
  };
  ctx.transactionTrace = trace;
  ctx.commandWatcher.transactionTrace = trace;
  return events;
}

describe('M1-34G isolation contract and recovery', () => {
  let productionBefore;

  beforeEach(() => {
    productionBefore = fingerprintProductionCommandRelayJournal();
  });

  afterEach(() => {
    assertProductionCommandRelayJournalUnchanged(
      productionBefore,
      fingerprintProductionCommandRelayJournal(),
    );
  });

  it('N1: missing relayOptions on rebind throws before GitHub client use', () => {
    const { contract } = isolatedContractAndOptions();
    const root = makeRoot();
    const { snapshotPath, relayStateDir } = seedRecoveryFixture(root);
    const ctx = createOnDemandRelayContext({
      snapshotPath,
      commandRelayStateDir: relayStateDir,
      relayIsolationContract: contract,
      requireRelayIsolation: true,
    });
    const trace = createRelayTransactionTrace({ requestId: 'n1', action: 'retrieve', snapshotDir: root });
    assert.throws(
      () => bindTransactionScopeToContext(ctx, {
        requestId: 'n1',
        trace,
        apiCallLog: createGhApiCallLog({ transactionId: 'n1' }),
        preserveWatcherIo: false,
      }),
      (err) => err.code === 'RELAY_ISOLATION_CONTRACT_VIOLATION',
    );
  });

  it('N2: production repo in rebuilt relayOptions violates contract', () => {
    const { contract, relayOptions } = isolatedContractAndOptions();
    const root = makeRoot();
    const { snapshotPath, relayStateDir } = seedRecoveryFixture(root);
    const ctx = createOnDemandRelayContext({
      snapshotPath,
      commandRelayStateDir: relayStateDir,
      relayOptions: {
        ...relayOptions,
        repo: DEFAULTS.repo,
        branch: DEFAULTS.branch,
      },
      relayIsolationContract: contract,
      requireRelayIsolation: true,
    });
    const trace = createRelayTransactionTrace({ requestId: 'n2', action: 'retrieve', snapshotDir: root });
    assert.throws(
      () => bindTransactionScopeToContext(ctx, {
        requestId: 'n2',
        trace,
        apiCallLog: createGhApiCallLog({ transactionId: 'n2' }),
        preserveWatcherIo: false,
      }),
      (err) => err.code === 'RELAY_ISOLATION_CONTRACT_VIOLATION',
    );
  });

  it('N3: client reconstruction dropping contentPaths violates contract', () => {
    const { contract, relayOptions } = isolatedContractAndOptions();
    const root = makeRoot();
    const { snapshotPath, relayStateDir } = seedRecoveryFixture(root);
    const stripped = { ...relayOptions };
    delete stripped.contentPaths;
    const ctx = createOnDemandRelayContext({
      snapshotPath,
      commandRelayStateDir: relayStateDir,
      relayOptions: stripped,
      relayIsolationContract: contract,
      requireRelayIsolation: true,
    });
    const trace = createRelayTransactionTrace({ requestId: 'n3', action: 'retrieve', snapshotDir: root });
    assert.throws(
      () => bindTransactionScopeToContext(ctx, {
        requestId: 'n3',
        trace,
        apiCallLog: createGhApiCallLog({ transactionId: 'n3' }),
        preserveWatcherIo: false,
      }),
      (err) => err.code === 'RELAY_ISOLATION_CONTRACT_VIOLATION',
    );
  });

  it('N4: isolationEnforced blocks production cooperative mutation', () => {
    assert.throws(
      () => publishRemoteContentFile(
        {
          repo: PRODUCTION_COOPERATIVE_RELAY.repo,
          branch: PRODUCTION_COOPERATIVE_RELAY.branch,
          isolationEnforced: true,
          maxRemoteBytes: 16 * 1024,
          ghApi: () => {
            throw new Error('ghApi must not be called');
          },
        },
        RELAY_CONTENT_PATHS.tacticalCommand,
        '{}\n',
        'test',
      ),
      /Refusing isolated-enforced GitHub mutation/,
    );
  });

  it('N5/N5b: recovery from delivered_local with absent inbox publishes FAILED then marks retired', async () => {
    const root = makeRoot();
    const { snapshotPath, relayStateDir, resultFixture } = seedRecoveryFixture(root);

    let deliverCount = 0;
    let publishCount = 0;
    let deleteRemoteCount = 0;
    const stepOrder = [];
    let remoteResult = {
      value: {
        command_id: PENDING_COMMAND_ID,
        status: 'REJECTED',
        sidecar_reject_code: 'SIDECAR_VALIDATION',
      },
      sha: 'wrong-result-sha',
    };

    const ctx = createOnDemandRelayContext({
      snapshotPath,
      commandRelayStateDir: relayStateDir,
      dryRun: false,
      contentClient: { paths: {}, readFile: () => null, publishFile: async () => {}, deleteFile: async () => {} },
    });
    const events = attachTrace(ctx);

    const deliverOrig = ctx.commandWatcher.deliverLocal.bind(ctx.commandWatcher);
    ctx.commandWatcher.deliverLocal = (...args) => {
      deliverCount += 1;
      return deliverOrig(...args);
    };
    ctx.commandWatcher.readRemoteCommand = async () => null;
    ctx.commandWatcher.fetchRemoteResult = async () => remoteResult;
    ctx.commandWatcher.publishRemoteResult = async (result) => {
      publishCount += 1;
      stepOrder.push('publish');
      assert.deepEqual(
        JSON.parse(JSON.stringify(result)),
        JSON.parse(JSON.stringify(resultFixture)),
        'engine FAILED payload must be published unchanged',
      );
      remoteResult = { value: result, sha: 'published-failed-sha' };
    };
    ctx.commandWatcher.retireRemoteCommand = async () => {
      deleteRemoteCount += 1;
      stepOrder.push('delete');
    };

    const markRetiredOrig = ctx.commandWatcher._markRetiredRemote.bind(ctx.commandWatcher);
    ctx.commandWatcher._markRetiredRemote = (journal, commandId, patch) => {
      stepOrder.push('retired');
      return markRetiredOrig(journal, commandId, patch);
    };

    const outcome = await runRetrieveOnce(ctx, {
      transactionId: 'tx-m1-34g-recovery',
      localWaitMs: 50,
      followUpPollMs: 10,
      maxFollowUpPolls: 6,
    });

    assert.equal(outcome.phase, RETRIEVE_PHASE.COMPLETED);
    assert.equal(deliverCount, 0);
    assert.equal(publishCount, 1);
    assert.equal(deleteRemoteCount, 0, 'absent inbox must mark_retired, not DELETE');

    const publishIdx = stepOrder.indexOf('publish');
    const retireIdx = stepOrder.indexOf('retired');
    assert.ok(publishIdx >= 0 && retireIdx > publishIdx, `order was ${stepOrder.join(',')}`);

    const journal = loadCommandJournal(relayStateDir);
    assert.equal(journal.active, null);
    const record = getCommandRecord(journal, PENDING_COMMAND_ID);
    assert.equal(record.phase, 'retired_remote');
    assert.equal(record.status, 'FAILED');

    const tx = ctx.commandWatcher.getRetrieveTransactionState();
    assert.equal(tx.completionKind, 'engine_reported');
    assert.ok(isRetrieveEndToEndComplete(tx));
    assert.ok(events.some((e) => e.phase === 'remote_result_published'));
    assert.ok(events.some((e) => e.phase === 'remote_command_marked_retired'));

    publishCount = 0;
    const outcome2 = await runRetrieveOnce(ctx, {
      transactionId: 'tx-m1-34g-recovery-idempotent',
      localWaitMs: 50,
      followUpPollMs: 10,
      maxFollowUpPolls: 4,
    });
    assert.equal(publishCount, 0, 'second recovery must not republish');
    assert.equal(deliverCount, 0);
    assert.equal(getCommandRecord(loadCommandJournal(relayStateDir), PENDING_COMMAND_ID).phase, 'retired_remote');
    assert.notEqual(outcome2.phase, RETRIEVE_PHASE.FAILED);
  });

  it('N6: sidecar_rejected is not cooperative retrieve complete', async () => {
    const root = makeRoot();
    const snapshotPath = path.join(root, 'tactical-live.yaml');
    fs.writeFileSync(
      snapshotPath,
      fs.readFileSync(path.join(__dirname, 'fixtures', 'valid-v5.yaml'), 'utf8'),
      'utf8',
    );
    const relayStateDir = isolatedCommandRelayStateDir(root, 'relay-state');
    const paths = require('../lib/companion-on-demand-relay.cjs').resolveOnDemandPaths(snapshotPath);
    const command = JSON.parse(fs.readFileSync(
      path.join(__dirname, 'fixtures', 'm1-34d-pending-command.json'),
      'utf8',
    ));
    command.snapshot_sha256 = 'intentionally-wrong-for-sidecar-reject';

    const ctx = createOnDemandRelayContext({
      snapshotPath,
      commandRelayStateDir: relayStateDir,
      contentClient: { paths: {}, readFile: () => null, publishFile: async () => {}, deleteFile: async () => {} },
    });

    let publishedStatus = null;
    ctx.commandWatcher.readRemoteCommand = async () => ({
      text: `${JSON.stringify(command, null, 2)}\n`,
      sha: 'remote-sha-sidecar',
    });
    ctx.commandWatcher.fetchRemoteResult = async () => null;
    ctx.commandWatcher.publishRemoteResult = async (result) => {
      publishedStatus = result.status;
    };
    ctx.commandWatcher.retireRemoteCommand = async () => {};

    const outcome = await runRetrieveOnce(ctx, {
      transactionId: 'tx-m1-34g-sidecar-reject',
      localWaitMs: 50,
      followUpPollMs: 10,
      maxFollowUpPolls: 4,
    });

    const tx = ctx.commandWatcher.getRetrieveTransactionState();
    assert.equal(publishedStatus, 'REJECTED');
    assert.equal(tx.completionKind, 'sidecar_rejected');
    assert.equal(tx.publishedResult, true);
    assert.equal(tx.publishedCommandId, command.command_id);
    assert.equal(tx.sidecarRejectCode, 'SIDECAR_VALIDATION');
    assert.ok(!isRetrieveEndToEndComplete(tx));
    assert.equal(outcome.phase, RETRIEVE_PHASE.FAILED);
    assert.match(outcome.message, /Sidecar rejected/i);
  });

  it('N7: processPendingRequest with isolation contract never touches production journal', async () => {
    const { contract, relayOptions } = isolatedContractAndOptions();
    const root = makeRoot();
    const { snapshotPath, relayStateDir } = seedRecoveryFixture(root);
    const paths = require('../lib/companion-on-demand-relay.cjs').resolveOnDemandPaths(snapshotPath);

    const ctx = createOnDemandRelayContext({
      snapshotPath,
      commandRelayStateDir: relayStateDir,
      relayOptions,
      relayIsolationContract: contract,
      requireRelayIsolation: true,
      contentClient: {
        paths: relayOptions.contentPaths,
        readFile: () => null,
        publishFile: async () => {},
        deleteFile: async () => {},
      },
    });
    ctx.commandWatcher.readRemoteCommand = async () => null;
    ctx.commandWatcher.fetchRemoteResult = async () => null;
    ctx.commandWatcher.publishRemoteResult = async () => {};
    ctx.commandWatcher.retireRemoteCommand = async () => {
      throw new Error('must not delete remote inbox during recovery fixture');
    };

    writeTextAtomic(
      paths.requestPath,
      `${JSON.stringify({ request_id: 'req-n7', action: 'retrieve', status: 'pending' }, null, 2)}\n`,
      fs.writeFileSync,
      fs.renameSync,
    );

    const before = fingerprintProductionCommandRelayJournal();
    await processPendingRequest(ctx, { preserveWatcherIo: true });
    assertProductionCommandRelayJournalUnchanged(before, fingerprintProductionCommandRelayJournal());
  });
});
