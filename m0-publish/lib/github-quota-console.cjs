'use strict';

const { formatQuotaConsoleLine, DEFAULT_WARN_FRACTION } = require('./github-quota-telemetry.cjs');
const { writeCompanionGithubQuotaHudFile } = require('./github-quota-hud-file.cjs');

function createGithubQuotaConsoleMonitor(options = {}) {
  const store = options.store;
  if (!store || typeof store.getSnapshot !== 'function') {
    throw new Error('createGithubQuotaConsoleMonitor requires a quota telemetry store.');
  }
  const rateLimitGate = options.rateLimitGate ?? null;
  const log = options.log ?? ((line) => console.log(line));
  const nowFn = options.now ?? (() => Date.now());
  const warnFraction = options.warnFraction ?? DEFAULT_WARN_FRACTION;
  const writeHudFile = options.writeHudFile !== false;

  function tick() {
    const now = nowFn();
    const line = formatQuotaConsoleLine({
      snapshot: store.getSnapshot(),
      rateLimitGate,
      now,
      warnFraction,
    });
    log(line);
    if (writeHudFile) {
      writeCompanionGithubQuotaHudFile({
        store,
        rateLimitGate,
        now,
        hudPath: options.hudPath,
        snapshotPathEnv: options.snapshotPathEnv,
        m0PublishRoot: options.m0PublishRoot,
        writeFileSync: options.writeFileSync,
        renameSync: options.renameSync,
      });
    }
  }

  return {
    tick,
    store,
    rateLimitGate,
  };
}

module.exports = {
  createGithubQuotaConsoleMonitor,
};
