'use strict';

const path = require('node:path');
const { DEFAULTS, RELAY_CONTENT_PATHS } = require('./lib/github-relay.cjs');
const { loadRelayIsolationConfigFromEnv } = require('./lib/relay-isolation-config.cjs');
const { publishRulesReferenceOnce, RulesReferenceRelayError } = require('./lib/rules-reference-relay-publish.cjs');
const { createGhApiCallLog } = require('./lib/github-api-instrumentation.cjs');

const DEFAULT_LOCAL = path.resolve(__dirname, '../../local/m0/companion-rules-reference.json');

function usage() {
  console.log(`Usage: node publish-rules-reference-once.cjs [options]

  --dry-run            Validate local artifact and envelope only (default)
  --publish            One-shot GitHub PUT to remote rules reference path
  --path               Local companion-rules-reference.json (default: ${DEFAULT_LOCAL})
  --expect-campaign-id Optional 32-hex campaign guard before publish
  --isolation-config   Relay isolation JSON (tests); or set COMPANION_RELAY_ISOLATION_CONFIG

Production remote path: ${RELAY_CONTENT_PATHS.rulesReference}
Production repo: ${DEFAULTS.repo} branch ${DEFAULTS.branch}`);
}

function parseArgs(argv) {
  let publish = false;
  let dryRun = true;
  let localPath = DEFAULT_LOCAL;
  let expectCampaignId = null;
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
    if (arg === '--expect-campaign-id') {
      expectCampaignId = argv[++i];
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

  return { publish, dryRun, localPath, expectCampaignId, isolationConfigPath };
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

  const outcome = await publishRulesReferenceOnce({
    localPath: args.localPath,
    expectCampaignId: args.expectCampaignId,
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
      campaign_id: outcome.summary.campaignId,
      content_revision_sha256: outcome.summary.contentRevisionSha256,
      item_count: outcome.summary.itemCount,
    }, null, 2));
    return;
  }

  console.log(JSON.stringify({
    ok: true,
    mode: 'published',
    remote_path: outcome.remotePath,
    campaign_id: outcome.summary.campaignId,
    content_revision_sha256: outcome.summary.contentRevisionSha256,
    github_api_calls: outcome.githubApiCalls,
    marker_path: outcome.markerPath,
  }, null, 2));
}

main().catch((error) => {
  const payload = {
    ok: false,
    code: error instanceof RulesReferenceRelayError ? error.code : (error.code || 'publish_failed'),
    message: error.message || String(error),
  };
  console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
});
