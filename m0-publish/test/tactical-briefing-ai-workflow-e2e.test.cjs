'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const YAML = require('yaml');
const { loadAndValidateSnapshotFromText, buildRelayPayload } = require('../lib/tactical-publish.cjs');
const { sha256HexLower } = require('../lib/briefing-snapshot.cjs');
const {
  MANDATORY_F6_REVIEW_SEQUENCE,
  getAiBriefingInstructionsMarkdown,
  runMandatoryBattlefieldStatusReview,
  runMandatoryBriefingPrelude,
  runMandatoryPostCommandPrelude,
} = require('../lib/tactical-briefing-ai-workflow.cjs');

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const CURSOR_RULE = path.join(REPO_ROOT, '.cursor', 'rules', 'tactical-briefing-m1-mandatory-status.mdc');
const AGENTS_MD = path.join(REPO_ROOT, 'AGENTS.md');
const STAGE_D_YAML = path.join(
  REPO_ROOT,
  'local',
  'm0',
  'test-battle-harness',
  'captures',
  'D-interior-explored',
  '2026-11-05T16-28-56-377Z',
  'tactical.yaml',
);

describe('M1 tactical briefing AI workflow (consumer E2E)', () => {
  it('wires instructions into Cursor rule and AGENTS.md (not runbook-only)', () => {
    assert.ok(fs.existsSync(CURSOR_RULE), 'Cursor rule must exist for in-IDE consumer');
    assert.ok(fs.existsSync(AGENTS_MD), 'AGENTS.md must point agents at workflow');
    const ruleText = fs.readFileSync(CURSOR_RULE, 'utf8');
    const agentsText = fs.readFileSync(AGENTS_MD, 'utf8');
    for (const item of MANDATORY_F6_REVIEW_SEQUENCE) {
      const needle = item.title.replace(/`/g, '');
      assert.ok(
        ruleText.replace(/`/g, '').includes(needle),
        `Cursor rule missing step: ${item.title}`,
      );
    }
    assert.ok(ruleText.includes('unitStateBrief.exceptions'));
    assert.ok(agentsText.includes('tactical-briefing-ai-workflow.cjs'));
    assert.ok(agentsText.includes('unitStateBrief.exceptions'));
    assert.ok(agentsText.includes('hostile-intelligence-consumer.cjs'));
  });

  it('Stage D relay → mandatory review matches Battleship assessment expectations', () => {
    assert.ok(fs.existsSync(STAGE_D_YAML), `missing harness capture: ${STAGE_D_YAML}`);
    const text = fs.readFileSync(STAGE_D_YAML, 'utf8');
    const tactical = loadAndValidateSnapshotFromText(text, YAML);
    const digest = sha256HexLower(Buffer.from(text, 'utf8'));
    const relay = buildRelayPayload(
      tactical,
      new Date().toISOString(),
      {
        request_id: 'e2e-stage-d',
        session_id: '0fba10174cf6f70f770c6383c0c426b6',
        turn: tactical.turn,
      },
      { snapshotSha256: digest },
    );

    assert.ok(relay.unitStateBrief?.exceptions?.some((e) => e.id === 3 && e.kind === 'mind_controlled_roster_soldier'));
    assert.ok(relay.commandBinding?.player_soldiers?.every((s) => s.id !== 3));

    const review = runMandatoryBattlefieldStatusReview(relay);
    assert.equal(review.sequenceCompleted, true);

    const unit1 = review.unitAssessments.find((u) => u.unitId === 1);
    const unit3 = review.unitAssessments.find((u) => u.unitId === 3);
    assert.ok(unit1, 'Eric Reyes (#1) assessment');
    assert.ok(unit3, 'mind-controlled roster (#3) assessment');
    assert.ok(unit1.heuristics.includes('low_morale'));
    assert.ok(!unit1.confirmed.includes('panicking'));
    assert.ok(unit3.confirmed.includes('mind_control'));
    assert.equal(unit3.commandable, false);
    assert.ok(!review.commandedIds.includes(3));

    const joined = review.tacticalStatusLines.join('\n');
    assert.match(joined, /Eric Reyes \(#1\).*Low morale/i);
    assert.match(joined, /Unit #3.*mind control/i);
    assert.match(joined, /Historical panic: Unknown/i);

    const md = getAiBriefingInstructionsMarkdown();
    assert.ok(md.includes('Virender Shah (#3)'));
    assert.ok(md.includes('Eric Reyes (#1)'));
    assert.match(md, /Mandatory tactical equipment review/);
    assert.match(md, /Hostile intelligence fair-play/);
    assert.match(md, /sessionId/);
    assert.match(md, /Mandatory MOVE result verification/);
    assert.match(md, /runMandatoryPostCommandPrelude/);

    assert.match(md, /Pre-MOVE exposure and reaction fire/);
    assert.match(md, /KNOWN THREAT/);
    assert.match(md, /between movement steps/i);

    const prelude = runMandatoryBriefingPrelude(relay);
    assert.equal(prelude.workflowVersion, 3);
    assert.ok(prelude.equipment.soldiers.length > 0);
  });

  it('post-command prelude gates next command on verified MOVE', () => {
    const command = {
      command_type: 'MOVE',
      command_id: 'wf-move-1',
      destination: { x: 2, y: 2, z: 0 },
    };
    const ok = runMandatoryPostCommandPrelude({
      result: {
        command_type: 'MOVE',
        command_id: 'wf-move-1',
        status: 'COMPLETED',
        final_position: { x: 2, y: 2, z: 0 },
        destination_reached: true,
      },
      command,
    });
    assert.equal(ok.readyForNextCommand, true);
    const bad = runMandatoryPostCommandPrelude({
      result: {
        command_type: 'MOVE',
        command_id: 'wf-move-1',
        status: 'COMPLETED',
        final_position: { x: 1, y: 2, z: 0 },
        destination_reached: true,
      },
      command,
    });
    assert.equal(bad.readyForNextCommand, false);
    const interrupted = runMandatoryPostCommandPrelude({
      result: {
        command_type: 'MOVE',
        command_id: 'wf-move-2',
        status: 'INTERRUPTED',
        final_position: { x: 3, y: 3, z: 0 },
        destination_reached: false,
      },
      command: {
        command_type: 'MOVE',
        command_id: 'wf-move-2',
        destination: { x: 3, y: 3, z: 1 },
      },
    });
    assert.equal(interrupted.readyForNextCommand, false);
    assert.equal(interrupted.mayPublishAfterFreshBinding, true);
  });
});
