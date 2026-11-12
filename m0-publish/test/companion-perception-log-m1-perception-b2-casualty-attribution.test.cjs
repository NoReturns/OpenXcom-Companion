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

function attributionEvent(overrides = {}) {
  return {
    seq: 1,
    type: 'combat_casualty_attributed',
    turn: 3,
    perceptionChannel: 'seen',
    confidence: 'fatal',
    positionKnown: true,
    position: [10, 12, 0],
    subjectUnitId: 1_000_000,
    attributedActorUnitId: 2,
    attributionScope: 'fatal',
    ...overrides,
  };
}

describe('M1 PERCEPTION-B2 combat casualty attribution', () => {
  it('accepts visible actor kills visible hostile', () => {
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([attributionEvent()]),
    });
    const tactical = parseAndValidate(raw);
    const ev = tactical.perceptionLog.events[0];
    assert.equal(ev.type, 'combat_casualty_attributed');
    assert.equal(ev.attributedActorUnitId, 2);
    assert.equal(ev.attributionScope, 'fatal');
  });

  it('accepts visible hostile kills roster soldier', () => {
    const ev = attributionEvent({
      subjectUnitId: 3,
      attributedActorUnitId: 1_000_000,
      perceptionChannel: 'notification',
      positionKnown: false,
    });
    delete ev.position;
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([ev]),
    });
    const tactical = parseAndValidate(raw);
    assert.equal(tactical.perceptionLog.events[0].subjectUnitId, 3);
    assert.equal(tactical.perceptionLog.events[0].attributedActorUnitId, 1_000_000);
  });

  it('requires attributedActorUnitId and attributionScope', () => {
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([attributionEvent({ attributedActorUnitId: undefined, attributionScope: undefined })]),
    });
    delete raw.perceptionLog.events[0].attributedActorUnitId;
    delete raw.perceptionLog.events[0].attributionScope;
    assert.throws(() => parseAndValidate(raw), /attributedActorUnitId required/);
  });

  it('rejects missing subjectUnitId', () => {
    const base = attributionEvent();
    delete base.subjectUnitId;
    const raw = v4Root({ perceptionLog: emptyPerceptionMeta([base]) });
    assert.throws(() => parseAndValidate(raw), /subjectUnitId required/);
  });

  it('rejects invalid attributionScope', () => {
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([attributionEvent({ attributionScope: 'statistical' })]),
    });
    assert.throws(() => parseAndValidate(raw), /attributionScope invalid/);
  });

  it('rejects explosion origin fields on attribution events', () => {
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([
        attributionEvent({
          explosionOriginClass: 'unit_death_detonation',
          explosionOriginClassSource: 'engine_state',
        }),
      ]),
    });
    assert.throws(() => parseAndValidate(raw), /must not include explosionOriginClass/);
  });

  it('requires hostile victim present in units[]', () => {
    const raw = v4Root({
      units: v4Root().units.filter((u) => u.id !== 1_000_000),
      perceptionLog: emptyPerceptionMeta([attributionEvent()]),
    });
    assert.throws(() => parseAndValidate(raw), /hostile victim must be present/);
  });

  it('requires attributed actor present in units[]', () => {
    const raw = v4Root({
      units: v4Root().units.filter((u) => u.id !== 2),
      perceptionLog: emptyPerceptionMeta([attributionEvent()]),
    });
    assert.throws(() => parseAndValidate(raw), /attributed actor must be present/);
  });

  it('preserves B1 explosion without attribution fields', () => {
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([
        {
          seq: 1,
          type: 'explosion_observed_or_heard',
          turn: 2,
          perceptionChannel: 'seen',
          confidence: 'blast_visible',
          positionKnown: true,
          position: [8, 9, 0],
          explosionOriginClass: 'unit_death_detonation',
          explosionOriginClassSource: 'engine_state',
        },
      ]),
    });
    assert.doesNotThrow(() => parseAndValidate(raw));
  });

  it('preserves soldier_down without attribution fields', () => {
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([
        {
          seq: 1,
          type: 'soldier_down',
          turn: 4,
          perceptionChannel: 'notification',
          confidence: 'dead',
          positionKnown: false,
          subjectUnitId: 3,
        },
      ]),
    });
    const tactical = parseAndValidate(raw);
    assert.equal(tactical.perceptionLog.events[0].type, 'soldier_down');
    assert.equal(tactical.perceptionLog.events[0].attributedActorUnitId, undefined);
  });
});
