'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');
const {
  isEligibleManualExportFilename,
  parseExportedAtMsFromManualFilename,
  pruneManualExportDirectory,
} = require('../lib/companion-manual-export-retention.cjs');
const { MANUAL_UPLOAD_NOTICE_FILENAME } = require('../lib/companion-manual-upload-notice.cjs');

function filenameForMs(ms) {
  return `relay-manual_abcd1234_t2_${ms}_snap00000001.json`;
}

describe('manual export retention', () => {
  it('parses eligible relay filenames', () => {
    assert.equal(isEligibleManualExportFilename('relay-manual_x_t1_99_a.json'), true);
    assert.equal(parseExportedAtMsFromManualFilename('relay-manual_x_t1_99_a.json'), 99);
    assert.equal(isEligibleManualExportFilename('readme.txt'), false);
  });

  it('prunes while keeping active notice artifact and recent set', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm0-retention-'));
    const exportDir = path.join(root, 'manual-exports');
    fs.mkdirSync(exportDir, { recursive: true });
    const protectedFile = path.join(exportDir, filenameForMs(1000));
    fs.writeFileSync(protectedFile, '{}');
    for (let ms = 2000; ms <= 7000; ms += 1000) {
      fs.writeFileSync(path.join(exportDir, filenameForMs(ms)), '{}');
    }
    fs.writeFileSync(
      path.join(root, MANUAL_UPLOAD_NOTICE_FILENAME),
      JSON.stringify({
        active: true,
        producer: 'node',
        reason_code: 'RELAY_SHRINK_EXHAUSTED',
        artifact_path: protectedFile,
        session_id: 'sess',
        turn: 2,
      }),
    );
    const result = pruneManualExportDirectory(root, exportDir, { extraProtected: [protectedFile] });
    assert.equal(result.ok, true);
    assert.ok(result.deleted >= 2);
    assert.ok(fs.existsSync(protectedFile));
  });

  it('tolerates missing export directory without touching production paths', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm0-retention-miss-'));
    const result = pruneManualExportDirectory(root, path.join(root, 'missing'));
    assert.equal(result.deleted, 0);
  });
});
