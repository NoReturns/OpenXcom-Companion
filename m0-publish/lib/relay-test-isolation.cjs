'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_COMMAND_RELAY_STATE_DIR } = require('./companion-relay-launcher.cjs');
const { journalPath } = require('./command-journal.cjs');

function isNodeTestProcess() {
  return Boolean(process.env.NODE_TEST_CONTEXT);
}

/** True when this process was started by `node --test …/something.test.cjs` (not a spawned daemon). */
function isDirectNodeTestEntrypoint() {
  if (!isNodeTestProcess()) {
    return false;
  }
  return process.argv.some((arg) => /\.test\.(cjs|js|mjs)$/.test(arg));
}

function getProductionCommandRelayJournalPath() {
  return journalPath(DEFAULT_COMMAND_RELAY_STATE_DIR);
}

function fingerprintProductionCommandRelayJournal() {
  const filePath = getProductionCommandRelayJournalPath();
  if (!fs.existsSync(filePath)) {
    return { filePath, exists: false, sha256: null, byteLength: 0, mtimeMs: null };
  }
  const bytes = fs.readFileSync(filePath);
  return {
    filePath,
    exists: true,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    byteLength: bytes.length,
    mtimeMs: fs.statSync(filePath).mtimeMs,
  };
}

function assertProductionCommandRelayJournalUnchanged(before, after) {
  assertFingerprint(before, 'before');
  assertFingerprint(after, 'after');
  if (before.sha256 !== after.sha256) {
    throw new Error(
      `Production command-relay journal changed during tests (${before.filePath}): `
      + `sha256 ${before.sha256} -> ${after.sha256}, bytes ${before.byteLength} -> ${after.byteLength}`,
    );
  }
}

function assertFingerprint(fp, label) {
  if (!fp || typeof fp.filePath !== 'string') {
    throw new Error(`Missing ${label} production journal fingerprint`);
  }
}

function isolatedCommandRelayStateDir(root, label = 'relay-state') {
  return path.join(root, label);
}

function daemonCommandRelayStateDirCliArgs(stateDir) {
  if (!stateDir) {
    return [];
  }
  return ['--command-relay-state-dir', path.resolve(stateDir)];
}

function assertSubprocessRelayStateDirIsolated(relayStateDir) {
  const productionJournal = getProductionCommandRelayJournalPath();
  const isolatedJournal = journalPath(path.resolve(relayStateDir));
  if (path.resolve(isolatedJournal) === path.resolve(productionJournal)) {
    throw new Error(`Subprocess relay state dir must not be production journal path (${productionJournal})`);
  }
}

function assertCommandRelayStateDirForTests(options = {}) {
  if (!isDirectNodeTestEntrypoint()) {
    return;
  }
  if (options.allowProductionCommandRelayState) {
    return;
  }
  if (options.commandRelayStateDir) {
    return;
  }
  throw new Error(
    'Node tests must pass commandRelayStateDir (isolated temp directory); '
    + `refusing default production journal at ${getProductionCommandRelayJournalPath()}.`,
  );
}

/** Heuristic: M1-25G2-style synthetic ids and placeholder shas written by relay tests. */
function isLikelySyntheticJournalRecord(record) {
  if (!record || typeof record !== 'object') {
    return false;
  }
  const id = String(record.command_id || '');
  if (/^([0-9a-f])\1{31}$/.test(id)) {
    return true;
  }
  if (typeof record.remote_sha256 === 'string' && /^sha-[0-9a-f]{8}$/.test(record.remote_sha256)) {
    return true;
  }
  if (record.remote_sha256 === 'sha-live') {
    return true;
  }
  return false;
}

function auditProductionCommandRelayJournal() {
  const filePath = getProductionCommandRelayJournalPath();
  if (!fs.existsSync(filePath)) {
    return { filePath, records: [], synthetic: [], inconsistent: [] };
  }
  const journal = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const records = Object.values(journal.records || {});
  const synthetic = records.filter((record) => isLikelySyntheticJournalRecord(record));
  const inconsistent = records.filter((record) => {
    const phase = record.phase;
    const hasRetirementClose = Boolean(record.retirement_closed_at || record.retirement_closed_reason);
    if (hasRetirementClose && phase !== 'retirement_closed') {
      return true;
    }
    if (phase === 'published_terminal' && record.retirement_closed_reason) {
      return true;
    }
    return false;
  });
  return { filePath, journal, records, synthetic, inconsistent };
}

module.exports = {
  isNodeTestProcess,
  isDirectNodeTestEntrypoint,
  getProductionCommandRelayJournalPath,
  fingerprintProductionCommandRelayJournal,
  assertProductionCommandRelayJournalUnchanged,
  isolatedCommandRelayStateDir,
  daemonCommandRelayStateDirCliArgs,
  assertSubprocessRelayStateDirIsolated,
  assertCommandRelayStateDirForTests,
  isLikelySyntheticJournalRecord,
  auditProductionCommandRelayJournal,
};
