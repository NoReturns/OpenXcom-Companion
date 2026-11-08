'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { companionRuntimeLayout } = require('./companion-canonical-runtime.cjs');
const {
  PRODUCTION_COOPERATIVE_RELAY,
} = require('./relay-isolation-config.cjs');
const {
  createRelayContentClient,
  RELAY_CONTENT_PATHS,
} = require('./github-relay.cjs');
const {
  fingerprintProductionCommandRelayJournal,
  assertProductionCommandRelayJournalUnchanged,
} = require('./relay-test-isolation.cjs');

const PRODUCTION_LOCAL_JSON_WATCHLIST = [
  'tactical-command.json',
  'tactical-result.json',
  'companion-on-demand-request.json',
  'companion-on-demand-status.json',
  'tactical-command-journal.json',
];

function sha256File(filePath) {
  if (!fs.existsSync(filePath)) {
    return { filePath, exists: false, sha256: null, byteLength: 0 };
  }
  const bytes = fs.readFileSync(filePath);
  return {
    filePath,
    exists: true,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase(),
    byteLength: bytes.length,
  };
}

function fingerprintProductionLocalRelayJson(repoRoot = companionRuntimeLayout().repoRoot) {
  const layout = companionRuntimeLayout(repoRoot);
  const snapshotDir = layout.snapshotDir;
  const files = {};
  for (const name of PRODUCTION_LOCAL_JSON_WATCHLIST) {
    const fp = sha256File(path.join(snapshotDir, name));
    files[name] = fp;
  }
  return { snapshotDir, files };
}

function assertProductionLocalRelayJsonUnchanged(before, after) {
  for (const name of PRODUCTION_LOCAL_JSON_WATCHLIST) {
    const b = before.files[name];
    const a = after.files[name];
    if (b.sha256 !== a.sha256 || b.byteLength !== a.byteLength) {
      throw new Error(
        `Production local relay file changed during validation (${name}): `
        + `sha256 ${b.sha256} -> ${a.sha256}, bytes ${b.byteLength} -> ${a.byteLength}`,
      );
    }
  }
}

function fingerprintProductionGitHubRemote() {
  const client = createRelayContentClient({
    repo: PRODUCTION_COOPERATIVE_RELAY.repo,
    branch: PRODUCTION_COOPERATIVE_RELAY.branch,
  });
  const paths = RELAY_CONTENT_PATHS;
  let command = null;
  let result = null;
  try {
    command = client.readFile(paths.tacticalCommand, 8 * 1024);
  } catch (error) {
    return { ok: false, error: error.message || String(error), command: null, result: null };
  }
  try {
    result = client.readFile(paths.tacticalResult, 16 * 1024);
  } catch (error) {
    return { ok: false, error: error.message || String(error), command, result: null };
  }
  return {
    ok: true,
    repo: PRODUCTION_COOPERATIVE_RELAY.repo,
    branch: PRODUCTION_COOPERATIVE_RELAY.branch,
    command: command ? { sha: command.sha, byteLength: command.bytes?.length ?? 0 } : null,
    result: result ? { sha: result.sha, byteLength: result.bytes?.length ?? 0 } : null,
  };
}

function assertProductionGitHubRemoteUnchanged(before, after) {
  if (!before.ok || !after.ok) {
    throw new Error(
      `Production GitHub fingerprint unavailable (before: ${before.error || 'ok'}, after: ${after.error || 'ok'})`,
    );
  }
  const cmdBefore = before.command?.sha ?? null;
  const cmdAfter = after.command?.sha ?? null;
  const resBefore = before.result?.sha ?? null;
  const resAfter = after.result?.sha ?? null;
  if (cmdBefore !== cmdAfter) {
    throw new Error(`Production GitHub tactical-command sha changed: ${cmdBefore} -> ${cmdAfter}`);
  }
  if (resBefore !== resAfter) {
    throw new Error(`Production GitHub tactical-result sha changed: ${resBefore} -> ${resAfter}`);
  }
}

function captureProductionIntegrityBaseline(repoRoot) {
  return {
    journal: fingerprintProductionCommandRelayJournal(),
    localJson: fingerprintProductionLocalRelayJson(repoRoot),
    github: fingerprintProductionGitHubRemote(),
  };
}

function assertProductionIntegrityUnchanged(before, after) {
  assertProductionCommandRelayJournalUnchanged(before.journal, after.journal);
  assertProductionLocalRelayJsonUnchanged(before.localJson, after.localJson);
  assertProductionGitHubRemoteUnchanged(before.github, after.github);
}

module.exports = {
  PRODUCTION_LOCAL_JSON_WATCHLIST,
  sha256File,
  fingerprintProductionLocalRelayJson,
  assertProductionLocalRelayJsonUnchanged,
  fingerprintProductionGitHubRemote,
  assertProductionGitHubRemoteUnchanged,
  captureProductionIntegrityBaseline,
  assertProductionIntegrityUnchanged,
};
