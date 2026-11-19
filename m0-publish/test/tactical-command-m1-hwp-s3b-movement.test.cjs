'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const {
  buildCommandBinding,
  composeHwpMoveCommand,
  composeMoveCommand,
} = require('../lib/command-binding.cjs');
const {
  buildSoldierControlMirror,
} = require('../lib/soldier-control-relay.cjs');
const { loadAndValidateSnapshotFromText } = require('../lib/tactical-publish.cjs');
const {
  parseHwpMoveCommand,
  parseTacticalCommand,
  parseMoveCommand,
  validateHwpMoveAgainstSnapshot,
  validateMoveAgainstSnapshot,
  validateTacticalCommandAgainstSnapshot,
  COMMAND_TYPE_HWP_MOVE,
  isHwpMoveCommandType,
} = require('../lib/tactical-command.cjs');
const { readSnapshotByteBuffer, sha256HexLower } = require('../lib/briefing-snapshot.cjs');

const FIXTURE_OBS = path.join(__dirname, 'fixtures', 'friendly-hwp-observation-v1.yaml');
const SESSION = 'f6e5d4c3b2a19081726354433221100a';
const CAMPAIGN = '0123456789abcdef0123456789abcdef';
const TACTICAL = 'fedcba9876543210fedcba9876543210';
const DIGEST = 'd'.repeat(64);

function mixedControlJson({ soldierAi = [], hwpAi = [] }) {
  const assignments = {};
  for (const id of soldierAi) assignments[String(id)] = 'ai';
  const hwp_assignments = {};
  for (const id of hwpAi) hwp_assignments[String(id)] = 'ai';
  return JSON.stringify({
    schema_version: 2,
    session_id: SESSION,
    campaign_id: CAMPAIGN,
    tactical_battle_id: TACTICAL,
    assignments,
    hwp_assignments,
  });
}

function tacticalFixture() {
  return loadAndValidateSnapshotFromText(fs.readFileSync(FIXTURE_OBS, 'utf8'), YAML);
}

function bindingForAiHwp(tactical, hwpAi = [1_000_000]) {
  const mirror = buildSoldierControlMirror(tactical, {
    soldierControlFileJson: mixedControlJson({ hwpAi }),
    ownershipBindingContext: { campaign_id: CAMPAIGN, tactical_battle_id: TACTICAL },
  });
  return buildCommandBinding(tactical, DIGEST, { soldierControl: mirror });
}

describe('M1-HWP-S3B HWP_MOVE Node contract', () => {
  it('compose + parse valid AI-owned HWP_MOVE', () => {
    const tactical = tacticalFixture();
    const binding = bindingForAiHwp(tactical);
    const cmd = composeHwpMoveCommand(binding, {
      commandId: 'hwp-move-valid',
      actorUnitId: 1_000_000,
      destination: { x: 6, y: 5, z: 0 },
    });
    assert.equal(cmd.command_type, COMMAND_TYPE_HWP_MOVE);
    assert.equal(isHwpMoveCommandType(COMMAND_TYPE_HWP_MOVE), true);
    const parsed = parseHwpMoveCommand(cmd);
    assert.deepEqual(parsed.destination, { x: 6, y: 5, z: 0 });
    assert.equal(parseTacticalCommand(cmd).commandType, COMMAND_TYPE_HWP_MOVE);
  });

  it('validateHwpMoveAgainstSnapshot passes with advisory hint only', () => {
    const tactical = tacticalFixture();
    const binding = bindingForAiHwp(tactical);
    const cmd = composeHwpMoveCommand(binding, {
      commandId: 'hwp-move-validate',
      actorUnitId: 1_000_000,
      destination: { x: 4, y: 4, z: 0 },
    });
    const out = validateHwpMoveAgainstSnapshot(cmd, tactical, DIGEST, { commandBinding: binding });
    assert.equal(out.actor.id, 1_000_000);
    assert.equal(out.planningHint.advisory, true);
    assert.equal(out.planningHint.pathTuEstimateIncluded, false);
    assert.equal(out.planningHint.footprintEstimateIncluded, false);
  });

  it('rejects human-owned HWP in compose and validate', () => {
    const tactical = tacticalFixture();
    const mirror = buildSoldierControlMirror(tactical, {
      soldierControlFileJson: mixedControlJson({ hwpAi: [] }),
      ownershipBindingContext: { campaign_id: CAMPAIGN, tactical_battle_id: TACTICAL },
    });
    const binding = buildCommandBinding(tactical, DIGEST, { soldierControl: mirror });
    assert.throws(
      () => composeHwpMoveCommand(binding, {
        commandId: 'hwp-human',
        actorUnitId: 1_000_000,
        destination: { x: 5, y: 6, z: 0 },
      }),
      /AI-owned/,
    );
    const cmd = {
      schema_version: 1,
      command_id: 'hwp-human-validate',
      command_type: COMMAND_TYPE_HWP_MOVE,
      actor_unit_id: 1_000_000,
      destination: { x: 4, y: 4, z: 0 },
      snapshot_sha256: DIGEST,
      session_id: tactical.eventLog.sessionId,
      turn: tactical.turn,
      state_version: tactical.eventLog.latestSeq,
    };
    assert.throws(
      () => validateHwpMoveAgainstSnapshot(cmd, tactical, DIGEST, { commandBinding: binding }),
      /AI-owned/,
    );
  });

  it('rejects roster soldier as HWP_MOVE actor', () => {
    const tactical = tacticalFixture();
    const binding = bindingForAiHwp(tactical);
    assert.throws(
      () => composeHwpMoveCommand(binding, {
        commandId: 'hwp-soldier',
        actorUnitId: 1,
        destination: { x: 2, y: 2, z: 0 },
      }),
      /HWP unit id/,
    );
    assert.throws(
      () => composeMoveCommand(binding, {
        commandId: 'move-hwp-id',
        actorUnitId: 1_000_000,
        destination: { x: 5, y: 5, z: 0 },
      }),
      /HWP_MOVE|player_soldier/,
    );
  });

  it('rejects missing or destroyed HWP', () => {
    const tactical = tacticalFixture();
    const binding = bindingForAiHwp(tactical);
    const missing = {
      schema_version: 1,
      command_id: 'hwp-missing',
      command_type: COMMAND_TYPE_HWP_MOVE,
      actor_unit_id: 1_000_099,
      destination: { x: 4, y: 4, z: 0 },
      snapshot_sha256: DIGEST,
      session_id: tactical.eventLog.sessionId,
      turn: tactical.turn,
      state_version: tactical.eventLog.latestSeq,
    };
    assert.throws(
      () => validateHwpMoveAgainstSnapshot(missing, tactical, DIGEST, { commandBinding: binding }),
      /not in snapshot/,
    );

    const destroyed = {
      ...tactical,
      units: tactical.units.map((u) => (u.id === 1_000_000
        ? {
          ...u,
          friendlyHwpObservationV1: { ...u.friendlyHwpObservationV1, health: 0 },
        }
        : u)),
    };
    const cmd = composeHwpMoveCommand(binding, {
      commandId: 'hwp-dead',
      actorUnitId: 1_000_000,
      destination: { x: 4, y: 4, z: 0 },
    });
    assert.throws(
      () => validateHwpMoveAgainstSnapshot(cmd, destroyed, DIGEST, { commandBinding: binding }),
      /not operational/,
    );
  });

  it('rejects invalid destination and stale binding', () => {
    const tactical = tacticalFixture();
    const binding = bindingForAiHwp(tactical);
    const cmd = composeHwpMoveCommand(binding, {
      commandId: 'hwp-oob',
      actorUnitId: 1_000_000,
      destination: { x: 4, y: 4, z: 0 },
    });
    cmd.destination = { x: 20, y: 5, z: 0 };
    assert.throws(
      () => validateHwpMoveAgainstSnapshot(cmd, tactical, DIGEST, { commandBinding: binding }),
      /destination out of map bounds/,
    );

    const stale = composeHwpMoveCommand(binding, {
      commandId: 'hwp-stale',
      actorUnitId: 1_000_000,
      destination: { x: 4, y: 4, z: 0 },
    });
    stale.state_version = tactical.eventLog.latestSeq + 1;
    assert.throws(
      () => validateHwpMoveAgainstSnapshot(stale, tactical, DIGEST, { commandBinding: binding }),
      /state_version/,
    );
  });

  it('binding keeps commandExecutionSupported false but reports HWP_MOVE capability', () => {
    const tactical = tacticalFixture();
    const binding = bindingForAiHwp(tactical);
    const hwp = binding.player_hwps.find((h) => h.id === 1_000_000);
    assert.equal(hwp.commandExecutionSupported, false);
    assert.equal(hwp.hwpMoveExecutionSupported, true);
  });

  it('soldier MOVE regression unchanged', () => {
    const tactical = tacticalFixture();
    const bytes = readSnapshotByteBuffer(fs.readFileSync, FIXTURE_OBS);
    const digest = sha256HexLower(bytes);
    const mirror = buildSoldierControlMirror(tactical, {
      soldierControlFileJson: mixedControlJson({ soldierAi: [1] }),
      ownershipBindingContext: { campaign_id: CAMPAIGN, tactical_battle_id: TACTICAL },
    });
    const binding = buildCommandBinding(tactical, digest, { soldierControl: mirror });
    const move = composeMoveCommand(binding, {
      commandId: 'soldier-move-regression',
      actorUnitId: 1,
      destination: { x: 2, y: 2, z: 0 },
    });
    parseMoveCommand(move);
    validateMoveAgainstSnapshot(move, tactical, digest);
    validateTacticalCommandAgainstSnapshot(move, tactical, digest);
  });
});