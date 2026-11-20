'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');
const {
  RULES_REFERENCE_STATUS,
  resolveSidecarRulesReferenceValidation,
  buildSidecarTacticalValidationOptions,
} = require('../lib/rules-reference-sidecar-consumer.cjs');
const {
  FACTION_PLAYER,
  BT_FIREARM,
  loadAndValidateSnapshotFromText,
} = require('../lib/tactical-publish.cjs');
const { composeGuidedLaunchCommand } = require('../lib/command-binding.cjs');
const { validateTacticalCommandAgainstSnapshot } = require('../lib/tactical-command.cjs');

const SESSION = 'a1b2c3d4e5f6789012345678abcdef01';
const CAMPAIGN = '624067d2038b6f2d36f27cd0d94b8d03';

function rulesDoc(campaignId = CAMPAIGN) {
  return {
    schema_version: 2,
    artifact: 'companion-rules-reference',
    exported_at_ms: Date.now(),
    identity: {
      campaign_id: campaignId,
      research_revision_sha256: 'a'.repeat(64),
      ruleset_revision_sha256: 'b'.repeat(64),
      content_revision_sha256: 'c'.repeat(64),
    },
    ruleset: { mods: ['xcom1'] },
    inventorySections: [],
    items: [
      {
        type: 'STR_BLASTER_BOMB',
        battleType: 'ammo',
        damagePower: 200,
        damageType: 'explosive',
      },
      {
        type: 'STR_BLASTER_LAUNCHER',
        battleType: 'firearm',
        waypoints: 9,
        clipSize: 1,
        flatRate: false,
      },
    ],
  };
}

function blasterSnapshotYaml() {
  const unit = {
    id: 1,
    faction: FACTION_PLAYER,
    originalFaction: FACTION_PLAYER,
    position: [5, 5, 0],
    name: 'Sidecar',
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
            { id: 'launch', actionType: 8, tuCost: 40, usable: true, canAffordTu: true },
          ],
        },
        left: { actions: [] },
      },
    },
  };
  return YAML.stringify({
    schemaVersion: 4,
    turn: 2,
    side: 0,
    selectedUnitId: 1,
    map: { width: 50, height: 50, depth: 4 },
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
      memoryNote: 'rules-sidecar-test',
      droppedCount: 0,
      observations: [],
    },
  });
}

describe('rules-reference-sidecar-consumer', () => {
  it('rejects GUIDED_LAUNCH when rules file missing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-sidecar-miss-'));
    const snapshotPath = path.join(root, 'tactical-live.yaml');
    fs.writeFileSync(snapshotPath, blasterSnapshotYaml(), 'utf8');
    fs.writeFileSync(
      path.join(root, 'companion-soldier-control.json'),
      JSON.stringify({ campaign_id: CAMPAIGN }),
      'utf8',
    );
    try {
      const gate = buildSidecarTacticalValidationOptions(snapshotPath, { command_type: 'GUIDED_LAUNCH' });
      assert.equal(gate.blocked, true);
      assert.equal(gate.rules.status, RULES_REFERENCE_STATUS.MISSING);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects HWP_GUIDED_LAUNCH when rules file missing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-sidecar-hwp-miss-'));
    const snapshotPath = path.join(root, 'tactical-live.yaml');
    fs.writeFileSync(snapshotPath, blasterSnapshotYaml(), 'utf8');
    fs.writeFileSync(
      path.join(root, 'companion-soldier-control.json'),
      JSON.stringify({ campaign_id: CAMPAIGN }),
      'utf8',
    );
    try {
      const gate = buildSidecarTacticalValidationOptions(snapshotPath, { command_type: 'HWP_GUIDED_LAUNCH' });
      assert.equal(gate.blocked, true);
      assert.equal(gate.rules.status, RULES_REFERENCE_STATUS.MISSING);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects campaign mismatch', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-sidecar-mismatch-'));
    const snapshotPath = path.join(root, 'tactical-live.yaml');
    fs.writeFileSync(snapshotPath, blasterSnapshotYaml(), 'utf8');
    fs.writeFileSync(
      path.join(root, 'companion-rules-reference.json'),
      JSON.stringify(rulesDoc('30386f743b0fa2337a703f79e164981b')),
      'utf8',
    );
    fs.writeFileSync(
      path.join(root, 'companion-soldier-control.json'),
      JSON.stringify({ campaign_id: CAMPAIGN }),
      'utf8',
    );
    try {
      const resolved = resolveSidecarRulesReferenceValidation(snapshotPath);
      assert.equal(resolved.status, RULES_REFERENCE_STATUS.CAMPAIGN_MISMATCH);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts GUIDED_LAUNCH with matched rules reference', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-sidecar-ok-'));
    const snapshotPath = path.join(root, 'tactical-live.yaml');
    const snapshotText = blasterSnapshotYaml();
    fs.writeFileSync(snapshotPath, snapshotText, 'utf8');
    fs.writeFileSync(path.join(root, 'companion-rules-reference.json'), `${JSON.stringify(rulesDoc(), null, 2)}\n`, 'utf8');
    fs.writeFileSync(
      path.join(root, 'companion-soldier-control.json'),
      JSON.stringify({ campaign_id: CAMPAIGN }),
      'utf8',
    );
    const crypto = require('node:crypto');
    const digest = crypto.createHash('sha256').update(Buffer.from(snapshotText, 'utf8')).digest('hex');
    const tactical = loadAndValidateSnapshotFromText(snapshotText, YAML);
    const binding = {
      schema_version: 1,
      snapshot_sha256: digest,
      session_id: tactical.eventLog.sessionId,
      turn: tactical.turn,
      state_version: 0,
      map: tactical.map,
      player_soldiers: [{ id: 1, position: tactical.units[0].position, kneeled: false }],
    };
    const cmd = composeGuidedLaunchCommand(binding, {
      commandId: 'gl-sidecar-accept',
      actorUnitId: 1,
      activeHand: 'STR_RIGHT_HAND',
      waypoints: [{ x: 10, y: 12, z: 0 }],
    });
    try {
      const gate = buildSidecarTacticalValidationOptions(snapshotPath, cmd);
      assert.equal(gate.blocked, false);
      validateTacticalCommandAgainstSnapshot(cmd, tactical, digest, gate.validationOptions);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});