'use strict';

const NOTIFICATION_CODES = Object.freeze({
  BRIEFING_PUBLISHED: 'BRIEFING_PUBLISHED',
  COMMAND_RECEIVED: 'COMMAND_RECEIVED',
  COMMAND_DELIVERED: 'COMMAND_DELIVERED',
  COMMAND_EXECUTING: 'COMMAND_EXECUTING',
  COMMAND_COMPLETED: 'COMMAND_COMPLETED',
  COMMAND_INTERRUPTED: 'COMMAND_INTERRUPTED',
  COMMAND_FAILED: 'COMMAND_FAILED',
  COMMAND_REJECTED: 'COMMAND_REJECTED',
  COMMAND_STALE: 'COMMAND_STALE',
  COMMAND_DUPLICATE: 'COMMAND_DUPLICATE',
  COMMAND_CONFLICT: 'COMMAND_CONFLICT',
  RELAY_DISCONNECTED: 'RELAY_DISCONNECTED',
  RELAY_RECONNECTED: 'RELAY_RECONNECTED',
  MANUAL_UPLOAD_REQUIRED: 'MANUAL_UPLOAD_REQUIRED',
});

const STRUCTURED_PREFIX = '@COMPANION_NOTIFY\t';

const STALE_REASON_PATTERN = /STALE_|state_version|snapshot_sha256|session_id|turn mismatch|binding/i;

const {
  enrichMoveResultNotification,
} = require('./move-result-consumer.cjs');
const {
  buildFireOutcomeBrief,
  isDirectedFireCommandType,
} = require('./fire-result-consumer.cjs');

function pickCorrelation(fields = {}) {
  const out = {};
  for (const key of ['command_id', 'command_type', 'session_id', 'request_id', 'turn', 'state_version', 'reason_code',
    'remote_sha256', 'inbox_sha256', 'result_sha256', 'channel', 'message',
    'move_outcome_class', 'move_tactical_success', 'may_chain_next_command',
    'movement_stop_reason', 'move_interruption_cause', 'requires_fresh_binding',
    'remaining_tu', 'commanded_destination', 'final_position',
    'fire_outcome_class']) {
    if (fields[key] !== undefined && fields[key] !== null && fields[key] !== '') {
      out[key] = fields[key];
    }
  }
  return out;
}

function buildNotification(code, fields = {}) {
  return {
    code,
    at: new Date().toISOString(),
    ...pickCorrelation(fields),
  };
}

function classifySidecarReject(rejectCode, publicReason) {
  const text = `${rejectCode || ''} ${publicReason || ''}`;
  if (rejectCode === 'DUPLICATE_COMMAND_ID' || /duplicate command/i.test(text)) {
    return NOTIFICATION_CODES.COMMAND_DUPLICATE;
  }
  if (rejectCode === 'SIDECAR_VALIDATION' || STALE_REASON_PATTERN.test(text)) {
    return NOTIFICATION_CODES.COMMAND_STALE;
  }
  if (/conflict|identity|result_command_id|payload mismatch/i.test(text)) {
    return NOTIFICATION_CODES.COMMAND_CONFLICT;
  }
  return NOTIFICATION_CODES.COMMAND_REJECTED;
}

function classifyEngineTerminal(status, publicReason, rejectCode) {
  if (status === 'COMPLETED') {
    return NOTIFICATION_CODES.COMMAND_COMPLETED;
  }
  if (status === 'INTERRUPTED') {
    return NOTIFICATION_CODES.COMMAND_INTERRUPTED;
  }
  if (status === 'FAILED') {
    return NOTIFICATION_CODES.COMMAND_FAILED;
  }
  if (status === 'REJECTED') {
    return classifySidecarReject(rejectCode, publicReason);
  }
  return null;
}

function terminalRequiresObservedResult(code) {
  return code === NOTIFICATION_CODES.COMMAND_COMPLETED
    || code === NOTIFICATION_CODES.COMMAND_INTERRUPTED
    || code === NOTIFICATION_CODES.COMMAND_FAILED
    || code === NOTIFICATION_CODES.COMMAND_REJECTED
    || code === NOTIFICATION_CODES.COMMAND_STALE
    || code === NOTIFICATION_CODES.COMMAND_DUPLICATE
    || code === NOTIFICATION_CODES.COMMAND_CONFLICT;
}

function notificationFromLocalResult(result, inboxSha256, context = {}) {
  if (!result || typeof result !== 'object' || !result.status) {
    return null;
  }
  if (result.status === 'EXECUTING' || result.status === 'ACCEPTED') {
    return buildNotification(NOTIFICATION_CODES.COMMAND_EXECUTING, {
      command_id: result.command_id,
      session_id: result.session_id,
      turn: result.turn,
      state_version: result.state_version,
      inbox_sha256: result.inbox_sha256 || inboxSha256,
      reason_code: result.status,
    });
  }
  if (result.status === 'REJECTED') {
    const reasonText = `${result.public_reason || ''} ${result.reject_code || ''}`;
    if (/conflict|identity|mismatch/i.test(reasonText)) {
      return buildNotification(NOTIFICATION_CODES.COMMAND_CONFLICT, {
        command_id: result.command_id,
        session_id: result.session_id,
        turn: result.turn,
        state_version: result.state_version,
        inbox_sha256: result.inbox_sha256 || inboxSha256,
        reason_code: result.public_reason || result.reject_code || 'REJECTED',
      });
    }
  }
  const reasonCode = result.public_reason || result.reject_code || result.sidecar_reject_code;
  const code = classifyEngineTerminal(result.status, reasonCode, reasonCode);
  if (!code) {
    return null;
  }
  const fields = {
    command_id: result.command_id,
    session_id: result.session_id,
    turn: result.turn,
    state_version: result.state_version,
    inbox_sha256: result.inbox_sha256 || inboxSha256,
    reason_code: typeof reasonCode === 'string' ? reasonCode : result.status,
  };
  if (result.command_type === 'MOVE') {
    const moveEnrichment = enrichMoveResultNotification(result, context.command ?? null);
    if (moveEnrichment) {
      Object.assign(fields, moveEnrichment);
    }
  } else if (isDirectedFireCommandType(result.command_type)) {
    const fireBrief = buildFireOutcomeBrief(result);
    if (fireBrief) {
      fields.command_type = result.command_type;
      fields.fire_outcome_class = fireBrief.outcome_class;
      if (fireBrief.message) {
        fields.message = fireBrief.message;
      }
    }
  }
  return buildNotification(code, fields);
}

function notificationFromMoveCommand(command, extra = {}) {
  return buildNotification(extra.code || NOTIFICATION_CODES.COMMAND_RECEIVED, {
    command_id: command.command_id,
    session_id: command.session_id,
    turn: command.turn,
    state_version: command.state_version,
    remote_sha256: extra.remote_sha256,
    inbox_sha256: extra.inbox_sha256,
    reason_code: extra.reason_code,
    request_id: extra.request_id,
  });
}

function formatSupervisorConsoleLine(event) {
  const parts = [`[notify] ${event.code}`];
  if (event.command_id) {
    parts.push(`command=${String(event.command_id).slice(0, 8)}…`);
  }
  if (event.command_type) {
    parts.push(`type=${event.command_type}`);
  }
  if (event.request_id) {
    parts.push(`request=${String(event.request_id).slice(0, 8)}…`);
  }
  if (event.session_id) {
    parts.push(`session=${String(event.session_id).slice(0, 8)}…`);
  }
  if (event.turn !== undefined) {
    parts.push(`turn=${event.turn}`);
  }
  if (event.state_version !== undefined) {
    parts.push(`state_version=${event.state_version}`);
  }
  if (event.inbox_sha256) {
    parts.push(`inbox_sha256=${String(event.inbox_sha256).slice(0, 12)}…`);
  }
  if (event.remote_sha256) {
    parts.push(`remote_sha256=${String(event.remote_sha256).slice(0, 12)}…`);
  }
  if (event.reason_code) {
    parts.push(`reason=${event.reason_code}`);
  }
  if (event.message) {
    parts.push(String(event.message));
  }
  return parts.join(' ');
}

function serializeStructuredNotify(event) {
  return `${STRUCTURED_PREFIX}${JSON.stringify(event)}\n`;
}

class NotificationDeduper {
  constructor() {
    this.seen = new Set();
    this.relayDisconnected = false;
  }

  dedupeKey(event) {
    return [
      event.code,
      event.command_id || '',
      event.request_id || '',
      event.remote_sha256 || '',
      event.inbox_sha256 || '',
      event.reason_code || '',
      event.turn ?? '',
      event.state_version ?? '',
    ].join('|');
  }

  shouldEmit(event) {
    if (event.code === NOTIFICATION_CODES.RELAY_RECONNECTED) {
      if (!this.relayDisconnected) {
        return false;
      }
      this.relayDisconnected = false;
      return true;
    }
    if (event.code === NOTIFICATION_CODES.RELAY_DISCONNECTED) {
      if (this.relayDisconnected) {
        return false;
      }
      this.relayDisconnected = true;
      return true;
    }
    const key = this.dedupeKey(event);
    if (this.seen.has(key)) {
      return false;
    }
    this.seen.add(key);
    return true;
  }

  resetForTests() {
    this.seen.clear();
    this.relayDisconnected = false;
  }
}

function createNotifyEmitter(options = {}) {
  const deduper = options.deduper ?? new NotificationDeduper();
  const writeStructured = options.writeStructured
    ?? ((line) => { process.stdout.write(line); });
  const writeConsole = options.writeConsole
    ?? ((line) => { process.stdout.write(`${line}\n`); });

  function emit(rawEvent) {
    if (!rawEvent || !rawEvent.code) {
      return false;
    }
    if (!deduper.shouldEmit(rawEvent)) {
      return false;
    }
    writeStructured(serializeStructuredNotify(rawEvent));
    if (options.alsoPrintConsole !== false) {
      writeConsole(formatSupervisorConsoleLine(rawEvent));
    }
    return true;
  }

  return { emit, deduper };
}

function createSupervisorNotifyBridge(options = {}) {
  const deduper = options.deduper ?? new NotificationDeduper();
  const writeConsole = options.writeConsole
    ?? ((line) => { process.stdout.write(`${line}\n`); });

  function ingestStructuredLine(line) {
    if (!line.startsWith(STRUCTURED_PREFIX)) {
      return false;
    }
    let event;
    try {
      event = JSON.parse(line.slice(STRUCTURED_PREFIX.length));
    } catch {
      return false;
    }
    if (!deduper.shouldEmit(event)) {
      return false;
    }
    writeConsole(formatSupervisorConsoleLine(event));
    return true;
  }

  function wrapSidecarLogWrite(channel, logWrite) {
    return (chunk) => {
      const text = chunk.toString();
      for (const line of text.split(/\r?\n/)) {
        if (line.startsWith(STRUCTURED_PREFIX)) {
          ingestStructuredLine(line);
          continue;
        }
        if (line.length > 0) {
          logWrite(`[${channel}] ${line}\n`);
        }
      }
    };
  }

  return { ingestStructuredLine, wrapSidecarLogWrite, deduper };
}

function createSidecarNotifySink(options = {}) {
  return createNotifyEmitter({
    ...options,
    alsoPrintConsole: false,
  }).emit;
}

module.exports = {
  NOTIFICATION_CODES,
  STRUCTURED_PREFIX,
  buildNotification,
  classifySidecarReject,
  classifyEngineTerminal,
  terminalRequiresObservedResult,
  notificationFromLocalResult,
  notificationFromMoveCommand,
  formatSupervisorConsoleLine,
  serializeStructuredNotify,
  NotificationDeduper,
  createNotifyEmitter,
  createSidecarNotifySink,
  createSupervisorNotifyBridge,
};
