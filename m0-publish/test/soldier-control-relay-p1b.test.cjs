'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const YAML = require('yaml');
const {
  loadAndValidateSnapshotFromText,
  buildRelayPayload,
} = require('../lib/tactical-publish.cjs');
const { buildCommandBinding, composeMoveCommand } = require('../lib/command-binding.cjs');
const {
  buildSoldierControlMirror,
  parseSoldierControlDocument,
} = require('../lib/soldier-control-relay.cjs');

const FIXTURE_V5 = path.join(__dirname, 'fixtures', 'valid-v5.yaml');
const FIXTURE_CARRIED = path.join(__dirname, 'fixtures', 'carried-unconscious-v5.yaml');

function sha256HexLower(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function loadV5() {
  const text = fs.readFileSync(FIXTURE_V5, 'utf8');
  const tactical = loadAndValidateSnapshotFromText(text, YAML);
  return { text, tactical, session: tactical.eventLog.sessionId };
}

function controlJson({
  session,
  assignments = {},
  campaign_id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  tactical_battle_id = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
} = {}) {
  return JSON.stringify({
    schema_version: 1,
    session_id: session,
    campaign_id,
    tactical_battle_id,
    assignments,
  });
}

describe('P1-B soldierControl relay mirror', () => {
  it('exposes one AI and one human for valid session with single AI soldier', () => {
    const { tactical, session } = loadV5();
    const mirror = buildSoldierControlMirror(tactical, {
      soldierControlFileJson: controlJson({ session, assignments: { 1: 'ai' } }),
      capturedAt: '2026-11-11T12:00:00.000Z',
    });
    assert.equal(mirror.availability, 'available');
    assert.equal(mirror.soldiers.length, 2);
    assert.deepEqual(mirror.soldiers.find((s) => s.id === 1), { id: 1, controlMode: 'ai' });
    assert.deepEqual(mirror.soldiers.find((s) => s.id === 2), { id: 2, controlMode: 'human' });
  });

  it('exposes multiple AI soldiers', () => {
    const { tactical, session } = loadV5();
    const mirror = buildSoldierControlMirror(tactical, {
      soldierControlFileJson: controlJson({ session, assignments: { 1: 'ai', 2: 'ai' } }),
    });
    assert.equal(mirror.availability, 'available');
    assert.equal(mirror.soldiers.filter((s) => s.controlMode === 'ai').length, 2);
  });

  it('treats all roster soldiers as human when assignments empty', () => {
    const { tactical, session } = loadV5();
    const mirror = buildSoldierControlMirror(tactical, {
      soldierControlFileJson: controlJson({ session, assignments: {} }),
    });
    assert.equal(mirror.availability, 'available');
    assert.ok(mirror.soldiers.every((s) => s.controlMode === 'human'));
  });

  it('includes AI-owned on-map unconscious and carried unconscious roster soldiers', () => {
    const text = fs.readFileSync(FIXTURE_CARRIED, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(text, YAML);
    const session = tactical.eventLog.sessionId;
    const mirror = buildSoldierControlMirror(tactical, {
      soldierControlFileJson: controlJson({ session, assignments: { 2: 'ai', 3: 'ai' } }),
    });
    assert.equal(mirror.availability, 'available');
    const carried = mirror.soldiers.find((s) => s.id === 3);
    assert.equal(carried.controlMode, 'ai');
    const onMap = mirror.soldiers.find((s) => s.id === 2);
    assert.equal(onMap.controlMode, 'ai');
    assert.equal(mirror.soldiers.find((s) => s.id === 1).controlMode, 'human');
  });

  it('reports unavailable when control file missing', () => {
    const { tactical } = loadV5();
    const mirror = buildSoldierControlMirror(tactical, {});
    assert.equal(mirror.availability, 'unavailable');
    assert.equal(mirror.unavailable_reason, 'missing_control_file');
  });

  it('reports stale session id without guessing ownership', () => {
    const { tactical, session } = loadV5();
    const mirror = buildSoldierControlMirror(tactical, {
      soldierControlFileJson: controlJson({ session: 'c'.repeat(32), assignments: { 1: 'ai' } }),
    });
    assert.equal(mirror.availability, 'unavailable');
    assert.equal(mirror.unavailable_reason, 'stale_session_id');
    assert.equal(mirror.session_id, session);
    assert.equal(mirror.soldiers, undefined);
  });

  it('reports identity mismatch when durable context does not match', () => {
    const { tactical, session } = loadV5();
    const mirror = buildSoldierControlMirror(tactical, {
      soldierControlFileJson: controlJson({ session, assignments: { 1: 'ai' } }),
      ownershipBindingContext: {
        campaign_id: 'cccccccccccccccccccccccccccccccc',
        tactical_battle_id: 'dddddddddddddddddddddddddddddddd',
      },
    });
    assert.equal(mirror.availability, 'unavailable');
    assert.equal(mirror.unavailable_reason, 'identity_mismatch');
  });

  it('rejects unknown soldier id in assignments', () => {
    const { tactical, session } = loadV5();
    const mirror = buildSoldierControlMirror(tactical, {
      soldierControlFileJson: controlJson({ session, assignments: { 99: 'ai' } }),
    });
    assert.equal(mirror.availability, 'unavailable');
    assert.equal(mirror.unavailable_reason, 'unknown_assignment_soldier_id');
  });

  it('reflects ownership changes across publications', () => {
    const { text, tactical, session } = loadV5();
    const digest = sha256HexLower(text);
    const publishedAt = '2026-11-11T12:00:00.000Z';
    const relayA = buildRelayPayload(tactical, publishedAt, null, {
      snapshotSha256: digest,
      soldierControlFileJson: controlJson({ session, assignments: { 1: 'ai' } }),
    });
    const relayB = buildRelayPayload(tactical, publishedAt, null, {
      snapshotSha256: digest,
      soldierControlFileJson: controlJson({ session, assignments: { 2: 'ai' } }),
    });
    assert.equal(relayA.soldierControl.soldiers.find((s) => s.id === 1).controlMode, 'ai');
    assert.equal(relayA.soldierControl.soldiers.find((s) => s.id === 2).controlMode, 'human');
    assert.equal(relayB.soldierControl.soldiers.find((s) => s.id === 2).controlMode, 'ai');
    assert.equal(relayB.soldierControl.soldiers.find((s) => s.id === 1).controlMode, 'human');
  });

  it('keeps commandBinding MOVE roster unchanged (carried still excluded)', () => {
    const text = fs.readFileSync(FIXTURE_CARRIED, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(text, YAML);
    const digest = sha256HexLower(text);
    const session = tactical.eventLog.sessionId;
    const relay = buildRelayPayload(tactical, new Date().toISOString(), null, {
      snapshotSha256: digest,
      soldierControlFileJson: controlJson({ session, assignments: { 1: 'ai' } }),
    });
    const binding = buildCommandBinding(tactical, digest);
    assert.equal(binding.player_soldiers.length, 2);
    assert.ok(relay.soldierControl.soldiers.find((s) => s.id === 3));
    const move = composeMoveCommand(binding, {
      commandId: 'move-ai-1',
      actorUnitId: 1,
      destination: { x: 2, y: 2, z: 0 },
    });
    assert.equal(move.actor_unit_id, 1);
    assert.throws(() => composeMoveCommand(binding, {
      commandId: 'move-carried',
      actorUnitId: 3,
      destination: { x: 2, y: 2, z: 0 },
    }), /player_soldier/);
  });

  it('parseSoldierControlDocument matches engine ai-only assignment shape', () => {
    const doc = parseSoldierControlDocument(controlJson({
      session: 'a'.repeat(32),
      assignments: { 1: 'ai' },
    }));
    assert.equal(doc.assignments[1], 'ai');
    assert.throws(() => parseSoldierControlDocument(controlJson({
      session: 'a'.repeat(32),
      assignments: { 1: 'human' },
    })), /invalid_assignment_mode/);
  });
});
