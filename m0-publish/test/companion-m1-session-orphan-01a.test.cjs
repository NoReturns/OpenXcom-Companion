'use strict';

/**
 * ASTER-M1-SESSION-ORPHAN-01A/01B — session-transition orphan (command 029 → 032).
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const YAML = require('yaml');

const {
  SESSION_BOUNDARY_PUBLIC_REASON,
  shouldRehydrateOrphanedDirectedFireForSession,
  productionOnBattleCompanionBindingContext,
  productionTryResolveSessionBoundaryOrphan,
  productionTryResolveWhileSameSessionInFlight,
  createEmptyMemory,
  runProductionColdStartSessionBSequence,
  runCorrectedColdStartSessionBSequence,
  runRecoveryOrderingLauncherQuarantineFirst,
  runRecoveryOrderingEngineBindFirst,
} = require('./support/session-orphan-production-lifecycle-model.cjs');

const { evaluateInboxQuarantine } = require('../lib/companion-canonical-runtime.cjs');
const { canAcceptNewCommand } = require('../lib/tactical-command.cjs');
const { CommandRelayWatcher, localRelayPaths } = require('../lib/command-relay-watcher.cjs');
const { loadAndValidateSnapshotFromText } = require('../lib/tactical-publish.cjs');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'session-orphan-incident');
const SESSION_A = '112482ac508d5bc16dcde1470d197d09';
const SESSION_B = 'c2c699950ddc838bfe4b37babc03967f';
const COMMAND_029 = 'aster-20261110-seppe-sectoid-auto-29';
const COMMAND_032 = 'aster-20261110-jolienne-reload-sectoid-32';

function sha256HexLower(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function loadIncidentJson(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
}

function makeCommand032Move(tactical, digest) {
  return {
    schema_version: 1,
    command_id: COMMAND_032,
    command_type: 'MOVE',
    actor_unit_id: 2,
    destination: { x: 3, y: 3, z: 0 },
    snapshot_sha256: digest,
    session_id: tactical.eventLog.sessionId,
    turn: tactical.turn,
    state_version: tactical.eventLog.latestSeq,
  };
}

function applyProductionDiskRecoveryToHarness(harness, disk) {
  const result = {
    ...loadIncidentJson('command-029-result-executing.json'),
    status: disk.resultStatus,
    public_reason: disk.publicReason,
    session_id: disk.resultSessionId,
    command_id: disk.resultCommandId,
  };
  fs.writeFileSync(harness.local.result, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  if (!disk.inboxPresent && fs.existsSync(harness.local.command)) {
    fs.unlinkSync(harness.local.command);
  }
}

function makeRelayHarness() {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'session-orphan-01a-'));
  const snapshotPath = path.join(root, 'tactical-live.yaml');
  const baseYaml = fs.readFileSync(path.join(__dirname, 'fixtures', 'valid-v5.yaml'), 'utf8');
  const snapshotText = baseYaml
    .replace(/^turn: \d+$/m, 'turn: 1')
    .replace(/^selectedUnitId: \d+$/m, 'selectedUnitId: 2')
    .replace(
      /sessionId: [a-f0-9]{32}/,
      `sessionId: ${SESSION_B}`,
    );
  fs.writeFileSync(snapshotPath, snapshotText, 'utf8');
  const tactical = loadAndValidateSnapshotFromText(snapshotText, YAML);
  const digest = sha256HexLower(Buffer.from(snapshotText, 'utf8'));
  assert.equal(tactical.eventLog.sessionId, SESSION_B);

  const stateDir = path.join(root, 'state');
  const local = localRelayPaths(snapshotPath);
  const watcher = new CommandRelayWatcher({
    snapshotPath,
    stateDir,
    dryRun: true,
    pollIntervalMs: 5,
    log: () => {},
    readRemoteCommand: async () => watcher._remoteCommand,
    publishRemoteResult: async () => {},
    fetchRemoteResult: async () => null,
    readFileSync: fs.readFileSync,
    existsSync: fs.existsSync,
    writeFileSync: fs.writeFileSync,
    renameSync: fs.renameSync,
    unlinkSync: fs.unlinkSync,
  });
  watcher._remoteCommand = null;

  return {
    root,
    snapshotPath,
    tactical,
    digest,
    local,
    watcher,
    seed029Executing() {
      const inbox = loadIncidentJson('command-029-inbox.json');
      const result = loadIncidentJson('command-029-result-executing.json');
      fs.writeFileSync(local.command, `${JSON.stringify(inbox, null, 2)}\n`, 'utf8');
      fs.writeFileSync(local.result, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    },
    setRemote032() {
      const cmd = makeCommand032Move(tactical, digest);
      watcher._remoteCommand = {
        text: `${JSON.stringify(cmd, null, 2)}\n`,
        sha: sha256HexLower(JSON.stringify(cmd)),
      };
    },
  };
}

describe('ASTER-M1-SESSION-ORPHAN — mechanism (01B production mirror)', () => {
  it('029 inbox/session binding does not match Session B (rehydrate blocked)', () => {
    assert.equal(
      shouldRehydrateOrphanedDirectedFireForSession(SESSION_B, SESSION_A, SESSION_A),
      false,
    );
  });

  it('cold start: binding recovers cross-session EXECUTING orphan without prior bound context', () => {
    const memory = createEmptyMemory();
    assert.equal(memory.boundSessionId, '');
    const effects = productionOnBattleCompanionBindingContext(memory, SESSION_B, 'tactical-b');
    assert.equal(effects.contextChanged, false);
    assert.equal(effects.recoveredOnBind, true);
    assert.equal(memory.disk.resultStatus, 'INTERRUPTED');
    assert.equal(memory.disk.inboxPresent, false);
    assert.equal(memory.disk.publicReason, SESSION_BOUNDARY_PUBLIC_REASON);
  });

  it('interruptInFlightForBindingReset is no-op when g_active.inFlight is false (recovery is separate)', () => {
    const memory = createEmptyMemory();
    memory.g_activeInFlight = false;
    const effects = productionOnBattleCompanionBindingContext(memory, SESSION_B, 'tactical-b');
    assert.equal(effects.interruptedInFlight, false);
    assert.equal(memory.disk.resultStatus, 'INTERRUPTED');
  });

  it('warm transition archives stale inbox when prior bound session existed', () => {
    const memory = createEmptyMemory();
    memory.boundSessionId = SESSION_A;
    memory.boundTacticalBattleId = 'prior-tactical-id';
    memory.disk = {
      ...memory.disk,
      resultStatus: 'COMPLETED',
      inboxPresent: true,
      inboxSessionId: SESSION_A,
    };
    const effects = productionOnBattleCompanionBindingContext(memory, SESSION_B, 'tactical-b');
    assert.equal(effects.contextChanged, true);
    assert.equal(effects.inboxArchived, true);
    assert.equal(memory.disk.inboxPresent, false);
  });

  it('launcher quarantine: cross-session matching EXECUTING pair is not safe to resume', () => {
    const inbox = loadIncidentJson('command-029-inbox.json');
    const decision = evaluateInboxQuarantine({
      inboxExists: true,
      resultExists: true,
      resultStatus: 'EXECUTING',
      resultParseError: false,
      inboxValue: inbox,
      resultCommandId: COMMAND_029,
      snapshotBinding: {
        sessionId: SESSION_B,
        snapshotSha256: '223b701f353ebcaa309ece7a0be8a23fac33148b5a095dcc2f23fa11ee6cf',
        turn: 1,
        stateVersion: 0,
      },
    });
    assert.equal(decision.action, 'quarantine');
    assert.equal(decision.reason, 'stale_session_executing_orphan');
  });

  it('launcher: same-session matching EXECUTING pair still warns (engine may resume)', () => {
    const commandId = 'a7f0e2d51c9b4f8da65b30c192e74f06';
    const session = 'c2c699950ddc838bfe4b37babc03967f';
    const decision = evaluateInboxQuarantine({
      inboxExists: true,
      resultExists: true,
      resultStatus: 'EXECUTING',
      resultParseError: false,
      inboxValue: { command_id: commandId, session_id: session },
      resultCommandId: commandId,
      snapshotBinding: {
        sessionId: session,
        snapshotSha256: 'ab'.repeat(32),
        turn: 1,
        stateVersion: 0,
      },
    });
    assert.equal(decision.action, 'warn');
    assert.equal(decision.reason, 'orphan_executing_resume');
  });

  it('ambiguous session identity blocks launch instead of quarantining', () => {
    const decision = evaluateInboxQuarantine({
      inboxExists: true,
      resultExists: true,
      resultStatus: 'EXECUTING',
      resultParseError: false,
      inboxValue: { command_id: COMMAND_029, session_id: SESSION_A },
      resultCommandId: COMMAND_029,
      snapshotBinding: null,
    });
    assert.equal(decision.action, 'block_launch');
    assert.equal(decision.reason, 'ambiguous_session_identity');
  });

  it('boundary resolver terminalizes disk-only orphan on tick (idempotent)', () => {
    const memory = createEmptyMemory();
    const resolved = productionTryResolveSessionBoundaryOrphan(memory, SESSION_B);
    assert.equal(resolved, true);
    assert.equal(memory.disk.resultStatus, 'INTERRUPTED');
    assert.match(memory.disk.publicReason, /session changed/i);
    assert.equal(memory.disk.commandFired, false);
    const again = productionTryResolveSessionBoundaryOrphan(memory, SESSION_B);
    assert.equal(again, false);
  });

  it('same-session genuine in-flight must not be session-boundary interrupted', () => {
    const memory = createEmptyMemory();
    memory.g_activeInFlight = true;
    memory.g_activeCommandId = memory.disk.resultCommandId;
    memory.activeCommandSessionId = SESSION_B;
    memory.disk.inboxSessionId = SESSION_B;
    memory.disk.resultSessionId = SESSION_B;
    assert.equal(productionTryResolveSessionBoundaryOrphan(memory, SESSION_B), false);
    assert.equal(productionTryResolveWhileSameSessionInFlight(memory, SESSION_B), true);
    assert.equal(memory.disk.resultStatus, 'EXECUTING');
  });

  it('disk-only EXECUTING closes on binding without companion tick', () => {
    const outcome = runProductionColdStartSessionBSequence({ tickCount: 0 });
    assert.equal(outcome.disk.resultStatus, 'INTERRUPTED');
    assert.equal(outcome.disk.inboxPresent, false);
    assert.equal(outcome.launchDecision.action, 'quarantine');
    const binding = outcome.trace.find((e) => e.phase === 'binding_context');
    assert.equal(binding.recoveredOnBind, true);
  });
});

describe('ASTER-M1-SESSION-ORPHAN-01B — recovery ordering (launcher vs engine)', () => {
  it('launcher quarantine first: 029 becomes INTERRUPTED and 032 can deliver', async () => {
    const outcome = runRecoveryOrderingLauncherQuarantineFirst();
    assert.equal(outcome.launchDecision.action, 'quarantine');
    assert.equal(outcome.disk.inboxQuarantined, true);
    assert.equal(outcome.disk.inboxPresent, false);
    assert.equal(outcome.bindingEffects.recoveredOnBind, true);
    assert.equal(outcome.disk.resultStatus, 'INTERRUPTED');
    assert.equal(outcome.disk.commandFired, false);
    assert.equal(outcome.disk.publicReason, SESSION_BOUNDARY_PUBLIC_REASON);

    const harness = makeRelayHarness();
    harness.seed029Executing();
    harness.setRemote032();
    applyProductionDiskRecoveryToHarness(harness, outcome.disk);
    await harness.watcher._pollOnce();
    assert.ok(fs.existsSync(harness.local.command));
    assert.equal(JSON.parse(fs.readFileSync(harness.local.command, 'utf8')).command_id, COMMAND_032);
  });

  it('engine bind first: 029 becomes INTERRUPTED and 032 can deliver', async () => {
    const outcome = runRecoveryOrderingEngineBindFirst();
    assert.equal(outcome.bindingEffects.recoveredOnBind, true);
    assert.equal(outcome.disk.resultStatus, 'INTERRUPTED');
    assert.equal(outcome.disk.inboxPresent, false);
    assert.notEqual(outcome.launchDecision.action, 'warn');
    assert.equal(outcome.disk.commandFired, false);

    const harness = makeRelayHarness();
    harness.seed029Executing();
    harness.setRemote032();
    applyProductionDiskRecoveryToHarness(harness, outcome.disk);
    await harness.watcher._pollOnce();
    assert.equal(JSON.parse(fs.readFileSync(harness.local.command, 'utf8')).command_id, COMMAND_032);
  });
});

describe('ASTER-M1-SESSION-ORPHAN-01B — incident regression (029 → 032)', () => {
  it('cold-start Session B entry terminalizes Session A disk orphan', () => {
    const production = runProductionColdStartSessionBSequence({ tickCount: 0 });
    assert.equal(production.disk.resultStatus, 'INTERRUPTED');
    assert.equal(production.disk.inboxPresent, false);
    assert.equal(production.disk.publicReason, SESSION_BOUNDARY_PUBLIC_REASON);
  });

  it('launcher quarantines stale-session EXECUTING orphan at cold start', () => {
    const production = runProductionColdStartSessionBSequence({ tickCount: 0 });
    assert.equal(production.launchDecision.action, 'quarantine');
    assert.equal(production.launchDecision.reason, 'stale_session_executing_orphan');
  });

  it('relay delivers command 032 after production lifecycle recovery', async () => {
    const harness = makeRelayHarness();
    harness.seed029Executing();
    harness.setRemote032();
    const production = runProductionColdStartSessionBSequence({ tickCount: 0 });
    applyProductionDiskRecoveryToHarness(harness, production.disk);
    assert.equal(canAcceptNewCommand(production.disk.resultStatus), true);
    await harness.watcher._pollOnce();
    assert.ok(fs.existsSync(harness.local.command));
    const localCommand = JSON.parse(fs.readFileSync(harness.local.command, 'utf8'));
    assert.equal(localCommand.command_id, COMMAND_032);
  });

  it('recovery idempotency across repeated binding and ticks', () => {
    const first = runProductionColdStartSessionBSequence({ tickCount: 5 });
    const memory = first.memory;
    for (let i = 0; i < 3; i += 1) {
      productionOnBattleCompanionBindingContext(memory, SESSION_B, 'tactical-b');
      const tick = productionTryResolveSessionBoundaryOrphan(memory, SESSION_B);
      assert.equal(tick, false);
      assert.equal(memory.disk.resultStatus, 'INTERRUPTED');
    }
  });
});

describe('ASTER-M1-SESSION-ORPHAN — sidecar relay (current production)', () => {
  let harness;

  beforeEach(() => {
    harness = makeRelayHarness();
  });

  it('blocks delivery of command 032 while local 029 is EXECUTING', async () => {
    harness.seed029Executing();
    harness.setRemote032();
    await harness.watcher._pollOnce();
    const localCommand = JSON.parse(fs.readFileSync(harness.local.command, 'utf8'));
    const localResult = JSON.parse(fs.readFileSync(harness.local.result, 'utf8'));
    assert.equal(localCommand.command_id, COMMAND_029);
    assert.equal(localResult.status, 'EXECUTING');
    assert.equal(localResult.command_id, COMMAND_029);
  });

  it('after production recovery state, one poll delivers command 032', async () => {
    harness.seed029Executing();
    harness.setRemote032();
    const production = runProductionColdStartSessionBSequence({ tickCount: 0 });
    applyProductionDiskRecoveryToHarness(harness, production.disk);
    await harness.watcher._pollOnce();
    assert.ok(fs.existsSync(harness.local.command));
    const localCommand = JSON.parse(fs.readFileSync(harness.local.command, 'utf8'));
    assert.equal(localCommand.command_id, COMMAND_032);
  });
});

describe('ASTER-M1-SESSION-ORPHAN — evidence fixture integrity', () => {
  it('preserved incident inbox/result bindings match RCA manifest', () => {
    const inbox = loadIncidentJson('command-029-inbox.json');
    const result = loadIncidentJson('command-029-result-executing.json');
    assert.equal(inbox.command_id, COMMAND_029);
    assert.equal(inbox.session_id, SESSION_A);
    assert.equal(result.status, 'EXECUTING');
    assert.equal(result.session_id, SESSION_A);
    assert.equal(inbox.command_id, result.command_id);
  });
});
