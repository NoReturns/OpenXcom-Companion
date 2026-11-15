'use strict';

/**
 * WP8E Stage 3 — relay integration: sidecar validation, publish dry-run, notify enrichment.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const YAML = require('yaml');
const {
  FACTION_PLAYER,
  BT_FIREARM,
  loadAndValidateSnapshotFromText,
} = require('../lib/tactical-publish.cjs');
const {
  validateTacticalCommandAgainstSnapshot,
  validateTacticalCommandAgainstSnapshotFile,
} = require('../lib/tactical-command.cjs');
const { composeGuidedLaunchCommand } = require('../lib/command-binding.cjs');
const { publishTacticalCommandOnce } = require('../lib/relay-tactical-command-publish.cjs');
const { buildRelayOptionsFromConfig } = require('../lib/relay-isolation-config.cjs');
const { notificationFromLocalResult } = require('../lib/companion-relay-notify.cjs');
const {
  resolveCompanionEngineHarness,
} = require('./helpers/companion-engine-harness-path.cjs');

const SESSION = 'a1b2c3d4e5f6789012345678abcdef01';
const COMPANION_COMMAND_TEST_EXE = 'companion_command_test.exe';

function sha256HexLower(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function blasterUnit() {
  return {
    id: 1,
    faction: FACTION_PLAYER,
    originalFaction: FACTION_PLAYER,
    position: [5, 5, 0],
    name: 'WP8E-Relay',
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
  };
}

function snapshotYaml(map = { width: 50, height: 50, depth: 4 }) {
  const unit = blasterUnit();
  return YAML.stringify({
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
      memoryNote: 'wp8e-relay-integration',
      droppedCount: 0,
      observations: [],
    },
  });
}

function rulesReferenceObject() {
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

describe('WP8E Stage 3 — relay integration [Node-only]', () => {
  const snapshotText = `${snapshotYaml()}\n`;
  const tactical = loadAndValidateSnapshotFromText(snapshotText, YAML);
  const digest = sha256HexLower(Buffer.from(snapshotText, 'utf8'));
  const validateOpts = { rulesReference: rulesReferenceObject() };

  it('sidecar file validation accepts composed GUIDED_LAUNCH', () => {
    const binding = bindingFromTactical(tactical, digest);
    const draft = composeGuidedLaunchCommand(binding, {
      commandId: 'gl-relay-sidecar-ok',
      actorUnitId: 1,
      activeHand: 'STR_RIGHT_HAND',
      waypoints: [
        { x: 10, y: 12, z: 0 },
        { x: 11, y: 12, z: 0 },
      ],
    });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp8e-sidecar-'));
    const snapshotPath = path.join(root, 'tactical-live.yaml');
    fs.writeFileSync(snapshotPath, snapshotText, 'utf8');
    try {
      validateTacticalCommandAgainstSnapshotFile(draft, snapshotPath, YAML, fs.readFileSync, validateOpts);
      validateTacticalCommandAgainstSnapshot(draft, tactical, digest, validateOpts);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('sidecar rejects out-of-bounds waypoints (preflight path)', () => {
    const cmd = {
      schema_version: 1,
      command_id: 'gl-relay-reject-oob',
      command_type: 'GUIDED_LAUNCH',
      actor_unit_id: 1,
      active_hand: 'STR_RIGHT_HAND',
      waypoints: [{ x: 99, y: 99, z: 0 }],
      snapshot_sha256: digest,
      session_id: tactical.eventLog.sessionId,
      turn: tactical.turn,
      state_version: 0,
    };
    assert.throws(
      () => validateTacticalCommandAgainstSnapshot(cmd, tactical, digest, validateOpts),
      /out of map bounds/,
    );
  });

  it('publish dry-run accepts GUIDED_LAUNCH draft file', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp8e-publish-dry-'));
    const draftPath = path.join(root, 'tactical-command-draft.json');
    const binding = bindingFromTactical(tactical, digest);
    const draft = composeGuidedLaunchCommand(binding, {
      commandId: 'gl-relay-dry-run-1',
      actorUnitId: 1,
      activeHand: 'STR_RIGHT_HAND',
      waypoints: [{ x: 8, y: 8, z: 0 }],
    });
    fs.writeFileSync(draftPath, `${JSON.stringify(draft, null, 2)}\n`, 'utf8');
    try {
      const outcome = await publishTacticalCommandOnce({
        localPath: draftPath,
        dryRun: true,
        publish: false,
        relayOptions: buildRelayOptionsFromConfig({
          schema_version: 1,
          repo: 'ExampleOrg/OpenXcom-Command-Publish-Test',
          branch: 'main',
          state_path: 'm0-e2e/state.json',
          content_paths: {
            tacticalCommand: 'm0-e2e/tactical-command.json',
            tacticalResult: 'm0-e2e/tactical-result.json',
            terrainQuery: 'm0-e2e/terrain-query.json',
            terrainQueryResult: 'm0-e2e/terrain-query-result.json',
            rulesReference: 'm0-e2e/rules-reference.json',
          },
        }),
        requireGhAuth: false,
      });
      assert.equal(outcome.ok, true);
      assert.equal(outcome.dryRun, true);
      assert.equal(outcome.command_type, 'GUIDED_LAUNCH');
      assert.equal(outcome.command_id, 'gl-relay-dry-run-1');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('terminal result notify enrichment for GUIDED_LAUNCH', () => {
    const event = notificationFromLocalResult({
      schema_version: 1,
      command_id: 'gl-notify-1',
      command_type: 'GUIDED_LAUNCH',
      status: 'COMPLETED',
      session_id: SESSION,
      turn: 2,
    });
    assert.equal(event.command_type, 'GUIDED_LAUNCH');
    assert.equal(event.guided_launch_outcome_class, 'projectile_launched');
    assert.match(event.message, /Detonation or damage not confirmed/);
  });
});

describe('WP8E Stage 3 — engine harness rejection paths', () => {
  it('[Engine harness] companion_command_test includes guided launch validation', () => {
    const resolved = resolveCompanionEngineHarness(COMPANION_COMMAND_TEST_EXE);
    if (!resolved) {
      return;
    }
    const out = execFileSync(resolved.executablePath, [], {
      encoding: 'utf8',
      timeout: 120_000,
    });
    assert.match(out, /companion_command_test: all tests passed/);
  });
});