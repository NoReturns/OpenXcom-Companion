'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');
const { loadAndValidateSnapshotFromText } = require('../lib/tactical-publish.cjs');
const { tryPublishPostCommandTacticalState } = require('../lib/post-command-tactical-publish.cjs');
const { tryAttachDropOutcomeBriefToRelayOptions } = require('../lib/drop-result-ground-placement.cjs');
const { sha256HexLower } = require('../lib/briefing-snapshot.cjs');

const FIXTURE = path.join(__dirname, 'fixtures', 'valid-v5.yaml');
const SESSION = 'a1b2c3d4e5f6789012345678abcdef01';

function makePostDropSnapshot(baseText, groundInventory) {
  const doc = YAML.parse(baseText);
  doc.units[0].groundInventory = groundInventory;
  return YAML.stringify(doc);
}

describe('P1-C DROP relay observability', () => {
  it('post-command publish attaches lastDropOutcomeBrief when snapshot confirms placement', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-relay-'));
    try {
      const baseText = fs.readFileSync(FIXTURE, 'utf8');
      const oldDigest = sha256HexLower(Buffer.from(baseText, 'utf8'));
      const updatedText = makePostDropSnapshot(baseText, [{
        slot: 'STR_GROUND',
        inventorySlotType: 'ground',
        battleItemId: 300,
        itemType: 'STR_RIFLE_CLIP',
        battleType: 9,
        inventoryX: 0,
        inventoryY: 0,
      }]);
      const snapshotPath = path.join(root, 'tactical-live.yaml');
      fs.writeFileSync(snapshotPath, updatedText, 'utf8');
      const tactical = loadAndValidateSnapshotFromText(updatedText, YAML);
      const newDigest = sha256HexLower(Buffer.from(updatedText, 'utf8'));
      const result = {
        schema_version: 1,
        command_id: 'drop-relay-1',
        command_type: 'DROP',
        status: 'COMPLETED',
        session_id: SESSION,
        turn: tactical.turn,
        state_version: 0,
        actor_unit_id: 1,
        item_battle_item_id: 300,
        source_slot: 'STR_BELT',
        snapshot_sha256: newDigest,
        final_position: { x: 1, y: 2, z: 0 },
        remaining_tu: 44,
        kneeled: false,
        tu_spent: 6,
        ground_placement: {
          item_battle_item_id: 300,
          tile: { x: 1, y: 2, z: 0 },
          inventory_x: 0,
          inventory_y: 0,
          verification_status: 'engine_postcondition_verified',
          evidence_class: 'engine_immediate',
        },
      };
      const relayPublishes = [];
      const outcome = await tryPublishPostCommandTacticalState({
        snapshotPath,
        result,
        commandId: result.command_id,
        journal: { version: 1, active: null, records: {} },
        record: { delivered_command_snapshot_sha256: oldDigest },
        deliveredCommand: {
          command_id: 'drop-relay-1',
          command_type: 'DROP',
          item_battle_item_id: 300,
          snapshot_sha256: oldDigest,
        },
        publishRelayState: async (relay) => {
          relayPublishes.push(relay);
          return { skipped: false };
        },
        readFileSync: fs.readFileSync,
        existsSync: fs.existsSync,
      });
      assert.equal(outcome.action, 'published');
      assert.ok(relayPublishes[0].lastDropOutcomeBrief);
      assert.equal(relayPublishes[0].lastDropOutcomeBrief.verification_class, 'drop_independently_confirmed');
      assert.deepEqual(relayPublishes[0].lastDropOutcomeBrief.ground_tile, { x: 1, y: 2, z: 0 });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('F6 attach helper reads terminal tactical-result beside snapshot', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-f6-'));
    try {
      const text = fs.readFileSync(FIXTURE, 'utf8');
      const updated = makePostDropSnapshot(text, [{
        slot: 'STR_GROUND',
        inventorySlotType: 'ground',
        battleItemId: 300,
        itemType: 'STR_RIFLE_CLIP',
        battleType: 9,
        inventoryX: 0,
        inventoryY: 0,
      }]);
      const snapshotPath = path.join(root, 'tactical-live.yaml');
      fs.writeFileSync(snapshotPath, updated, 'utf8');
      const digest = sha256HexLower(Buffer.from(updated, 'utf8'));
      const tactical = loadAndValidateSnapshotFromText(updated, YAML);
      fs.writeFileSync(path.join(root, 'tactical-result.json'), `${JSON.stringify({
        command_type: 'DROP',
        status: 'COMPLETED',
        command_id: 'f6-drop',
        session_id: SESSION,
        turn: 1,
        state_version: 0,
        actor_unit_id: 1,
        item_battle_item_id: 300,
        snapshot_sha256: digest,
        ground_placement: {
          item_battle_item_id: 300,
          tile: { x: 1, y: 2, z: 0 },
          inventory_x: 0,
          inventory_y: 0,
          verification_status: 'engine_postcondition_verified',
          evidence_class: 'engine_immediate',
        },
      })}\n`);
      const relayOptions = {};
      const brief = tryAttachDropOutcomeBriefToRelayOptions(relayOptions, {
        snapshotPath,
        tactical,
        digest,
      });
      assert.ok(brief);
      assert.equal(relayOptions.lastDropOutcomeBrief.verification_class, 'drop_independently_confirmed');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
