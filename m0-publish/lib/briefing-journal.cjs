'use strict';

const fs = require('node:fs');
const path = require('node:path');

const JOURNAL_VERSION = 1;

function journalPath(stateDir) {
  return path.join(stateDir, 'journal.json');
}

function loadJournal(stateDir, readFileSync = fs.readFileSync, existsSync = fs.existsSync) {
  const file = journalPath(stateDir);
  if (!existsSync(file)) {
    return { version: JOURNAL_VERSION, records: {} };
  }
  const raw = readFileSync(file, 'utf8');
  const value = JSON.parse(raw);
  if (value.version !== JOURNAL_VERSION || !value.records || typeof value.records !== 'object') {
    throw new Error('Briefing journal format mismatch');
  }
  return value;
}

function persistJournal(stateDir, journal, writeFileSync = fs.writeFileSync, renameSync = fs.renameSync) {
  fs.mkdirSync(stateDir, { recursive: true });
  const dest = journalPath(stateDir);
  const tmp = `${dest}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(journal)}\n`, 'utf8');
  renameSync(tmp, dest);
}

function getRecord(journal, requestId) {
  return journal.records[requestId] ?? null;
}

function isTerminalRecord(record) {
  if (!record) return false;
  if (record.status === 'published') return true;
  if (record.status === 'manual_upload_required') return true;
  if (record.terminal === true) return true;
  return false;
}

function markRecord(journal, requestId, patch) {
  journal.records[requestId] = {
    ...(journal.records[requestId] ?? {}),
    request_id: requestId,
    ...patch,
    updated_at: new Date().toISOString(),
  };
}

module.exports = {
  JOURNAL_VERSION,
  journalPath,
  loadJournal,
  persistJournal,
  getRecord,
  isTerminalRecord,
  markRecord,
};
