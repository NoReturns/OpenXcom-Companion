'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { parseAndValidate, loadAndValidateSnapshotFromText } = require('../lib/tactical-publish.cjs');

const FIXTURE_V4 = path.join(__dirname, 'fixtures', 'valid-v4.yaml');

function v4Root(overrides = {}) {
  const base = YAML.parse(fs.readFileSync(FIXTURE_V4, 'utf8'));
  return { ...base, ...overrides };
}

function emptyPerceptionMeta(events, rosterCasualtySummary) {
  return {
    sessionId: 'a1b2c3d4e5f6789012345678abcdef01',
    oldestSeq: events.length ? 1 : 0,
    latestSeq: events.length ? events.length : 0,
    droppedCount: 0,
    events,
    rosterCasualtySummary: rosterCasualtySummary ?? { schemaVersion: 1, entries: [] },
  };
}

describe('M1 combat feedback perception (impact classification + soldier casualty)', () => {
  it('accepts visible_unit_hit and generic impact_visible without subjectUnitId', () => {
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([
        {
          seq: 1,
          type: 'impact_observed',
          turn: 2,
          perceptionChannel: 'seen',
          confidence: 'visible_unit_hit',
          positionKnown: true,
          position: [10, 11, 0],
        },
        {
          seq: 2,
          type: 'impact_observed',
          turn: 2,
          perceptionChannel: 'seen_and_heard',
          confidence: 'impact_visible',
          positionKnown: true,
          position: [10, 12, 0],
        },
      ]),
    });
    const tactical = parseAndValidate(raw);
    assert.equal(tactical.perceptionLog.events[0].confidence, 'visible_unit_hit');
    assert.equal(tactical.perceptionLog.events[1].confidence, 'impact_visible');
  });

  it('fair-play: legacy visible_terrain_hit and visible_impact_unclassified still validate', () => {
    for (const confidence of ['visible_terrain_hit', 'visible_impact_unclassified']) {
      const raw = v4Root({
        perceptionLog: emptyPerceptionMeta([{
          seq: 1,
          type: 'impact_observed',
          turn: 2,
          perceptionChannel: 'seen',
          confidence,
          positionKnown: true,
          position: [12, 13, 0],
        }]),
      });
      assert.doesNotThrow(() => parseAndValidate(raw));
    }
  });

  it('rejects impact_observed victim subjectUnitId', () => {
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([{
        seq: 1,
        type: 'impact_observed',
        turn: 1,
        perceptionChannel: 'seen',
        confidence: 'visible_unit_hit',
        positionKnown: true,
        position: [1, 1, 0],
        subjectUnitId: 1_000_007,
      }]),
    });
    assert.throws(() => parseAndValidate(raw), /must not identify victim/);
  });

  it('rejects audio_only impact with coordinates', () => {
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([{
        seq: 1,
        type: 'impact_observed',
        turn: 1,
        perceptionChannel: 'heard',
        confidence: 'audio_only',
        positionKnown: true,
        position: [1, 1, 0],
      }]),
    });
    assert.throws(() => parseAndValidate(raw), /heard-only events must not expose coordinates/);
  });

  it('accepts compact soldier_down and soldier_recovered roster events', () => {
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([
        {
          seq: 1,
          type: 'soldier_down',
          turn: 3,
          perceptionChannel: 'notification',
          confidence: 'unconscious',
          positionKnown: true,
          position: [4, 5, 0],
          subjectUnitId: 2,
          subjectName: 'Bravo',
        },
        {
          seq: 2,
          type: 'soldier_recovered',
          turn: 4,
          perceptionChannel: 'seen',
          confidence: 'standing',
          positionKnown: true,
          position: [4, 5, 0],
          subjectUnitId: 2,
          subjectName: 'Bravo',
        },
      ]),
    });
    const tactical = parseAndValidate(raw);
    assert.equal(tactical.perceptionLog.events[0].type, 'soldier_down');
    assert.equal(tactical.perceptionLog.events[1].confidence, 'standing');
  });

  it('retains legacy impact_visible confidence', () => {
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([{
        seq: 1,
        type: 'impact_observed',
        turn: 1,
        perceptionChannel: 'seen',
        confidence: 'impact_visible',
        positionKnown: true,
        position: [2, 2, 0],
      }]),
    });
    assert.doesNotThrow(() => parseAndValidate(raw));
  });

  it('bounded perception log validation unchanged (256 cap)', () => {
    const events = Array.from({ length: 257 }, (_, i) => ({
      seq: i + 1,
      type: 'impact_observed',
      turn: 1,
      perceptionChannel: 'heard',
      confidence: 'audio_only',
      positionKnown: false,
    }));
    const raw = v4Root({ perceptionLog: emptyPerceptionMeta(events) });
    assert.throws(() => parseAndValidate(raw), /256 event limit/);
  });


  it('accepts rosterCasualtySummary ledger surviving event eviction', () => {
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([], {
        schemaVersion: 1,
        entries: [{
          subjectUnitId: 2,
          episodeSerial: 2,
          status: 'unconscious',
          turn: 5,
          positionKnown: true,
          position: [4, 5, 0],
          subjectName: 'Angelika',
        }],
      }),
    });
    const tactical = parseAndValidate(raw);
    assert.equal(tactical.perceptionLog.rosterCasualtySummary.entries.length, 1);
    assert.equal(tactical.perceptionLog.rosterCasualtySummary.entries[0].episodeSerial, 2);
  });

  it('rejects duplicate soldier_down dedupe episode confusion in ledger', () => {
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([
        {
          seq: 1,
          type: 'soldier_down',
          turn: 3,
          perceptionChannel: 'notification',
          confidence: 'unconscious',
          positionKnown: true,
          position: [1, 1, 0],
          subjectUnitId: 3,
        },
        {
          seq: 2,
          type: 'soldier_recovered',
          turn: 4,
          perceptionChannel: 'seen',
          confidence: 'standing',
          positionKnown: true,
          position: [1, 1, 0],
          subjectUnitId: 3,
        },
        {
          seq: 3,
          type: 'soldier_down',
          turn: 6,
          perceptionChannel: 'notification',
          confidence: 'unconscious',
          positionKnown: true,
          position: [2, 2, 0],
          subjectUnitId: 3,
        },
      ], {
        schemaVersion: 1,
        entries: [{
          subjectUnitId: 3,
          episodeSerial: 2,
          status: 'unconscious',
          turn: 6,
          positionKnown: true,
          position: [2, 2, 0],
        }],
      }),
    });
    const tactical = parseAndValidate(raw);
    assert.equal(tactical.perceptionLog.events.filter((e) => e.type === 'soldier_down').length, 2);
    assert.equal(tactical.perceptionLog.rosterCasualtySummary.entries[0].episodeSerial, 2);
  });

  it('accepts soldier_down subjectName when KIA soldier absent from units[]', () => {
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([{
        seq: 1,
        type: 'soldier_down',
        turn: 4,
        perceptionChannel: 'notification',
        confidence: 'dead',
        positionKnown: true,
        position: [5, 5, 0],
        subjectUnitId: 4,
        subjectName: 'Sarah Fitzgerald',
      }], {
        schemaVersion: 1,
        entries: [{
          subjectUnitId: 4,
          episodeSerial: 1,
          status: 'dead',
          turn: 4,
          positionKnown: true,
          position: [5, 5, 0],
          subjectName: 'Sarah Fitzgerald',
        }],
      }),
    });
    assert.doesNotThrow(() => parseAndValidate(raw));
  });

  it('relay shrink retains rosterCasualtySummary while trimming perception events', () => {
    const { trimLogEventsBeforeTurn } = require('../lib/relay-payload-adaptive-shrink.cjs');
    const perceptionLog = {
      sessionId: 'a1b2c3d4e5f6789012345678abcdef01',
      oldestSeq: 1,
      latestSeq: 4,
      droppedCount: 0,
      events: [
        { seq: 1, type: 'soldier_down', turn: 5, perceptionChannel: 'notification', confidence: 'dead', positionKnown: false, subjectUnitId: 4 },
        { seq: 2, type: 'impact_observed', turn: 6, perceptionChannel: 'seen', confidence: 'impact_visible', positionKnown: true, position: [1, 1, 0] },
        { seq: 3, type: 'impact_observed', turn: 7, perceptionChannel: 'seen', confidence: 'impact_visible', positionKnown: true, position: [2, 2, 0] },
        { seq: 4, type: 'impact_observed', turn: 7, perceptionChannel: 'seen', confidence: 'impact_visible', positionKnown: true, position: [3, 3, 0] },
      ],
      rosterCasualtySummary: {
        schemaVersion: 1,
        entries: [{
          subjectUnitId: 4,
          episodeSerial: 1,
          status: 'dead',
          turn: 5,
          positionKnown: false,
        }],
      },
    };
    const ledgerBefore = structuredClone(perceptionLog.rosterCasualtySummary);
    trimLogEventsBeforeTurn(perceptionLog, 7);
    assert.equal(perceptionLog.events.length, 2);
    assert.deepEqual(perceptionLog.rosterCasualtySummary, ledgerBefore);
  });

  it('repeated validation of casualty snapshot is idempotent', () => {
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([{
        seq: 1,
        type: 'soldier_down',
        turn: 2,
        perceptionChannel: 'notification',
        confidence: 'dead',
        positionKnown: false,
        subjectUnitId: 1,
      }]),
    });
    const text = YAML.stringify(raw);
    const first = loadAndValidateSnapshotFromText(text, YAML);
    const second = loadAndValidateSnapshotFromText(text, YAML);
    assert.deepEqual(first.perceptionLog, second.perceptionLog);
  });
});
