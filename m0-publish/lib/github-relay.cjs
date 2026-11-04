'use strict';

const { execFileSyncHidden } = require('./exec-file-sync.cjs');
const { isRateLimitBlob } = require('./relay-rate-limit-gate.cjs');
const { parseGhApiIncludeStdout } = require('./github-quota-telemetry.cjs');

const DEFAULTS = {
  repo: 'NoReturns/OpenXcom-Aster-Relay',
  branch: 'main',
  statePath: 'm0/state.json',
  maxRemoteBytes: 256 * 1024,
};

const RELAY_CONTENT_PATHS = {
  tacticalCommand: 'm0/tactical-command.json',
  tacticalResult: 'm0/tactical-result.json',
  terrainQuery: 'm0/terrain-query.json',
  terrainQueryResult: 'm0/terrain-query-result.json',
};

const DEFAULT_COMMAND_MAX_BYTES = 8 * 1024;
const DEFAULT_RESULT_MAX_BYTES = 16 * 1024;
const DEFAULT_TERRAIN_QUERY_MAX_BYTES = 4 * 1024;
const DEFAULT_TERRAIN_QUERY_RESULT_MAX_BYTES = 12 * 1024;

function createGhApiExec(options = {}) {
  let execFileSyncImpl = options.execFileSync ?? execFileSyncHidden;
  if (options.apiCallLog && typeof options.apiCallLog.wrapExecFileSync === 'function') {
    execFileSyncImpl = options.apiCallLog.wrapExecFileSync(execFileSyncImpl);
  }
  const rateLimitGate = options.rateLimitGate ?? null;
  const quotaTelemetryStore = options.quotaTelemetryStore ?? null;
  const nowFn = options.now ?? (() => Date.now());
  const apiCallLog = options.apiCallLog ?? null;
  const baseGhApi = function ghApi(method, apiPath, body) {
    const args = ['api', '--method', method, apiPath, '-H', 'Accept: application/vnd.github+json', '--include'];
    if (body !== undefined) {
      args.push('--input', '-');
    }
    try {
      const stdout = execFileSyncImpl('gh', args, {
        encoding: 'utf8',
        input: body === undefined ? undefined : JSON.stringify(body),
        maxBuffer: 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const parsed = parseGhApiIncludeStdout(stdout);
      if (quotaTelemetryStore && typeof quotaTelemetryStore.recordFromHeaders === 'function') {
        quotaTelemetryStore.recordFromHeaders(parsed.headers, { method, apiPath, now: nowFn() });
      }
      if (!parsed.body.trim()) {
        return null;
      }
      return JSON.parse(parsed.body);
    } catch (error) {
      const normalized = normalizeGhApiExecError(error);
      if (quotaTelemetryStore && typeof quotaTelemetryStore.recordFromGhError === 'function') {
        quotaTelemetryStore.recordFromGhError(normalized, nowFn());
      }
      throw normalized;
    }
  };
  if (rateLimitGate && typeof rateLimitGate.wrapGhApiExec === 'function') {
    return rateLimitGate.wrapGhApiExec(baseGhApi);
  }
  return baseGhApi;
}

function normalizeGhApiExecError(error) {
  const stderr = error && error.stderr ? String(error.stderr) : '';
  const message = String(error && error.message ? error.message : error);
  const blob = `${stderr}\n${message}`;

  if (isNotFoundError(error)) {
    const notFound = new Error('GitHub API resource not found');
    notFound.code = 'NOT_FOUND';
    notFound.stderr = stderr;
    return notFound;
  }
  if (isRateLimitBlob(blob)) {
    const rate = new Error('GitHub API rate limit exceeded.');
    rate.code = 'RATE_LIMIT';
    rate.stderr = stderr;
    return rate;
  }
  if (/401|authentication|Bad credentials/i.test(blob)) {
    const auth = new Error('GitHub authentication failed.');
    auth.code = 'AUTH_FAILED';
    auth.stderr = stderr;
    return auth;
  }
  if (/403/.test(blob) && !/rate limit/i.test(blob)) {
    const auth = new Error('GitHub authentication failed.');
    auth.code = 'AUTH_FAILED';
    auth.stderr = stderr;
    return auth;
  }
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|network|socket hang up/i.test(blob)) {
    const network = new Error('GitHub API network failure.');
    network.code = 'NETWORK_FAILED';
    network.stderr = stderr;
    return network;
  }
  return error;
}

function checkGhAuthReadiness(ghApiExec = createGhApiExec()) {
  try {
    execFileSyncHidden('gh', ['auth', 'status', '--hostname', 'github.com'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    return true;
  } catch {
    return false;
  }
}

function isNotFoundError(error) {
  const stderr = error && error.stderr ? String(error.stderr) : '';
  return /404|Not Found/i.test(stderr) || /404/.test(String(error && error.message));
}

function readRemoteStateMeta(deps) {
  const { ghApi, repo, branch, statePath } = deps;
  try {
    return ghApi('GET', `repos/${repo}/contents/${statePath}?ref=${encodeURIComponent(branch)}`);
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error.code ? error : normalizeGhApiExecError(error);
  }
}

function decodeRemoteFileContent(meta, maxRemoteBytes, label = 'remote file') {
  if (!meta || meta.type !== 'file' || meta.encoding !== 'base64') {
    throw new Error(`Unexpected ${label} metadata`);
  }
  const bytes = Buffer.from(meta.content.replace(/\s/g, ''), 'base64');
  if (bytes.length > maxRemoteBytes) {
    throw new Error(`${label} exceeds local size limit`);
  }
  return { sha: meta.sha, bytes, text: bytes.toString('utf8') };
}

function decodeRemoteState(meta, maxRemoteBytes) {
  const decoded = decodeRemoteFileContent(meta, maxRemoteBytes, 'remote state.json');
  return { sha: decoded.sha, value: JSON.parse(decoded.text) };
}

function readRemoteContentMeta(deps, contentPath) {
  const { ghApi, repo, branch } = deps;
  try {
    return ghApi('GET', `repos/${repo}/contents/${contentPath}?ref=${encodeURIComponent(branch)}`);
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error.code ? error : normalizeGhApiExecError(error);
  }
}

function readRemoteContentFile(deps, contentPath, maxRemoteBytes) {
  const meta = readRemoteContentMeta(deps, contentPath);
  if (!meta) {
    return null;
  }
  const decoded = decodeRemoteFileContent(meta, maxRemoteBytes, contentPath);
  return {
    sha: decoded.sha,
    bytes: decoded.bytes,
    text: decoded.text,
  };
}

function publishRemoteContentFile(deps, contentPath, serializedUtf8, commitMessage) {
  if (Buffer.byteLength(serializedUtf8, 'utf8') > deps.maxRemoteBytes) {
    throw new Error(`Remote payload for ${contentPath} exceeds size limit`);
  }
  const remote = readRemoteContentMeta(deps, contentPath);
  const body = {
    message: commitMessage,
    content: Buffer.from(serializedUtf8, 'utf8').toString('base64'),
    branch: deps.branch,
  };
  if (remote && remote.sha) {
    body.sha = remote.sha;
  }
  try {
    deps.ghApi('PUT', `repos/${deps.repo}/contents/${contentPath}`, body);
  } catch (error) {
    const stderr = error.stderr ? String(error.stderr) : '';
    if (/409|Conflict/i.test(stderr)) {
      const conflict = new Error(`SHA conflict while publishing ${contentPath}; stop and retry manually.`);
      conflict.code = 'SHA_CONFLICT';
      throw conflict;
    }
    if (error.code === 'AUTH_FAILED') {
      throw error;
    }
    if (isRateLimitBlob(`${stderr}\n${error.message}`)) {
      throw error.code === 'RATE_LIMIT' ? error : normalizeGhApiExecError(error);
    }
    if (/401|authentication|Bad credentials/i.test(stderr + String(error.message))) {
      const auth = new Error('GitHub authentication failed.');
      auth.code = 'AUTH_FAILED';
      throw auth;
    }
    throw error;
  }
  return { skipped: false };
}

function deleteRemoteContentFile(deps, contentPath, sha, commitMessage) {
  if (!sha) {
    throw new Error(`Cannot delete ${contentPath} without content SHA`);
  }
  const body = {
    message: commitMessage,
    sha,
    branch: deps.branch,
  };
  try {
    deps.ghApi('DELETE', `repos/${deps.repo}/contents/${contentPath}`, body);
    return { deleted: true };
  } catch (error) {
    if (error.code === 'NOT_FOUND') {
      return { deleted: false, alreadyAbsent: true };
    }
    const stderr = error.stderr ? String(error.stderr) : '';
    if (/409|Conflict/i.test(stderr)) {
      const conflict = new Error(`SHA conflict while deleting ${contentPath}; remote command may have changed.`);
      conflict.code = 'SHA_CONFLICT';
      throw conflict;
    }
    if (error.code === 'AUTH_FAILED' || error.code === 'RATE_LIMIT' || error.code === 'NETWORK_FAILED') {
      throw error;
    }
    if (isRateLimitBlob(`${stderr}\n${error.message}`)) {
      throw error.code === 'RATE_LIMIT' ? error : normalizeGhApiExecError(error);
    }
    if (/401|authentication|Bad credentials/i.test(stderr + String(error.message))) {
      const auth = new Error('GitHub authentication failed.');
      auth.code = 'AUTH_FAILED';
      throw auth;
    }
    throw error;
  }
}

function createRelayContentClient(options = {}) {
  const deps = {
    repo: options.repo ?? DEFAULTS.repo,
    branch: options.branch ?? DEFAULTS.branch,
    maxRemoteBytes: options.maxRemoteBytes ?? DEFAULTS.maxRemoteBytes,
    ghApi: options.ghApi ?? createGhApiExec({
      rateLimitGate: options.rateLimitGate,
      quotaTelemetryStore: options.quotaTelemetryStore,
      execFileSync: options.execFileSync,
      now: options.now,
      apiCallLog: options.apiCallLog,
      transactionId: options.transactionId,
    }),
  };

  return {
    deps,
    paths: RELAY_CONTENT_PATHS,
    readFile: (contentPath, maxBytes = deps.maxRemoteBytes) =>
      readRemoteContentFile(deps, contentPath, maxBytes),
    publishFile: (contentPath, value, commitMessage, maxBytes = deps.maxRemoteBytes) => {
      const priorMax = deps.maxRemoteBytes;
      deps.maxRemoteBytes = maxBytes;
      try {
        const serialized = typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`;
        return publishRemoteContentFile(deps, contentPath, serialized, commitMessage);
      } finally {
        deps.maxRemoteBytes = priorMax;
      }
    },
    deleteFile: (contentPath, sha, commitMessage) =>
      deleteRemoteContentFile(deps, contentPath, sha, commitMessage),
  };
}

function createRelayPublisher(options = {}) {
  const deps = {
    repo: options.repo ?? DEFAULTS.repo,
    branch: options.branch ?? DEFAULTS.branch,
    statePath: options.statePath ?? DEFAULTS.statePath,
    maxRemoteBytes: options.maxRemoteBytes ?? DEFAULTS.maxRemoteBytes,
    ghApi: options.ghApi ?? createGhApiExec({
      rateLimitGate: options.rateLimitGate,
      quotaTelemetryStore: options.quotaTelemetryStore,
      execFileSync: options.execFileSync,
      now: options.now,
      apiCallLog: options.apiCallLog,
      transactionId: options.transactionId,
    }),
  };

  async function publishRelayState(relayJson) {
    const serialized = JSON.stringify(relayJson, null, 2) + '\n';
    if (Buffer.byteLength(serialized, 'utf8') > deps.maxRemoteBytes) {
      throw new Error('Relay payload exceeds 256 KiB limit');
    }

    const remote = readRemoteStateMeta(deps);
    if (remote) {
      const { value } = decodeRemoteState(remote, deps.maxRemoteBytes);
      if (value && value.snapshot_id === relayJson.snapshot_id) {
        if (!relayJson.request_id) {
          return { skipped: true, reason: 'remote_unchanged' };
        }
        if (value.request_id === relayJson.request_id) {
          return { skipped: true, reason: 'remote_unchanged' };
        }
      }
    }

    const messageSuffix = relayJson.request_id
      ? ` req ${relayJson.request_id.slice(0, 8)}`
      : '';
    const body = {
      message: `M1 tactical snapshot ${relayJson.snapshot_id.slice(0, 12)} turn ${relayJson.source.turn}${messageSuffix}`,
      content: Buffer.from(serialized, 'utf8').toString('base64'),
      branch: deps.branch,
    };
    if (remote && remote.sha) {
      body.sha = remote.sha;
    }

    try {
      deps.ghApi('PUT', `repos/${deps.repo}/contents/${deps.statePath}`, body);
    } catch (error) {
      const stderr = error.stderr ? String(error.stderr) : '';
      if (/409|Conflict/i.test(stderr)) {
        const conflict = new Error('SHA conflict while publishing state.json; stop and retry manually.');
        conflict.code = 'SHA_CONFLICT';
        throw conflict;
      }
      if (isRateLimitBlob(`${stderr}\n${error.message}`)) {
        throw error.code === 'RATE_LIMIT' ? error : normalizeGhApiExecError(error);
      }
      if (/401|authentication|Bad credentials/i.test(stderr + String(error.message))) {
        const auth = new Error('GitHub authentication failed.');
        auth.code = 'AUTH_FAILED';
        throw auth;
      }
      throw error;
    }

    return { skipped: false };
  }

  return {
    deps,
    publishRelayState,
    readRemoteStateMeta: () => readRemoteStateMeta(deps),
  };
}

module.exports = {
  DEFAULTS,
  RELAY_CONTENT_PATHS,
  DEFAULT_COMMAND_MAX_BYTES,
  DEFAULT_RESULT_MAX_BYTES,
  DEFAULT_TERRAIN_QUERY_MAX_BYTES,
  DEFAULT_TERRAIN_QUERY_RESULT_MAX_BYTES,
  checkGhAuthReadiness,
  createGhApiExec,
  createRelayPublisher,
  createRelayContentClient,
  readRemoteStateMeta,
  readRemoteContentMeta,
  readRemoteContentFile,
  publishRemoteContentFile,
  deleteRemoteContentFile,
  decodeRemoteState,
  decodeRemoteFileContent,
  isNotFoundError,
  normalizeGhApiExecError,
  execFileSyncHidden,
};
