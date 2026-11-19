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

  it('accepts hostile victim absent from export-time units[] when historically attributed', () => {
    const raw = v4Root({
      units: v4Root().units.filter((u) => u.id !== 1_000_000),
      perceptionLog: emptyPerceptionMeta([attributionEvent()]),
    });
    const tactical = parseAndValidate(raw);
    assert.equal(tactical.perceptionLog.events[0].subjectUnitId, 1_000_000);
  });

  it('accepts attributed roster actor absent from export-time units[] when historically attributed', () => {
    const raw = v4Root({
      units: v4Root().units.filter((u) => u.id !== 2),
      perceptionLog: emptyPerceptionMeta([attributionEvent()]),
    });
    const tactical = parseAndValidate(raw);
    assert.equal(tactical.perceptionLog.events[0].attributedActorUnitId, 2);
  });

  it('rejects live battle-unit victim row with player originalFaction', () => {
    const base = v4Root();
    const units = base.units.map((u) => (u.id === 1_000_000 ? { ...u, originalFaction: 0 } : u));
    const raw = v4Root({
      units,
      perceptionLog: emptyPerceptionMeta([attributionEvent()]),
    });
    assert.throws(() => parseAndValidate(raw), /battle-unit victim.*origin invalid/);
  });

  it('accepts friendly HWP attributed actor when victim absent from units[] (S5 live kill shape)', () => {
    const base = v4Root();
    const units = [
      ...base.units.filter((u) => u.id !== 1_000_000),
      {
        id: 1_000_000,
        faction: 0,
        originalFaction: 0,
        position: [25, 38, 0],
        friendlyHwpObservationV1: {
          schemaVersion: 1,
          unitId: 1_000_000,
          hwpUnitType: 'STR_TANK_CANNON',
          position: { x: 25, y: 38, z: 0 },
          timeUnits: 15,
          kneeled: false,
          fixedWeapons: [{ battleItemId: 0, itemType: 'STR_TANK_CANNON', battleType: 1 }],
        },
      },
    ];
    const raw = v4Root({
      units,
      perceptionLog: emptyPerceptionMeta([
        attributionEvent({
          seq: 1,
          turn: 3,
          subjectUnitId: 1_000_002,
          attributedActorUnitId: 1_000_000,
          position: [28, 37, 0],
        }),
      ]),
    });
    const tactical = parseAndValidate(raw);
    const ev = tactical.perceptionLog.events[0];
    assert.equal(ev.attributedActorUnitId, 1_000_000);
    assert.equal(ev.subjectUnitId, 1_000_002);
  });

  it('rejects high-id attributed actor when row is not friendly HWP control', () => {
    const raw = v4Root({
      units: [
        {
          id: 1_000_099,
          originalFaction: 0,
          faction: 1,
          position: [5, 5, 0],
        },
      ],
      perceptionLog: emptyPerceptionMeta([
        attributionEvent({
          subjectUnitId: 1_000_002,
          attributedActorUnitId: 1_000_099,
        }),
      ]),
    });
    assert.throws(() => parseAndValidate(raw), /attributed actor battle-unit origin invalid/);
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

  it('accepts roster victim name on combat attribution when soldier absent from units[]', () => {
    const raw = v4Root({
      units: v4Root().units.filter((u) => u.id !== 3),
      perceptionLog: emptyPerceptionMeta([
        attributionEvent({
          subjectUnitId: 3,
          attributedActorUnitId: 1_000_000,
          subjectName: 'Test Soldier',
        }),
      ]),
    });
    const tactical = parseAndValidate(raw);
    assert.equal(tactical.perceptionLog.events[0].subjectName, 'Test Soldier');
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
