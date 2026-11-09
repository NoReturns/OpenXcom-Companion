'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  runSendOnce,
  createOnDemandRelayContext,
  SEND_PHASE,
  resolveOnDemandPaths,
} = require('../lib/companion-on-demand-relay.cjs');
const { writeJsonAtomic } = require('../lib/local-atomic.cjs');
const { isolatedCommandRelayStateDir } = require('../lib/relay-test-isolation.cjs');
const { assessStrategicSendReadiness } = require('../lib/strategic-publish.cjs');

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'm1-25e2-'));
}

describe('companion on-demand relay M1-25E2', () => {
  let root;
  let snapshotPath;

  let relayStateDir;

  beforeEach(() => {
    root = makeRoot();
    snapshotPath = path.join(root, 'tactical-live.yaml');
    fs.writeFileSync(snapshotPath, fs.readFileSync(path.join(__dirname, 'fixtures', 'valid-v5.yaml'), 'utf8'), 'utf8');
    relayStateDir = isolatedCommandRelayStateDir(root, 'relay-state');
  });

  it('strategic send without BI marker is not_ready', async () => {
    const paths = resolveOnDemandPaths(snapshotPath);
    const readiness = assessStrategicSendReadiness(paths, 'a'.repeat(32));
    assert.equal(readiness.ok, false);
    const ctx = createOnDemandRelayContext({ snapshotPath, commandRelayStateDir: relayStateDir, dryRun: true });
    const outcome = await runSendOnce(ctx, {
      request_id: 'a'.repeat(32),
      send_scope: 'strategic',
    });
    assert.equal(outcome.phase, SEND_PHASE.NOT_READY);
  });

  it('publishes unchanged snapshot when on-demand request_id is fresh', async () => {
    const paths = resolveOnDemandPaths(snapshotPath);
    const digest = crypto.createHash('sha256').update(fs.readFileSync(snapshotPath)).digest('hex');
    writeJsonAtomic(paths.tacticalSendMarkerPath, {
      schema_version: 1,
      briefing_request_id: 'b'.repeat(32),
      session_id: '0'.repeat(32),
      turn: 1,
      snapshot_sha256: digest,
      exported_at_ms: 1,
    });
    let publishCalls = 0;
    const ctx = createOnDemandRelayContext({
      snapshotPath,
      commandRelayStateDir: relayStateDir,
      dryRun: false,
      relayPublisher: {
        publishRelayState: async (relay) => {
          publishCalls += 1;
          assert.match(relay.request_id, /^[0-9a-f]{32}$/);
          return { skipped: false };
        },
      },
    });
    const pending = {
      request_id: 'c'.repeat(32),
      briefing_request_id: 'b'.repeat(32),
      send_scope: 'tactical',
    };
    const outcome = await runSendOnce(ctx, pending);
    assert.equal(outcome.phase, SEND_PHASE.SENT);
    assert.equal(publishCalls, 1);
  });

  it('repeated tactical send uses distinct on-demand request ids', async () => {
    const ids = new Set();
    for (let i = 0; i < 3; i += 1) {
      ids.add(`${i}`.repeat(32).slice(0, 32));
    }
    assert.equal(ids.size, 3);
  });
});
