'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildCommandBinding,
  composeMoveCommand,
  isCommandApplicableForBinding,
} = require('../lib/command-binding.cjs');

const DIGEST = 'a'.repeat(64);
const SESSION = 'a1b2c3d4e5f6789012345678abcdef01';

function tacticalBase(units) {
  return {
    schemaVersion: 5,
    turn: 3,
    side: 0,
    selectedUnitId: 8,
    map: { width: 50, height: 50, depth: 4 },
    eventLog: { sessionId: SESSION, latestSeq: 42 },
    units,
  };
}

function rosterSoldier(overrides = {}) {
  return {
    id: 2,
    faction: 0,
    originalFaction: 0,
    position: [4, 4, 0],
    name: 'Downed Trooper',
    health: 30,
    timeUnits: 63,
    kneeled: false,
    condition: {
      alive: true,
      conscious: false,
      engineStatus: 'unconscious',
    },
    readiness: {
      summary: 'unconscious',
      engineStatus: 'unconscious',
      engineActingUnitAvailable: false,
    },
    ...overrides,
  };
}

describe('commandBinding incapacitated TU presentation (RELAY-D)', () => {
  it('unconscious soldier: binding row identifiable, TU not command-actionable', () => {
    const binding = buildCommandBinding(tacticalBase([rosterSoldier()]), DIGEST);
    assert.equal(binding.player_soldiers.length, 1);
    const row = binding.player_soldiers[0];
    assert.equal(row.id, 2);
    assert.equal(row.name, 'Downed Trooper');
    assert.deepEqual(row.position, [4, 4, 0]);
    assert.equal(row.timeUnits, null);
    assert.equal(row.timeUnitsApplicability, 'not_command_applicable');
    assert.equal(row.engineReportedTimeUnits, 63);
    assert.match(binding.player_soldiers_tu_note, /not_command_applicable/);
  });

  it('ready soldier: timeUnits unchanged for command planning', () => {
    const ready = rosterSoldier({
      id: 8,
      name: 'Active',
      timeUnits: 61,
      condition: {
        alive: true,
        conscious: true,
        engineStatus: 'standing',
      },
      readiness: {
        summary: 'ready_to_act',
        engineStatus: 'standing',
        engineActingUnitAvailable: true,
      },
    });
    const binding = buildCommandBinding(tacticalBase([ready]), DIGEST);
    const row = binding.player_soldiers[0];
    assert.equal(row.timeUnits, 61);
    assert.equal(row.timeUnitsApplicability, undefined);
    assert.equal(row.engineReportedTimeUnits, undefined);
  });

  it('mixed roster: only unconscious rows use not_command_applicable TU', () => {
    const ready = rosterSoldier({
      id: 8,
      position: [5, 39, 1],
      timeUnits: 53,
      condition: { alive: true, conscious: true, engineStatus: 'standing' },
      readiness: {
        summary: 'ready_to_act',
        engineActingUnitAvailable: true,
      },
    });
    const binding = buildCommandBinding(tacticalBase([rosterSoldier(), ready]), DIGEST);
    assert.equal(binding.player_soldiers.length, 2);
    const down = binding.player_soldiers.find((s) => s.id === 2);
    const up = binding.player_soldiers.find((s) => s.id === 8);
    assert.equal(down.timeUnits, null);
    assert.equal(down.engineReportedTimeUnits, 63);
    assert.equal(up.timeUnits, 53);
  });

  it('panicking readiness uses not_command_applicable without changing listing', () => {
    const panicking = rosterSoldier({
      id: 4,
      timeUnits: 40,
      condition: { alive: true, conscious: true, engineStatus: 'panicking' },
      readiness: { summary: 'panicking', engineActingUnitAvailable: true },
    });
    assert.equal(isCommandApplicableForBinding(panicking), false);
    const row = buildCommandBinding(tacticalBase([panicking]), DIGEST).player_soldiers[0];
    assert.equal(row.timeUnits, null);
    assert.equal(row.engineReportedTimeUnits, 40);
  });

  it('composeMoveCommand still accepts listed incapacitated id (engine rejects execution)', () => {
    const binding = buildCommandBinding(tacticalBase([rosterSoldier()]), DIGEST);
    const cmd = composeMoveCommand(binding, {
      commandId: 'move-downed-01',
      actorUnitId: 2,
      destination: { x: 5, y: 4, z: 0 },
    });
    assert.equal(cmd.actor_unit_id, 2);
    assert.equal(cmd.command_type, 'MOVE');
  });
});
