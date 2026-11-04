'use strict';

const { formatQuotaConsoleLine, DEFAULT_WARN_FRACTION } = require('./github-quota-telemetry.cjs');
const {
  writeCompanionGithubQuotaHudFile,
  buildGithubQuotaHudPayload,
  hudQuotaContentSignature,
  HUD_HEARTBEAT_WRITE_MS,
  resolveCompanionGithubQuotaHudPath,
} = require('./github-quota-hud-file.cjs');

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

  let lastLogSignature = null;
  let lastLogAtMs = 0;

  function tick() {
    const now = nowFn();
    const hudPath = options.hudPath ?? resolveCompanionGithubQuotaHudPath(options);
    const payload = buildGithubQuotaHudPayload({
      store,
      rateLimitGate,
      now,
      hudPath,
      snapshotPathEnv: options.snapshotPathEnv,
      m0PublishRoot: options.m0PublishRoot,
    });
    const signature = hudQuotaContentSignature(payload);
    const quotaChanged = signature !== lastLogSignature;
    if (quotaChanged || (now - lastLogAtMs) >= HUD_HEARTBEAT_WRITE_MS) {
      const line = formatQuotaConsoleLine({
        snapshot: store.getSnapshot(),
        rateLimitGate,
        now,
        warnFraction,
      });
      log(line);
      lastLogSignature = signature;
      lastLogAtMs = now;
    }
    if (writeHudFile) {
      writeCompanionGithubQuotaHudFile({
        store,
        rateLimitGate,
        now,
        hudPath,
        snapshotPathEnv: options.snapshotPathEnv,
        m0PublishRoot: options.m0PublishRoot,
        writeFileSync: options.writeFileSync,
        renameSync: options.renameSync,
        payload,
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
