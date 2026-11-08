'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const {
  ValidationError,
  parseAndValidate,
  loadAndValidateSnapshotFromText,
} = require('../lib/tactical-publish.cjs');

const FIXTURE_V4 = path.join(__dirname, 'fixtures', 'valid-v4.yaml');
const FIXTURE_STAGE_C = path.join(__dirname, 'fixtures', 'test-battle-stage-c-perception-regression.yaml');

function stageCUnits(base) {
  return [
    ...base.units,
    {
      id: 4,
      faction: 0,
      originalFaction: 0,
      position: [3, 2, 0],
      name: 'Observer Soldier',
      health: 33,
      timeUnits: 5,
      kneeled: false,
      activeHand: 'STR_RIGHT_HAND',
      hands: { right: { itemType: 'STR_LASER_RIFLE', battleType: 1 }, left: null },
      inventory: [],
    },
    {
      id: 1000002,
      faction: 1,
      originalFaction: 1,
      position: [19, 33, 0],
    },
  ];
}

function v4Root(overrides = {}) {
  const base = YAML.parse(fs.readFileSync(FIXTURE_V4, 'utf8'));
  return { ...base, ...overrides };
}

function emptyPerceptionMeta(events) {
  return {
    sessionId: 'a1b2c3d4e5f6789012345678abcdef01',
    oldestSeq: events.length ? 1 : 0,
    latestSeq: events.length ? events.length : 0,
    droppedCount: 0,
    events,
  };
}

describe('M1-WP6 perceptionLog validation', () => {
  it('accepts audio-only gunfire without coordinates', () => {
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([
        {
          seq: 1,
          type: 'gunfire_observed',
          turn: 1,
          perceptionChannel: 'heard',
          confidence: 'audio_only',
          positionKnown: false,
        },
      ]),
    });
    const tactical = parseAndValidate(raw);
    assert.equal(tactical.perceptionLog.events[0].position, undefined);
  });

  it('rejects hidden gunfire that leaks coordinates on heard channel', () => {
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([
        {
          seq: 1,
          type: 'gunfire_observed',
          turn: 1,
          perceptionChannel: 'heard',
          confidence: 'audio_only',
          positionKnown: true,
          position: [1, 2, 0],
        },
      ]),
    });
    assert.throws(() => parseAndValidate(raw), /heard-only events must not expose coordinates/);
  });

  it('rejects Novosibirsk live unit_last_seen heard+coordinates leak (seq 20)', () => {
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([
        {
          seq: 1,
          type: 'unit_last_seen',
          turn: 3,
          perceptionChannel: 'seen',
          confidence: 'sighted',
          positionKnown: true,
          position: [17, 7, 0],
          observerUnitId: 1,
          subjectUnitId: 1000008,
          compassDirection: 'west',
        },
        {
          seq: 2,
          type: 'unit_last_seen',
          turn: 3,
          perceptionChannel: 'heard',
          confidence: 'last_seen',
          positionKnown: true,
          position: [15, 6, 0],
          subjectUnitId: 1000008,
        },
      ]),
    });
    assert.throws(() => parseAndValidate(raw), /heard-only events must not expose coordinates/);
  });

  it('accepts corrected Novosibirsk memory at last observed tile (17,7)', () => {
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([
        {
          seq: 1,
          type: 'unit_last_seen',
          turn: 3,
          perceptionChannel: 'seen',
          confidence: 'sighted',
          positionKnown: true,
          position: [17, 7, 0],
          observerUnitId: 1,
          subjectUnitId: 1000008,
          compassDirection: 'west',
        },
        {
          seq: 2,
          type: 'unit_last_seen',
          turn: 3,
          perceptionChannel: 'seen',
          confidence: 'last_seen',
          positionKnown: true,
          position: [17, 7, 0],
          subjectUnitId: 1000008,
        },
      ]),
    });
    const tactical = parseAndValidate(raw);
    assert.equal(tactical.perceptionLog.events[1].perceptionChannel, 'seen');
    assert.deepEqual(tactical.perceptionLog.events[1].position, [17, 7, 0]);
  });

  it('accepts unit_last_seen with last_seen confidence and coordinates', () => {
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([
        {
          seq: 1,
          type: 'unit_last_seen',
          turn: 1,
          perceptionChannel: 'seen',
          confidence: 'last_seen',
          positionKnown: true,
          position: [7, 8, 0],
          subjectUnitId: 1000000,
          observerUnitId: 1,
          compassDirection: 'north',
        },
      ]),
    });
    const tactical = parseAndValidate(raw);
    assert.equal(tactical.perceptionLog.events[0].subjectUnitId, 1000000);
  });

  it('accepts hostile_casualty_tile_observed with position only (WP8C)', () => {
    const base = v4Root();
    const raw = {
      ...base,
      perceptionLog: emptyPerceptionMeta([
        {
          seq: 1,
          type: 'hostile_casualty_tile_observed',
          turn: 3,
          perceptionChannel: 'seen',
          confidence: 'possible_ground_equipment',
          positionKnown: true,
          position: [12, 19, 0],
          observerUnitId: 4,
        },
      ]),
      units: stageCUnits(base),
    };
    const tactical = parseAndValidate(raw);
    assert.equal(tactical.perceptionLog.events[0].type, 'hostile_casualty_tile_observed');
    assert.deepEqual(tactical.perceptionLog.events[0].position, [12, 19, 0]);
  });

  it('rejects hostile_casualty_tile_observed with subjectUnitId', () => {
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([
        {
          seq: 1,
          type: 'hostile_casualty_tile_observed',
          turn: 1,
          perceptionChannel: 'seen',
          confidence: 'alien_casualty_tile',
          positionKnown: true,
          position: [1, 1, 0],
          subjectUnitId: 1000000,
        },
      ]),
    });
    assert.throws(() => parseAndValidate(raw), /must not include subjectUnitId/);
  });

  it('accepts visible door with seen_and_heard and coordinates', () => {
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([
        {
          seq: 1,
          type: 'door_sound_heard',
          turn: 1,
          perceptionChannel: 'seen_and_heard',
          confidence: 'door_visible',
          positionKnown: true,
          position: [5, 5, 0],
          observerUnitId: 1,
          compassDirection: 'west',
        },
      ]),
    });
    const tactical = parseAndValidate(raw);
    assert.equal(tactical.perceptionLog.events[0].perceptionChannel, 'seen_and_heard');
  });

  it('rejects compass bearing without known position', () => {
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([
        {
          seq: 1,
          type: 'door_sound_heard',
          turn: 1,
          perceptionChannel: 'heard',
          confidence: 'audio_only',
          positionKnown: false,
          compassDirection: 'east',
        },
      ]),
    });
    assert.throws(() => parseAndValidate(raw), /compassDirection/);
  });

  it('rejects empty perceptionLog.sessionId', () => {
    const raw = v4Root({
      perceptionLog: {
        sessionId: '',
        oldestSeq: 0,
        latestSeq: 0,
        droppedCount: 0,
        events: [],
      },
    });
    assert.throws(() => parseAndValidate(raw), /perceptionLog\.sessionId/);
  });

  it('rejects heard-only door with observer not in friendly roster (M1 live Stage C)', () => {
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([
        {
          seq: 1,
          type: 'door_sound_heard',
          turn: 1,
          perceptionChannel: 'heard',
          confidence: 'audio_only',
          positionKnown: false,
          observerUnitId: 18,
          subjectUnitId: 13094337,
        },
        {
          seq: 2,
          type: 'unit_last_seen',
          turn: 2,
          perceptionChannel: 'seen',
          confidence: 'sighted',
          positionKnown: true,
          position: [19, 33, 0],
          observerUnitId: 4,
          subjectUnitId: 1000002,
          compassDirection: 'southwest',
        },
      ]),
    });
    assert.throws(() => parseAndValidate(raw), /observerUnitId must be a friendly soldier/);
  });

  it('accepts corrected Stage C perception after bogus heard-only observer removed', () => {
    const base = v4Root();
    const raw = {
      ...base,
      units: stageCUnits(base),
      perceptionLog: emptyPerceptionMeta([
        {
          seq: 1,
          type: 'door_sound_heard',
          turn: 1,
          perceptionChannel: 'heard',
          confidence: 'audio_only',
          positionKnown: false,
        },
        {
          seq: 2,
          type: 'unit_last_seen',
          turn: 2,
          perceptionChannel: 'seen',
          confidence: 'sighted',
          positionKnown: true,
          position: [19, 33, 0],
          observerUnitId: 4,
          subjectUnitId: 1000002,
          compassDirection: 'southwest',
        },
      ]),
    };
    const tactical = parseAndValidate(raw);
    assert.equal(tactical.perceptionLog.events.length, 2);
    assert.equal(tactical.perceptionLog.events[0].observerUnitId, undefined);
  });

  it('loads Stage C perception regression fixture', () => {
    const tactical = loadAndValidateSnapshotFromText(fs.readFileSync(FIXTURE_STAGE_C, 'utf8'), YAML);
    assert.equal(tactical.perceptionLog.events.length, 2);
    assert.equal(tactical.perceptionLog.events[1].observerUnitId, 4);
  });

  it('does not require perceptionLog (backward compatible)', () => {
    const tactical = loadAndValidateSnapshotFromText(fs.readFileSync(FIXTURE_V4, 'utf8'), YAML);
    assert.equal(tactical.perceptionLog, undefined);
  });

  it('repeated validation of same snapshot does not duplicate perception events', () => {
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([
        {
          seq: 1,
          type: 'impact_observed',
          turn: 1,
          perceptionChannel: 'heard',
          confidence: 'audio_only',
          positionKnown: false,
        },
      ]),
    });
    const text = YAML.stringify(raw);
    const first = loadAndValidateSnapshotFromText(text, YAML);
    const second = loadAndValidateSnapshotFromText(text, YAML);
    assert.deepEqual(first.perceptionLog, second.perceptionLog);
  });
});
