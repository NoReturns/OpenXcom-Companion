'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const {
  loadAndValidateSnapshotFromText,
  validateFacing,
  validateCondition,
  validateReadiness,
  buildRelayPayload,
  computeSnapshotId,
} = require('../lib/tactical-publish.cjs');
const { buildUnitStateBrief } = require('../lib/unit-state-brief.cjs');

const FIXTURES = path.join(__dirname, 'fixtures');

function minimalFriendlyUnit(overrides = {}) {
  return {
    id: 1,
    faction: 0,
    originalFaction: 0,
    position: [0, 0, 0],
    name: 'Alpha',
    health: 50,
    timeUnits: 12,
    kneeled: false,
    activeHand: 'STR_RIGHT_HAND',
    hands: { right: null, left: null },
    inventory: [],
    ...overrides,
  };
}

describe('M1-WP2 tactical unit state', () => {
  it('validates all eight facing directions and map vectors', () => {
    const vectors = [
      { direction: 0, dx: 0, dy: -1, label: 'north' },
      { direction: 1, dx: 1, dy: -1, label: 'northeast' },
      { direction: 2, dx: 1, dy: 0, label: 'east' },
      { direction: 3, dx: 1, dy: 1, label: 'southeast' },
      { direction: 4, dx: 0, dy: 1, label: 'south' },
      { direction: 5, dx: -1, dy: 1, label: 'southwest' },
      { direction: 6, dx: -1, dy: 0, label: 'west' },
      { direction: 7, dx: -1, dy: -1, label: 'northwest' },
    ];
    for (const v of vectors) {
      const facing = validateFacing(
        { direction: v.direction, label: v.label, vector: { dx: v.dx, dy: v.dy } },
        'facing'
      );
      assert.equal(facing.direction, v.direction);
      assert.equal(facing.vector.dx, v.dx);
      assert.equal(facing.vector.dy, v.dy);
    }
    assert.throws(() => validateFacing({ direction: 9, vector: { dx: 0, dy: 0 } }, 'bad'), /direction/);
  });

  it('accepts legacy v4 fixture without wp2 fields', () => {
    const text = fs.readFileSync(path.join(FIXTURES, 'valid-v4.yaml'), 'utf8');
    const tactical = loadAndValidateSnapshotFromText(text, YAML);
    assert.equal(tactical.schemaVersion, 4);
    assert.equal(tactical.units[0].facing, undefined);
  });

  it('rejects hostile condition leak', () => {
    const raw = {
      schemaVersion: 4,
      turn: 1,
      side: 0,
      selectedUnitId: 1,
      map: { width: 2, height: 2, depth: 1 },
      units: [
        minimalFriendlyUnit(),
        {
          id: 100,
          faction: 1,
          originalFaction: 1,
          position: [1, 1, 0],
          condition: {
            energy: 1,
            morale: 1,
            stunLevel: 0,
            alive: true,
            conscious: true,
            engineStatus: 'standing',
            engineStatusId: 0,
            floating: false,
            movementTypeId: 0,
            movementType: 'walk',
          },
        },
      ],
      eventLog: {
        sessionId: 'a1b2c3d4e5f6789012345678abcdef01',
        oldestSeq: 0,
        latestSeq: 0,
        droppedCount: 0,
        events: [],
      },
    };
    assert.throws(() => loadAndValidateSnapshotFromText(YAML.stringify(raw), YAML), /must not include condition/);
  });

  it('allows visible hostile facing and kneeled observations only', () => {
    const raw = {
      schemaVersion: 4,
      turn: 1,
      side: 0,
      selectedUnitId: 1,
      map: { width: 2, height: 2, depth: 1 },
      units: [
        minimalFriendlyUnit({
          facing: { direction: 2, label: 'east', vector: { dx: 1, dy: 0 } },
          condition: {
            energy: 10,
            maxEnergy: 60,
            morale: 80,
            stunLevel: 0,
            alive: true,
            conscious: true,
            engineStatus: 'standing',
            engineStatusId: 0,
            floating: false,
            movementTypeId: 1,
            movementType: 'fly',
          },
          readiness: {
            summary: 'ready_to_act',
            engineStatus: 'standing',
            liveRosterSoldier: true,
            engineActingUnitAvailable: true,
            observationNote: 'Observational only: not Companion command authorization.',
          },
        }),
        {
          id: 100,
          faction: 1,
          originalFaction: 1,
          position: [1, 1, 0],
          kneeled: true,
          facing: { direction: 6, label: 'west', vector: { dx: -1, dy: 0 } },
        },
      ],
      eventLog: {
        sessionId: 'a1b2c3d4e5f6789012345678abcdef01',
        oldestSeq: 0,
        latestSeq: 0,
        droppedCount: 0,
        events: [],
      },
    };
    const tactical = loadAndValidateSnapshotFromText(YAML.stringify(raw), YAML);
    assert.equal(tactical.units[1].facing.direction, 6);
    assert.equal(tactical.units[1].kneeled, true);
    assert.equal(tactical.units[1].health, undefined);
  });

  it('validates unconscious readiness separately from low TU', () => {
    const condition = validateCondition(
      {
        energy: 0,
        maxEnergy: 50,
        morale: 40,
        stunLevel: 200,
        alive: true,
        conscious: false,
        engineStatus: 'unconscious',
        engineStatusId: 7,
        floating: false,
        movementTypeId: 0,
        movementType: 'walk',
      },
      'condition'
    );
    assert.equal(condition.conscious, false);
    const readiness = validateReadiness(
      {
        summary: 'unconscious',
        engineStatus: 'unconscious',
        liveRosterSoldier: true,
        engineActingUnitAvailable: false,
        observationNote: 'Observational only: not Companion command authorization.',
      },
      'readiness'
    );
    assert.equal(readiness.summary, 'unconscious');
    assert.equal(readiness.engineActingUnitAvailable, false);
  });

  it('relay includes unitStateBrief and preserves snapshot_id determinism', () => {
    const text = fs.readFileSync(path.join(FIXTURES, 'valid-v5.yaml'), 'utf8');
    const tactical = loadAndValidateSnapshotFromText(text, YAML);
    const id1 = computeSnapshotId(tactical);
    const relay = buildRelayPayload(tactical, new Date(0).toISOString(), null, {
      snapshotSha256: 'a'.repeat(64),
    });
    assert.ok(relay.unitStateBrief);
    assert.equal(relay.snapshot_id, id1);
    const relay2 = buildRelayPayload(tactical, new Date(0).toISOString(), null, {
      snapshotSha256: 'a'.repeat(64),
    });
    assert.equal(relay.snapshot_id, relay2.snapshot_id);
  });

  it('unitStateBrief highlights incapacitated and heuristic morale', () => {
    const tactical = {
      schemaVersion: 5,
      units: [
        minimalFriendlyUnit({
          condition: {
            energy: 50,
            maxEnergy: 50,
            morale: 30,
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
            companionCommandActorEligible: true,
            note: 'x',
          },
          facing: { direction: 0, label: 'north', vector: { dx: 0, dy: -1 } },
        }),
      ],
    };
    const brief = buildUnitStateBrief(tactical);
    assert.ok(brief.exceptions.some((e) => e.kind === 'low_morale_heuristic'));
    assert.equal(brief.facingBySoldier[0].label, 'north');
    assert.ok(!brief.exceptions.some((e) => e.kind === 'mind_controlled_roster_soldier'));
    assert.ok(!brief.exceptions.some((e) => e.kind === 'readiness' && e.summary === 'panicking'));
  });

  it('unitStateBrief reports mind-controlled roster soldiers outside friendly filter', () => {
    const tactical = {
      schemaVersion: 5,
      units: [
        minimalFriendlyUnit({ id: 2, name: 'Bravo' }),
        {
          id: 3,
          faction: 1,
          originalFaction: 0,
          position: [24, 5, 0],
          kneeled: false,
          facing: { direction: 0, label: 'north', vector: { dx: 0, dy: -1 } },
        },
        {
          id: 1_000_002,
          faction: 1,
          originalFaction: 1,
          position: [19, 33, 0],
          facing: { direction: 4, label: 'south', vector: { dx: 0, dy: 1 } },
        },
      ],
    };
    const brief = buildUnitStateBrief(tactical);
    const mc = brief.exceptions.filter((e) => e.kind === 'mind_controlled_roster_soldier');
    assert.equal(mc.length, 1);
    assert.equal(mc[0].id, 3);
    assert.deepEqual(mc[0].position, [24, 5, 0]);
    assert.equal(mc[0].currentFaction, 1);
    assert.match(mc[0].note, /not commandable/i);
    assert.ok(!brief.visibleHostileObservations.some((o) => o.id === 3));
    assert.ok(brief.visibleHostileObservations.some((o) => o.id === 1_000_002));
    assert.ok(!brief.exceptions.some((e) => e.id === 1_000_002 && e.kind === 'mind_controlled_roster_soldier'));
    assert.equal(brief.friendlyRosterCount, 1);
  });

  it('unitStateBrief keeps panic and berserk readiness exceptions on friendlies', () => {
    for (const [summary, engineStatus] of [['panicking', 'panicking'], ['berserk', 'berserk']]) {
      const tactical = {
        schemaVersion: 5,
        units: [
          minimalFriendlyUnit({
            condition: {
              energy: 50,
              maxEnergy: 50,
              morale: 100,
              stunLevel: 0,
              alive: true,
              conscious: true,
              engineStatus,
              engineStatusId: engineStatus === 'panicking' ? 8 : 9,
              floating: false,
              movementTypeId: 0,
              movementType: 'walk',
            },
            readiness: {
              summary,
              engineStatus,
              liveRosterSoldier: true,
              engineActingUnitAvailable: true,
              observationNote: 'x',
            },
          }),
        ],
      };
      const brief = buildUnitStateBrief(tactical);
      assert.ok(
        brief.exceptions.some((e) => e.kind === 'readiness' && e.summary === summary),
        `expected readiness ${summary}`,
      );
      assert.ok(!brief.exceptions.some((e) => e.kind === 'low_morale_heuristic'));
    }
  });
});
