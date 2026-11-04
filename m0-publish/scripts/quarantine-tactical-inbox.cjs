'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  companionRuntimeLayout,
  parseJsonFileIfExists,
  evaluateInboxQuarantine,
  readSnapshotExportBinding,
  sha256FileHex,
} = require('../lib/companion-canonical-runtime.cjs');

function formatQuarantineName(iso) {
  return iso.replace(/[:.]/g, '').replace('T', '-').replace('Z', 'z');
}

function main() {
  const layout = companionRuntimeLayout();
  const inbox = parseJsonFileIfExists(layout.tacticalCommand);
  const result = parseJsonFileIfExists(layout.tacticalResult);

  const decision = evaluateInboxQuarantine({
    inboxExists: inbox.exists,
    resultExists: result.exists,
    resultStatus: result.value && result.value.status,
    resultParseError: result.parseError,
    inboxValue: inbox.value,
    snapshotBinding: readSnapshotExportBinding(
      layout.snapshotYaml,
      fs.readFileSync,
      fs.existsSync,
      sha256FileHex,
    ),
  });

  if (decision.action === 'none') {
    console.log(JSON.stringify({ ok: true, decision, quarantined: false }));
    return 0;
  }
  if (decision.action === 'warn') {
    console.log(JSON.stringify({ ok: true, decision, quarantined: false }));
    return 0;
  }
  if (decision.action === 'block_launch') {
    console.error(JSON.stringify({ ok: false, decision }));
    return 2;
  }

  fs.mkdirSync(layout.tacticalBackupsDir, { recursive: true });
  const stamp = formatQuarantineName(new Date().toISOString());
  const commandId = inbox.value && inbox.value.command_id ? inbox.value.command_id : 'unknown';
  const dest = path.join(
    layout.tacticalBackupsDir,
    `tactical-command.quarantined-${stamp}-${commandId.slice(0, 8)}.json`,
  );
  fs.renameSync(layout.tacticalCommand, dest);
  console.log(JSON.stringify({
    ok: true,
    decision,
    quarantined: true,
    archived_to: dest,
  }));
  return 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { main, formatQuarantineName };
