'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { RELAY_SHRINK_EXHAUSTED } = require('../lib/relay-payload-adaptive-shrink.cjs');
const { buildShrinkExhaustedRelay } = require('./helpers/oversized-relay-fixture.cjs');
const { publishRelayWithManualFallback } = require('../lib/briefing-relay-publish.cjs');
const {
  readManualUploadNotice,
  isActiveManualUploadNotice,
  MANUAL_UPLOAD_NOTICE_FILENAME,
} = require('../lib/companion-manual-upload-notice.cjs');
const {
  MANUAL_ARTIFACT_MAX_BYTES,
  buildManualIntelligenceArtifact,
  ManualUploadExportError,
} = require('../lib/manual-upload-export.cjs');
const { pruneManualExportDirectory } = require('../lib/companion-manual-export-retention.cjs');
const {
  fingerprintProductionCommandRelayJournal,
  assertProductionCommandRelayJournalUnchanged,
} = require('../lib/relay-test-isolation.cjs');

function disposableSnapshotTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm0-p3-step6-'));
  const snapshotDir = path.join(root, 'isolated-m0');
  fs.mkdirSync(snapshotDir, { recursive: true });
  const manualExports = path.join(snapshotDir, 'manual-exports');
  fs.mkdirSync(manualExports, { recursive: true });
  fs.writeFileSync(path.join(snapshotDir, 'tactical-live.yaml'), 'schemaVersion: 4\nturn: 1\n');
  fs.writeFileSync(
    path.join(snapshotDir, 'companion-tactical-send-marker.json'),
    JSON.stringify({ session_id: '0'.repeat(32), turn: 1 }),
  );
  return { root, snapshotDir, manualExports };
}

describe('M1 P3 step 6 — Node manual fallback integration (isolated)', () => {
  let journalBefore;

  before(() => {
    journalBefore = fingerprintProductionCommandRelayJournal();
  });

  after(() => {
    assertProductionCommandRelayJournalUnchanged(
      journalBefore,
      fingerprintProductionCommandRelayJournal(),
    );
  });

  it('relay shrink exhaustion writes notice and artifact without GitHub publish', async () => {
    const { snapshotDir, manualExports } = disposableSnapshotTree();
    const relay = buildShrinkExhaustedRelay();
    const publishRelayState = async () => {
      const err = new Error('shrink exhausted');
      err.code = RELAY_SHRINK_EXHAUSTED;
      err.initialBytes = 400_000;
      err.finalBytes = 270_000;
      err.steps = [{ step: 'terrain_map_brief_omit_last_resort' }];
      throw err;
    };

    const outcome = await publishRelayWithManualFallback({
      snapshotDir,
      relay,
      sessionId: relay.session_id,
      turn: relay.turn,
      requestId: 'req-step6-isolated',
      publishRelayState,
      log: () => {},
      exportedAtMs: Date.now(),
    });

    assert.equal(outcome.kind, 'manual_upload_required');
    assert.ok(outcome.exportResult?.path);
    assert.ok(fs.existsSync(outcome.exportResult.path));
    const notice = readManualUploadNotice(snapshotDir);
    assert.ok(isActiveManualUploadNotice(notice));
    assert.equal(notice.producer, 'node');
    assert.equal(notice.reason_code, RELAY_SHRINK_EXHAUSTED);
    assert.ok(notice.artifact_sha256);
    assert.ok(
      fs.readFileSync(outcome.exportResult.path, 'utf8').includes('"authoritative": false'),
      'manual relay artifact is read-only',
    );

    pruneManualExportDirectory(snapshotDir, manualExports, {
      extraProtected: [outcome.exportResult.path],
    });
    assert.ok(fs.existsSync(outcome.exportResult.path), 'retention keeps active artifact');
  });

  it('rejects manual artifacts above 4 MiB cap', () => {
    const relay = buildShrinkExhaustedRelay();
    const huge = { ...relay, tactical: { ...(relay.tactical ?? {}), padding: 'x'.repeat(MANUAL_ARTIFACT_MAX_BYTES) } };
    assert.throws(
      () => buildManualIntelligenceArtifact(huge, { requireShrinkExhausted: false, reasonCode: RELAY_SHRINK_EXHAUSTED }),
      (err) => err instanceof ManualUploadExportError && err.code === 'MANUAL_ARTIFACT_TOO_LARGE',
    );
  });

  it('ignores malformed notices without throwing', () => {
    const { snapshotDir } = disposableSnapshotTree();
    fs.writeFileSync(path.join(snapshotDir, MANUAL_UPLOAD_NOTICE_FILENAME), '{ broken', 'utf8');
    assert.equal(readManualUploadNotice(snapshotDir), null);
  });
});
