'use strict';

const crypto = require('node:crypto');
const { ValidationError, loadAndValidateSnapshotFromText } = require('./tactical-publish.cjs');

class BriefingSnapshotError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'BriefingSnapshotError';
    this.code = code ?? 'SNAPSHOT_ERROR';
  }
}

function sha256HexLower(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function readSnapshotByteBuffer(readFileSync, snapshotPath) {
  const bytes = readFileSync(snapshotPath);
  if (!Buffer.isBuffer(bytes)) {
    return Buffer.from(bytes, 'utf8');
  }
  return Buffer.from(bytes);
}

function verifyBriefingSnapshot({ request, snapshotBytes, yaml }) {
  if (!Buffer.isBuffer(snapshotBytes)) {
    throw new BriefingSnapshotError('snapshot bytes must be a Buffer', 'INTERNAL');
  }
  const digest = sha256HexLower(snapshotBytes);
  if (digest !== request.snapshot_sha256) {
    throw new BriefingSnapshotError(
      `snapshot_sha256 mismatch: file digest ${digest.slice(0, 12)}… does not match request ${request.snapshot_sha256.slice(0, 12)}…`,
      'SNAPSHOT_HASH_MISMATCH'
    );
  }

  const text = snapshotBytes.toString('utf8');
  let tactical;
  try {
    tactical = loadAndValidateSnapshotFromText(text, yaml);
  } catch (error) {
    const message = error instanceof ValidationError ? error.message : String(error);
    throw new BriefingSnapshotError(message, 'SNAPSHOT_VALIDATION');
  }

  if (tactical.schemaVersion !== 4 && tactical.schemaVersion !== 5) {
    throw new BriefingSnapshotError('briefing requires schemaVersion 4 or 5 snapshot', 'SNAPSHOT_SCHEMA');
  }
  if (!tactical.eventLog || typeof tactical.eventLog.sessionId !== 'string') {
    throw new BriefingSnapshotError('eventLog.sessionId required for briefing', 'SNAPSHOT_SESSION');
  }
  if (tactical.turn !== request.turn) {
    throw new BriefingSnapshotError(
      `turn mismatch: snapshot turn ${tactical.turn} does not match request turn ${request.turn}`,
      'TURN_MISMATCH'
    );
  }
  if (tactical.eventLog.sessionId !== request.session_id) {
    throw new BriefingSnapshotError(
      'session_id mismatch: eventLog.sessionId does not match request.session_id',
      'SESSION_MISMATCH'
    );
  }

  return { tactical, digest, text };
}

module.exports = {
  BriefingSnapshotError,
  sha256HexLower,
  readSnapshotByteBuffer,
  verifyBriefingSnapshot,
};
