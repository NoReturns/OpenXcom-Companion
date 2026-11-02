'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const YAML = require('yaml');
const { TacticalWatcher } = require('../lib/tactical-watcher.cjs');
const { computeSnapshotId, loadAndValidateSnapshotFromText } = require('../lib/tactical-publish.cjs');

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'valid-v2.yaml'), 'utf8');

function makeChangedYaml(baseText, mutate) {
  const raw = YAML.parse(baseText);
  mutate(raw);
  return YAML.stringify(raw);
}

function createWatcherHarness(options = {}) {
  let now = 0;
  let fileText = options.initialText ?? null;
  const logs = [];
  const publishes = [];

  const watcher = new TacticalWatcher({
    inputPath: options.inputPath ?? path.join(os.tmpdir(), 'unused.yaml'),
    dryRun: options.dryRun ?? true,
    pollIntervalMs: options.pollIntervalMs ?? 1000,
    minPublishIntervalMs: options.minPublishIntervalMs ?? 15000,
    maxPublishes: options.maxPublishes ?? 20,
    now: () => now,
    log: (line) => logs.push(line),
    existsSync: () => fileText !== null,
    readFileSync: () => fileText,
    publishRelayState: async (relay) => {
      publishes.push({ at: now, relay });
      if (options.publishImpl) {
        return options.publishImpl(relay);
      }
      return { skipped: false };
    },
    signal: options.signal,
  });

  return {
    watcher,
    logs,
    publishes,
    setText(text) {
      fileText = text;
    },
    advance(ms) {
      now += ms;
    },
  };
}

describe('TacticalWatcher', () => {
  it('establishes baseline on startup without publishing existing snapshot', async () => {
    const h = createWatcherHarness({ initialText: FIXTURE });
    await h.watcher._pollOnce();
    assert.equal(h.publishes.length, 0);
    assert.match(h.logs.join('\n'), /Baseline established/);
    assert.equal(h.watcher.baselineSnapshotId, computeSnapshotId(loadAndValidateSnapshotFromText(FIXTURE, YAML)));
  });

  it('handles missing snapshot at startup until file appears', async () => {
    const h = createWatcherHarness({ initialText: null });
    await h.watcher._pollOnce();
    assert.equal(h.watcher.baselineSnapshotId, null);
    h.setText(FIXTURE);
    await h.watcher._pollOnce();
    assert.equal(h.publishes.length, 0);
    assert.match(h.logs.join('\n'), /Baseline established/);
  });

  it('detects a new snapshot and publishes after baseline change', async () => {
    const changed = makeChangedYaml(FIXTURE, (raw) => { raw.turn = 2; });
    const h = createWatcherHarness({ initialText: FIXTURE, dryRun: true });
    await h.watcher._pollOnce();
    h.setText(changed);
    await h.watcher._pollOnce();
    assert.equal(h.watcher.publishCount, 1);
    assert.match(h.logs.join('\n'), /Snapshot change detected/);
    assert.match(h.logs.join('\n'), /Snapshot validated/);
    assert.match(h.logs.join('\n'), /Published \(dry-run\)/);
  });

  it('suppresses duplicate snapshot IDs', async () => {
    const changed = makeChangedYaml(FIXTURE, (raw) => { raw.turn = 2; });
    const h = createWatcherHarness({ initialText: FIXTURE, dryRun: true, minPublishIntervalMs: 0 });
    await h.watcher._pollOnce();
    h.setText(changed);
    await h.watcher._pollOnce();
    assert.equal(h.watcher.publishCount, 1);

    h.watcher.lastSeenSnapshotId = 'stale-pointer';
    h.setText(changed);
    await h.watcher._pollOnce();
    assert.match(h.logs.join('\n'), /duplicate snapshot ID/);
    assert.equal(h.watcher.publishCount, 1);
  });

  it('enforces a 15-second minimum publish interval and coalesces latest state', async () => {
    const changeA = makeChangedYaml(FIXTURE, (raw) => { raw.turn = 2; });
    const changeB = makeChangedYaml(FIXTURE, (raw) => { raw.turn = 3; });
    const h = createWatcherHarness({ initialText: FIXTURE, dryRun: false, minPublishIntervalMs: 15000 });
    await h.watcher._pollOnce();

    h.setText(changeA);
    await h.watcher._pollOnce();
    assert.equal(h.publishes.length, 1);

    h.advance(5000);
    h.setText(changeB);
    await h.watcher._pollOnce();
    assert.equal(h.publishes.length, 1);

    h.advance(15000);
    await h.watcher._maybeFlushPending(false);
    assert.equal(h.publishes.length, 2);
    assert.equal(h.publishes[1].relay.source.turn, 3);
  });

  it('stops publishing after 20 successful publications', async () => {
    const h = createWatcherHarness({
      initialText: FIXTURE,
      dryRun: true,
      maxPublishes: 2,
      minPublishIntervalMs: 0,
    });
    await h.watcher._pollOnce();

    for (let turn = 2; turn <= 4; turn++) {
      h.setText(makeChangedYaml(FIXTURE, (raw) => { raw.turn = turn; }));
      await h.watcher._pollOnce();
      h.advance(1);
    }

    assert.equal(h.watcher.publishCount, 2);
    assert.match(h.logs.join('\n'), /Session limit reached/);
    assert.equal(h.watcher.publishingStopped, true);
  });

  it('recovers from malformed YAML without losing baseline', async () => {
    const h = createWatcherHarness({ initialText: FIXTURE });
    await h.watcher._pollOnce();
    const baseline = h.watcher.baselineSnapshotId;
    h.setText('schemaVersion: 2\nbroken: [');
    await h.watcher._pollOnce();
    assert.match(h.logs.join('\n'), /Validation failed/);
    assert.equal(h.watcher.baselineSnapshotId, baseline);
  });

  it('stops on GitHub SHA conflicts', async () => {
    const changed = makeChangedYaml(FIXTURE, (raw) => { raw.turn = 2; });
    const h = createWatcherHarness({
      initialText: FIXTURE,
      dryRun: false,
      minPublishIntervalMs: 0,
      publishImpl: async () => {
        const error = new Error('SHA conflict while publishing state.json; stop and retry manually.');
        error.code = 'SHA_CONFLICT';
        throw error;
      },
    });
    await h.watcher._pollOnce();
    h.setText(changed);
    await assert.rejects(
      () => h.watcher._pollOnce(),
      (error) => error.code === 'SHA_CONFLICT'
    );
    assert.match(h.logs.join('\n'), /Watcher stopped \(error\)/);
    assert.equal(h.watcher.running, false);
  });

  it('stops cleanly on abort signal', () => {
    const controller = new AbortController();
    const h = createWatcherHarness({ initialText: FIXTURE, signal: controller.signal });
    h.watcher.start();
    controller.abort();
    assert.match(h.logs.join('\n'), /Watcher stopped/);
    assert.equal(h.watcher.running, false);
  });

  it('dry-run performs zero network publish calls', async () => {
    let networkCalls = 0;
    const changed = makeChangedYaml(FIXTURE, (raw) => { raw.turn = 2; });
    const h = createWatcherHarness({
      initialText: FIXTURE,
      dryRun: true,
      minPublishIntervalMs: 0,
      publishImpl: async () => {
        networkCalls += 1;
        return { skipped: false };
      },
    });
    await h.watcher._pollOnce();
    h.setText(changed);
    await h.watcher._pollOnce();
    await h.watcher._maybeFlushPending(false);
    assert.equal(networkCalls, 0);
    assert.match(h.logs.join('\n'), /Published \(dry-run\)/);
  });

  it('does not publish when file content stays unchanged after baseline', async () => {
    const h = createWatcherHarness({ initialText: FIXTURE, dryRun: true, minPublishIntervalMs: 0 });
    await h.watcher._pollOnce();
    await h.watcher._pollOnce();
    await h.watcher._maybeFlushPending(false);
    assert.equal(h.publishes.length, 0);
  });
});

describe('github relay helpers', () => {
  it('treats first-time GET 404 as expected', () => {
    const { isNotFoundError } = require('../lib/github-relay.cjs');
    assert.equal(isNotFoundError({ stderr: 'gh: Not Found (HTTP 404)' }), true);
  });
});
