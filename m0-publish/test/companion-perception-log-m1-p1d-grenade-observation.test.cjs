'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { parseAndValidate, THROW_LAUNCH_PERCEPTION_EVENT_TYPES } = require('../lib/tactical-publish.cjs');

const FIXTURE_V4 = path.join(__dirname, 'fixtures', 'valid-v4.yaml');

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

describe('M1 P1-D grenade throw / launch perception', () => {
  it('registers throw and launch observation event types', () => {
    assert.ok(THROW_LAUNCH_PERCEPTION_EVENT_TYPES.has('grenade_throw_observed'));
    assert.ok(THROW_LAUNCH_PERCEPTION_EVENT_TYPES.has('explosive_launch_observed'));
    assert.ok(THROW_LAUNCH_PERCEPTION_EVENT_TYPES.has('object_throw_observed'));
    assert.ok(THROW_LAUNCH_PERCEPTION_EVENT_TYPES.has('throw_observed'));
  });

  it('accepts visible hostile grenade throw with subjectUnitId', () => {
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([
        {
          seq: 1,
          type: 'grenade_throw_observed',
          turn: 2,
          perceptionChannel: 'seen_and_heard',
          confidence: 'source_visible',
          positionKnown: true,
          position: [18, 20, 0],
          subjectUnitId: 1_000_001,
          observerUnitId: 1,
          compassDirection: 'east',
        },
      ]),
    });
    const tactical = parseAndValidate(raw);
    assert.equal(tactical.perceptionLog.events[0].type, 'grenade_throw_observed');
    assert.equal(tactical.perceptionLog.events[0].subjectUnitId, 1_000_001);
  });

  it('accepts visible unclassified throw at origin tile without grenade typing', () => {
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([
        {
          seq: 1,
          type: 'throw_observed',
          turn: 2,
          perceptionChannel: 'seen',
          confidence: 'source_visible',
          positionKnown: true,
          position: [18, 20, 0],
        },
      ]),
    });
    assert.doesNotThrow(() => parseAndValidate(raw));
  });

  it('accepts hidden throw as audio-only generic throw_observed', () => {
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([
        {
          seq: 1,
          type: 'throw_observed',
          turn: 2,
          perceptionChannel: 'heard',
          confidence: 'audio_only',
          positionKnown: false,
        },
      ]),
    });
    const tactical = parseAndValidate(raw);
    assert.equal(tactical.perceptionLog.events[0].position, undefined);
  });

  it('rejects hidden throw that leaks grenade class or coordinates', () => {
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([
        {
          seq: 1,
          type: 'grenade_throw_observed',
          turn: 2,
          perceptionChannel: 'heard',
          confidence: 'audio_only',
          positionKnown: false,
        },
      ]),
    });
    assert.throws(() => parseAndValidate(raw), /classified throw\/launch requires source_visible/);
  });

  it('accepts explosion-only alongside throw without linking fields', () => {
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([
        {
          seq: 1,
          type: 'throw_observed',
          turn: 2,
          perceptionChannel: 'heard',
          confidence: 'audio_only',
          positionKnown: false,
        },
        {
          seq: 2,
          type: 'explosion_observed_or_heard',
          turn: 2,
          perceptionChannel: 'seen',
          confidence: 'blast_visible',
          positionKnown: true,
          position: [22, 21, 0],
        },
      ]),
    });
    const tactical = parseAndValidate(raw);
    assert.equal(tactical.perceptionLog.events.length, 2);
    assert.notEqual(tactical.perceptionLog.events[0].type, tactical.perceptionLog.events[1].type);
  });

  it('accepts visible explosive launch and non-grenade object throw', () => {
    for (const [type, pos] of [
      ['explosive_launch_observed', [10, 11, 0]],
      ['object_throw_observed', [11, 12, 0]],
    ]) {
      const raw = v4Root({
        perceptionLog: emptyPerceptionMeta([
          {
            seq: 1,
            type,
            turn: 3,
            perceptionChannel: 'seen',
            confidence: 'source_visible',
            positionKnown: true,
            position: pos,
          },
        ]),
      });
      assert.doesNotThrow(() => parseAndValidate(raw));
    }
  });

  it('rejects throw events that identify a roster soldier as thrower', () => {
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([
        {
          seq: 1,
          type: 'grenade_throw_observed',
          turn: 2,
          perceptionChannel: 'seen',
          confidence: 'source_visible',
          positionKnown: true,
          position: [5, 5, 0],
          subjectUnitId: 2,
        },
      ]),
    });
    assert.throws(() => parseAndValidate(raw), /subjectUnitId must be a hostile battle unit/);
  });

  it('rejects throw_observed with subjectUnitId', () => {
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([
        {
          seq: 1,
          type: 'throw_observed',
          turn: 2,
          perceptionChannel: 'heard',
          confidence: 'audio_only',
          positionKnown: false,
          subjectUnitId: 1_000_001,
        },
      ]),
    });
    assert.throws(() => parseAndValidate(raw), /throw_observed must not identify thrower/);
  });
});
