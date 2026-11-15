'use strict';

/**
 * M1-WP9 S4 — bounded Node relay contract exercises (isolated fixtures; no live campaign).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  parseTacticalCommand,
  validateTacticalCommandAgainstSnapshot,
} = require('../lib/tactical-command.cjs');
const { composeHealCommand, composeStimulantCommand, composePainKillerCommand } = require('../lib/command-binding.cjs');
const { publishTacticalCommandOnce } = require('../lib/relay-tactical-command-publish.cjs');
const { buildRelayOptionsFromConfig } = require('../lib/relay-isolation-config.cjs');
const {
  SNAPSHOT_SHA,
  MEDIKIT_ID,
  TARGET_ID,
  medkitActorUnit,
  woundedTargetUnit,
  loadMedikitTactical,
} = require('./helpers/medikit-wp9-fixture.cjs');
const { resolveCompanionEngineHarness } = require('./helpers/companion-engine-harness-path.cjs');

const MEDIKIT_RELAY_EXE = 'companion_medikit_engine_test.exe';

function bindingFromTactical(tactical) {
  return {
    schema_version: 1,
    snapshot_sha256: SNAPSHOT_SHA,
    session_id: tactical.eventLog.sessionId,
    turn: tactical.turn,
    state_version: tactical.eventLog.latestSeq,
    map: tactical.map,
    player_soldiers: [
      { id: 1, position: [1, 1, 0], kneeled: false },
      { id: TARGET_ID, position: [1, 1, 0], kneeled: false },
    ],
  };
}

describe('M1-WP9 medikit S4 relay integration (Node)', () => {
  it('compose + validate HEAL/STIMULANT/PAINKILLER drafts for relay publish', () => {
    const tactical = loadMedikitTactical([medkitActorUnit(), woundedTargetUnit()]);
    const binding = bindingFromTactical(tactical);
    for (const [label, compose] of [
      ['HEAL', () => composeHealCommand(binding, { commandId: 's4-heal', actorUnitId: 1, activeHand: 'STR_RIGHT_HAND', targetUnitId: TARGET_ID, bodyPart: 1, medikitBattleItemId: MEDIKIT_ID })],
      ['STIMULANT', () => composeStimulantCommand(binding, { commandId: 's4-stim', actorUnitId: 1, activeHand: 'STR_RIGHT_HAND', targetUnitId: TARGET_ID, medikitBattleItemId: MEDIKIT_ID })],
      ['PAINKILLER', () => composePainKillerCommand(binding, { commandId: 's4-pk', actorUnitId: 1, activeHand: 'STR_RIGHT_HAND', targetUnitId: TARGET_ID, medikitBattleItemId: MEDIKIT_ID })],
    ]) {
      const draft = compose();
      const parsed = parseTacticalCommand(draft);
      assert.equal(parsed.commandType, label, label);
      validateTacticalCommandAgainstSnapshot(draft, tactical, SNAPSHOT_SHA);
    }
  });

  it('publish dry-run accepts HEAL medikit draft', async () => {
    const tactical = loadMedikitTactical([medkitActorUnit(), woundedTargetUnit()]);
    const binding = bindingFromTactical(tactical);
    const draft = composeHealCommand(binding, {
      commandId: 's4-heal-dry',
      actorUnitId: 1,
      activeHand: 'STR_RIGHT_HAND',
      targetUnitId: TARGET_ID,
      bodyPart: 1,
      medikitBattleItemId: MEDIKIT_ID,
    });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp9-medikit-dry-'));
    const draftPath = path.join(root, 'tactical-command-draft.json');
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
          },
        }),
        requireGhAuth: false,
      });
      assert.equal(outcome.ok, true);
      assert.equal(outcome.command_type, 'HEAL');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('M1-WP9 medikit S4 relay integration (engine harness)', () => {
  it('[Engine harness] companion_medikit_engine_test includes relay inbox E2E', () => {
    const resolved = resolveCompanionEngineHarness(MEDIKIT_RELAY_EXE);
    if (!resolved) {
      return;
    }
    const out = execFileSync(resolved.executablePath, [], {
      encoding: 'utf8',
      timeout: 180_000,
      cwd: resolved.workingDirectory,
    });
    assert.match(out, /All companion medikit engine tests passed/);
  });
});