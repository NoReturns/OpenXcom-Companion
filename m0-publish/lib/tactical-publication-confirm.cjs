'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { writeJsonAtomic } = require('./local-atomic.cjs');

const FILENAME = 'companion-tactical-publication-confirm.json';
const SCHEMA_VERSION = 1;

function writeTacticalPublicationConfirmAtomic(snapshotDir, payload, io = {}) {
  if (!snapshotDir) {
    return false;
  }
  const writeFileSync = io.writeFileSync ?? fs.writeFileSync;
  const renameSync = io.renameSync ?? fs.renameSync;
  const body = {
    schema_version: SCHEMA_VERSION,
    session_id: payload.session_id,
    turn: payload.turn,
    state_version: payload.state_version,
    snapshot_sha256: payload.snapshot_sha256,
    source: payload.source,
    confirmed_at_ms: payload.confirmed_at_ms ?? Date.now(),
  };
  if (payload.status) {
    body.status = payload.status;
  }
  const dest = path.join(snapshotDir, FILENAME);
  writeJsonAtomic(dest, body, writeFileSync, renameSync);
  return true;
}

module.exports = {
  FILENAME,
  writeTacticalPublicationConfirmAtomic,
};
