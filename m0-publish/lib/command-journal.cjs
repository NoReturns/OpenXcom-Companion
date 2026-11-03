'use strict';

const fs = require('node:fs');
const path = require('node:path');

const JOURNAL_VERSION = 1;

function journalPath(stateDir) {
  return path.join(stateDir, 'command-relay-journal.json');
}

function loadCommandJournal(stateDir, readFileSync = fs.readFileSync, existsSync = fs.existsSync) {
  const file = journalPath(stateDir);
  if (!existsSync(file)) {
    return { version: JOURNAL_VERSION, active: null, records: {} };
  }
  const raw = readFileSync(file, 'utf8');
  const value = JSON.parse(raw);
  if (value.version !== JOURNAL_VERSION || !value.records || typeof value.records !== 'object') {
    throw new Error('Command relay journal format mismatch');
  }
  return {
    version: JOURNAL_VERSION,
    active: value.active ?? null,
    records: value.records,
  };
}

function persistCommandJournal(stateDir, journal, writeFileSync = fs.writeFileSync, renameSync = fs.renameSync) {
  fs.mkdirSync(stateDir, { recursive: true });
  const dest = journalPath(stateDir);
  const tmp = `${dest}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(journal)}\n`, 'utf8');
  renameSync(tmp, dest);
}

function getCommandRecord(journal, commandId) {
  return journal.records[commandId] ?? null;
}

function isTerminalRelayRecord(record) {
  if (!record) return false;
  return record.phase === 'published_terminal' || record.phase === 'retired_remote';
}

function isRetiredRemoteRecord(record) {
  if (!record) return false;
  return record.phase === 'retired_remote';
}

function markCommandRecord(journal, commandId, patch) {
  journal.records[commandId] = {
    ...(journal.records[commandId] ?? {}),
    command_id: commandId,
    ...patch,
    updated_at: new Date().toISOString(),
  };
}

module.exports = {
  JOURNAL_VERSION,
  journalPath,
  loadCommandJournal,
  persistCommandJournal,
  getCommandRecord,
  isTerminalRelayRecord,
  isRetiredRemoteRecord,
  markCommandRecord,
};
