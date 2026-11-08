'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');
const {
  testBattleHarnessLayout,
  assertProductionIsolation,
  resolveStage,
  pathsEqual,
  readBuildProvenanceManifest,
  assertBuildProvenanceVerified,
} = require('../lib/test-battle-harness-layout.cjs');
const {
  verifySnapshotText,
  verifySnapshotFile,
  reportToMarkdown,
} = require('../lib/test-battle-snapshot-verifier.cjs');
const { compareCaptureReports } = require('../lib/test-battle-capture-compare.cjs');
const { MAX_INPUT_BYTES } = require('../lib/tactical-publish.cjs');

const FIXTURE_V4 = path.join(__dirname, 'fixtures', 'valid-v4.yaml');
const FIXTURE_V5 = path.join(__dirname, 'fixtures', 'valid-v5.yaml');
const FIXTURE_STAGE_C = path.join(__dirname, 'fixtures', 'test-battle-stage-c-perception-regression.yaml');

function tempHarnessRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oxc-h1-'));
}

describe('M1-H1 test battle harness', () => {
  it('layout paths stay disjoint from production companion dirs', () => {
    const layout = testBattleHarnessLayout(path.join(__dirname, '..', '..', '..'));
    assert.ok(!pathsEqual(layout.userDir, layout.production.userDir));
    assert.ok(!pathsEqual(layout.liveSnapshotYaml, layout.production.snapshotYaml));
    assert.doesNotThrow(() => assertProductionIsolation(layout));
  });

  it('rejects production snapshot path overlap', () => {
    const layout = testBattleHarnessLayout(path.join(__dirname, '..', '..', '..'));
    assert.throws(
      () => assertProductionIsolation(layout, { snapshotPath: layout.production.snapshotYaml }),
      (err) => err.code === 'PRODUCTION_PATH_OVERLAP',
    );
  });

  it('resolveStage accepts A–E only', () => {
    assert.equal(resolveStage('b').slug, 'hull-observed');
    assert.throws(() => resolveStage('Z'));
  });

  it('verifier: missing snapshot file', () => {
    const report = verifySnapshotFile(path.join(os.tmpdir(), 'missing-tactical.yaml'));
    assert.equal(report.ok, false);
    assert.match(report.errors[0], /not found/);
  });

  it('verifier: malformed YAML', () => {
    const report = verifySnapshotText('schemaVersion: [broken\n');
    assert.equal(report.ok, false);
    assert.ok(report.validationErrors.length > 0 || report.errors.length > 0);
  });

  it('verifier: unsupported schema', () => {
    const report = verifySnapshotText('schemaVersion: 99\nturn: 1\nside: 0\nselectedUnitId: 1\nmap:\n  width: 1\n  height: 1\n  depth: 1\nunits: []\n');
    assert.equal(report.ok, false);
  });

  it('verifier: valid v4 fallback fixture', () => {
    const text = fs.readFileSync(FIXTURE_V4, 'utf8');
    const report = verifySnapshotText(text);
    assert.equal(report.ok, true);
    assert.equal(report.tactical.schemaVersion, 4);
    assert.equal(report.tactical.terrainAvailable, false);
    assert.ok(report.warnings.some((w) => w.includes('schemaVersion 4')));
  });

  it('verifier: Stage C perception regression fixture', () => {
    const text = fs.readFileSync(FIXTURE_STAGE_C, 'utf8');
    const report = verifySnapshotText(text);
    assert.equal(report.ok, true);
    const { loadAndValidateSnapshotFromText } = require('../lib/tactical-publish.cjs');
    const tactical = loadAndValidateSnapshotFromText(text, YAML);
    assert.equal(tactical.perceptionLog.events.length, 2);
  });

  it('verifier: sparse-v2 semantics on v5 export', () => {
    const { loadAndValidateSnapshotFromText } = require('../lib/tactical-publish.cjs');
    const base = YAML.parse(fs.readFileSync(FIXTURE_V5, 'utf8'));
    base.terrain = {
      memoryNote: 'harness sparse-v2',
      tiles: [],
      semantics: {
        encoding: 'sparse-v2',
        recordCount: 0,
        data: 'T1hUUwIAAAAAAAAA',
      },
    };
    const parsed = loadAndValidateSnapshotFromText(YAML.stringify(base), YAML);
    assert.equal(parsed.terrain.semantics.encoding, 'sparse-v2');
    const report = verifySnapshotText(YAML.stringify(base));
    assert.equal(report.ok, true);
    assert.equal(report.tactical.semanticsEncoding, 'sparse-v2');
  });

  it('verifier: valid v5 verbose terrain', () => {
    const text = fs.readFileSync(FIXTURE_V5, 'utf8');
    const report = verifySnapshotText(text);
    assert.equal(report.ok, true);
    assert.equal(report.tactical.schemaVersion, 5);
    assert.ok(report.discovery.totalDiscoveredRecords >= 1);
    assert.ok(reportToMarkdown(report).includes('Test battle snapshot verification'));
  });

  it('verifier: empty perception log block acceptable', () => {
    const base = YAML.parse(fs.readFileSync(FIXTURE_V4, 'utf8'));
    base.perceptionLog = {
      sessionId: base.eventLog.sessionId,
      oldestSeq: 0,
      latestSeq: 0,
      droppedCount: 0,
      events: [],
    };
    const report = verifySnapshotText(YAML.stringify(base));
    assert.equal(report.ok, true);
    assert.equal(report.perception.eventCount, 0);
  });

  it('verifier: WP6/WP7 perception counts', () => {
    const base = YAML.parse(fs.readFileSync(FIXTURE_V4, 'utf8'));
    base.perceptionLog = {
      sessionId: base.eventLog.sessionId,
      oldestSeq: 1,
      latestSeq: 2,
      droppedCount: 1,
      events: [
        {
          seq: 1,
          type: 'gunfire_observed',
          turn: 1,
          perceptionChannel: 'heard',
          confidence: 'audio_only',
          positionKnown: false,
        },
        {
          seq: 2,
          type: 'projectile_direction_observed',
          turn: 1,
          perceptionChannel: 'seen',
          confidence: 'trajectory_unavailable',
          positionKnown: true,
          position: [1, 1, 0],
        },
      ],
    };
    const report = verifySnapshotText(YAML.stringify(base));
    assert.equal(report.ok, true, report.errors.join('; '));
    assert.equal(report.perception.byType.gunfire_observed, 1);
    assert.equal(report.perception.projectileDirectionCount, 1);
    assert.equal(report.perception.droppedCount, 1);
  });

  it('verifier: WP9 ground items', () => {
    const base = YAML.parse(fs.readFileSync(FIXTURE_V5, 'utf8'));
    base.groundItems = {
      schemaVersion: 1,
      sessionId: base.eventLog.sessionId,
      memoryNote: 'harness fixture',
      droppedCount: 0,
      observations: [
        {
          position: { x: 1, y: 2, z: 0 },
          observationStatus: 'CONFIRMED_IN_LOS',
          items: [{ itemCategory: 'firearm', battleType: 1, itemType: 'STR_RIFLE' }],
        },
      ],
    };
    const report = verifySnapshotText(YAML.stringify(base));
    assert.equal(report.ok, true, report.errors.join('; '));
    assert.equal(report.groundItems.observationCount, 1);
  });

  it('verifier: multi-level discovery counts', () => {
    const base = YAML.parse(fs.readFileSync(FIXTURE_V5, 'utf8'));
    base.terrain.tiles.push({
      p: [3, 3, 1],
      disc: 4,
      inLos: true,
      body: { noFloor: false, elev: 0, walkF: 4 },
      sem: { body: 8 },
    });
    const report = verifySnapshotText(YAML.stringify(base));
    assert.equal(report.ok, true);
    const z1 = report.discovery.perLevel.find((r) => r.z === 1);
    assert.ok(z1 && z1.discoveredRecords >= 1);
  });

  it('verifier: over 256 KiB cap flagged', () => {
    const pad = 'x'.repeat(MAX_INPUT_BYTES + 64);
    const report = verifySnapshotText(`# ${pad}\n`);
    assert.equal(report.ok, false);
    assert.equal(report.file.overCap, true);
  });

  it('verifier: missing session identity warns', () => {
    const text = fs.readFileSync(path.join(__dirname, 'fixtures', 'valid-v2.yaml'), 'utf8');
    const report = verifySnapshotText(text);
    assert.equal(report.ok, true);
    assert.ok(report.warnings.some((w) => w.toLowerCase().includes('sessionid')));
  });

  it('compare highlights discovery growth', () => {
    const v4 = verifySnapshotText(fs.readFileSync(FIXTURE_V4, 'utf8'));
    const v5 = verifySnapshotText(fs.readFileSync(FIXTURE_V5, 'utf8'));
    const result = compareCaptureReports([
      { stageId: 'A', captureId: 'a1', report: v4 },
      { stageId: 'B', captureId: 'b1', report: v5 },
    ]);
    assert.ok(result.highlights.some((h) => h.kind === 'progression'));
  });

  describe('capture script integration', () => {
    let root;
    let layout;
    before(() => {
      root = tempHarnessRoot();
      layout = testBattleHarnessLayout(root);
      fs.mkdirSync(path.dirname(layout.liveSnapshotYaml), { recursive: true });
      fs.copyFileSync(FIXTURE_V5, layout.liveSnapshotYaml);
      fs.utimesSync(layout.liveSnapshotYaml, new Date(), new Date());
    });

    after(() => {
      fs.rmSync(root, { recursive: true, force: true });
    });

    it('capture rejects duplicate label', () => {
      const script = path.join(__dirname, '..', 'scripts', 'capture-test-battle-stage.cjs');
      const run = (extra) => {
        const { spawnSync } = require('node:child_process');
        return spawnSync(process.execPath, [script, '--repo', root, '--stage', 'A', ...extra], {
          encoding: 'utf8',
        });
      };
      const first = run(['--label', 'dup-test']);
      assert.equal(first.status, 0, first.stderr);
      const second = run(['--label', 'dup-test']);
      assert.equal(second.status, 3);
    });
  });

  it('build provenance manifest verifies against workspace when recorded', () => {
    const repoRoot = path.join(__dirname, '..', '..', '..');
    const layout = testBattleHarnessLayout(repoRoot);
    if (!fs.existsSync(layout.buildExe)) {
      return;
    }
    const { buildProvenanceManifest } = require('../lib/test-battle-build-provenance.cjs');
    fs.mkdirSync(layout.configDir, { recursive: true });
    const manifest = buildProvenanceManifest(repoRoot, {
      cppTests: { ok: true, total: 20, passed: 20, failed: 0, results: [] },
      nodeTests: { ok: true, pass: 529, fail: 0 },
    });
    fs.writeFileSync(layout.buildProvenanceManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const readBack = readBuildProvenanceManifest(layout);
    assert.ok(readBack.executableSha256.length === 64);
    assert.doesNotThrow(() => assertBuildProvenanceVerified(layout, repoRoot));
  });
});
