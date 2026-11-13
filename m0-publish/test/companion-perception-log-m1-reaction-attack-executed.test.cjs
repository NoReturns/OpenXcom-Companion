'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { ValidationError, parseAndValidate } = require('../lib/tactical-publish.cjs');

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

describe('reaction_attack_executed perception validation', () => {
  it('accepts visible hostile snap reaction with subjectUnitId', () => {
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([
        {
          seq: 1,
          type: 'reaction_attack_executed',
          turn: 1,
          perceptionChannel: 'seen_and_heard',
          confidence: 'source_visible',
          positionKnown: true,
          position: [5, 5, 0],
          actionType: 'snap',
          subjectUnitId: 1_000_000,
        },
      ]),
    });
    const tactical = parseAndValidate(raw);
    assert.equal(tactical.perceptionLog.events[0].actionType, 'snap');
    assert.equal(tactical.perceptionLog.events[0].subjectUnitId, 1_000_000);
  });

  it('accepts audio-only reaction without identity', () => {
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([
        {
          seq: 1,
          type: 'reaction_attack_executed',
          turn: 1,
          perceptionChannel: 'heard',
          confidence: 'audio_only',
          positionKnown: false,
          actionType: 'snap',
        },
      ]),
    });
    const tactical = parseAndValidate(raw);
    assert.equal(tactical.perceptionLog.events[0].subjectUnitId, undefined);
  });

  it('rejects audio_only reaction that leaks shooter identity', () => {
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([
        {
          seq: 1,
          type: 'reaction_attack_executed',
          turn: 1,
          perceptionChannel: 'heard',
          confidence: 'audio_only',
          positionKnown: false,
          actionType: 'melee',
          subjectUnitId: 1_000_001,
        },
      ]),
    });
    assert.throws(() => parseAndValidate(raw), ValidationError);
  });

  it('rejects missing actionType', () => {
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([
        {
          seq: 1,
          type: 'reaction_attack_executed',
          turn: 1,
          perceptionChannel: 'heard',
          confidence: 'audio_only',
          positionKnown: false,
        },
      ]),
    });
    assert.throws(() => parseAndValidate(raw), ValidationError);
  });

  it('accepts visible hostile reaction shooter still exported in units[]', () => {
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([
        {
          seq: 1,
          type: 'reaction_attack_executed',
          turn: 1,
          perceptionChannel: 'seen_and_heard',
          confidence: 'source_visible',
          positionKnown: true,
          position: [5, 5, 0],
          actionType: 'snap',
          subjectUnitId: 1_000_000,
        },
      ]),
    });
    assert.doesNotThrow(() => parseAndValidate(raw));
  });

  it('accepts identified hostile reaction shooter absent after death from units[]', () => {
    const raw = v4Root({
      units: v4Root().units.filter((u) => u.id !== 1_000_001),
      perceptionLog: emptyPerceptionMeta([
        {
          seq: 1,
          type: 'reaction_attack_executed',
          turn: 1,
          perceptionChannel: 'seen_and_heard',
          confidence: 'source_visible',
          positionKnown: true,
          position: [6, 6, 0],
          actionType: 'snap',
          subjectUnitId: 1_000_001,
        },
      ]),
    });
    const tactical = parseAndValidate(raw);
    assert.equal(tactical.perceptionLog.events[0].subjectUnitId, 1_000_001);
  });

  it('rejects source_visible hostile identity when exported row is not hostile origin', () => {
    const base = v4Root();
    const units = base.units.map((u) => (u.id === 1_000_000 ? { ...u, originalFaction: 2 } : u));
    const raw = v4Root({
      units,
      perceptionLog: emptyPerceptionMeta([
        {
          seq: 1,
          type: 'reaction_attack_executed',
          turn: 1,
          perceptionChannel: 'seen_and_heard',
          confidence: 'source_visible',
          positionKnown: true,
          position: [5, 5, 0],
          actionType: 'melee',
          subjectUnitId: 1_000_000,
        },
      ]),
    });
    assert.throws(() => parseAndValidate(raw), /reaction shooter hostile origin invalid/);
  });
});
