'use strict';

/**
 * Terrain query snapshot binding (M1 P0A).
 *
 * snapshot_id on the relay envelope is computeSnapshotId(full tactical) at publish time.
 * Relay shrink mutates relay.tactical only; envelope snapshot_id and commandBinding
 * remain tied to verified on-disk YAML.
 *
 * Terrain queries must authorize against the canonical tactical object (from YAML),
 * not a re-hash of trimmed relay JSON.
 */

const { ValidationError, computeSnapshotId } = require('./tactical-publish.cjs');
const { parseCommandBinding } = require('./command-binding.cjs');
const { SNAPSHOT_SHA256_RE } = require('./briefing-request.cjs');

const SNAPSHOT_ID_RE = /^[a-f0-9]{64}$/;
const SESSION_ID_RE = /^[a-f0-9]{32}$/;

function assert(condition, message) {
  if (!condition) throw new ValidationError(message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalTerrainQuerySnapshotId(canonicalTactical) {
  return computeSnapshotId(canonicalTactical);
}

/**
 * @param {object} options
 * @param {object} options.request — terrain query request (snapshot_id required)
 * @param {object} options.canonicalTactical — full validated tactical from YAML
 * @param {string} [options.yamlSha256] — SHA-256 of on-disk YAML bytes (command authority twin)
 * @param {object} [options.commandBinding] — relay commandBinding when cross-check desired
 * @param {object} [options.relayEnvelope] — published relay JSON for envelope snapshot_id pin
 * @param {object} [options.executionTactical] — tactical object passed to executeTerrainQuery (may be trimmed)
 */
function verifyTerrainQuerySnapshotBinding(options) {
  const {
    request,
    canonicalTactical,
    yamlSha256,
    commandBinding,
    relayEnvelope,
    executionTactical,
  } = options;

  assert(canonicalTactical && isPlainObject(canonicalTactical), 'canonicalTactical required');
  assert(isPlainObject(request), 'terrain query must be an object');
  assert(typeof request.snapshot_id === 'string' && SNAPSHOT_ID_RE.test(request.snapshot_id),
    'snapshot_id must be 64-char lowercase hex sha256');

  const canonicalId = canonicalTerrainQuerySnapshotId(canonicalTactical);
  assert(request.snapshot_id === canonicalId,
    'snapshot_id does not match canonical tactical snapshot');

  if (executionTactical && executionTactical !== canonicalTactical) {
    const executionId = computeSnapshotId(executionTactical);
    if (executionId !== canonicalId) {
      assert(yamlSha256 || commandBinding,
        'trimmed relay tactical requires verified YAML digest or commandBinding');
    }
  }

  if (yamlSha256 !== undefined) {
    assert(typeof yamlSha256 === 'string' && SNAPSHOT_SHA256_RE.test(yamlSha256),
      'yamlSha256 must be 64 lowercase hex');
  }

  if (commandBinding !== undefined && commandBinding !== null) {
    const binding = parseCommandBinding(commandBinding);
    assert(binding.session_id === canonicalTactical.eventLog.sessionId,
      'commandBinding.session_id does not match canonical tactical session');
    assert(binding.turn === canonicalTactical.turn,
      'commandBinding.turn does not match canonical tactical turn');
    assert(binding.state_version === canonicalTactical.eventLog.latestSeq,
      'commandBinding.state_version does not match canonical eventLog.latestSeq');
    if (yamlSha256 !== undefined) {
      assert(binding.snapshot_sha256 === yamlSha256,
        'commandBinding.snapshot_sha256 does not match verified YAML digest');
    }
    if (request.session_id !== undefined) {
      assert(typeof request.session_id === 'string' && SESSION_ID_RE.test(request.session_id),
        'session_id must be 32-char lowercase hex');
      assert(request.session_id === binding.session_id,
        'terrain query session_id does not match commandBinding');
    }
    if (request.turn !== undefined) {
      assert(Number.isInteger(request.turn) && request.turn === binding.turn,
        'terrain query turn does not match commandBinding');
    }
    if (request.state_version !== undefined) {
      assert(Number.isInteger(request.state_version) && request.state_version === binding.state_version,
        'terrain query state_version does not match commandBinding');
    }
  }

  if (relayEnvelope !== undefined && relayEnvelope !== null) {
    assert(typeof relayEnvelope.snapshot_id === 'string' && SNAPSHOT_ID_RE.test(relayEnvelope.snapshot_id),
      'relay envelope snapshot_id invalid');
    assert(relayEnvelope.snapshot_id === canonicalId,
      'relay envelope snapshot_id does not match verified canonical tactical snapshot');
    if (relayEnvelope.tactical) {
      const relayTacticalId = computeSnapshotId(relayEnvelope.tactical);
      if (relayTacticalId !== canonicalId) {
        const shrunk = Boolean(relayEnvelope.relay_export_shrink)
          || Boolean(relayEnvelope.tactical.terrainOmittedForRelay);
        assert(shrunk,
          'relay tactical JSON hash mismatch without documented adaptive shrink');
      }
    }
  }

  return { canonicalSnapshotId: canonicalId };
}

function resolveTerrainQueryTactical(canonicalTactical, executionTactical) {
  return canonicalTactical ?? executionTactical;
}

module.exports = {
  canonicalTerrainQuerySnapshotId,
  verifyTerrainQuerySnapshotBinding,
  resolveTerrainQueryTactical,
};
