'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const {
  ValidationError,
  parseAndValidate,
  buildRelayPayload,
  loadAndValidateSnapshotFromText,
  PSYCHOLOGICAL_PERCEPTION_EVENT_TYPES,
} = require('../lib/tactical-publish.cjs');
const { buildUnitStateBrief } = require('../lib/unit-state-brief.cjs');
const {
  buildPsychologicalHistoricalLines,
  describePsychEventHistoricalLine,
} = require('../lib/psychological-perception-consumer.cjs');
const {
  runMandatoryBattlefieldStatusReview,
} = require('../lib/tactical-briefing-ai-workflow.cjs');

const FIXTURE_V4 = path.join(__dirname, 'fixtures', 'valid-v4.yaml');
const WP6_ALIEN_BASE_TURN2_FIXTURE = path.join(
  __dirname,
  'fixtures',
  'wp6-alien-base-turn2-mind-control-synthetic-v5.yaml',
);

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

function minimalFriendlyUnit(overrides = {}) {
  return {
    id: 1,
    faction: 0,
    originalFaction: 0,
    position: [1, 1, 0],
    name: 'Alpha',
    health: 50,
    timeUnits: 40,
    kneeled: false,
    activeHand: 'STR_RIGHT_HAND',
    hands: { right: { itemType: 'STR_LASER_RIFLE', battleType: 1 }, left: null },
    inventory: [],
    condition: {
      energy: 50,
      maxEnergy: 50,
      morale: 80,
      stunLevel: 0,
      alive: true,
      conscious: true,
      engineStatus: 'standing',
      engineStatusId: 0,
      floating: false,
      movementTypeId: 0,
      movementType: 'walk',
    },
    readiness: {
      summary: 'ready_to_act',
      engineStatus: 'standing',
      liveRosterSoldier: true,
      engineActingUnitAvailable: true,
      observationNote: 'x',
    },
    ...overrides,
  };
}

describe('M1-WP6-PSY-1 psychological perceptionLog', () => {
  it('accepts soldier panicked observed without coordinates', () => {
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([
        {
          seq: 1,
          type: 'soldier_panicked_observed',
          turn: 2,
          perceptionChannel: 'notification',
          confidence: 'unit_visible',
          positionKnown: false,
          subjectUnitId: 1,
          subjectName: 'Alpha',
        },
      ]),
    });
    const tactical = parseAndValidate(raw);
    assert.equal(tactical.perceptionLog.events[0].type, 'soldier_panicked_observed');
    assert.equal(tactical.perceptionLog.events[0].position, undefined);
  });

  it('rejects psychological event with position leak', () => {
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([
        {
          seq: 1,
          type: 'psi_morale_attack_observed',
          turn: 2,
          perceptionChannel: 'notification',
          confidence: 'unit_visible',
          positionKnown: true,
          position: [1, 1, 0],
          subjectUnitId: 1,
        },
      ]),
    });
    assert.throws(() => parseAndValidate(raw), /psychological events must not expose positionKnown/);
  });

  it('requires subjectUnitId on psychological events', () => {
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([
        {
          seq: 1,
          type: 'alien_mind_controlled_observed',
          turn: 1,
          perceptionChannel: 'notification',
          confidence: 'message_notification',
          positionKnown: false,
        },
      ]),
    });
    assert.throws(() => parseAndValidate(raw), /subjectUnitId required/);
  });

  it('allows multiple psych events same turn and type with different seq', () => {
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([
        {
          seq: 1,
          type: 'psi_morale_attack_observed',
          turn: 3,
          perceptionChannel: 'notification',
          confidence: 'unit_visible',
          positionKnown: false,
          subjectUnitId: 1,
        },
        {
          seq: 2,
          type: 'psi_morale_attack_observed',
          turn: 3,
          perceptionChannel: 'notification',
          confidence: 'unit_visible',
          positionKnown: false,
          subjectUnitId: 2,
        },
      ]),
    });
    const tactical = parseAndValidate(raw);
    assert.equal(tactical.perceptionLog.events.length, 2);
  });

  it('historical panic line distinguishes standing current status', () => {
    const tactical = {
      units: [minimalFriendlyUnit({ id: 1, readiness: { summary: 'ready_to_act', engineStatus: 'standing', liveRosterSoldier: true, engineActingUnitAvailable: true, observationNote: 'x' } })],
    };
    const line = describePsychEventHistoricalLine(
      {
        type: 'soldier_panicked_observed',
        turn: 2,
        subjectUnitId: 1,
        subjectName: 'Alpha',
      },
      tactical,
    );
    assert.match(line, /panicked during turn 2/i);
    assert.match(line, /historical panic event/i);
    assert.match(line, /ready_to_act|standing/i);
  });

  it('psi morale line does not confirm panic', () => {
    const line = describePsychEventHistoricalLine(
      {
        type: 'psi_morale_attack_observed',
        turn: 2,
        subjectUnitId: 1,
        subjectName: 'Alpha',
      },
      { units: [minimalFriendlyUnit()] },
    );
    assert.match(line, /not confirmed/i);
  });

  it('unitStateBrief marks xcom controlled hostile and omits from hostile observations', () => {
    const tactical = {
      schemaVersion: 5,
      units: [
        minimalFriendlyUnit({ id: 1 }),
        {
          id: 1_000_001,
          faction: 0,
          originalFaction: 1,
          position: [5, 5, 0],
          facing: { direction: 2, label: 'east', vector: { dx: 1, dy: 0 } },
        },
        {
          id: 1_000_002,
          faction: 1,
          originalFaction: 1,
          position: [6, 6, 0],
          facing: { direction: 4, label: 'south', vector: { dx: 0, dy: 1 } },
        },
      ],
    };
    const brief = buildUnitStateBrief(tactical);
    assert.ok(brief.exceptions.some((e) => e.kind === 'xcom_controlled_hostile_unit' && e.id === 1_000_001));
    assert.ok(brief.visibleHostileObservations.some((o) => o.id === 1_000_002));
    assert.ok(!brief.visibleHostileObservations.some((o) => o.id === 1_000_001));
  });

  it('relay review merges psych history without replacing unknown panic note when empty', () => {
    const tactical = v4Root({
      perceptionLog: emptyPerceptionMeta([
        {
          seq: 1,
          type: 'soldier_berserk_observed',
          turn: 2,
          perceptionChannel: 'notification',
          confidence: 'unit_visible',
          positionKnown: false,
          subjectUnitId: 1,
          subjectName: 'Test Soldier',
        },
      ]),
    });
    const parsed = parseAndValidate(tactical);
    const relay = buildRelayPayload(parsed, new Date().toISOString());
    const review = runMandatoryBattlefieldStatusReview(relay);
    assert.equal(review.psychEventCount, 1);
    assert.match(review.psychHistoricalLines[0], /berserk during turn 2/i);
    assert.ok(!review.tacticalStatusLines.some((l) => l.startsWith('Historical panic: Unknown')));
  });

  it('exports all psychological event type constants', () => {
    assert.ok(PSYCHOLOGICAL_PERCEPTION_EVENT_TYPES.has('soldier_mind_controlled_observed'));
    assert.ok(PSYCHOLOGICAL_PERCEPTION_EVENT_TYPES.has('alien_panicked_observed'));
  });

  it('accepts hidden alien panic notification without subjectUnitId', () => {
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([
        {
          seq: 1,
          type: 'alien_panicked_observed',
          turn: 2,
          perceptionChannel: 'notification',
          confidence: 'message_notification',
          positionKnown: false,
        },
      ]),
    });
    const tactical = parseAndValidate(raw);
    assert.equal(tactical.perceptionLog.events[0].subjectUnitId, undefined);
  });

  it('requires subjectUnitId for visible alien panic', () => {
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([
        {
          seq: 1,
          type: 'alien_berserk_observed',
          turn: 2,
          perceptionChannel: 'notification',
          confidence: 'unit_visible',
          positionKnown: false,
          subjectUnitId: 1_000_000,
        },
      ]),
    });
    const tactical = parseAndValidate(raw);
    assert.equal(tactical.perceptionLog.events[0].subjectUnitId, 1_000_000);
  });

  it('rejects hidden alien panic that leaks subjectUnitId', () => {
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([
        {
          seq: 1,
          type: 'alien_panicked_observed',
          turn: 2,
          perceptionChannel: 'notification',
          confidence: 'message_notification',
          positionKnown: false,
          subjectUnitId: 1_000_000,
        },
      ]),
    });
    assert.throws(() => parseAndValidate(raw), /must not expose subjectUnitId/);
  });

  it('allows two psi morale events same turn via distinct seq', () => {
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([
        {
          seq: 1,
          type: 'psi_morale_attack_observed',
          turn: 4,
          perceptionChannel: 'notification',
          confidence: 'unit_visible',
          positionKnown: false,
          subjectUnitId: 1,
          subjectName: 'Test Soldier',
        },
        {
          seq: 2,
          type: 'psi_morale_attack_observed',
          turn: 4,
          perceptionChannel: 'notification',
          confidence: 'unit_visible',
          positionKnown: false,
          subjectUnitId: 1,
          subjectName: 'Test Soldier',
        },
      ]),
    });
    assert.equal(parseAndValidate(raw).perceptionLog.events.length, 2);
  });

  it('formats hidden alien psych history without unit id', () => {
    const line = describePsychEventHistoricalLine(
      {
        type: 'alien_panicked_observed',
        turn: 2,
        confidence: 'message_notification',
      },
      { units: [] },
    );
    assert.match(line, /hostile unit/i);
    assert.match(line, /identity not in export/i);
  });

  it('accepts roster subjectName on mind-control psych when soldier absent from units[]', () => {
    const raw = v4Root({
      units: [minimalFriendlyUnit({ id: 3 })],
      perceptionLog: emptyPerceptionMeta([
        {
          seq: 1,
          type: 'soldier_mind_controlled_observed',
          turn: 1,
          perceptionChannel: 'notification',
          confidence: 'unit_visible',
          positionKnown: false,
          subjectUnitId: 2,
          subjectName: 'Jolienne Tshiamanina',
        },
      ]),
    });
    const tactical = parseAndValidate(raw);
    assert.equal(tactical.perceptionLog.events[0].subjectName, 'Jolienne Tshiamanina');
  });

  it('accepts roster subjectName on mind-control psych for MC roster row in units[]', () => {
    const raw = v4Root({
      units: [
        minimalFriendlyUnit({ id: 1 }),
        {
          id: 2,
          faction: 1,
          originalFaction: 0,
          position: [5, 5, 0],
          facing: { direction: 0, label: 'north', vector: { dx: 0, dy: -1 } },
        },
      ],
      perceptionLog: emptyPerceptionMeta([
        {
          seq: 1,
          type: 'soldier_mind_controlled_observed',
          turn: 1,
          perceptionChannel: 'notification',
          confidence: 'unit_visible',
          positionKnown: false,
          subjectUnitId: 2,
          subjectName: 'Jolienne Tshiamanina',
        },
      ]),
    });
    const tactical = parseAndValidate(raw);
    assert.equal(tactical.perceptionLog.events[0].subjectName, 'Jolienne Tshiamanina');
  });

  it('rejects subjectName on psych event for non-roster subject unit id', () => {
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([
        {
          seq: 1,
          type: 'alien_panicked_observed',
          turn: 2,
          perceptionChannel: 'notification',
          confidence: 'unit_visible',
          positionKnown: false,
          subjectUnitId: 1_000_002,
          subjectName: 'Sectoid',
        },
      ]),
    });
    assert.throws(() => parseAndValidate(raw), /subjectName only allowed for roster soldiers/);
  });

  it('alien base turn-2 synthetic fixture passes perceptionLog subjectName validation', () => {
    const text = fs.readFileSync(WP6_ALIEN_BASE_TURN2_FIXTURE, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(text, YAML);
    const mc = tactical.perceptionLog.events.find(
      (ev) => ev.type === 'soldier_mind_controlled_observed' && ev.subjectName === 'Jolienne Tshiamanina',
    );
    assert.ok(mc);
    assert.equal(mc.subjectUnitId, 2);
    assert.equal(mc.turn, 2);
    assert.equal(tactical.missionContext.missionClass, 'alien_base');
  });
});
