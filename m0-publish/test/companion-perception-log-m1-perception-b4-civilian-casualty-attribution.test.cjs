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

function neutralCivilianUnit(id, overrides = {}) {
  return {
    id,
    faction: 2,
    originalFaction: 2,
    position: [6, 6, 0],
    ...overrides,
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
    position: [6, 6, 0],
    subjectUnitId: 1_000_001,
    attributedActorUnitId: 1,
    attributionScope: 'fatal',
    ...overrides,
  };
}

describe('M1 PERCEPTION-B4 civilian/neutral combat casualty attribution', () => {
  it('accepts visible roster berserk kills visible neutral civilian (Oso-shaped)', () => {
    const raw = v4Root({
      units: [...v4Root().units, neutralCivilianUnit(1_000_001)],
      perceptionLog: emptyPerceptionMeta([attributionEvent()]),
    });
    const tactical = parseAndValidate(raw);
    const ev = tactical.perceptionLog.events[0];
    assert.equal(ev.subjectUnitId, 1_000_001);
    assert.equal(ev.attributedActorUnitId, 1);
  });

  it('accepts neutral victim absent from export-time units[] when historically attributed', () => {
    const raw = v4Root({
      units: v4Root().units.filter((u) => u.id !== 1_000_001),
      perceptionLog: emptyPerceptionMeta([attributionEvent()]),
    });
    const tactical = parseAndValidate(raw);
    assert.equal(tactical.perceptionLog.events[0].subjectUnitId, 1_000_001);
  });

  it('accepts neutral victim row with neutral originalFaction when still exported', () => {
    const raw = v4Root({
      units: [...v4Root().units, neutralCivilianUnit(1_000_001)],
      perceptionLog: emptyPerceptionMeta([attributionEvent()]),
    });
    const tactical = parseAndValidate(raw);
    const row = tactical.units.find((u) => u.id === 1_000_001);
    assert.equal(row.originalFaction, 2);
    assert.equal(tactical.perceptionLog.events[0].subjectUnitId, 1_000_001);
  });

  it('preserves B2 hostile victim attribution unchanged', () => {
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([
        attributionEvent({
          subjectUnitId: 1_000_000,
          attributedActorUnitId: 2,
          position: [5, 5, 0],
        }),
      ]),
    });
    const tactical = parseAndValidate(raw);
    assert.equal(tactical.perceptionLog.events[0].subjectUnitId, 1_000_000);
  });
});