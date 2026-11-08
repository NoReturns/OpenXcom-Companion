'use strict';

const YAML = require('yaml');
const {
  loadAndValidateSnapshotFromText,
  buildRelayPayload,
} = require('./tactical-publish.cjs');
const { readSnapshotByteBuffer, sha256HexLower } = require('./briefing-snapshot.cjs');
const { isTerminalStatus } = require('./tactical-command.cjs');
const { markCommandRecord } = require('./command-journal.cjs');
const path = require('node:path');
const { writeTacticalPublicationConfirmAtomic } = require('./tactical-publication-confirm.cjs');
const { buildMoveOutcomeBrief } = require('./move-result-consumer.cjs');

const SNAPSHOT_SHA_PATTERN = /^[a-f0-9]{64}$/;
const POST_COMMAND_PUBLISH_STATUSES = new Set(['COMPLETED', 'INTERRUPTED', 'FAILED']);

function positionsEqual(snapshotPos, resultPos) {
  if (!snapshotPos || !resultPos) {
    return false;
  }
  const sx = Array.isArray(snapshotPos) ? snapshotPos[0] : snapshotPos.x;
  const sy = Array.isArray(snapshotPos) ? snapshotPos[1] : snapshotPos.y;
  const sz = Array.isArray(snapshotPos) ? snapshotPos[2] : snapshotPos.z;
  return sx === resultPos.x && sy === resultPos.y && sz === resultPos.z;
}

/**
 * Publish GitHub m0/state.json from on-disk tactical YAML after a terminal companion
 * command, without fabricating F6 briefing requests or acknowledgements.
 */
async function tryPublishPostCommandTacticalState(input) {
  const {
    snapshotPath,
    result,
    commandId,
    journal,
    record,
    deliveredCommand = null,
    dryRun = false,
    publishRelayState,
    log = () => {},
    readFileSync,
    existsSync,
    now = () => Date.now(),
  } = input;

  if (typeof publishRelayState !== 'function') {
    return { action: 'skip', reason: 'no_publisher' };
  }
  if (!result || result.__parseError) {
    return { action: 'skip', reason: 'invalid_result' };
  }
  if (!isTerminalStatus(result.status)) {
    return { action: 'skip', reason: 'not_terminal' };
  }
  if (!POST_COMMAND_PUBLISH_STATUSES.has(result.status)) {
    return { action: 'skip', reason: 'status_not_publishable' };
  }
  if (typeof result.snapshot_sha256 !== 'string' || !SNAPSHOT_SHA_PATTERN.test(result.snapshot_sha256)) {
    return { action: 'fail_closed', reason: 'missing_result_snapshot_sha256' };
  }

  if (record && record.post_command_tactical_sha256 === result.snapshot_sha256) {
    return { action: 'skip', reason: 'already_published' };
  }

  if (!existsSync(snapshotPath)) {
    return { action: 'fail_closed', reason: 'snapshot_missing' };
  }

  let digest;
  let tactical;
  try {
    const bytes = readSnapshotByteBuffer(readFileSync, snapshotPath);
    digest = sha256HexLower(bytes);
    if (digest !== result.snapshot_sha256) {
      return { action: 'fail_closed', reason: 'snapshot_sha256_mismatch' };
    }
    tactical = loadAndValidateSnapshotFromText(bytes.toString('utf8'), YAML);
  } catch (error) {
    return {
      action: 'fail_closed',
      reason: 'snapshot_invalid',
      message: error.message || String(error),
    };
  }

  if (!tactical.eventLog || tactical.eventLog.sessionId !== result.session_id) {
    return { action: 'fail_closed', reason: 'session_mismatch' };
  }
  if (tactical.turn !== result.turn) {
    return { action: 'fail_closed', reason: 'turn_mismatch' };
  }

  if (record && record.delivered_command_snapshot_sha256
    && digest === record.delivered_command_snapshot_sha256) {
    return { action: 'fail_closed', reason: 'snapshot_stale_unchanged' };
  }

  if (result.status === 'COMPLETED') {
    if (!Number.isInteger(result.actor_unit_id)) {
      return { action: 'fail_closed', reason: 'missing_actor_unit_id' };
    }
    if (!result.final_position || !Number.isInteger(result.final_position.x)) {
      return { action: 'fail_closed', reason: 'missing_final_position' };
    }
    const actor = tactical.units.find((unit) => unit.id === result.actor_unit_id);
    if (!actor) {
      return { action: 'fail_closed', reason: 'actor_missing_from_snapshot' };
    }
    if (!positionsEqual(actor.position, result.final_position)) {
      return { action: 'fail_closed', reason: 'final_position_mismatch' };
    }
    if (typeof result.remaining_tu === 'number' && actor.timeUnits !== result.remaining_tu) {
      return { action: 'fail_closed', reason: 'remaining_tu_mismatch' };
    }
    if (typeof result.kneeled === 'boolean' && actor.kneeled !== result.kneeled) {
      return { action: 'fail_closed', reason: 'kneeled_mismatch' };
    }
  }

  const publishedAt = new Date(now()).toISOString();
  const relayOptions = { snapshotSha256: digest };
  if (
    result.command_type === 'MOVE'
    && deliveredCommand
    && deliveredCommand.command_id === result.command_id
  ) {
    const brief = buildMoveOutcomeBrief(result, deliveredCommand);
    if (brief) {
      relayOptions.lastMoveOutcomeBrief = brief;
    }
  }
  const relay = buildRelayPayload(tactical, publishedAt, null, relayOptions);

  if (dryRun) {
    markCommandRecord(journal, commandId, {
      post_command_tactical_sha256: digest,
      post_command_tactical_snapshot_id: relay.snapshot_id,
      post_command_tactical_dry_run: true,
    });
    log(`Dry-run would publish post-command tactical ${relay.snapshot_id.slice(0, 12)} for ${commandId.slice(0, 8)}.`);
    return {
      action: 'published_dry_run',
      relay,
      journal,
    };
  }

  try {
    const publishOutcome = await publishRelayState(relay);
    markCommandRecord(journal, commandId, {
      post_command_tactical_sha256: digest,
      post_command_tactical_snapshot_id: relay.snapshot_id,
      post_command_tactical_published_at: publishedAt,
      post_command_tactical_skipped_remote: Boolean(publishOutcome && publishOutcome.skipped),
    });
    writeTacticalPublicationConfirmAtomic(path.dirname(snapshotPath), {
      session_id: result.session_id,
      turn: result.turn,
      state_version: tactical.eventLog?.latestSeq ?? 0,
      snapshot_sha256: digest,
      source: 'post_command',
      status: publishOutcome && publishOutcome.skipped ? 'skipped_unchanged' : 'published',
    });
    const skipped = publishOutcome && publishOutcome.skipped;
    log(
      skipped
        ? `Post-command tactical unchanged on GitHub (${relay.snapshot_id.slice(0, 12)}).`
        : `Published post-command tactical ${relay.snapshot_id.slice(0, 12)} for ${commandId.slice(0, 8)}.`,
    );
    return {
      action: skipped ? 'skipped_remote_unchanged' : 'published',
      relay,
      journal,
      publishOutcome,
    };
  } catch (error) {
    return {
      action: 'fail_closed',
      reason: 'publish_failed',
      message: error.message || String(error),
    };
  }
}

module.exports = {
  POST_COMMAND_PUBLISH_STATUSES,
  tryPublishPostCommandTacticalState,
};
