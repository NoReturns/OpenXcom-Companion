'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const YAML = require('yaml');

const { loadAndValidateSnapshotFromText, buildRelayPayload } = require('../../lib/tactical-publish.cjs');
const {
  cloneRelayPayload,
  publishedByteLength,
  prepareRelayPayloadForPublish,
  RELAY_PUBLISH_MAX_BYTES,
  RELAY_SHRINK_EXHAUSTED,
} = require('../../lib/relay-payload-adaptive-shrink.cjs');
const { sha256HexLower } = require('../../lib/briefing-snapshot.cjs');

const FIXTURE_V5 = path.join(__dirname, '..', 'fixtures', 'valid-v5.yaml');

/** Raw padding bytes inside synthetic packed-v1 blob (deterministic). */
const SYNTHETIC_TERRAIN_PAD_CHARS = 140_000;

function syncEventLogSeq(log) {
  if (!log?.events) {
    return;
  }
  let seq = 0;
  for (const event of log.events) {
    seq += 1;
    event.seq = seq;
  }
  log.oldestSeq = log.events.length ? 1 : 0;
  log.latestSeq = log.events.length ? seq : 0;
}

/**
 * Builds a relay JSON copy that exceeds {@link RELAY_PUBLISH_MAX_BYTES} before adaptive shrink.
 * Based on valid-v5.yaml only (no live tactical-live.yaml dependency).
 */
function buildOversizedRelayForShrinkTest(overrides = {}) {
  const padLen = overrides.terrainPadChars ?? SYNTHETIC_TERRAIN_PAD_CHARS;
  const priorTurn = overrides.priorTurn ?? 0;
  const currentTurn = overrides.currentTurn ?? 1;
  const perceptionCount = overrides.perceptionCount ?? 128;
  const extraWeaponEvents = overrides.extraWeaponEvents ?? 128;

  const text = fs.readFileSync(FIXTURE_V5, 'utf8');
  const tactical = loadAndValidateSnapshotFromText(text, YAML);
  const digest = sha256HexLower(Buffer.from(text, 'utf8'));
  const meta = {
    request_id: crypto.randomBytes(16).toString('hex'),
    session_id: tactical.eventLog.sessionId,
    turn: tactical.turn,
  };
  const base = buildRelayPayload(tactical, new Date(0).toISOString(), meta, { snapshotSha256: digest });
  const relay = cloneRelayPayload(base);

  relay.tactical.terrain = {
    memoryNote: 'synthetic oversized packed-v1 padding for relay shrink tests',
    encoding: 'packed-v1',
    recordCount: 1,
    data: Buffer.from('P'.repeat(padLen)).toString('base64'),
  };

  const perceptionEvents = [];
  for (let i = 0; i < perceptionCount; i += 1) {
    perceptionEvents.push({
      seq: i + 1,
      type: 'door_sound_heard',
      turn: i < Math.floor(perceptionCount / 2) ? priorTurn : currentTurn,
      perceptionChannel: 'heard',
      confidence: 'audio_only',
      positionKnown: false,
    });
  }
  relay.tactical.perceptionLog = {
    sessionId: tactical.eventLog.sessionId,
    oldestSeq: 1,
    latestSeq: perceptionCount,
    droppedCount: 0,
    events: perceptionEvents,
  };

  for (let i = 0; i < extraWeaponEvents; i += 1) {
    relay.tactical.eventLog.events.push({
      seq: 0,
      type: 'weapon_fired',
      turn: currentTurn,
      actorUnitId: 1,
      weaponItemType: 'STR_RIFLE',
      actionType: 'snap',
      target: { x: 5, y: 5, z: 0 },
    });
  }
  syncEventLogSeq(relay.tactical.eventLog);

  const hostile = relay.tactical.units?.find((u) => u.faction === 1);
  if (hostile && !hostile.facing) {
    hostile.facing = { direction: 0, label: 'north', vector: { dx: 0, dy: -1 } };
  }

  const bytes = publishedByteLength(relay);
  if (bytes <= RELAY_PUBLISH_MAX_BYTES) {
    throw new Error(
      `oversized relay fixture is ${bytes} bytes (need > ${RELAY_PUBLISH_MAX_BYTES}); increase SYNTHETIC_TERRAIN_PAD_CHARS`,
    );
  }

  return relay;
}

/**
 * Relay that still exceeds {@link RELAY_PUBLISH_MAX_BYTES} after all adaptive-shrink tiers.
 * Irreducible bulk is attached to unitStateBrief (not trimmed by shrink).
 */
function buildShrinkExhaustedRelay(overrides = {}) {
  const exceptionCount = overrides.exceptionCount ?? 800;
  const messageChars = overrides.messageChars ?? 400;
  const relay = buildOversizedRelayForShrinkTest(overrides);
  relay.unitStateBrief = relay.unitStateBrief ?? { schema_version: 1, exceptions: [] };
  relay.unitStateBrief.exceptions = relay.unitStateBrief.exceptions ?? [];
  for (let i = 0; i < exceptionCount; i += 1) {
    relay.unitStateBrief.exceptions.push({
      kind: 'low_morale_heuristic',
      unitId: 1,
      message: `fixture_pad_${i}_${'x'.repeat(messageChars)}`,
    });
  }
  try {
    prepareRelayPayloadForPublish(relay);
  } catch (error) {
    if (error.code === RELAY_SHRINK_EXHAUSTED) {
      return relay;
    }
    throw error;
  }
  throw new Error(
    'buildShrinkExhaustedRelay: increase exceptionCount/messageChars; shrink must exhaust',
  );
}

module.exports = {
  FIXTURE_V5,
  SYNTHETIC_TERRAIN_PAD_CHARS,
  buildOversizedRelayForShrinkTest,
  buildShrinkExhaustedRelay,
};
