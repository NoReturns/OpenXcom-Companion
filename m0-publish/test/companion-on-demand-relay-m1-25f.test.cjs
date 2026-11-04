'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createGhApiExec,
  normalizeGhApiExecError,
  publishRemoteContentFile,
  deleteRemoteContentFile,
} = require('../lib/github-relay.cjs');
const { execFileSyncHidden } = require('../lib/exec-file-sync.cjs');

describe('silent GitHub CLI execution (M1-25F)', () => {
  it('execFileSyncHidden sets windowsHide on Windows', () => {
    if (process.platform !== 'win32') {
      return;
    }
    let captured = null;
    execFileSyncHidden('gh', ['auth', 'status'], { encoding: 'utf8' }, (file, args, options) => {
      captured = { file, args, options: { ...options } };
      return '';
    });
    assert.equal(captured.file, 'gh');
    assert.equal(captured.options.windowsHide, true);
  });

  it('createGhApiExec default path uses execFileSyncHidden (windowsHide on Windows)', () => {
    if (process.platform !== 'win32') {
      return;
    }
    const calls = [];
    const ghApi = createGhApiExec({
      execFileSync: (file, args, options) => execFileSyncHidden(file, args, options, (f, a, o) => {
        calls.push({ file: f, options: { ...o } });
        return 'HTTP/2 200\r\n\r\n{"type":"file","encoding":"base64","content":"e30=","sha":"abc"}';
      }),
    });
    ghApi('GET', 'repos/o/r/contents/m0/tactical-command.json');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.windowsHide, true);
  });

  it('preserves gh stderr for failure classification', () => {
    const execFileSyncImpl = () => {
      const error = new Error('Command failed');
      error.stderr = 'gh: Bad credentials (HTTP 401)';
      error.status = 1;
      throw error;
    };
    const ghApi = createGhApiExec({ execFileSync: execFileSyncImpl });
    assert.throws(
      () => ghApi('GET', 'repos/o/r/contents/m0/tactical-command.json'),
      (error) => error.code === 'AUTH_FAILED' && /Bad credentials/.test(String(error.stderr)),
    );
  });

  it('publish and delete content issue three gh api subprocess calls', () => {
    const calls = [];
    const execFileSyncImpl = (file, args) => {
      calls.push({ file, args });
      const method = args[2];
      if (method === 'GET') {
        return 'HTTP/2 200\r\n\r\n{"type":"file","encoding":"base64","content":"e30=","sha":"abc"}';
      }
      if (method === 'PUT' || method === 'DELETE') {
        return 'HTTP/2 200\r\n\r\n{"content":{"sha":"next"}}';
      }
      throw new Error(`unexpected ${method}`);
    };
    const ghApi = createGhApiExec({ execFileSync: execFileSyncImpl });
    const deps = {
      ghApi,
      repo: 'o/r',
      branch: 'main',
      maxRemoteBytes: 16 * 1024,
    };
    publishRemoteContentFile(deps, 'm0/tactical-result.json', '{"status":"COMPLETED"}\n', 'result');
    deleteRemoteContentFile(deps, 'm0/tactical-command.json', 'abc', 'retire');
    const apiCalls = calls.filter((call) => call.file === 'gh' && call.args[0] === 'api');
    assert.equal(apiCalls.length, 3, 'publish is GET+PUT, delete is DELETE');
  });
});

describe('execFileSyncHidden unit', () => {
  it('exports helper used by github-relay', () => {
    assert.equal(typeof execFileSyncHidden, 'function');
    assert.equal(typeof normalizeGhApiExecError, 'function');
  });
});
