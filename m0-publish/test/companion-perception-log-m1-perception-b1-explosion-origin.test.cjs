'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { parseAndValidate } = require('../lib/tactical-publish.cjs');

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
    rosterCasualtySummary: { schemaVersion: 1, entries: [] },
  };
}

function explosionEvent(overrides = {}) {
  return {
    seq: 1,
    type: 'explosion_observed_or_heard',
    turn: 2,
    perceptionChannel: 'seen',
    confidence: 'blast_visible',
    positionKnown: true,
    position: [8, 9, 0],
    ...overrides,
  };
}

describe('M1 PERCEPTION-B1 explosion origin class', () => {
  it('accepts visible death-triggered explosion with unit_death_detonation', () => {
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([
        explosionEvent({
          explosionOriginClass: 'unit_death_detonation',
          explosionOriginClassSource: 'engine_state',
        }),
      ]),
    });
    const tactical = parseAndValidate(raw);
    const ev = tactical.perceptionLog.events[0];
    assert.equal(ev.explosionOriginClass, 'unit_death_detonation');
    assert.equal(ev.explosionOriginClassSource, 'engine_state');
  });

  it('accepts generic grenade-style explosion without origin fields', () => {
    const raw = v4Root({ perceptionLog: emptyPerceptionMeta([explosionEvent()]) });
    const tactical = parseAndValidate(raw);
    assert.equal(tactical.perceptionLog.events[0].explosionOriginClass, undefined);
  });

  it('accepts terrain-style generic explosion (blast_visible, no class)', () => {
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([
        explosionEvent({ position: [3, 4, 1], perceptionChannel: 'seen_and_heard' }),
      ]),
    });
    assert.doesNotThrow(() => parseAndValidate(raw));
  });

  it('rejects hidden-source classification on audio_only explosion', () => {
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([
        {
          seq: 1,
          type: 'explosion_observed_or_heard',
          turn: 2,
          perceptionChannel: 'heard',
          confidence: 'audio_only',
          positionKnown: false,
          explosionOriginClass: 'unit_death_detonation',
          explosionOriginClassSource: 'engine_state',
        },
      ]),
    });
    assert.throws(() => parseAndValidate(raw), /audio_only explosion must not include explosionOriginClass/);
  });

  it('rejects origin class without blast_visible confidence', () => {
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([
        {
          seq: 1,
          type: 'explosion_observed_or_heard',
          turn: 2,
          perceptionChannel: 'heard',
          confidence: 'audio_only',
          positionKnown: false,
        },
      ]),
    });
    const withClass = v4Root({
      perceptionLog: emptyPerceptionMeta([
        {
          seq: 1,
          type: 'explosion_observed_or_heard',
          turn: 2,
          perceptionChannel: 'heard',
          confidence: 'audio_only',
          positionKnown: false,
          explosionOriginClass: 'unit_death_detonation',
          explosionOriginClassSource: 'engine_state',
        },
      ]),
    });
    parseAndValidate(raw);
    assert.throws(() => parseAndValidate(withClass), /audio_only explosion must not include explosionOriginClass/);
  });

  it('rejects explosion subjectUnitId identity leak', () => {
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([
        explosionEvent({ subjectUnitId: 1_000_003 }),
      ]),
    });
    assert.throws(() => parseAndValidate(raw), /explosion must not identify source unit/);
  });

  it('rejects unsupported explosionOriginClass values', () => {
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([
        explosionEvent({
          explosionOriginClass: 'grenade_detonation',
          explosionOriginClassSource: 'engine_state',
        }),
      ]),
    });
    assert.throws(() => parseAndValidate(raw), /explosionOriginClass invalid/);
  });

  it('rejects origin class without paired source field', () => {
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([
        explosionEvent({ explosionOriginClass: 'unit_death_detonation' }),
      ]),
    });
    assert.throws(() => parseAndValidate(raw), /origin class and source must appear together/);
  });
});
