'use strict';

const path = require('node:path');
const { redactSecrets } = require('./on-demand-daemon-diagnostics.cjs');
const { NotificationDeduper } = require('./companion-relay-notify.cjs');

const BRIEFING_CONSOLE_PREFIX = '[briefing]';

function formatRequestToken(requestId) {
  if (!requestId || typeof requestId !== 'string') {
    return 'request=unknown';
  }
  return `request=${requestId.slice(0, 8)}…`;
}

function sanitizeBriefingReason(text) {
  if (text === undefined || text === null) {
    return '';
  }
  let reason = redactSecrets(String(text));
  if (/github_pat_|gho_[A-Za-z0-9_]+|Bearer\s+\S+/i.test(reason)) {
    return 'Redacted credential material in upstream error.';
  }
  const ghBlob = /gh:\s.+HTTP\s\d{3}/i.test(reason) || /Bad credentials/i.test(reason);
  if (ghBlob && !/perceptionLog|SNAPSHOT_|schemaVersion|malformed YAML/i.test(reason)) {
    return 'GitHub API error (details redacted).';
  }
  reason = reason.replace(/\r\n/g, '\n');
  if (reason.length > 320) {
    reason = `${reason.slice(0, 317)}…`;
  }
  return reason;
}

function formatIsoTimestamp(ms) {
  return new Date(ms).toISOString();
}

function formatBriefingDaemonConsoleLine(event, atMs = Date.now()) {
  const parts = [
    `[${formatIsoTimestamp(atMs)}]`,
    BRIEFING_CONSOLE_PREFIX,
    formatRequestToken(event.request_id),
    `outcome=${event.outcome}`,
  ];
  if (event.error_code) {
    parts.push(`code=${event.error_code}`);
  }
  if (event.turn !== undefined && event.turn !== null) {
    parts.push(`turn=${event.turn}`);
  }
  if (event.artifact_filename) {
    parts.push(`artifact=${event.artifact_filename}`);
  }
  if (event.reason) {
    parts.push(`reason=${sanitizeBriefingReason(event.reason)}`);
  }
  return parts.join(' ');
}

function createBriefingDiagnosticsEmitter(options = {}) {
  const deduper = options.deduper ?? new NotificationDeduper();
  const log = options.log ?? (() => {});
  const now = options.now ?? (() => Date.now());

  function shouldEmitConsole(event) {
    const synthetic = {
      code: `BRIEFING_${event.outcome}`,
      request_id: event.request_id,
      reason_code: event.error_code || '',
      turn: event.turn ?? '',
    };
    return deduper.shouldEmit(synthetic);
  }

  function emit(event) {
    if (!event || !event.outcome) {
      return false;
    }
    if (!shouldEmitConsole(event)) {
      return false;
    }
    log(formatBriefingDaemonConsoleLine(event, now()));
    return true;
  }

  return {
    emit,
    deduper,
    formatBriefingDaemonConsoleLine,
    sanitizeBriefingReason,
  };
}

function basenameArtifact(artifactPath) {
  if (!artifactPath) {
    return undefined;
  }
  return path.basename(String(artifactPath));
}

module.exports = {
  BRIEFING_CONSOLE_PREFIX,
  sanitizeBriefingReason,
  formatBriefingDaemonConsoleLine,
  createBriefingDiagnosticsEmitter,
  basenameArtifact,
};
