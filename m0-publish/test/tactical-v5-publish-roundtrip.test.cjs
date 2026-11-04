'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const YAML = require('yaml');
const {
  loadAndValidateSnapshotFromText,
  buildRelayPayload,
} = require('../lib/tactical-publish.cjs');
const { buildCommandBinding } = require('../lib/command-binding.cjs');
const { tryPublishPostCommandTacticalState } = require('../lib/post-command-tactical-publish.cjs');

const FIXTURE_V4 = path.join(__dirname, 'fixtures', 'valid-v4.yaml');
const FIXTURE_V5 = path.join(__dirname, 'fixtures', 'valid-v5.yaml');

function sha256HexLower(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function assertFriendlyV3FieldsPreserved(tactical) {
  const standing = tactical.units.find((u) => u.id === 1);
  const kneeling = tactical.units.find((u) => u.id === 2);
  assert.equal(standing.kneeled, false);
  assert.equal(kneeling.kneeled, true);
  assert.equal(standing.activeHand, 'STR_RIGHT_HAND');
  assert.equal(standing.hands.right.itemType, 'STR_RIFLE');
  assert.equal(standing.hands.right.loaded.rounds, 25);
  assert.deepEqual(standing.inventory, []);
  assert.ok(tactical.eventLog);
  if (tactical.schemaVersion === 5) {
    assert.ok(tactical.terrain);
  }
}

describe('schema v4/v5 tactical publish round-trip (M1-29A)', () => {
  for (const [label, fixturePath] of [['v4', FIXTURE_V4], ['v5', FIXTURE_V5]]) {
    it(`${label} fixture preserves soldier equipment and posture after validation`, () => {
      const text = fs.readFileSync(fixturePath, 'utf8');
      const tactical = loadAndValidateSnapshotFromText(text, YAML);
      assert.equal(tactical.schemaVersion, label === 'v4' ? 4 : 5);
      assertFriendlyV3FieldsPreserved(tactical);
    });

    it(`${label} relay JSON and commandBinding keep kneeled flags`, () => {
      const text = fs.readFileSync(fixturePath, 'utf8');
      const tactical = loadAndValidateSnapshotFromText(text, YAML);
      const digest = sha256HexLower(Buffer.from(text, 'utf8'));
      const relay = buildRelayPayload(tactical, new Date().toISOString(), null, { snapshotSha256: digest });
      const published = JSON.parse(JSON.stringify(relay));
      assert.equal(published.tactical.units.find((u) => u.id === 1).kneeled, false);
      assert.equal(published.tactical.units.find((u) => u.id === 2).kneeled, true);
      const binding = buildCommandBinding(tactical, digest);
      assert.equal(binding.player_soldiers.find((s) => s.id === 1).kneeled, false);
      assert.equal(binding.player_soldiers.find((s) => s.id === 2).kneeled, true);
    });
  }

  it('post-command publish keeps kneeling soldier after COMPLETED KNEEL result', async () => {
    const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'm1-29a-kneel-'));
    try {
      const baseText = fs.readFileSync(FIXTURE_V5, 'utf8');
      const baseTactical = loadAndValidateSnapshotFromText(baseText, YAML);
      const oldDigest = sha256HexLower(Buffer.from(baseText, 'utf8'));

      const doc = YAML.parse(baseText);
      const unit = doc.units.find((u) => u.id === 1);
      unit.kneeled = true;
      const updatedText = YAML.stringify(doc);
      const snapshotPath = path.join(root, 'tactical-live.yaml');
      fs.writeFileSync(snapshotPath, updatedText, 'utf8');
      const updatedTactical = loadAndValidateSnapshotFromText(updatedText, YAML);
      const newDigest = sha256HexLower(Buffer.from(updatedText, 'utf8'));
      assert.equal(updatedTactical.units.find((u) => u.id === 1).kneeled, true);

      const actor = updatedTactical.units.find((u) => u.id === 1);
      const result = {
        schema_version: 1,
        command_id: 'kneel-m1-29a',
        command_type: 'KNEEL',
        status: 'COMPLETED',
        session_id: updatedTactical.eventLog.sessionId,
        turn: updatedTactical.turn,
        actor_unit_id: 1,
        final_position: { x: actor.position[0], y: actor.position[1], z: actor.position[2] },
        remaining_tu: actor.timeUnits,
        kneeled: true,
        destination_reached: false,
        snapshot_sha256: newDigest,
      };

      const relayPublishes = [];
      const outcome = await tryPublishPostCommandTacticalState({
        snapshotPath,
        result,
        commandId: result.command_id,
        journal: { version: 1, active: null, records: {} },
        record: { delivered_command_snapshot_sha256: oldDigest },
        dryRun: false,
        publishRelayState: async (relay) => {
          relayPublishes.push(relay);
          return { skipped: false };
        },
        readFileSync: fs.readFileSync,
        existsSync: fs.existsSync,
      });

      assert.equal(outcome.action, 'published');
      assert.equal(relayPublishes.length, 1);
      const jenni = relayPublishes[0].tactical.units.find((u) => u.id === 1);
      assert.equal(jenni.kneeled, true);
      assert.equal(relayPublishes[0].commandBinding.player_soldiers.find((s) => s.id === 1).kneeled, true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when terminal kneeled disagrees with snapshot bytes', async () => {
    const text = fs.readFileSync(FIXTURE_V5, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(text, YAML);
    const digest = sha256HexLower(Buffer.from(text, 'utf8'));
    const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'm1-29a-kneel-mismatch-'));
    try {
      const snapshotPath = path.join(root, 'tactical-live.yaml');
      fs.writeFileSync(snapshotPath, text, 'utf8');
      const actor = tactical.units.find((u) => u.id === 1);
      const result = {
        schema_version: 1,
        command_id: 'kneel-mismatch',
        command_type: 'KNEEL',
        status: 'COMPLETED',
        session_id: tactical.eventLog.sessionId,
        turn: tactical.turn,
        actor_unit_id: 1,
        final_position: { x: actor.position[0], y: actor.position[1], z: actor.position[2] },
        remaining_tu: actor.timeUnits,
        kneeled: true,
        snapshot_sha256: digest,
      };
      const outcome = await tryPublishPostCommandTacticalState({
        snapshotPath,
        result,
        commandId: result.command_id,
        journal: { version: 1, active: null, records: {} },
        record: null,
        publishRelayState: async () => ({ skipped: false }),
        readFileSync: fs.readFileSync,
        existsSync: fs.existsSync,
      });
      assert.equal(outcome.action, 'fail_closed');
      assert.equal(outcome.reason, 'kneeled_mismatch');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
