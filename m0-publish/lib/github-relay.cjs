'use strict';

const { execFileSync } = require('node:child_process');

const DEFAULTS = {
  repo: 'NoReturns/OpenXcom-Aster-Relay',
  branch: 'main',
  statePath: 'm0/state.json',
  maxRemoteBytes: 256 * 1024,
};

function createGhApiExec() {
  return function ghApi(method, apiPath, body) {
    const args = ['api', '--method', method, apiPath, '-H', 'Accept: application/vnd.github+json'];
    if (body !== undefined) {
      args.push('--input', '-');
    }
    const stdout = execFileSync('gh', args, {
      encoding: 'utf8',
      input: body === undefined ? undefined : JSON.stringify(body),
      maxBuffer: 1024 * 1024,
    });
    if (!stdout.trim()) return null;
    return JSON.parse(stdout);
  };
}

function checkGhAuthReadiness(ghApiExec = createGhApiExec()) {
  try {
    execFileSync('gh', ['auth', 'status', '--hostname', 'github.com'], {
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
    throw error;
  }
}

function decodeRemoteState(meta, maxRemoteBytes) {
  if (!meta || meta.type !== 'file' || meta.encoding !== 'base64') {
    throw new Error('Unexpected remote state metadata');
  }
  const bytes = Buffer.from(meta.content.replace(/\s/g, ''), 'base64');
  if (bytes.length > maxRemoteBytes) {
    throw new Error('Remote state.json exceeds local size limit');
  }
  return { sha: meta.sha, value: JSON.parse(bytes.toString('utf8')) };
}

function createRelayPublisher(options = {}) {
  const deps = {
    repo: options.repo ?? DEFAULTS.repo,
    branch: options.branch ?? DEFAULTS.branch,
    statePath: options.statePath ?? DEFAULTS.statePath,
    maxRemoteBytes: options.maxRemoteBytes ?? DEFAULTS.maxRemoteBytes,
    ghApi: options.ghApi ?? createGhApiExec(),
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
        return { skipped: true, reason: 'remote_unchanged' };
      }
    }

    const body = {
      message: `M1 tactical snapshot ${relayJson.snapshot_id.slice(0, 12)} turn ${relayJson.source.turn}`,
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
      if (/401|403|authentication|Bad credentials/i.test(stderr + String(error.message))) {
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
  checkGhAuthReadiness,
  createGhApiExec,
  createRelayPublisher,
  readRemoteStateMeta,
  decodeRemoteState,
  isNotFoundError,
};
