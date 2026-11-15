'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOnDemandRelayContext, resolveOnDemandPaths } = require('../lib/companion-on-demand-relay.cjs');
const {
  ingestLocalBattleAar,
  processBattleAarQueueOnce,
  processBattleAarRelayTick,
  validateBattleAarDocument,
  archiveRelPath,
  BATTLE_AAR_LOCAL_FILENAME,
  loadJournal,
  loadQueue,
} = require('../lib/battle-aar-relay-publish.cjs');
const { DEFAULT_BATTLE_AAR_PATH } = require('../lib/relay-config.cjs');
const { sha256HexLower } = require('../lib/briefing-snapshot.cjs');
const { isolatedCommandRelayStateDir } = require('../lib/relay-test-isolation.cjs');

const FIXTURE = path.join(__dirname, 'fixtures', 'minimal-battle-aar-finalized.json');

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'm1-aar-relay-'));
}

function writeFixtureAar(snapshotDir, mutate = null) {
  let text = fs.readFileSync(FIXTURE, 'utf8');
  let doc = JSON.parse(text);
  if (mutate) {
    doc = mutate(doc);
  }
  text = `${JSON.stringify(doc, null, 2)}\n`;
  fs.writeFileSync(path.join(snapshotDir, BATTLE_AAR_LOCAL_FILENAME), text, 'utf8');
  return { doc, digest: sha256HexLower(Buffer.from(text, 'utf8')) };
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

describe('companion battle AAR relay', () => {
  let root;
  let ctx;

  beforeEach(() => {
    root = makeRoot();
    ctx = makeCtx(root);
    ctx.bypassGhAuth = true;
  });

  it('rejects incomplete finalized reports', () => {
    writeFixtureAar(ctx.paths.snapshotDir, (doc) => {
      const copy = { ...doc, post_debrief: { ...doc.post_debrief } };
      delete copy.post_debrief.lost_in_service;
      return copy;
    });
    const ingest = ingestLocalBattleAar(ctx);
    assert.equal(ingest.ingested, false);
    assert.equal(ingest.reason, 'incomplete_report');
  });

  it('rejects non-finalized status', () => {
    writeFixtureAar(ctx.paths.snapshotDir, (doc) => ({ ...doc, status: 'phase_a_staged' }));
    const ingest = ingestLocalBattleAar(ctx);
    assert.equal(ingest.ingested, false);
    assert.equal(ingest.reason, 'not_finalized');
  });

  it('rejects campaign identity mismatch vs base intelligence', () => {
    const biPath = ctx.paths.baseIntelligencePath;
    fs.writeFileSync(
      biPath,
      JSON.stringify({ identity: { campaign_id: 'cccccccccccccccccccccccccccccccc' } }),
      'utf8',
    );
    writeFixtureAar(ctx.paths.snapshotDir);
    const ingest = ingestLocalBattleAar(ctx);
    assert.equal(ingest.ingested, false);
    assert.equal(ingest.reason, 'campaign_mismatch');
  });

  it('ingests and publishes to latest and archive with consistent envelope', async () => {
    const { doc } = writeFixtureAar(ctx.paths.snapshotDir);
    const ingest = ingestLocalBattleAar(ctx);
    assert.equal(ingest.ingested, true);

    const published = { latest: null, archive: null };
    ctx.relayContentClient = {
      readFile: () => null,
      publishFile: (archivePath, body) => {
        published.archive = { path: archivePath, body };
        return { skipped: false };
      },
    };
    ctx.publisher = {
      publishRelayDocument: async (envelope, options = {}) => {
        published.latest = { path: options.statePath, envelope };
        return { skipped: false };
      },
    };

    const outcome = await processBattleAarQueueOnce(ctx);
    assert.equal(outcome.ok, true);
    assert.equal(published.latest.path, DEFAULT_BATTLE_AAR_PATH);
    assert.equal(
      published.archive.path,
      archiveRelPath(doc.identity.campaign_id, doc.identity.tactical_battle_id, doc.identity.mission_statistics_id),
    );
    assert.equal(published.latest.envelope.report_id, doc.report_id);
    assert.equal(published.archive.body.includes(doc.report_id), true);
    assert.equal(published.latest.envelope.snapshot_id, doc.report_id);
    assert.equal(published.latest.envelope.type, 'battle_aar_compact');
    assert.equal(published.latest.envelope.debrief.wounded[0].recovery_days, 5);
    assert.equal('tactical_terminal' in published.latest.envelope, false);
    const archived = JSON.parse(published.archive.body);
    assert.equal('tactical_terminal' in archived, false);
    assert.equal('terminal_payload' in archived, false);
    assert.equal(archived.debrief.commendations.length, 1);
  });

  it('skips duplicate ingest after successful publish', async () => {
    writeFixtureAar(ctx.paths.snapshotDir);
    ingestLocalBattleAar(ctx);
    ctx.relayContentClient = {
      readFile: () => null,
      publishFile: () => ({ skipped: false }),
    };
    ctx.publisher = {
      publishRelayDocument: async () => ({ skipped: false }),
    };
    await processBattleAarQueueOnce(ctx);
    writeFixtureAar(ctx.paths.snapshotDir);
    const again = ingestLocalBattleAar(ctx);
    assert.equal(again.reason, 'already_published');
  });

  it('retains queue entry on GitHub outage and retries', async () => {
    writeFixtureAar(ctx.paths.snapshotDir);
    ingestLocalBattleAar(ctx);
    ctx.relayContentClient = {
      readFile: () => null,
      publishFile: () => {
        const err = new Error('GitHub API network failure.');
        err.code = 'NETWORK_FAILED';
        throw err;
      },
    };
  const first = await processBattleAarQueueOnce(ctx);
    assert.equal(first.ok, false);
    assert.ok(first.code === 'ARCHIVE_PUBLISH_FAILED' || first.code === 'NETWORK_FAILED');
    const queue = loadQueue(path.join(ctx.paths.snapshotDir, 'companion-battle-aar-pending-queue.json'));
    assert.equal(queue.entries.length, 1);
    assert.equal(queue.entries[0].attempts, 1);
  });

  it('queues multiple missions without overwriting pending artifacts', () => {
    const first = writeFixtureAar(ctx.paths.snapshotDir, (doc) => ({
      ...doc,
      report_id: '1'.repeat(64),
      identity: { ...doc.identity, mission_statistics_id: 1, tactical_battle_id: 'battle-1' },
    }));
    ingestLocalBattleAar(ctx);
    const second = writeFixtureAar(ctx.paths.snapshotDir, (doc) => ({
      ...doc,
      report_id: '2'.repeat(64),
      generation_id: '1731000000002',
      identity: { ...doc.identity, mission_statistics_id: 2, tactical_battle_id: 'battle-2' },
    }));
    ingestLocalBattleAar(ctx);
    const queue = loadQueue(path.join(ctx.paths.snapshotDir, 'companion-battle-aar-pending-queue.json'));
    assert.equal(queue.entries.length, 2);
    assert.equal(queue.entries[0].report_id, '1'.repeat(64));
    assert.equal(queue.entries[1].report_id, '2'.repeat(64));
    assert.ok(fs.existsSync(path.join(ctx.paths.snapshotDir, 'aar-produced', `${'1'.repeat(64)}.json`)));
    assert.ok(fs.existsSync(path.join(ctx.paths.snapshotDir, 'aar-produced', `${'2'.repeat(64)}.json`)));
    assert.notEqual(first.doc.identity.mission_statistics_id, second.doc.identity.mission_statistics_id);
  });

  it('daemon tick runs ingest before on-demand work without throwing', async () => {
    writeFixtureAar(ctx.paths.snapshotDir);
    ctx.relayContentClient = {
      readFile: () => null,
      publishFile: () => ({ skipped: false }),
    };
    ctx.publisher = {
      publishRelayDocument: async () => ({ skipped: false }),
    };
    const tick = await processBattleAarRelayTick(ctx);
    assert.equal(tick.ingest.ingested, true);
    assert.equal(tick.publish.ok, true);
  });

  it('validateBattleAarDocument accepts debrief-aligned lost and wounded blocks', () => {
    const doc = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    const v = validateBattleAarDocument(doc);
    assert.equal(v.ok, true);
    assert.ok(Array.isArray(doc.post_debrief.lost_in_service));
    assert.ok(Array.isArray(doc.post_debrief.wounded));
  });
});