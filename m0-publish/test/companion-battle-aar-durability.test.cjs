'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOnDemandRelayContext, resolveOnDemandPaths } = require('../lib/companion-on-demand-relay.cjs');
const {
  discoverProducedAarArtifacts,
  processBattleAarQueueOnce,
  processBattleAarRelayTick,
  archiveRelPath,
  PRODUCED_DIRNAME,
  loadQueue,
} = require('../lib/battle-aar-relay-publish.cjs');
const { DEFAULT_BATTLE_AAR_PATH } = require('../lib/relay-config.cjs');
const { sha256HexLower } = require('../lib/briefing-snapshot.cjs');
const { isolatedCommandRelayStateDir } = require('../lib/relay-test-isolation.cjs');

const FIXTURE = path.join(__dirname, 'fixtures', 'minimal-battle-aar-finalized.json');

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'm1-aar-durability-'));
}

function makeCtx(root) {
  const snapshotPath = path.join(root, 'tactical-live.yaml');
  fs.writeFileSync(snapshotPath, 'tactical: {}\n', 'utf8');
  const relayStateDir = isolatedCommandRelayStateDir(root, 'relay-state');
  return createOnDemandRelayContext({
    snapshotPath,
    commandRelayStateDir: relayStateDir,
    dryRun: false,
    bypassGhAuth: true,
    now: () => 1731000000001,
    log: () => {},
  });
}

function writeProduced(snapshotDir, mutate) {
  let doc = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  if (mutate) {
    doc = mutate(doc);
  }
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  const producedDir = path.join(snapshotDir, PRODUCED_DIRNAME);
  fs.mkdirSync(producedDir, { recursive: true });
  fs.writeFileSync(path.join(producedDir, `${doc.report_id}.json`), text, 'utf8');
  return doc;
}

describe('companion battle AAR durability', () => {
  let root;
  let ctx;

  beforeEach(() => {
    root = makeRoot();
    ctx = makeCtx(root);
    ctx.bypassGhAuth = true;
  });

  it('discovers two producer artifacts after offline gap (daemon restart)', async () => {
    const mission1 = writeProduced(ctx.paths.snapshotDir, (doc) => ({
      ...doc,
      report_id: '1'.repeat(64),
      finalized_at_ms: 1731000000001,
      generation_id: '1731000000001',
      identity: { ...doc.identity, mission_statistics_id: 1, tactical_battle_id: 'battle-offline-1' },
    }));
    const mission2 = writeProduced(ctx.paths.snapshotDir, (doc) => ({
      ...doc,
      report_id: '2'.repeat(64),
      finalized_at_ms: 1731000000002,
      generation_id: '1731000000002',
      identity: { ...doc.identity, mission_statistics_id: 2, tactical_battle_id: 'battle-offline-2' },
    }));

    const discover = discoverProducedAarArtifacts(ctx);
    assert.equal(discover.enqueued, 2);

    const publishedArchives = [];
    const latestReports = [];
    ctx.relayContentClient = {
      readFile: () => null,
      publishFile: (archivePath) => {
        publishedArchives.push(archivePath);
        return { skipped: false };
      },
    };
    ctx.publisher = {
      publishRelayDocument: async (envelope) => {
        latestReports.push(envelope.report_id);
        return { skipped: false };
      },
    };

    await processBattleAarQueueOnce(ctx);
    await processBattleAarQueueOnce(ctx);

    assert.equal(publishedArchives.length, 2);
    assert.equal(latestReports.length, 2);
    assert.equal(latestReports[latestReports.length - 1], mission2.report_id);
    assert.equal(
      publishedArchives[0],
      archiveRelPath(mission1.identity.campaign_id, mission1.identity.tactical_battle_id, mission1.identity.mission_statistics_id),
    );
    assert.equal(
      publishedArchives[1],
      archiveRelPath(mission2.identity.campaign_id, mission2.identity.tactical_battle_id, mission2.identity.mission_statistics_id),
    );
  });

  it('duplicate discovery does not create extra queue entries', () => {
    writeProduced(ctx.paths.snapshotDir);
    const first = discoverProducedAarArtifacts(ctx);
    const second = discoverProducedAarArtifacts(ctx);
    assert.equal(first.enqueued, 1);
    assert.equal(second.enqueued, 0);
    const queue = loadQueue(path.join(ctx.paths.snapshotDir, 'companion-battle-aar-pending-queue.json'));
    assert.equal(queue.entries.length, 1);
  });

  it('archive paths differ when mission_statistics_id collides but tactical_battle_id differs', () => {
    const campaign = 'b'.repeat(32);
    const pathA = archiveRelPath(campaign, 'tactical-alpha', 7);
    const pathB = archiveRelPath(campaign, 'tactical-beta', 7);
    assert.notEqual(pathA, pathB);
    assert.match(pathA, /tactical-alpha/);
    assert.match(pathB, /tactical-beta/);
  });

  it('failed upload retains produced artifacts on disk', async () => {
    writeProduced(ctx.paths.snapshotDir);
    discoverProducedAarArtifacts(ctx);
    ctx.relayContentClient = {
      readFile: () => null,
      publishFile: () => {
        const err = new Error('GitHub API network failure.');
        err.code = 'NETWORK_FAILED';
        throw err;
      },
    };
    const outcome = await processBattleAarQueueOnce(ctx);
    assert.equal(outcome.ok, false);
    const producedDir = path.join(ctx.paths.snapshotDir, PRODUCED_DIRNAME);
    const files = fs.readdirSync(producedDir).filter((f) => f.endsWith('.json'));
    assert.equal(files.length, 1);
    const queue = loadQueue(path.join(ctx.paths.snapshotDir, 'companion-battle-aar-pending-queue.json'));
    assert.equal(queue.entries.length, 1);
  });

  it('relay tick discovers produced artifacts without requiring latest pointer content', async () => {
    writeProduced(ctx.paths.snapshotDir, (doc) => ({
      ...doc,
      report_id: '3'.repeat(64),
      finalized_at_ms: 1731000000003,
    }));
    fs.writeFileSync(
      path.join(ctx.paths.snapshotDir, 'companion-battle-aar.json'),
      JSON.stringify({ stale: true }),
      'utf8',
    );
    ctx.relayContentClient = {
      readFile: () => null,
      publishFile: () => ({ skipped: false }),
    };
    ctx.publisher = {
      publishRelayDocument: async (envelope, options = {}) => {
        assert.equal(options.statePath, DEFAULT_BATTLE_AAR_PATH);
        assert.equal(envelope.report_id, '3'.repeat(64));
        return { skipped: false };
      },
    };
    const tick = await processBattleAarRelayTick(ctx);
    assert.equal(tick.discover.enqueued, 1);
    assert.equal(tick.publish.ok, true);
  });
});