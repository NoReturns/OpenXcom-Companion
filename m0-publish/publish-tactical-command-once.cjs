'use strict';

const path = require('node:path');
const { applyRelayEnvFromLocalConfig, tryResolveRelayDefaults } = require('./lib/relay-config.cjs');
applyRelayEnvFromLocalConfig();
const { DEFAULTS, RELAY_CONTENT_PATHS } = require('./lib/github-relay.cjs');
const { loadRelayIsolationConfigFromEnv } = require('./lib/relay-isolation-config.cjs');
const {
  publishTacticalCommandOnce,
  TacticalCommandPublishError,
} = require('./lib/relay-tactical-command-publish.cjs');
const { createGhApiCallLog } = require('./lib/github-api-instrumentation.cjs');

const DEFAULT_LOCAL = path.resolve(__dirname, '../../local/m0/tactical-command-draft.json');

function formatConfiguredRelayLabel() {
  const resolved = tryResolveRelayDefaults();
  return resolved
    ? `${resolved.repo} branch ${resolved.branch}`
    : '(unset — set OPENXCOM_COMPANION_RELAY_REPO or m0-publish/config/relay.local.json)';
}

function usage() {
  console.log(`Usage: node publish-tactical-command-once.cjs [options]

  --dry-run            Validate local command JSON only (default)
  --publish            One-shot GitHub PUT to remote tactical-command inbox (create-only)
  --path               Local tactical-command.json draft (default: ${DEFAULT_LOCAL})
  --isolation-config   Relay isolation JSON (tests); or set COMPANION_RELAY_ISOLATION_CONFIG

Production remote path: ${RELAY_CONTENT_PATHS.tacticalCommand}
Configured relay: ${formatConfiguredRelayLabel()}`);
}

function parseArgs(argv) {
  let publish = false;
  let dryRun = true;
  let localPath = DEFAULT_LOCAL;
  let isolationConfigPath = null;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    if (arg === '--publish') {
      publish = true;
      dryRun = false;
      continue;
    }
    if (arg === '--dry-run') {
      dryRun = true;
      publish = false;
      continue;
    }
    if (arg === '--path') {
      localPath = argv[++i];
      continue;
    }
    if (arg === '--isolation-config') {
      isolationConfigPath = argv[++i];
      continue;
    }
    console.error(`Unknown argument: ${arg}`);
    usage();
    process.exit(2);
  }

  return { publish, dryRun, localPath, isolationConfigPath };
}

async function main() {
  const args = parseArgs(process.argv);
  const apiCallLog = createGhApiCallLog();
  let relayIsolationConfig = null;
  if (args.isolationConfigPath) {
    const { loadRelayIsolationConfig } = require('./lib/relay-isolation-config.cjs');
    relayIsolationConfig = loadRelayIsolationConfig(args.isolationConfigPath);
  } else if (process.env.COMPANION_RELAY_ISOLATION_CONFIG || process.env.COMPANION_M134E_RELAY_ISOLATION_CONFIG) {
    relayIsolationConfig = loadRelayIsolationConfigFromEnv(process.env);
  }

  const outcome = await publishTacticalCommandOnce({
    localPath: args.localPath,
    dryRun: args.dryRun,
    publish: args.publish,
    relayIsolationConfig,
    apiCallLog,
  });

  if (outcome.dryRun) {
    console.log(JSON.stringify({
      ok: true,
      mode: 'dry_run',
      remote_path: outcome.remotePath,
      command_id: outcome.command_id,
      command_type: outcome.command_type,
    }, null, 2));
    return;
  }

  console.log(JSON.stringify({
    ok: true,
    mode: outcome.skipped ? 'skipped' : 'published',
    remote_path: outcome.remotePath,
    command_id: outcome.command_id,
    command_type: outcome.command_type,
    skipped: Boolean(outcome.skipped),
    reason: outcome.reason ?? null,
    github_api_calls: outcome.githubApiCalls,
    github_api_put_success: outcome.github_api_put_success ?? null,
    github_ops: outcome.githubOps,
  }, null, 2));
}

main().catch((error) => {
  const payload = {
    ok: false,
    code: error instanceof TacticalCommandPublishError ? error.code : (error.code || 'publish_failed'),
    message: error.message || String(error),
    remote_command_id: error.remote_command_id ?? undefined,
  };
  console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
});
