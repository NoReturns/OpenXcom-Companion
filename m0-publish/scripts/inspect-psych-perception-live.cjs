'use strict';

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const {
  loadAndValidateSnapshotFromText,
  buildRelayPayload,
} = require('../lib/tactical-publish.cjs');
const { buildUnitStateBrief } = require('../lib/unit-state-brief.cjs');
const {
  collectPsychologicalPerceptionEvents,
  buildPsychologicalHistoricalLines,
} = require('../lib/psychological-perception-consumer.cjs');
const {
  runMandatoryBattlefieldStatusReview,
} = require('../lib/tactical-briefing-ai-workflow.cjs');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const defaultYaml = path.join(repoRoot, 'local', 'm0', 'tactical-live.yaml');
const yamlPath = process.argv[2] ? path.resolve(process.argv[2]) : defaultYaml;

if (!fs.existsSync(yamlPath)) {
  console.error(`No snapshot at ${yamlPath}. Press F6 on player turn first.`);
  process.exit(1);
}

const text = fs.readFileSync(yamlPath, 'utf8');
if (!text.trim()) {
  console.error(`${yamlPath} is empty — F6 may have been deferred (busy/falling/not player turn).`);
  process.exit(2);
}

const tactical = loadAndValidateSnapshotFromText(text, YAML);
const relay = buildRelayPayload(tactical, new Date().toISOString());
const brief = relay.unitStateBrief ?? buildUnitStateBrief(tactical);
const psych = collectPsychologicalPerceptionEvents(tactical.perceptionLog);
const psychLines = buildPsychologicalHistoricalLines(tactical.perceptionLog, tactical);
const review = runMandatoryBattlefieldStatusReview(relay);

console.log('=== WP6-PSY-1 live snapshot inspect ===');
console.log(`File: ${yamlPath}`);
console.log(`Turn: ${tactical.turn}  side: ${tactical.side}  schema: ${tactical.schemaVersion}`);
console.log(`perceptionLog: session=${tactical.perceptionLog?.sessionId ?? 'n/a'} events=${tactical.perceptionLog?.events?.length ?? 0}`);
console.log('');

console.log('--- Psychological history (perceptionLog; not current status) ---');
if (psych.length === 0) {
  console.log('(none — trigger panic/MC/psi in battle before F6, or events occurred before this sessionId)');
} else {
  for (const ev of psych) {
    console.log(`  [seq ${ev.seq}] ${ev.type} turn ${ev.turn} confidence=${ev.confidence}${ev.subjectUnitId ? ` subject=${ev.subjectUnitId}` : ''}${ev.subjectName ? ` name=${ev.subjectName}` : ''}`);
  }
  console.log('');
  for (const line of psychLines) {
    console.log(`  • ${line}`);
  }
}

console.log('');
console.log('--- Current threat / status (unitStateBrief at F6) ---');
for (const ex of brief.exceptions ?? []) {
  console.log(`  • [${ex.kind}] unit ${ex.id}${ex.name ? ` ${ex.name}` : ''}${ex.summary ? ` ${ex.summary}` : ''}`);
}
const hostiles = brief.visibleHostileObservations ?? [];
console.log(`  visibleHostileObservations: ${hostiles.length} (facing at export)`);
for (const h of hostiles.slice(0, 8)) {
  console.log(`    - unit ${h.id} @ ${JSON.stringify(h.position)} facing ${h.facing?.label ?? '?'}`);
}
if (hostiles.length > 8) {
  console.log(`    ... +${hostiles.length - 8} more`);
}

console.log('');
console.log('--- Mandatory review (abbrev) ---');
for (const line of review.tacticalStatusLines.slice(0, 12)) {
  console.log(`  • ${line}`);
}

console.log('');
console.log('Done. If hostiles > 0 or MC/panic exceptions appear, you are likely in trouble with aliens.');
