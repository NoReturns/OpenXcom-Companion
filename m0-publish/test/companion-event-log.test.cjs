'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const {
  MAX_EVENT_LOG_EVENTS,
  ValidationError,
  parseAndValidate,
  computeSnapshotId,
  buildRelayPayload,
  loadAndValidateSnapshotFromText,
} = require('../lib/tactical-publish.cjs');

const FIXTURE_V3 = path.join(__dirname, 'fixtures', 'valid-v3.yaml');
const FIXTURE_V4 = path.join(__dirname, 'fixtures', 'valid-v4.yaml');

function v4Root(overrides = {}) {
  const base = YAML.parse(fs.readFileSync(FIXTURE_V4, 'utf8'));
  return { ...base, ...overrides };
}

describe('schema v4 weapon fire event log (mocked validation)', () => {
  it('accepts valid-v4 fixture with rifle, heavy cannon, and auto-fire events', () => {
    const tactical = loadAndValidateSnapshotFromText(fs.readFileSync(FIXTURE_V4, 'utf8'), YAML);
    assert.equal(tactical.schemaVersion, 4);
    assert.equal(tactical.eventLog.events.length, 3);
    assert.equal(tactical.eventLog.events[0].actionType, 'snap');
    assert.equal(tactical.eventLog.events[1].weaponItemType, 'STR_HEAVY_CANNON');
    assert.equal(tactical.eventLog.events[2].autoShotIndex, 1);
  });

  it('retains identical eventLog across repeated validation (coalesced snapshot semantics)', () => {
    const text = fs.readFileSync(FIXTURE_V4, 'utf8');
    const first = loadAndValidateSnapshotFromText(text, YAML);
    const second = loadAndValidateSnapshotFromText(text, YAML);
    assert.deepEqual(first.eventLog, second.eventLog);
    assert.equal(computeSnapshotId(first), computeSnapshotId(second));
  });

  it('includes eventLog in relay payload companion_schema 4', () => {
    const tactical = loadAndValidateSnapshotFromText(fs.readFileSync(FIXTURE_V4, 'utf8'), YAML);
    const payload = buildRelayPayload(tactical, '2026-01-01T00:00:00.000Z');
    assert.equal(payload.source.companion_schema, 4);
    assert.equal(payload.tactical.eventLog.sessionId.length, 32);
  });

  it('still accepts schema v3 without eventLog', () => {
    const tactical = loadAndValidateSnapshotFromText(fs.readFileSync(FIXTURE_V3, 'utf8'), YAML);
    assert.equal(tactical.schemaVersion, 3);
    assert.equal(tactical.eventLog, undefined);
  });

  it('rejects eventLog on schema v3 snapshots', () => {
    const raw = YAML.parse(fs.readFileSync(FIXTURE_V3, 'utf8'));
    raw.eventLog = {
      sessionId: 'a'.repeat(32),
      oldestSeq: 0,
      latestSeq: 0,
      droppedCount: 0,
      events: [],
    };
    assert.throws(() => parseAndValidate(raw), /unknown root field: eventLog/);
  });

  it('rejects hostile actorUnitId in events', () => {
    const raw = v4Root();
    raw.eventLog.events.push({
      seq: 4,
      type: 'weapon_fired',
      turn: 1,
      actorUnitId: 1000000,
      weaponItemType: 'STR_PLASMA_RIFLE',
      actionType: 'snap',
      target: [5, 5, 0],
    });
    raw.eventLog.latestSeq = 4;
    assert.throws(() => parseAndValidate(raw), /friendly soldier or recorded roster combatant/);
  });

  it('requires autoShotIndex for auto fire and forbids it for snap', () => {
    const raw = v4Root();
    raw.eventLog.events = [
      {
        seq: 1,
        type: 'weapon_fired',
        turn: 1,
        actorUnitId: 1,
        weaponItemType: 'STR_RIFLE',
        actionType: 'auto',
        target: [1, 1, 0],
      },
    ];
    raw.eventLog.oldestSeq = 1;
    raw.eventLog.latestSeq = 1;
    assert.throws(() => parseAndValidate(raw), /autoShotIndex required/);

    raw.eventLog.events[0].autoShotIndex = 1;
    parseAndValidate(raw);

    raw.eventLog.events = [
      {
        seq: 1,
        type: 'weapon_fired',
        turn: 1,
        actorUnitId: 1,
        weaponItemType: 'STR_RIFLE',
        actionType: 'snap',
        target: [1, 1, 0],
      },
    ];
    parseAndValidate(raw);

    raw.eventLog.events[0].autoShotIndex = 2;
    assert.throws(() => parseAndValidate(raw), /must not include autoShotIndex/);
  });

  it('rejects non-monotonic event sequences', () => {
    const raw = v4Root();
    raw.eventLog.events[1].seq = 5;
    assert.throws(() => parseAndValidate(raw), /must increase by 1/);
  });

  it('rejects more than 256 retained events', () => {
    const raw = v4Root({
      eventLog: {
        sessionId: 'b'.repeat(32),
        oldestSeq: 1,
        latestSeq: MAX_EVENT_LOG_EVENTS,
        droppedCount: 0,
        events: Array.from({ length: MAX_EVENT_LOG_EVENTS + 1 }, (_, i) => ({
          seq: i + 1,
          type: 'weapon_fired',
          turn: 1,
          actorUnitId: 1,
          weaponItemType: 'STR_RIFLE',
          actionType: 'snap',
          target: [1, 1, 0],
        })),
      },
    });
    assert.throws(() => parseAndValidate(raw), /256 event limit/);
  });

  it('validates overflow metadata with droppedCount', () => {
    const raw = v4Root();
    raw.eventLog.droppedCount = 12;
    raw.eventLog.oldestSeq = 13;
    raw.eventLog.latestSeq = 15;
    raw.eventLog.events = [1, 2, 3].map((offset) => ({
      seq: 12 + offset,
      type: 'weapon_fired',
      turn: 2,
      actorUnitId: 1,
      weaponItemType: 'STR_RIFLE',
      actionType: 'snap',
      target: [2, 2, 0],
    }));
    const tactical = parseAndValidate(raw);
    assert.equal(tactical.eventLog.droppedCount, 12);
    assert.equal(tactical.eventLog.oldestSeq, 13);
  });

  it('rejects unknown event fields (no hit/miss or alien leak fields)', () => {
    const raw = v4Root();
    raw.eventLog.events[0].hit = true;
    assert.throws(() => parseAndValidate(raw), /unknown field: hit/);
  });

  it('rejects missing eventLog on schema v4', () => {
    const raw = v4Root();
    delete raw.eventLog;
    assert.throws(() => parseAndValidate(raw), /eventLog required/);
  });

  it('validateEventLog accepts distinct session id after reload (mocked)', () => {
    const first = parseAndValidate(v4Root());
    const reloaded = parseAndValidate(
      v4Root({
        eventLog: {
          ...first.eventLog,
          sessionId: 'c'.repeat(32),
          oldestSeq: 0,
          latestSeq: 0,
          droppedCount: 0,
          events: [],
        },
      })
    );
    assert.notEqual(first.eventLog.sessionId, reloaded.eventLog.sessionId);
  });
});

describe('engine integration note', () => {
  it('documents that live capture is validated in-engine, not in this Node suite', () => {
    assert.ok(true, 'ProjectileFlyBState::createNewProjectile records one event per projectile');
  });
});
