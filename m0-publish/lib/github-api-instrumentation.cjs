'use strict';

const { parseGhApiIncludeStdout } = require('./github-quota-telemetry.cjs');

function parseHttpStatusFromHeaderText(headerText) {
  const match = String(headerText || '').match(/^HTTP\/[\d.]+\s+(\d{3})/m);
  if (!match) {
    return null;
  }
  const status = Number.parseInt(match[1], 10);
  return Number.isFinite(status) ? status : null;
}

function parseHttpStatusFromGhError(error) {
  const blob = `${error && error.stderr ? error.stderr : ''}\n${error && error.message ? error.message : ''}`;
  const match = blob.match(/HTTP\/[\d.]+\s+(\d{3})/i) || blob.match(/\b(429|403|404|409|401|5\d{2})\b/);
  if (!match) {
    return null;
  }
  const status = Number.parseInt(match[1], 10);
  return Number.isFinite(status) ? status : null;
}

/**
 * In-memory GitHub API call log for tests and on-demand transaction audits (M1-25G2+).
 * One gh api subprocess invocation -> one entry (via wrapExecFileSync). Method + endpoint only.
 */
function createGhApiCallLog(options = {}) {
  const entries = options.entries ?? [];
  const transactionId = options.transactionId ?? null;

  function record(method, endpoint, meta = {}) {
    entries.push({
      transaction_id: meta.transactionId ?? transactionId,
      method: String(method || '').toUpperCase(),
      endpoint: String(endpoint || ''),
      at_ms: meta.atMs ?? Date.now(),
      ...(meta.http_status != null ? { http_status: meta.http_status } : {}),
      ...(meta.outcome ? { outcome: meta.outcome } : {}),
    });
  }

  function wrapExecFileSync(baseExec) {
    return (file, args, opts) => {
      const isGhApi = file === 'gh' && args && args[0] === 'api' && args.length >= 4;
      const method = isGhApi ? args[2] : null;
      const endpoint = isGhApi ? args[3] : null;
      try {
        const stdout = baseExec(file, args, opts);
        if (isGhApi) {
          const parsed = parseGhApiIncludeStdout(stdout);
          record(method, endpoint, {
            http_status: parseHttpStatusFromHeaderText(parsed.headerText),
            outcome: 'response',
          });
        }
        return stdout;
      } catch (error) {
        if (isGhApi) {
          record(method, endpoint, {
            http_status: parseHttpStatusFromGhError(error),
            outcome: 'error',
          });
        }
        throw error;
      }
    };
  }

  return {
    entries,
    record,
    wrapExecFileSync,
    countApiCalls() {
      return entries.length;
    },
  };
}

module.exports = {
  createGhApiCallLog,
  parseHttpStatusFromHeaderText,
  parseHttpStatusFromGhError,
};
