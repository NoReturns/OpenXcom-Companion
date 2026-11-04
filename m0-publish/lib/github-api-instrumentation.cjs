'use strict';

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
    });
  }

  function wrapExecFileSync(baseExec) {
    return (file, args, opts) => {
      if (file === 'gh' && args && args[0] === 'api' && args.length >= 4) {
        record(args[2], args[3]);
      }
      return baseExec(file, args, opts);
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
};
