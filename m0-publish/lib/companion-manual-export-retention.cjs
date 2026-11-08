'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isActiveManualUploadNotice, readManualUploadNotice } = require('./companion-manual-upload-notice.cjs');

/** Keep protected artifacts plus this many additional newest eligible files. */
const MANUAL_EXPORT_KEEP_ADDITIONAL_RECENT = 3;

const ELIGIBLE_PREFIXES = ['engine-v5_', 'relay-manual_']; // relay-manual_ is 13 characters

function isEligibleManualExportFilename(name) {
  if (typeof name !== 'string' || !name.endsWith('.json')) {
    return false;
  }
  return ELIGIBLE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function parseExportedAtMsFromManualFilename(filename) {
  if (!isEligibleManualExportFilename(filename)) {
    return null;
  }
  const parts = filename.split('_');
  if (parts.length < 4) {
    return null;
  }
  const turnToken = parts[parts.length - 3];
  const msToken = parts[parts.length - 2];
  if (!turnToken.startsWith('t')) {
    return null;
  }
  const ms = Number(msToken);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

function collectProtectedPathsFromNotice(snapshotDir, io = {}) {
  const notice = readManualUploadNotice(snapshotDir, io);
  if (!isActiveManualUploadNotice(notice) || typeof notice.artifact_path !== 'string') {
    return [];
  }
  return [path.resolve(notice.artifact_path)];
}

function normalizePathKey(filePath) {
  return path.resolve(filePath).toLowerCase();
}

/**
 * @param {string} snapshotDir
 * @param {string} exportDir
 * @param {{ extraProtected?: string[], io?: object }} [options]
 */
function pruneManualExportDirectory(snapshotDir, exportDir, options = {}) {
  const existsSync = options.io?.existsSync ?? fs.existsSync;
  const readdirSync = options.io?.readdirSync ?? fs.readdirSync;
  const unlinkSync = options.io?.unlinkSync ?? fs.unlinkSync;
  const statSync = options.io?.statSync ?? fs.statSync;

  const result = { ok: true, candidates: 0, deleted: 0, retained: 0 };
  if (!exportDir || !existsSync(exportDir)) {
    return result;
  }

  let names;
  try {
    names = readdirSync(exportDir);
  } catch {
    return result;
  }

  const eligible = names.filter((name) => {
    try {
      return statSync(path.join(exportDir, name)).isFile() && isEligibleManualExportFilename(name);
    } catch {
      return false;
    }
  });
  result.candidates = eligible.length;

  const protectedKeys = new Set();
  for (const p of collectProtectedPathsFromNotice(snapshotDir, options.io)) {
    protectedKeys.add(normalizePathKey(p));
  }
  for (const p of options.extraProtected ?? []) {
    if (typeof p === 'string' && p.length > 0) {
      protectedKeys.add(normalizePathKey(p));
    }
  }

  const ranked = eligible.map((filename) => {
    const fullPath = path.join(exportDir, filename);
    const exportedAtMs = parseExportedAtMsFromManualFilename(filename) ?? 0;
    return {
      filename,
      fullPath,
      exportedAtMs,
      protectedFile: protectedKeys.has(normalizePathKey(fullPath)),
    };
  });

  ranked.sort((a, b) => {
    if (b.exportedAtMs !== a.exportedAtMs) {
      return b.exportedAtMs - a.exportedAtMs;
    }
    return b.filename.localeCompare(a.filename);
  });

  let additionalKept = 0;
  for (const entry of ranked) {
    if (entry.protectedFile) {
      result.retained += 1;
      continue;
    }
    if (additionalKept < MANUAL_EXPORT_KEEP_ADDITIONAL_RECENT) {
      additionalKept += 1;
      result.retained += 1;
      continue;
    }
    try {
      unlinkSync(entry.fullPath);
      result.deleted += 1;
    } catch {
      // leave file in place
    }
  }

  return result;
}

module.exports = {
  MANUAL_EXPORT_KEEP_ADDITIONAL_RECENT,
  isEligibleManualExportFilename,
  parseExportedAtMsFromManualFilename,
  collectProtectedPathsFromNotice,
  pruneManualExportDirectory,
};
