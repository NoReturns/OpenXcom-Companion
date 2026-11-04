'use strict';

const { isTerminalStatus } = require('./tactical-command.cjs');

const RETIREMENT_OPERATOR_MESSAGES = {
  missing_journaled_remote_sha:
    'Automatic remote command retirement blocked: command-relay journal has no remote_sha256 from delivery. '
    + 'Manually remove m0/tactical-command.json on GitHub (keep tactical-result.json) or repair the journal entry, then re-run preflight.',
};

function journaledRemoteSha(record) {
  return typeof record.remote_sha256 === 'string' && record.remote_sha256.length > 0
    ? record.remote_sha256
    : null;
}

function remoteResultMatchesCommand(remoteResultValue, commandId, expectedStatus) {
  if (!remoteResultValue || typeof remoteResultValue !== 'object') {
    return { ok: false, reason: 'missing_remote_result' };
  }
  if (remoteResultValue.command_id !== commandId) {
    return { ok: false, reason: 'result_command_id_mismatch' };
  }
  if (!isTerminalStatus(remoteResultValue.status)) {
    return { ok: false, reason: 'result_not_terminal' };
  }
  if (expectedStatus && remoteResultValue.status !== expectedStatus) {
    return { ok: false, reason: 'result_status_mismatch' };
  }
  return { ok: true, reason: null };
}

function evaluateRemoteCommandRetirement(input) {
  const {
    record,
    localResult,
    remoteCommandMeta,
    remoteCommandValue,
    remoteResultValue,
  } = input;

  if (!record || record.phase !== 'published_terminal') {
    return { action: 'skip', reason: 'not_published_terminal' };
  }
  if (record.remote_retired_at) {
    return { action: 'skip', reason: 'already_retired' };
  }

  const commandId = record.command_id;
  if (!commandId) {
    return { action: 'skip', reason: 'missing_command_id' };
  }

  if (localResult && !localResult.__parseError && localResult.command_id === commandId) {
    if (localResult.status === 'EXECUTING') {
      return { action: 'skip', reason: 'local_executing' };
    }
  }

  const resultCheck = remoteResultMatchesCommand(
    remoteResultValue,
    commandId,
    record.status,
  );
  if (!resultCheck.ok) {
    return { action: 'skip', reason: resultCheck.reason };
  }

  const expectedSha = journaledRemoteSha(record);
  if (!expectedSha) {
    return {
      action: 'fail_closed',
      reason: 'missing_journaled_remote_sha',
      operatorMessage: RETIREMENT_OPERATOR_MESSAGES.missing_journaled_remote_sha,
    };
  }

  if (!remoteCommandMeta || !remoteCommandMeta.text) {
    return { action: 'mark_retired', reason: 'remote_command_absent' };
  }

  if (remoteCommandValue && remoteCommandValue.command_id !== commandId) {
    return { action: 'skip', reason: 'replacement_command_id' };
  }

  if (!remoteCommandMeta.sha || remoteCommandMeta.sha !== expectedSha) {
    return { action: 'skip', reason: 'replacement_command_sha' };
  }

  return {
    action: 'delete',
    reason: null,
    deleteSha: expectedSha,
    commandId,
  };
}

const RETIREMENT_CLOSE_ON_SKIP = new Set([
  'result_command_id_mismatch',
  'result_not_terminal',
  'result_status_mismatch',
  'replacement_command_id',
  'replacement_command_sha',
  'not_published_terminal',
  'already_retired',
]);

module.exports = {
  RETIREMENT_OPERATOR_MESSAGES,
  RETIREMENT_CLOSE_ON_SKIP,
  journaledRemoteSha,
  remoteResultMatchesCommand,
  evaluateRemoteCommandRetirement,
};
