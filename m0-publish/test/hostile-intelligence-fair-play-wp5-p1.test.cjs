'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const {
  loadAndValidateSnapshotFromText,
  buildRelayPayload,
} = require('../lib/tactical-publish.cjs');
const { buildUnitStateBrief } = require('../lib/unit-state-brief.cjs');
const {
  assertSamePerceptionSession,
  mergePerceptionEventsSameSessionOnly,
  classifyCurrentHostileObservation,
  resolveHostileIntel,
  PerceptionSessionMismatchError,
  getHostileIntelligenceContractMarkdown,
} = require('../lib/hostile-intelligence-consumer.cjs');
const {
  getAiBriefingInstructionsMarkdown,
} = require('../lib/tactical-briefing-ai-workflow.cjs');

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const STAGE_D_FULL = path.join(
  REPO_ROOT,
  'local',
  'm0',
  'test-battle-harness',
  'captures',
  'D-interior-explored',
  '2026-11-05T16-28-56-377Z',
  'tactical.yaml',
);
const STAGE_D_SLIM = path.join(
  REPO_ROOT,
  'local',
  'm0',
  'test-battle-harness',
  'captures',
  'D-interior-explored',
  '2026-11-05T16-57-04-742Z',
  'tactical.yaml',
);

function minimalEventLog() {
  return {
    sessionId: 'a1b2c3d4e5f6789012345678abcdef01',
    oldestSeq: 0,
    latestSeq: 0,
    droppedCount: 0,
    events: [],
  };
}

function minimalTactical(overrides = {}) {
  return {
    schemaVersion: 5,
    turn: 1,
    side: 0,
    selectedUnitId: 1,
    map: { width: 4, height: 4, depth: 1 },
    units: [],
    eventLog: minimalEventLog(),
    ...overrides,
  };
}

function visibleHostile(id, position, facingDirection = 2) {
  return {
    id,
    faction: 1,
    originalFaction: 1,
    position,
    kneeled: false,
    facing: {
      direction: facingDirection,
      label: 'east',
      vector: { dx: 1, dy: 0 },
    },
  };
}

describe('M1-WP5-P1 hostile intelligence fair-play', () => {
  it('embeds consumer contract in canonical AI briefing markdown', () => {
    const md = getAiBriefingInstructionsMarkdown();
    assert.match(md, /Hostile intelligence fair-play/);
    assert.match(md, /sessionId/);
    assert.match(md, /does not mean a unit is hidden/);
    const standalone = getHostileIntelligenceContractMarkdown();
    assert.match(standalone, /visibleHostileObservations/);
  });

  it('classifies visible hostile with facing as confirmed current LOS without perceptionLog', () => {
    const tactical = minimalTactical({
      units: [
        {
          id: 1,
          faction: 0,
          originalFaction: 0,
          position: [0, 0, 0],
          name: 'Alpha',
          health: 50,
          timeUnits: 10,
          kneeled: false,
          activeHand: 'STR_RIGHT_HAND',
          hands: { right: null, left: null },
          inventory: [],
        },
        visibleHostile(1_000_007, [18, 15, 0]),
      ],
    });
    const intel = resolveHostileIntel(tactical, 1_000_007);
    assert.equal(intel.current.availability, 'confirmed_current_los');
    assert.deepEqual(intel.confirmedCurrentPosition, [18, 15, 0]);
    assert.equal(intel.memoryOnlyPosition, null);
    assert.equal(tactical.perceptionLog, undefined);
  });

  it('does not promote historical last_seen to confirmed current when unit is absent', () => {
    const tactical = minimalTactical({
      perceptionLog: {
        sessionId: 'a1b2c3d4e5f6789012345678abcdef01',
        oldestSeq: 1,
        latestSeq: 1,
        droppedCount: 0,
        events: [
          {
            seq: 1,
            type: 'unit_last_seen',
            turn: 2,
            perceptionChannel: 'seen',
            confidence: 'last_seen',
            positionKnown: true,
            position: [23, 10, 0],
            subjectUnitId: 1_000_007,
          },
        ],
      },
    });
    const intel = resolveHostileIntel(tactical, 1_000_007);
    assert.equal(intel.current.availability, 'no_current_position');
    assert.equal(intel.confirmedCurrentPosition, null);
    assert.deepEqual(intel.memoryOnlyPosition, [23, 10, 0]);
    assert.equal(intel.historicalLastSeen.confidence, 'last_seen');
  });

  it('rejects merging perception histories across different sessionId values', () => {
    assert.throws(
      () => assertSamePerceptionSession('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
      PerceptionSessionMismatchError,
    );
    assert.throws(
      () =>
        mergePerceptionEventsSameSessionOnly(
          [{ seq: 1 }],
          [{ seq: 2 }],
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        ),
      /sessionId/,
    );
  });

  it('Stage D slim vs full captures use different perception sessionIds', () => {
    assert.ok(fs.existsSync(STAGE_D_FULL));
    assert.ok(fs.existsSync(STAGE_D_SLIM));
    const full = loadAndValidateSnapshotFromText(fs.readFileSync(STAGE_D_FULL, 'utf8'), YAML);
    const slim = loadAndValidateSnapshotFromText(fs.readFileSync(STAGE_D_SLIM, 'utf8'), YAML);
    assert.notEqual(full.perceptionLog.sessionId, slim.perceptionLog.sessionId);
    assert.throws(
      () => mergePerceptionEventsSameSessionOnly(
        full.perceptionLog.events,
        slim.perceptionLog.events,
        full.perceptionLog.sessionId,
        slim.perceptionLog.sessionId,
      ),
      PerceptionSessionMismatchError,
    );
    assert.equal(slim.perceptionLog.droppedCount, 0);
  });

  it('Stage D slim: visible hostile without matching perception event stays confirmed current', () => {
    const slim = loadAndValidateSnapshotFromText(fs.readFileSync(STAGE_D_SLIM, 'utf8'), YAML);
    const intel7 = resolveHostileIntel(slim, 1_000_007);
    assert.equal(intel7.current.availability, 'confirmed_current_los');
    assert.deepEqual(intel7.confirmedCurrentPosition, [18, 15, 0]);
    const perceptionSubjects = new Set((slim.perceptionLog?.events ?? []).map((e) => e.subjectUnitId));
    assert.ok(!perceptionSubjects.has(1_000_007));
  });

  it('mind-controlled roster soldier in exceptions but omitted from visibleHostileObservations when visible', () => {
    const tactical = minimalTactical({
      units: [
        {
          id: 2,
          faction: 0,
          originalFaction: 0,
          position: [1, 0, 0],
          name: 'Bravo',
          health: 40,
          timeUnits: 20,
          kneeled: false,
          activeHand: 'STR_RIGHT_HAND',
          hands: { right: null, left: null },
          inventory: [],
        },
        {
          id: 3,
          faction: 1,
          originalFaction: 0,
          position: [24, 5, 0],
          kneeled: false,
          facing: { direction: 0, label: 'north', vector: { dx: 0, dy: -1 } },
        },
      ],
    });
    const brief = buildUnitStateBrief(tactical);
    assert.ok(brief.exceptions.some((e) => e.kind === 'mind_controlled_roster_soldier' && e.id === 3));
    assert.ok(!brief.visibleHostileObservations.some((o) => o.id === 3));
    assert.match(brief.notes.join(' '), /genuine hostiles/i);
    const intel = classifyCurrentHostileObservation(tactical, 3);
    assert.equal(intel.mindControlledRoster, true);
    assert.equal(intel.availability, 'confirmed_current_los_mind_controlled_roster');
    assert.deepEqual(intel.position, [24, 5, 0]);
  });

  it('excludes mind-controlled roster soldier from commandBinding', () => {
    const tactical = minimalTactical({
      units: [
        {
          id: 2,
          faction: 0,
          originalFaction: 0,
          position: [1, 0, 0],
          name: 'Bravo',
          health: 40,
          timeUnits: 20,
          kneeled: false,
          activeHand: 'STR_RIGHT_HAND',
          hands: { right: null, left: null },
          inventory: [],
        },
        {
          id: 3,
          faction: 1,
          originalFaction: 0,
          position: [24, 5, 0],
          kneeled: false,
          facing: { direction: 0, label: 'north', vector: { dx: 0, dy: -1 } },
        },
      ],
    });
    const relay = buildRelayPayload(tactical, new Date(0).toISOString(), null, {
      snapshotSha256: 'b'.repeat(64),
    });
    assert.ok(relay.commandBinding);
    assert.ok(relay.commandBinding.player_soldiers.every((s) => s.id !== 3));
  });

  it('hidden hostile fixture shape: no unit row means no current position', () => {
    const tactical = minimalTactical({ units: [] });
    const intel = resolveHostileIntel(tactical, 1_000_001);
    assert.equal(intel.current.availability, 'no_current_position');
  });
});
