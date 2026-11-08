'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  writeTextAtomic,
  renameWithBoundedRetry,
  isTransientRenameError,
} = require('../lib/local-atomic.cjs');

describe('local-atomic rename retry', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-atomic-'));
  const target = path.join(root, 'marker.json');

  it('isTransientRenameError recognizes EPERM', () => {
    const err = new Error('fail');
    err.code = 'EPERM';
    assert.equal(isTransientRenameError(err), true);
    err.code = 'ENOENT';
    assert.equal(isTransientRenameError(err), false);
  });

  it('writeTextAtomic succeeds after transient EPERM renames', () => {
    const tmp = `${target}.companion.test.tmp`;
    fs.writeFileSync(tmp, '{ "a": 1 }\n', 'utf8');
    let attempts = 0;
    const renameSync = (src, dest) => {
      attempts += 1;
      if (attempts < 3) {
        const err = new Error(`EPERM rename ${src} -> ${dest}`);
        err.code = 'EPERM';
        throw err;
      }
      fs.renameSync(src, dest);
    };
    writeTextAtomic(target, '{ "ok": true }\n', fs.writeFileSync, renameSync, { maxAttempts: 5, backoffMs: 1 });
    assert.equal(attempts, 3);
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { ok: true });
  });

  it('renameWithBoundedRetry fails after exhausting attempts', () => {
    const tmp = `${target}.companion.b.tmp`;
    fs.writeFileSync(tmp, 'x', 'utf8');
    const renameSync = () => {
      const err = new Error('EPERM');
      err.code = 'EPERM';
      throw err;
    };
    const outcome = renameWithBoundedRetry(tmp, target, renameSync, { maxAttempts: 2, backoffMs: 1 });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.error.code, 'EPERM');
    assert.equal(fs.existsSync(tmp), false);
  });

  it('concurrent unique temps converge to last write', () => {
    const one = path.join(root, 'concurrent.json');
    writeTextAtomic(one, '{ "v": 1 }\n');
    writeTextAtomic(one, '{ "v": 2 }\n');
    assert.equal(JSON.parse(fs.readFileSync(one, 'utf8')).v, 2);
  });

  it('writeTextAtomic preserves destination and removes tmp when retries exhaust', () => {
    const sub = path.join(root, 'preserve-only');
    fs.mkdirSync(sub, { recursive: true });
    const dest = path.join(sub, 'preserve.json');
    fs.writeFileSync(dest, '{ "preserved": true }\n', 'utf8');
    const alwaysEperm = () => {
      const err = new Error('EPERM');
      err.code = 'EPERM';
      throw err;
    };
    assert.throws(() => {
      writeTextAtomic(dest, '{ "lost": true }\n', fs.writeFileSync, alwaysEperm, { maxAttempts: 3, backoffMs: 1 });
    }, (error) => error.code === 'EPERM');
    assert.deepEqual(JSON.parse(fs.readFileSync(dest, 'utf8')), { preserved: true });
    assert.deepEqual(fs.readdirSync(sub).sort(), ['preserve.json']);
  });
});
