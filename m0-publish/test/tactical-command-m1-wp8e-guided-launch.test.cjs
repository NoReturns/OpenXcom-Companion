'use strict';

/**
 * WP8E Stage 1 — GUIDED_LAUNCH Node schema + snapshot validation (no engine).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const YAML = require('yaml');
const {
  FACTION_PLAYER,
  BT_FIREARM,
  loadAndValidateSnapshotFromText,
} = require('../lib/tactical-publish.cjs');
const {
  COMMAND_TYPE_GUIDED_LAUNCH,
  parseGuidedLaunchCommand,
  parseTacticalCommand,
  validateGuidedLaunchAgainstSnapshot,
  validateTacticalCommandAgainstSnapshot,
  ValidationError,
} = require('../lib/tactical-command.cjs');
const { composeGuidedLaunchCommand } = require('../lib/command-binding.cjs');

const SESSION = 'a1b2c3d4e5f6789012345678abcdef01';
const SHA = 'f'.repeat(64);

function rulesReferenceStandardBlaster() {
  return {
    schema_version: 2,
    artifact: 'companion-rules-reference',
    exported_at_ms: 1,
    identity: {
      campaign_id: 'a'.repeat(32),
      research_revision_sha256: 'b'.repeat(64),
      ruleset_revision_sha256: 'c'.repeat(64),
      content_revision_sha256: 'd'.repeat(64),
    },
    ruleset: { mods: ['xcom1'] },
    inventorySections: [],
    items: [
      {
        type: 'STR_BLASTER_LAUNCHER',
        battleType: 'firearm',
        waypoints: 9,
        clipSize: 1,
        flatRate: false,
      },
      {
        type: 'STR_BLASTER_BOMB',
        battleType: 'ammo',
        damagePower: 200,
        damageType: 'explosive',
      },
    ],
  };
}

function rulesReferenceUnlimitedLauncher() {
  return {
    ...rulesReferenceStandardBlaster(),
    items: [
      {
        type: 'STR_MOD_UNLIMITED_LAUNCHER',
        battleType: 'firearm',
        waypoints: -1,
        clipSize: 1,
        flatRate: false,
      },
    ],
  };
}

function blasterUnit(overrides = {}) {
  return {
    id: 1,
    faction: FACTION_PLAYER,
    originalFaction: FACTION_PLAYER,
    position: [5, 5, 0],
    name: 'WP8E',
    health: 50,
    timeUnits: 80,
    kneeled: false,
    activeHand: 'STR_RIGHT_HAND',
    inventory: [],
    groundInventory: [],
    hands: {
      right: {
        itemType: 'STR_BLASTER_LAUNCHER',
        battleType: BT_FIREARM,
        nestedAmmo: {
          battleItemId: 501,
          ammoType: 'STR_BLASTER_BOMB',
          rounds: 1,
        },
      },
      left: null,
    },
    actionCosts: {
      posture: { kneelDownTu: 4, standUpTu: 8 },
      hands: {
        right: {
          itemType: 'STR_BLASTER_LAUNCHER',
          actions: [
            {
              id: 'launch',
              actionType: 8,
              tuCost: 40,
              usable: true,
              canAffordTu: true,
            },
          ],
        },
        left: { actions: [] },
      },
    },
    ...overrides,
  };
}

function snapshotDoc(unit, map = { width: 50, height: 50, depth: 4 }) {
  return {
    schemaVersion: 4,
    turn: 2,
    side: 0,
    selectedUnitId: unit.id,
    map,
    units: [unit],
    eventLog: {
      sessionId: SESSION,
      oldestSeq: 0,
      latestSeq: 0,
      droppedCount: 0,
      events: [],
    },
    groundItems: {
      schemaVersion: 1,
      sessionId: SESSION,
      memoryNote: 'wp8e-guided-launch',
      droppedCount: 0,
      observations: [],
    },
  };
}

function loadTactical(unit, map) {
  return loadAndValidateSnapshotFromText(YAML.stringify(snapshotDoc(unit, map)), YAML);
}

function waypointList(count, zSteps = false) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push({ x: 10 + i, y: 12, z: zSteps ? (i % 4) : 0 });
  }
  return out;
}

function guidedLaunchBase(tactical, waypoints, overrides = {}) {
  return {
    schema_version: 1,
    command_id: 'gl-wp8e-1',
    command_type: COMMAND_TYPE_GUIDED_LAUNCH,
    actor_unit_id: 1,
    active_hand: 'STR_RIGHT_HAND',
    waypoints,
    snapshot_sha256: SHA,
    session_id: tactical.eventLog.sessionId,
    turn: tactical.turn,
    state_version: 0,
    ...overrides,
  };
}

function bindingFromTactical(tactical, digest) {
  return {
    schema_version: 1,
    snapshot_sha256: digest,
    session_id: tactical.eventLog.sessionId,
    turn: tactical.turn,
    state_version: tactical.eventLog.latestSeq,
    map: tactical.map,
    player_soldiers: [{ id: 1, position: tactical.units[0].position, kneeled: false }],
  };
}

describe('WP8E GUIDED_LAUNCH — Node schema and validation', () => {
  const rulesRef = rulesReferenceStandardBlaster();
  const tactical = loadTactical(blasterUnit());
  const validateOpts = { rulesReference: rulesRef };

  it('parses valid contract and preserves waypoint order', () => {
    const wps = [
      { x: 10, y: 11, z: 0 },
      { x: 11, y: 12, z: 1 },
      { x: 12, y: 13, z: 2 },
    ];
    const cmd = guidedLaunchBase(tactical, wps);
    const parsed = parseGuidedLaunchCommand(cmd);
    assert.equal(parsed.commandType, COMMAND_TYPE_GUIDED_LAUNCH);
    assert.deepEqual(parsed.waypoints, wps);
    assert.equal(parseTacticalCommand(cmd).waypoints.length, 3);
  });

  it('accepts 1, 3, and 9 waypoints with standard ruleset cap', () => {
    for (const n of [1, 3, 9]) {
      const cmd = guidedLaunchBase(tactical, waypointList(n));
      validateGuidedLaunchAgainstSnapshot(cmd, tactical, SHA, validateOpts);
    }
  });

  it('accepts vertical waypoint transitions within map depth', () => {
    const cmd = guidedLaunchBase(tactical, [
      { x: 8, y: 8, z: 0 },
      { x: 9, y: 8, z: 1 },
      { x: 10, y: 8, z: 2 },
    ]);
    validateGuidedLaunchAgainstSnapshot(cmd, tactical, SHA, validateOpts);
  });

  it('rejects excess waypoints when ruleset cap is known', () => {
    const cmd = guidedLaunchBase(tactical, waypointList(10));
    assert.throws(
      () => validateGuidedLaunchAgainstSnapshot(cmd, tactical, SHA, validateOpts),
      /waypoint count exceeds ruleset maximum \(9\)/,
    );
  });

  it('allows unlimited ruleset cap when waypoints is -1', () => {
    const modUnit = blasterUnit({
      hands: {
        right: {
          itemType: 'STR_MOD_UNLIMITED_LAUNCHER',
          battleType: BT_FIREARM,
          nestedAmmo: { battleItemId: 1, ammoType: 'STR_BLASTER_BOMB', rounds: 1 },
        },
        left: null,
      },
    });
    const modTac = loadTactical(modUnit);
    const cmd = guidedLaunchBase(modTac, waypointList(25));
    validateGuidedLaunchAgainstSnapshot(cmd, modTac, SHA, {
      rulesReference: rulesReferenceUnlimitedLauncher(),
    });
  });

  it('rejects when rules reference missing and waypoint cap unknown', () => {
    const modUnit = blasterUnit({
      hands: {
        right: {
          itemType: 'STR_UNKNOWN_GUIDED_LAUNCHER',
          battleType: BT_FIREARM,
          nestedAmmo: { battleItemId: 1, ammoType: 'STR_BLASTER_BOMB', rounds: 1 },
        },
        left: null,
      },
      actionCosts: {
        posture: { kneelDownTu: 4, standUpTu: 8 },
        hands: {
          right: {
            actions: [{ id: 'launch', actionType: 8, tuCost: 40, usable: true, canAffordTu: true }],
          },
          left: { actions: [] },
        },
      },
    });
    const modTac = loadTactical(modUnit);
    const cmd = guidedLaunchBase(modTac, waypointList(1));
    assert.throws(
      () => validateGuidedLaunchAgainstSnapshot(cmd, modTac, SHA, {}),
      /rules reference required/,
    );
  });

  it('rejects missing guided weapon / empty chamber', () => {
    const rifleUnit = blasterUnit({
      hands: {
        right: {
          itemType: 'STR_RIFLE',
          battleType: BT_FIREARM,
          noMagazineInserted: true,
        },
        left: null,
      },
      actionCosts: {
        posture: { kneelDownTu: 4, standUpTu: 8 },
        hands: {
          right: {
            actions: [{ id: 'snap', actionType: 6, tuCost: 25, usable: true, canAffordTu: true }],
          },
          left: { actions: [] },
        },
      },
    });
    const tac = loadTactical(rifleUnit);
    const cmd = guidedLaunchBase(tac, waypointList(1));
    assert.throws(
      () => validateGuidedLaunchAgainstSnapshot(cmd, tac, SHA, validateOpts),
      /no ammunition loaded|does not support guided launch/,
    );
  });

  it('rejects invalid active hand', () => {
    const cmd = guidedLaunchBase(tactical, waypointList(1), { active_hand: 'STR_BELT' });
    assert.throws(() => parseGuidedLaunchCommand(cmd), /invalid active_hand/);
  });

  it('rejects insufficient TU', () => {
    const poor = blasterUnit({
      actionCosts: {
        posture: { kneelDownTu: 4, standUpTu: 8 },
        hands: {
          right: {
            actions: [
              { id: 'launch', actionType: 8, tuCost: 40, usable: true, canAffordTu: false },
            ],
          },
          left: { actions: [] },
        },
      },
    });
    const tac = loadTactical(poor);
    const cmd = guidedLaunchBase(tac, waypointList(1));
    assert.throws(
      () => validateGuidedLaunchAgainstSnapshot(cmd, tac, SHA, validateOpts),
      /insufficient TU for guided launch/,
    );
  });

  it('rejects TU reservation conflict', () => {
    const reserved = blasterUnit({
      actionCosts: {
        posture: { kneelDownTu: 4, standUpTu: 8 },
        hands: {
          right: {
            actions: [
              {
                id: 'launch',
                actionType: 8,
                tuCost: 40,
                usable: true,
                canAffordTu: true,
                canAffordTuWithCurrentReservation: false,
              },
            ],
          },
          left: { actions: [] },
        },
      },
    });
    const tac = loadTactical(reserved);
    const cmd = guidedLaunchBase(tac, waypointList(1));
    assert.throws(
      () => validateGuidedLaunchAgainstSnapshot(cmd, tac, SHA, validateOpts),
      /insufficient TU with current reservation/,
    );
  });

  it('rejects invalid map coordinates', () => {
    const cmd = guidedLaunchBase(tactical, [{ x: 50, y: 5, z: 0 }]);
    assert.throws(
      () => validateGuidedLaunchAgainstSnapshot(cmd, tactical, SHA, validateOpts),
      /waypoints\[0\] out of map bounds/,
    );
  });

  it('rejects stale snapshot/session bindings', () => {
    const cmd = guidedLaunchBase(tactical, waypointList(1), {
      snapshot_sha256: 'a'.repeat(64),
    });
    assert.throws(
      () => validateGuidedLaunchAgainstSnapshot(cmd, tactical, SHA, validateOpts),
      /snapshot_sha256 mismatch/,
    );

    const cmd2 = guidedLaunchBase(tactical, waypointList(1), { session_id: 'b'.repeat(32) });
    assert.throws(
      () => validateGuidedLaunchAgainstSnapshot(cmd2, tactical, SHA, validateOpts),
      /session_id mismatch/,
    );
  });

  it('rejects unauthorized actor (not in snapshot roster)', () => {
    const tac = loadTactical(blasterUnit());
    const cmd = guidedLaunchBase(tac, waypointList(1), { actor_unit_id: 2 });
    assert.throws(
      () => validateGuidedLaunchAgainstSnapshot(cmd, tac, SHA, validateOpts),
      /actor_unit_id not in snapshot/,
    );
  });

  it('rejection messages do not expose hidden enemy identifiers', () => {
    const cmd = guidedLaunchBase(tactical, waypointList(1), { actor_unit_id: 424242 });
    let message = '';
    try {
      validateGuidedLaunchAgainstSnapshot(cmd, tactical, SHA, validateOpts);
    } catch (err) {
      message = String(err.message || err);
    }
    assert.match(message, /actor_unit_id not in snapshot/);
    assert.doesNotMatch(message, /SECTOID|Sectoid|muton|浮游|equipment/i);
  });

  it('validateTacticalCommandAgainstSnapshot dispatches GUIDED_LAUNCH', () => {
    const cmd = guidedLaunchBase(tactical, waypointList(2));
    validateTacticalCommandAgainstSnapshot(cmd, tactical, SHA, validateOpts);
  });

  it('composeGuidedLaunchCommand builds binding-aligned draft', () => {
    const binding = bindingFromTactical(tactical, SHA);
    const draft = composeGuidedLaunchCommand(binding, {
      commandId: 'gl-compose-1',
      actorUnitId: 1,
      activeHand: 'STR_RIGHT_HAND',
      waypoints: waypointList(3, true),
    });
    assert.equal(draft.command_type, 'GUIDED_LAUNCH');
    assert.equal(draft.waypoints.length, 3);
    assert.equal(draft.waypoints[2].z, 2);
    validateGuidedLaunchAgainstSnapshot(draft, tactical, SHA, validateOpts);
  });

  it('rejects empty waypoints array', () => {
    const cmd = guidedLaunchBase(tactical, []);
    assert.throws(() => parseGuidedLaunchCommand(cmd), ValidationError);
  });

  it('rejects unknown command fields', () => {
    const cmd = { ...guidedLaunchBase(tactical, waypointList(1)), target: { x: 1, y: 1, z: 0 } };
    assert.throws(() => parseGuidedLaunchCommand(cmd), /unknown command field/);
  });
});