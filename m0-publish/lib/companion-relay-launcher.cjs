'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createSupervisorNotifyBridge } = require('./companion-relay-notify.cjs');
const YAML = require('yaml');
const {
  RELAY_CONTENT_PATHS,
  DEFAULT_COMMAND_MAX_BYTES,
  DEFAULT_RESULT_MAX_BYTES,
  checkGhAuthReadiness,
  createRelayContentClient,
} = require('./github-relay.cjs');
const { tryResolveRelayDefaults: tryRelayConfig } = require('./relay-config.cjs');
const { localRelayPaths } = require('./command-relay-watcher.cjs');
const {
  loadCommandJournal,
  isTerminalRelayRecord,
  getCommandRecord,
} = require('./command-journal.cjs');
const {
  parseTacticalCommand,
  validateTacticalCommandAgainstSnapshotFile,
  isTerminalStatus,
  canAcceptNewCommand,
} = require('./tactical-command.cjs');
const { loadAndValidateSnapshotFromText } = require('./tactical-publish.cjs');
const { readSnapshotByteBuffer, sha256HexLower } = require('./briefing-snapshot.cjs');
const { execFileSyncHidden } = require('./exec-file-sync.cjs');

const DEFAULT_LIVE_SNAPSHOT = path.resolve(__dirname, '../../../local/m0/tactical-live.yaml');
const DEFAULT_BRIEFING_STATE_DIR = path.resolve(__dirname, '../.briefing-sidecar-state');
const DEFAULT_COMMAND_RELAY_STATE_DIR = path.resolve(__dirname, '../.command-relay-sidecar-state');
const PUBLISH_ONCE = path.resolve(__dirname, '../publish-tactical-once.cjs');

const MODES = {
  PREFLIGHT: 'preflight',
  OUTBOUND: 'outbound',
  FULL: 'full',
};

function resolveSnapshotPath(env = process.env) {
  const fromEnv = env.OPENXCOM_COMPANION_SNAPSHOT_PATH;
  if (fromEnv && String(fromEnv).trim()) {
    return path.resolve(String(fromEnv).trim());
  }
  return DEFAULT_LIVE_SNAPSHOT;
}

function resolvePaths(snapshotPath) {
  const snapshotDir = path.dirname(snapshotPath);
  const local = localRelayPaths(snapshotPath);
  return {
    snapshotPath,
    snapshotDir,
    briefingRequest: path.join(snapshotDir, 'briefing-request.json'),
    briefingAck: path.join(snapshotDir, 'briefing-ack.json'),
    engineCommandJournal: path.join(snapshotDir, 'tactical-command-journal.json'),
    localCommand: local.command,
    localResult: local.result,
    briefingStateDir: DEFAULT_BRIEFING_STATE_DIR,
    commandRelayStateDir: DEFAULT_COMMAND_RELAY_STATE_DIR,
    publishOnce: PUBLISH_ONCE,
    relayRepo: (tryRelayConfig() || {}).repo ?? '(not configured)',
    relayBranch: (tryRelayConfig() || {}).branch ?? 'main',
  };
}

function checkRelayConfig(env = process.env) {
  const resolved = tryRelayConfig(env);
  if (!resolved) {
    return {
      ok: false,
      message:
        'GitHub relay repo not configured. Set OPENXCOM_COMPANION_RELAY_REPO=owner/name '
        + 'or create m0-publish/config/relay.local.json from relay.local.example.json.',
    };
  }
  return {
    ok: true,
    repo: resolved.repo,
    branch: resolved.branch,
    source: resolved.configSource,
    message: `Relay destination: ${resolved.repo}@${resolved.branch} (${resolved.configSource}).`,
  };
}

function checkNodeRuntime(deps = {}) {
  const version = deps.processVersion ?? process.version;
  const major = Number.parseInt(String(version).replace(/^v/, '').split('.')[0], 10);
  return {
    ok: Number.isFinite(major) && major >= 22,
    version,
    required: '>=22',
  };
}

function checkGh(deps = {}) {
  const checkFn = deps.checkGhAuth ?? checkGhAuthReadiness;
  try {
    const ok = checkFn(deps.ghApiExec);
    return { ok, message: ok ? 'GitHub CLI authenticated.' : 'GitHub CLI not authenticated (run gh auth login).' };
  } catch (error) {
    return { ok: false, message: error.message || String(error) };
  }
}

function readJsonIfExists(filePath, existsSync = fs.existsSync, readFileSync = fs.readFileSync) {
  if (!existsSync(filePath)) {
    return { exists: false, value: null, parseError: false };
  }
  try {
    return { exists: true, value: JSON.parse(readFileSync(filePath, 'utf8')), parseError: false };
  } catch {
    return { exists: true, value: null, parseError: true };
  }
}

function inspectLocalState(paths, io = {}) {
  const existsSync = io.existsSync ?? fs.existsSync;
  const readFileSync = io.readFileSync ?? fs.readFileSync;
  const statSync = io.statSync ?? fs.statSync;

  const snapshot = {
    path: paths.snapshotPath,
    exists: existsSync(paths.snapshotPath),
    sizeBytes: null,
  };
  if (snapshot.exists) {
    try {
      snapshot.sizeBytes = statSync(paths.snapshotPath).size;
    } catch {
      snapshot.sizeBytes = null;
    }
  }

  const command = readJsonIfExists(paths.localCommand, existsSync, readFileSync);
  const result = readJsonIfExists(paths.localResult, existsSync, readFileSync);
  const engineJournal = readJsonIfExists(paths.engineCommandJournal, existsSync, readFileSync);

  let sidecarJournal = { exists: false, value: null, parseError: false, active: null };
  try {
    const journal = loadCommandJournal(paths.commandRelayStateDir, readFileSync, existsSync);
    sidecarJournal = { exists: existsSync(paths.commandRelayStateDir), value: journal, parseError: false, active: journal.active };
  } catch {
    sidecarJournal = { exists: existsSync(paths.commandRelayStateDir), value: null, parseError: true, active: null };
  }

  const openLocalStatus = result.value && typeof result.value.status === 'string'
    ? result.value.status
    : null;

  return {
    snapshot,
    command,
    result,
    engineJournal,
    sidecarJournal,
    openLocalStatus,
    canAcceptNewLocalCommand: canAcceptNewCommand(openLocalStatus),
  };
}

async function inspectRemoteCommand(paths, deps = {}) {
  const content = deps.contentClient ?? createRelayContentClient(deps.relayOptions);
  const readFile = deps.readRemoteFile
    ?? ((p, max) => Promise.resolve(content.readFile(p, max)));

  let remoteCommand = null;
  let remoteResult = null;
  let readErrors = [];

  try {
    remoteCommand = await readFile(RELAY_CONTENT_PATHS.tacticalCommand, DEFAULT_COMMAND_MAX_BYTES);
  } catch (error) {
    readErrors.push(`command: ${error.message || String(error)}`);
  }
  try {
    remoteResult = await readFile(RELAY_CONTENT_PATHS.tacticalResult, DEFAULT_RESULT_MAX_BYTES);
  } catch (error) {
    readErrors.push(`result: ${error.message || String(error)}`);
  }

  let parsedCommand = null;
  let commandParseError = null;
  if (remoteCommand && remoteCommand.text) {
    try {
      parsedCommand = JSON.parse(remoteCommand.text);
    } catch (error) {
      commandParseError = error.message || String(error);
    }
  }

  let parsedResult = null;
  let resultParseError = null;
  if (remoteResult && remoteResult.text) {
    try {
      parsedResult = JSON.parse(remoteResult.text);
    } catch (error) {
      resultParseError = error.message || String(error);
    }
  }

  return {
    remoteCommand,
    remoteResult,
    parsedCommand,
    parsedResult,
    commandParseError,
    resultParseError,
    readErrors,
  };
}

function validateRemoteAgainstSnapshot(parsedCommand, snapshotPath, io = {}) {
  if (!parsedCommand || !snapshotPath) {
    return { valid: false, reason: 'missing_command_or_snapshot' };
  }
  const existsSync = io.existsSync ?? fs.existsSync;
  const readFileSync = io.readFileSync ?? fs.readFileSync;
  if (!existsSync(snapshotPath)) {
    return { valid: false, reason: 'snapshot_missing' };
  }
  try {
    parseTacticalCommand(parsedCommand);
    validateTacticalCommandAgainstSnapshotFile(parsedCommand, snapshotPath, YAML, readFileSync);
    return { valid: true, reason: null };
  } catch (error) {
    return { valid: false, reason: error.message || String(error) };
  }
}

function assessInboundDeliverySafety(local, remote, paths, io = {}) {
  const blockers = [];
  const warnings = [];

  if (remote.readErrors.length > 0) {
    blockers.push(`Remote relay read failed: ${remote.readErrors.join('; ')}`);
  }

  const hasRemoteCommand = Boolean(remote.remoteCommand && remote.remoteCommand.text);
  if (!hasRemoteCommand) {
    if (!local.canAcceptNewLocalCommand) {
      blockers.push(`Local tactical-result.json status ${local.openLocalStatus} is not terminal; inbound delivery blocked.`);
    }
    return { safe: blockers.length === 0, blockers, warnings, unresolved: false };
  }

  if (remote.commandParseError) {
    blockers.push(`Remote tactical-command.json is not valid JSON: ${remote.commandParseError}`);
  }

  if (!local.canAcceptNewLocalCommand) {
    blockers.push(`Local tactical-result.json status ${local.openLocalStatus} is not terminal; inbound delivery blocked.`);
  }

  const commandId = remote.parsedCommand && remote.parsedCommand.command_id
    ? remote.parsedCommand.command_id
    : null;

  if (local.sidecarJournal.active && local.sidecarJournal.active.command_id) {
    blockers.push(`Sidecar journal active command ${local.sidecarJournal.active.command_id.slice(0, 8)}… (inbound delivery in progress).`);
  }

  if (local.command.exists && !local.command.parseError && local.command.value) {
    const localId = local.command.value.command_id;
    if (!commandId || localId !== commandId) {
      warnings.push('Local tactical-command.json exists and may differ from remote (engine inbox not empty).');
    }
  }

  if (commandId) {
    const record = local.sidecarJournal.value
      ? getCommandRecord(local.sidecarJournal.value, commandId)
      : null;

    const remoteResultId = remote.parsedResult && remote.parsedResult.command_id;
    const remoteResultStatus = remote.parsedResult && remote.parsedResult.status;
    const remoteTerminal = remoteResultStatus && isTerminalStatus(remoteResultStatus);

    if (isTerminalRelayRecord(record)) {
      warnings.push(`Sidecar journal terminal for command ${commandId.slice(0, 8)}…; inbound replay suppressed.`);
    } else if (remoteTerminal && remoteResultId === commandId) {
      blockers.push(
        `Remote command ${commandId.slice(0, 8)}… still on GitHub with terminal result but sidecar journal is not terminal (relay may redeliver to engine inbox).`,
      );
    } else if (!remoteTerminal) {
      blockers.push(`Remote command ${commandId.slice(0, 8)}… has no matching terminal result on GitHub.`);
    } else if (remoteResultId !== commandId) {
      blockers.push('Remote tactical-result.json command_id does not match remote command.');
    }

    if (record && !isTerminalRelayRecord(record)) {
      blockers.push(`Sidecar journal has non-terminal record for command ${commandId.slice(0, 8)}… (phase ${record.phase || 'unknown'}).`);
    }
  }

  const validation = validateRemoteAgainstSnapshot(remote.parsedCommand, paths.snapshotPath, io);
  if (hasRemoteCommand && remote.parsedCommand && !validation.valid) {
    blockers.push(`Remote command fails snapshot binding validation: ${validation.reason}`);
  }

  const unresolved = hasRemoteCommand && blockers.length > 0;
  return { safe: blockers.length === 0, blockers, warnings, unresolved };
}

function detectRunningSidecars(deps = {}) {
  const listFn = deps.listProcesses ?? defaultListProcesses;
  const processes = listFn();
  const matches = [];
  for (const proc of processes) {
    const cmd = proc.commandLine || '';
    if (!cmd.includes('publish-tactical-once.cjs')) {
      continue;
    }
    let kind = 'unknown';
    if (cmd.includes('--briefing-watch')) {
      kind = 'briefing';
    } else if (cmd.includes('--command-relay-watch')) {
      kind = 'command-relay';
    }
    matches.push({ pid: proc.pid, kind, commandLine: cmd });
  }
  return matches;
}

function defaultListProcesses() {
  if (process.platform !== 'win32') {
    return [];
  }
  try {
    const script = 'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*publish-tactical-once.cjs*" } | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress';
    const out = execFileSyncHidden('powershell.exe', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (!out) {
      return [];
    }
    const parsed = JSON.parse(out);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows
      .filter((row) => row && row.ProcessId)
      .map((row) => ({ pid: row.ProcessId, commandLine: row.CommandLine || '' }));
  } catch {
    return [];
  }
}

async function runPreflight(options = {}) {
  const snapshotPath = options.snapshotPath ?? resolveSnapshotPath(options.env);
  const paths = resolvePaths(snapshotPath);
  const node = checkNodeRuntime(options);
  const gh = checkGh(options);
  const relay = checkRelayConfig(options.env);

  const local = inspectLocalState(paths, options.io);
  let remote;
  if (relay.ok) {
    remote = await inspectRemoteCommand(paths, options);
  } else {
    remote = {
      remoteCommand: null,
      remoteResult: null,
      parsedCommand: null,
      parsedResult: null,
      commandParseError: null,
      resultParseError: null,
      readErrors: [relay.message],
    };
  }
  const inbound = assessInboundDeliverySafety(local, remote, paths, options.io);
  const running = detectRunningSidecars(options);

  const snapshotOk = local.snapshot.exists;
  const ghOkForPublish = gh.ok;
  const relayOk = relay.ok;
  const readyOutbound = node.ok && snapshotOk && ghOkForPublish && relayOk;
  const readyFull = readyOutbound && inbound.safe;

  return {
    mode: MODES.PREFLIGHT,
    paths,
    node,
    gh,
    relay,
    local,
    remote: {
      hasCommand: Boolean(remote.remoteCommand && remote.remoteCommand.text),
      hasResult: Boolean(remote.remoteResult && remote.remoteResult.text),
      commandId: remote.parsedCommand && remote.parsedCommand.command_id,
      resultStatus: remote.parsedResult && remote.parsedResult.status,
      commandParseError: remote.commandParseError,
      resultParseError: remote.resultParseError,
      readErrors: remote.readErrors,
    },
    inbound,
    runningSidecars: running,
    ready: {
      outbound: readyOutbound,
      full: readyFull,
    },
  };
}

function formatPreflightReport(report) {
  const lines = [];
  lines.push('Companion relay preflight (read-only)');
  lines.push(`Snapshot: ${report.paths.snapshotPath} (${report.local.snapshot.exists ? 'present' : 'MISSING'})`);
  lines.push(`Node: ${report.node.version} (${report.node.ok ? 'ok' : `need ${report.node.required}`})`);
  lines.push(`GitHub: ${report.gh.message}`);
  lines.push(report.relay?.message ?? 'Relay: (missing relay check)');
  lines.push(`Local result status: ${report.local.openLocalStatus ?? '(none)'}`);
  lines.push(`Inbound delivery safe: ${report.inbound.safe ? 'yes' : 'NO'}`);
  for (const b of report.inbound.blockers) {
    lines.push(`  blocker: ${b}`);
  }
  for (const w of report.inbound.warnings) {
    lines.push(`  warning: ${w}`);
  }
  if (report.remote.hasCommand) {
    lines.push(`Remote command: ${report.remote.commandId ?? '(unparsed)'} sha ${report.remote.remoteCommand?.sha?.slice(0, 8) ?? '?'}`);
  } else {
    lines.push('Remote command: (none or empty)');
  }
  if (report.runningSidecars.length > 0) {
    lines.push(`Running sidecars: ${report.runningSidecars.map((p) => `${p.kind} pid ${p.pid}`).join(', ')}`);
  } else {
    lines.push('Running sidecars: none detected');
  }
  lines.push(`Ready outbound briefing: ${report.ready.outbound ? 'yes' : 'no'}`);
  lines.push(`Ready full bidirectional relay: ${report.ready.full ? 'yes' : 'no'}`);
  return lines.join('\n');
}

function buildSidecarArgs(mode, paths, dryRun = false) {
  const publishFlag = dryRun ? '--dry-run' : '--publish';
  const base = [paths.publishOnce, publishFlag, '--path', paths.snapshotPath];
  if (mode === MODES.OUTBOUND || mode === 'outbound') {
    return [...base, '--request-path', paths.briefingRequest, '--briefing-watch'];
  }
  if (mode === MODES.FULL || mode === 'full') {
    return [...base, '--command-relay-watch'];
  }
  throw new Error(`Unknown sidecar mode: ${mode}`);
}

function prefixLines(channel, chunk, write) {
  const text = chunk.toString();
  for (const line of text.split(/\r?\n/)) {
    if (line.length > 0) {
      write(`[${channel}] ${line}\n`);
    }
  }
}

function spawnSidecarProcess(mode, paths, options = {}) {
  const args = buildSidecarArgs(mode, paths, options.dryRun);
  const nodeExec = options.nodeExec ?? process.execPath;
  const channel = mode === MODES.OUTBOUND || mode === 'outbound' ? 'briefing' : 'command-relay';
  const logWrite = options.logWrite ?? ((line) => process.stdout.write(line));
  const bridge = options.notifyBridge ?? createSupervisorNotifyBridge({
    writeConsole: (line) => logWrite(`${line}\n`),
  });
  const sidecarEnv = {
    ...(options.env ?? process.env),
    COMPANION_RELAY_STRUCTURED_NOTIFY: '1',
  };
  const child = spawn(nodeExec, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: sidecarEnv,
    windowsHide: true,
  });
  const onChunk = bridge.wrapSidecarLogWrite(channel, logWrite);
  child.stdout.on('data', onChunk);
  child.stderr.on('data', onChunk);
  return { child, channel, args, notifyBridge: bridge };
}

async function startRelaySupervisor(startMode, options = {}) {
  const snapshotPath = options.snapshotPath ?? resolveSnapshotPath(options.env);
  const paths = resolvePaths(snapshotPath);
  const preflight = await runPreflight({ ...options, snapshotPath });
  const children = [];
  const errors = [];

  if (!preflight.node.ok) {
    throw new Error(`Node ${preflight.node.version} does not satisfy ${preflight.node.required}`);
  }
  if (!preflight.local.snapshot.exists) {
    throw new Error(`Snapshot not found: ${paths.snapshotPath}`);
  }
  if (!preflight.gh.ok && !options.dryRun) {
    throw new Error(preflight.gh.message);
  }
  if (!preflight.relay.ok && !options.dryRun) {
    throw new Error(preflight.relay.message);
  }

  if (startMode === MODES.FULL || startMode === 'full') {
    if (!options.acknowledgeInboundRisk && !preflight.inbound.safe) {
      const err = new Error('Full relay blocked: unresolved inbound command state. Re-run preflight and pass acknowledge flag after operator review.');
      err.code = 'INBOUND_UNSAFE';
      err.blockers = preflight.inbound.blockers;
      throw err;
    }
  }

  const notifyBridge = createSupervisorNotifyBridge({
    writeConsole: (line) => (options.logWrite ?? ((l) => process.stdout.write(l)))(`${line}\n`),
  });

  const modesToStart = [];
  if (startMode === MODES.OUTBOUND || startMode === 'outbound') {
    modesToStart.push(MODES.OUTBOUND);
  } else if (startMode === MODES.FULL || startMode === 'full') {
    modesToStart.push(MODES.OUTBOUND, MODES.FULL);
  } else {
    throw new Error(`Unknown start mode: ${startMode}`);
  }

  for (const mode of modesToStart) {
    try {
      const spawnFn = options.spawnSidecarProcess ?? spawnSidecarProcess;
      children.push(spawnFn(mode, paths, { ...options, notifyBridge }));
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length > 0) {
    for (const { child } of children) {
      child.kill('SIGTERM');
    }
    throw errors[0];
  }

  return { preflight, children, paths, notifyBridge };
}

function shutdownSupervisor(children, signal = 'SIGTERM') {
  for (const { child } of children) {
    if (!child.killed) {
      child.kill(signal);
    }
  }
}

module.exports = {
  MODES,
  DEFAULT_LIVE_SNAPSHOT,
  DEFAULT_BRIEFING_STATE_DIR,
  DEFAULT_COMMAND_RELAY_STATE_DIR,
  resolveSnapshotPath,
  resolvePaths,
  checkNodeRuntime,
  checkGh,
  inspectLocalState,
  inspectRemoteCommand,
  validateRemoteAgainstSnapshot,
  assessInboundDeliverySafety,
  detectRunningSidecars,
  runPreflight,
  formatPreflightReport,
  buildSidecarArgs,
  spawnSidecarProcess,
  startRelaySupervisor,
  shutdownSupervisor,
  prefixLines,
};
