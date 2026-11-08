'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { verifySnapshotFile } = require('./test-battle-snapshot-verifier.cjs');

function loadCaptureMeta(captureDir) {
  const metaPath = path.join(captureDir, 'capture-meta.json');
  if (!fs.existsSync(metaPath)) {
    return { captureDir, metaPath, meta: null };
  }
  return { captureDir, metaPath, meta: JSON.parse(fs.readFileSync(metaPath, 'utf8')) };
}

function listCaptures(capturesRoot, readDirSync = fs.readdirSync, statSync = fs.statSync) {
  if (!fs.existsSync(capturesRoot)) {
    return [];
  }
  const out = [];
  for (const stageDir of readDirSync(capturesRoot, { withFileTypes: true })) {
    if (!stageDir.isDirectory()) continue;
    const stagePath = path.join(capturesRoot, stageDir.name);
    for (const cap of readDirSync(stagePath, { withFileTypes: true })) {
      if (!cap.isDirectory()) continue;
      const captureDir = path.join(stagePath, cap.name);
      const { meta } = loadCaptureMeta(captureDir);
      const yamlPath = path.join(captureDir, 'tactical.yaml');
      out.push({
        stageFolder: stageDir.name,
        captureId: cap.name,
        captureDir,
        yamlPath,
        meta,
        mtimeMs: statSync(yamlPath).mtimeMs,
      });
    }
  }
  return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

function pickLatestByStage(captures) {
  const byStage = new Map();
  for (const cap of captures) {
    const stageKey = cap.meta?.stageId ?? cap.stageFolder.charAt(0);
    const prev = byStage.get(stageKey);
    if (!prev || cap.mtimeMs > prev.mtimeMs) {
      byStage.set(stageKey, cap);
    }
  }
  return [...byStage.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, cap]) => cap);
}

function diffNumbers(a, b) {
  if (a == null || b == null) return null;
  return b - a;
}

function compareCaptureReports(reports) {
  const ordered = reports.filter((r) => r.report?.ok);
  const highlights = [];
  const failures = reports.filter((r) => !r.report?.ok);

  for (const f of failures) {
    highlights.push({
      kind: 'validation_failure',
      stageId: f.stageId,
      captureId: f.captureId,
      errors: f.report?.errors ?? ['unknown'],
    });
  }

  for (let i = 1; i < ordered.length; i += 1) {
    const prev = ordered[i - 1];
    const cur = ordered[i];
    const dDisc = diffNumbers(
      prev.report.discovery?.totalDiscoveredRecords,
      cur.report.discovery?.totalDiscoveredRecords,
    );
    const dSize = diffNumbers(prev.report.file.sizeBytes, cur.report.file.sizeBytes);
    const dVisible = diffNumbers(
      prev.report.discovery?.visibilityTotals?.currentlyVisibleRecords,
      cur.report.discovery?.visibilityTotals?.currentlyVisibleRecords,
    );

    highlights.push({
      kind: 'progression',
      from: { stageId: prev.stageId, captureId: prev.captureId },
      to: { stageId: cur.stageId, captureId: cur.captureId },
      discoveryGrowth: dDisc,
      visibleGrowth: dVisible,
      sizeGrowthBytes: dSize,
      schemaFrom: prev.report.tactical?.schemaVersion,
      schemaTo: cur.report.tactical?.schemaVersion,
      unexpectedV4Fallback:
        prev.report.tactical?.schemaVersion === 5 &&
        cur.report.tactical?.schemaVersion === 4,
      structureKindDelta: Object.fromEntries(
        Object.keys({ ...prev.report.structures?.byStructureKind, ...cur.report.structures?.byStructureKind })
          .map((kind) => [
            kind,
            (cur.report.structures?.byStructureKind?.[kind] ?? 0) -
              (prev.report.structures?.byStructureKind?.[kind] ?? 0),
          ]),
      ),
      newDisclosedDoors:
        (cur.report.structures?.disclosedDoorCount ?? 0) -
        (prev.report.structures?.disclosedDoorCount ?? 0),
      gravLiftDelta:
        (cur.report.structures?.gravLiftCount ?? 0) - (prev.report.structures?.gravLiftCount ?? 0),
    });
  }

  return {
    comparedAt: new Date().toISOString(),
    captureCount: reports.length,
    highlights,
    reports: reports.map((r) => ({
      stageId: r.stageId,
      stageTitle: r.stageTitle,
      captureId: r.captureId,
      ok: r.report?.ok ?? false,
      schemaVersion: r.report?.tactical?.schemaVersion,
      sizeBytes: r.report?.file?.sizeBytes,
      discoveredRecords: r.report?.discovery?.totalDiscoveredRecords,
      currentlyVisible: r.report?.discovery?.visibilityTotals?.currentlyVisibleRecords,
      perLevel: r.report?.discovery?.perLevel,
    })),
    note: 'Comparison uses Companion-exported snapshots only (discovered/visible state). No hidden-map ground truth.',
  };
}

function compareCaptures(capturesRoot, options = {}) {
  const captures = listCaptures(capturesRoot);
  const selected = options.latestPerStage ? pickLatestByStage(captures) : captures;
  const stageOrder = options.stageOrder ?? ['A', 'B', 'C', 'D', 'E'];
  const byStageId = new Map(selected.map((c) => [c.meta?.stageId ?? c.stageFolder.charAt(0), c]));

  const reports = [];
  for (const stageId of stageOrder) {
    const cap = byStageId.get(stageId);
    if (!cap) {
      reports.push({
        stageId,
        stageTitle: null,
        captureId: null,
        report: { ok: false, errors: [`No capture for stage ${stageId}`], warnings: [] },
      });
      continue;
    }
    const report = verifySnapshotFile(cap.yamlPath);
    reports.push({
      stageId: cap.meta?.stageId ?? stageId,
      stageTitle: cap.meta?.stageTitle ?? null,
      captureId: cap.captureId,
      report,
    });
  }

  return compareCaptureReports(reports);
}

function comparisonToMarkdown(result) {
  const lines = [];
  lines.push('# Test battle capture comparison (A–E)');
  lines.push(`- **Compared at:** ${result.comparedAt}`);
  lines.push(`- **Captures considered:** ${result.captureCount}`);
  lines.push('');
  lines.push(`> ${result.note}`);
  lines.push('');
  lines.push('## Summary by stage');
  lines.push('| Stage | Capture | OK | Schema | Size (B) | Discovered | Visible now |');
  lines.push('|-------|---------|----|--------|----------|------------|-------------|');
  for (const row of result.reports) {
    lines.push(
      `| ${row.stageId} | ${row.captureId ?? '—'} | ${row.ok ? 'yes' : 'no'} | ${row.schemaVersion ?? '—'} | ${row.sizeBytes ?? '—'} | ${row.discoveredRecords ?? '—'} | ${row.currentlyVisible ?? '—'} |`,
    );
  }
  lines.push('');
  lines.push('## Highlights');
  for (const h of result.highlights) {
    if (h.kind === 'validation_failure') {
      lines.push(`- **Stage ${h.stageId}** validation failed: ${h.errors.join('; ')}`);
      continue;
    }
    lines.push(
      `- **${h.from.stageId} → ${h.to.stageId}:** discovery ${h.discoveryGrowth >= 0 ? '+' : ''}${h.discoveryGrowth}, visible ${h.visibleGrowth >= 0 ? '+' : ''}${h.visibleGrowth}, size ${h.sizeGrowthBytes >= 0 ? '+' : ''}${h.sizeGrowthBytes} B` +
        (h.unexpectedV4Fallback ? ' — **unexpected v4 fallback**' : '') +
        (h.newDisclosedDoors ? `, +${h.newDisclosedDoors} disclosed doors` : '') +
        (h.gravLiftDelta ? `, grav lifts Δ ${h.gravLiftDelta}` : ''),
    );
  }
  return lines.join('\n');
}

module.exports = {
  listCaptures,
  pickLatestByStage,
  compareCaptures,
  compareCaptureReports,
  comparisonToMarkdown,
};
