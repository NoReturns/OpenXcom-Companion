'use strict';

const fs = require('node:fs');
const path = require('node:path');

const JOURNAL_VERSION = 1;

function journalPath(stateDir) {
  return path.join(stateDir, 'terrain-query-relay-journal.json');
}

function loadQueryJournal(stateDir, readFileSync = fs.readFileSync, existsSync = fs.existsSync) {
  const file = journalPath(stateDir);
  if (!existsSync(file)) {
    return { version: JOURNAL_VERSION, records: {} };
  }
  const raw = readFileSync(file, 'utf8');
  const value = JSON.parse(raw);
  if (value.version !== JOURNAL_VERSION || !value.records || typeof value.records !== 'object') {
    throw new Error('Terrain query relay journal format mismatch');
  }
  return value;
}

function persistQueryJournal(stateDir, journal, writeFileSync = fs.writeFileSync, renameSync = fs.renameSync) {
  fs.mkdirSync(stateDir, { recursive: true });
  const dest = journalPath(stateDir);
  const tmp = `${dest}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(journal)}\n`, 'utf8');
  renameSync(tmp, dest);
}

function queryKeyFromDigest(remoteSha, snapshotId) {
  return `${snapshotId.slice(0, 16)}:${remoteSha.slice(0, 16)}`;
}

function isTerminalQueryRecord(record) {
  return record && record.phase === 'published';
}

module.exports = {
  JOURNAL_VERSION,
  journalPath,
  loadQueryJournal,
  persistQueryJournal,
  queryKeyFromDigest,
  isTerminalQueryRecord,
};
