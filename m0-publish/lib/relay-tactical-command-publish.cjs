'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  DEFAULTS,
  DEFAULT_COMMAND_MAX_BYTES,
  RELAY_CONTENT_PATHS,
  checkGhAuthReadiness,
  createRelayContentClient,
  readRemoteContentFile,
  readRemoteContentMeta,
  putRemoteContentFileCreate,
  isNotFoundError,
} = require('./github-relay.cjs');
const { parseTacticalCommand, ValidationError } = require('./tactical-command.cjs');
const { buildRelayOptionsFromConfig } = require('./relay-isolation-config.cjs');

class TacticalCommandPublishError extends Error {
  constructor(code, message, meta = {}) {
    super(message);
    this.name = 'TacticalCommandPublishError';
    this.code = code;
    Object.assign(this, meta);
  }
}

function assertTestPublishSurface(relayOptions) {
  if (process.env.NODE_TEST_CONTEXT && relayOptions.isolationEnforced !== true) {
    throw new TacticalCommandPublishError(
      'test_surface_forbidden',
      'Node tests must publish tactical commands through relay isolation config (isolationEnforced).',
    );
  }
}

function canonicalCommandJson(command) {
  return `${JSON.stringify(command, null, 2)}\n`;
}

function loadLocalTacticalCommandFromFile(localPath, readFileSync = fs.readFileSync) {
  const resolved = path.resolve(String(localPath));
  if (!fs.existsSync(resolved)) {
    throw new TacticalCommandPublishError('missing_local_command', `Local tactical command not found: ${resolved}`);
  }
  const bytes = readFileSync(resolved);
  if (bytes.length > DEFAULT_COMMAND_MAX_BYTES) {
    throw new TacticalCommandPublishError('size_cap_exceeded', 'Local tactical command exceeds 8 KiB limit.');
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new TacticalCommandPublishError('invalid_json', 'Local tactical command is not valid JSON.');
  }
  try {
    parseTacticalCommand(parsed);
  } catch (error) {
    const message = error instanceof ValidationError ? error.message : String(error.message || error);
    throw new TacticalCommandPublishError('invalid_command', message);
  }
  return { resolved, command: parsed, serialized: canonicalCommandJson(parsed) };
}

function parseRemoteInboxCommand(remote) {
  if (!remote || !remote.text) {
    return null;
  }
  try {
    return JSON.parse(remote.text);
  } catch {
    throw new TacticalCommandPublishError('remote_malformed', 'Remote tactical-command.json is not valid JSON.');
  }
}

function resolveRelayOptions(options = {}) {
  if (options.relayOptions) {
    return options.relayOptions;
  }
  if (options.relayIsolationConfig) {
    return buildRelayOptionsFromConfig(options.relayIsolationConfig);
  }
  return {
    repo: options.repo ?? DEFAULTS.repo,
    branch: options.branch ?? DEFAULTS.branch,
    contentPaths: options.contentPaths ?? { ...RELAY_CONTENT_PATHS },
    isolationEnforced: options.isolationEnforced === true,
    maxRemoteBytes: options.maxRemoteBytes ?? DEFAULT_COMMAND_MAX_BYTES,
    ghApi: options.ghApi,
    apiCallLog: options.apiCallLog,
    rateLimitGate: options.rateLimitGate,
    quotaTelemetryStore: options.quotaTelemetryStore,
    execFileSync: options.execFileSync,
    relayIsolationContract: options.relayIsolationContract ?? null,
  };
}

function resolveTacticalCommandRemotePath(relayOptions) {
  const paths = relayOptions.contentPaths ?? RELAY_CONTENT_PATHS;
  return paths.tacticalCommand ?? RELAY_CONTENT_PATHS.tacticalCommand;
}

function evaluateInboxBeforeCreate(remote, command, serialized) {
  if (!remote || !remote.text) {
    return { action: 'create' };
  }
  const existing = parseRemoteInboxCommand(remote);
  if (!existing || typeof existing.command_id !== 'string') {
    throw new TacticalCommandPublishError(
      'inbox_occupied',
      'Remote tactical-command.json exists but has no command_id; refusing to overwrite.',
      { remote_command_id: null },
    );
  }
  if (existing.command_id === command.command_id) {
    const remoteCanonical = `${JSON.stringify(existing, null, 2)}\n`;
    if (remoteCanonical === serialized) {
      return { action: 'skip', reason: 'remote_unchanged', remote_command_id: existing.command_id };
    }
    throw new TacticalCommandPublishError(
      'inbox_occupied',
      'Remote inbox already holds the same command_id with different content; refusing to overwrite.',
      { remote_command_id: existing.command_id },
    );
  }
  throw new TacticalCommandPublishError(
    'inbox_occupied',
    `Remote inbox occupied by command ${existing.command_id}; refusing to overwrite.`,
    { remote_command_id: existing.command_id },
  );
}

function remoteInboxMatchesCommand(deps, contentPath, commandId, serialized) {
  try {
    const remote = readRemoteContentFile(deps, contentPath, DEFAULT_COMMAND_MAX_BYTES);
    if (!remote || !remote.text) {
      return { matches: false, reason: 'absent' };
    }
    const parsed = parseRemoteInboxCommand(remote);
    if (!parsed || parsed.command_id !== commandId) {
      return {
        matches: false,
        reason: 'command_id_mismatch',
        remote_command_id: parsed?.command_id ?? null,
      };
    }
    const remoteCanonical = `${JSON.stringify(parsed, null, 2)}\n`;
    if (remoteCanonical !== serialized) {
      return {
        matches: false,
        reason: 'content_mismatch',
        remote_command_id: commandId,
      };
    }
    return { matches: true };
  } catch (error) {
    if (error instanceof TacticalCommandPublishError) {
      return { matches: false, reason: 'absent' };
    }
    throw error;
  }
}

function classifyPutFailure(error) {
  if (error.code === 'SHA_CONFLICT') {
    return 'sha_conflict';
  }
  if (error.code === 'RATE_LIMIT') {
    return 'rate_limit';
  }
  if (error.code === 'AUTH_FAILED') {
    return 'auth_failed';
  }
  if (error.code === 'NOT_FOUND') {
    return 'not_found';
  }
  if (error.code === 'NETWORK_FAILED') {
    return 'ambiguous';
  }
  const stderr = error.stderr ? String(error.stderr) : '';
  if (isNotFoundError(error)) {
    return 'not_found';
  }
  if (/409|Conflict/i.test(stderr) || /422|Unprocessable Entity/i.test(stderr)) {
    return 'sha_conflict';
  }
  if (/429|rate limit|secondary rate limit/i.test(`${stderr}\n${error.message}`)) {
    return 'rate_limit';
  }
  if (/403/.test(stderr) && !/rate limit/i.test(stderr)) {
    return 'auth_failed';
  }
  return 'ambiguous';
}

function resolveVerifiedInboxAfterPutFailure(deps, contentPath, commandId, serialized) {
  const check = remoteInboxMatchesCommand(deps, contentPath, commandId, serialized);
  if (check.matches) {
    return { verified: true };
  }
  if (check.reason === 'content_mismatch') {
    throw new TacticalCommandPublishError(
      'inbox_occupied',
      'Remote inbox holds the same command_id with different content after PUT failure; refusing idempotent success.',
      { remote_command_id: commandId },
    );
  }
  return { verified: false, check };
}

function putCreateWithSafety(deps, contentPath, serialized, commitMessage, commandId) {
  const attemptPut = () => putRemoteContentFileCreate(deps, contentPath, serialized, commitMessage);

  try {
    attemptPut();
    return { created: true, verified: false, retried: false };
  } catch (firstError) {
    const kind = classifyPutFailure(firstError);
    if (kind === 'rate_limit') {
      throw new TacticalCommandPublishError('rate_limit', firstError.message, { cause: firstError });
    }
    if (kind === 'auth_failed') {
      throw new TacticalCommandPublishError('auth_failed', firstError.message, { cause: firstError });
    }
    const verifiedAfterFailure = resolveVerifiedInboxAfterPutFailure(deps, contentPath, commandId, serialized);
    if (verifiedAfterFailure.verified) {
      return { created: false, verified: true, retried: false, reason: 'verified_after_put_failure' };
    }
    if (kind === 'sha_conflict') {
      const remote = readRemoteContentFile(deps, contentPath, DEFAULT_COMMAND_MAX_BYTES);
      if (remote && remote.text) {
        const existing = parseRemoteInboxCommand(remote);
        throw new TacticalCommandPublishError(
          'inbox_occupied',
          `Create refused after SHA conflict; remote inbox holds ${existing?.command_id ?? 'unknown'}.`,
          { remote_command_id: existing?.command_id ?? null, cause: firstError },
        );
      }
      throw new TacticalCommandPublishError('sha_conflict', firstError.message, { cause: firstError });
    }
    if (kind !== 'ambiguous') {
      throw firstError;
    }

    const remoteAfter = readRemoteContentMeta(deps, contentPath);
    if (remoteAfter) {
      const existing = parseRemoteInboxCommand(readRemoteContentFile(deps, contentPath, DEFAULT_COMMAND_MAX_BYTES));
      throw new TacticalCommandPublishError(
        'inbox_occupied',
        `Remote inbox occupied during ambiguous PUT (${existing?.command_id ?? 'unknown'}).`,
        { remote_command_id: existing?.command_id ?? null, cause: firstError },
      );
    }

    try {
      attemptPut();
      return { created: true, verified: false, retried: true };
    } catch (retryError) {
      const verifiedAfterRetry = resolveVerifiedInboxAfterPutFailure(deps, contentPath, commandId, serialized);
      if (verifiedAfterRetry.verified) {
        return { created: false, verified: true, retried: true, reason: 'verified_after_retry_failure' };
      }
      throw retryError;
    }
  }
}

/**
 * Canonical GitHub publish for Aster-issued m0/tactical-command.json (inbox create-only).
 */
async function publishTacticalCommandOnce(options = {}) {
  const dryRun = options.dryRun !== false && options.publish !== true;
  const relayOptions = resolveRelayOptions(options);
  assertTestPublishSurface(relayOptions);

  const localPath = options.localPath;
  if (!localPath) {
    throw new TacticalCommandPublishError('missing_local_path', 'localPath is required.');
  }

  const { command, serialized } = loadLocalTacticalCommandFromFile(localPath, options.readFileSync);
  const remotePath = resolveTacticalCommandRemotePath(relayOptions);
  const commitMessage = options.commitMessage
    ?? `Companion tactical command ${command.command_id.slice(0, 8)} ${command.command_type} turn ${command.turn}`;

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      remotePath,
      command_id: command.command_id,
      command_type: command.command_type,
      githubApiCalls: 0,
      githubOps: [],
    };
  }

  if (options.requireGhAuth !== false && !relayOptions.ghApi && !checkGhAuthReadiness()) {
    throw new TacticalCommandPublishError('auth_unavailable', 'GitHub CLI authentication is not ready.');
  }

  const client = createRelayContentClient({
    ...relayOptions,
    apiCallLog: options.apiCallLog,
    maxRemoteBytes: DEFAULT_COMMAND_MAX_BYTES,
  });
  const deps = client.deps;

  let remote;
  try {
    remote = readRemoteContentFile(deps, remotePath, DEFAULT_COMMAND_MAX_BYTES);
  } catch (error) {
    if (error.code === 'RATE_LIMIT') {
      throw new TacticalCommandPublishError('rate_limit', error.message, { cause: error });
    }
    if (error.code === 'AUTH_FAILED') {
      throw new TacticalCommandPublishError('auth_failed', error.message, { cause: error });
    }
    throw error;
  }

  const inboxDecision = evaluateInboxBeforeCreate(remote, command, serialized);
  if (inboxDecision.action === 'skip') {
    return {
      ok: true,
      dryRun: false,
      skipped: true,
      reason: inboxDecision.reason,
      remotePath,
      command_id: command.command_id,
      githubApiCalls: options.apiCallLog?.countApiCalls?.() ?? null,
      githubOps: options.apiCallLog?.entries ?? [],
    };
  }

  const putOutcome = putCreateWithSafety(deps, remotePath, serialized, commitMessage, command.command_id);

  const githubOps = options.apiCallLog?.entries ? [...options.apiCallLog.entries] : [];
  const putStatuses = githubOps
    .filter((entry) => entry.method === 'PUT')
    .map((entry) => entry.http_status)
    .filter((status) => status != null);
  const createdViaPut = putStatuses.some((status) => status === 200 || status === 201);

  return {
    ok: true,
    dryRun: false,
    skipped: putOutcome.verified && !putOutcome.created,
    reason: putOutcome.reason ?? (putOutcome.created ? 'created' : 'verified'),
    remotePath,
    command_id: command.command_id,
    command_type: command.command_type,
    created: putOutcome.created,
    verified_idempotent: putOutcome.verified,
    retried_put: putOutcome.retried,
    github_api_put_success: createdViaPut || putOutcome.verified,
    githubApiCalls: options.apiCallLog?.countApiCalls?.() ?? null,
    githubOps,
  };
}

module.exports = {
  TacticalCommandPublishError,
  publishTacticalCommandOnce,
  loadLocalTacticalCommandFromFile,
  evaluateInboxBeforeCreate,
  putCreateWithSafety,
  remoteInboxMatchesCommand,
  resolveTacticalCommandRemotePath,
};
