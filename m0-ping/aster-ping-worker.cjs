'use strict';

// Standalone M0 prototype. No shell execution and no OpenXcom access.
// Requires Node.js 22+, ASTER_GITHUB_TOKEN, and ASTER_RELAY_BRANCH.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

const BASE = 'https://api.github.com/repos/NoReturns/OpenXcom-Aster-Relay';
const COMMAND = 'm0/command.json';
const RESULT = 'm0/result.json';
const DIR = path.join(__dirname, '.aster-ping-state');
const JOURNAL = path.join(DIR, 'journal.json');
const LOCK = path.join(DIR, 'worker.lock');
const token = process.env.ASTER_GITHUB_TOKEN;
const branch = process.env.ASTER_RELAY_BRANCH;
const stop = new AbortController();
let ownsLock = false;
let journal;
let connectionVerified = false;

class Halt extends Error {}
class Retry extends Error {
  constructor(message, wait = 10000) { super(message); this.wait = wait; }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function persist() {
  const temp = JOURNAL + '.tmp';
  const fd = fs.openSync(temp, 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(journal)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temp, JOURNAL);
}

function acquire() {
  fs.mkdirSync(DIR, { recursive: true });
  try {
    fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
    ownsLock = true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Halt('Worker lock exists. If its process has ended, remove only worker.lock, then restart. Retain journal.json.');
  }
}

async function api(method, url, body) {
  let response;
  let raw = '';
  try {
    response = await fetch(url, {
      method, redirect: 'error',
      signal: AbortSignal.any([stop.signal, AbortSignal.timeout(15000)]),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'Aster-M0-Ping-Worker'
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 65536) {
        await response.body.cancel().catch(() => {});
        throw new Halt('API response exceeds 64 KiB.');
      }
      chunks.push(Buffer.from(chunk));
    }
    raw = Buffer.concat(chunks).toString('utf8');
  } catch (e) {
    if (e instanceof Halt || stop.signal.aborted) throw e;
    throw new Retry('Network/timeout error; cached work retained.');
  }
  if ([429, 500, 502, 503, 504].includes(response.status) ||
      (response.status === 403 && (response.headers.has('retry-after') ||
       response.headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(raw)))) {
    const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000 - Date.now();
    const retry = Number(response.headers.get('retry-after')) * 1000;
    throw new Retry(`HTTP ${response.status}; retry deferred.`,
      Math.max(60000, Number.isFinite(reset) ? reset : 0, Number.isFinite(retry) ? retry : 0));
  }
  if (response.status === 409) throw new Retry('HTTP 409; will reread the current blob SHA.');
  if (response.status === 404) return null;
  if (!response.ok) throw new Halt(`HTTP ${response.status}; check branch, permissions, or file configuration.`);
  try { return JSON.parse(raw); }
  catch { throw new Halt('GitHub returned invalid JSON.'); }
}

async function readFile(name) {
  const file = await api('GET', `${BASE}/contents/${name}?ref=${encodeURIComponent(branch)}`);
  if (file === null) return null;
  if (file.type !== 'file' || file.path !== name || file.encoding !== 'base64' ||
      !/^[a-f0-9]{40}$/.test(file.sha) || !Number.isInteger(file.size) || file.size > 4096) {
    throw new Halt('Unexpected file metadata or file larger than 4 KiB.');
  }
  const bytes = Buffer.from(file.content, 'base64');
  if (bytes.length > 4096) throw new Halt('Decoded file exceeds 4 KiB.');
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Halt(`${name} is not valid JSON; repair it before restarting.`); }
  return { sha: file.sha, value };
}

async function publish(record, terminal) {
  const current = await readFile(RESULT);
  const wanted = terminal ? record.final : record.accepted;
  if (current) {
    if (same(current.value, record.final)) return true;
    if (same(current.value, wanted)) return terminal;
    if (!current.value || current.value.schema_version !== 1 ||
        !own(journal.records, current.value.request_id)) {
      throw new Halt('Result file is not recognized by this journal; do not overwrite it.');
    }
    const previous = journal.records[current.value.request_id];
    if (!same(current.value, previous.accepted) && !same(current.value, previous.final)) {
      throw new Halt('Result content was changed externally; owner review required.');
    }
  }
  const reply = await api('PUT', `${BASE}/contents/${RESULT}`, {
    branch, message: `M0 ping ${record.final.request_id}: ${wanted.status}`,
    content: Buffer.from(JSON.stringify(wanted, null, 2) + '\n').toString('base64'),
    ...(current ? { sha: current.sha } : {})
  });
  if (!reply) throw new Halt('Result write returned 404; check repository and branch access.');
  return terminal;
}

async function finishPending() {
  const record = Object.values(journal.records).find(r => !r.delivered);
  if (!record) return false;
  if (!record.acknowledged) {
    const alreadyFinal = await publish(record, false);
    record.acknowledged = true;
    if (alreadyFinal) record.delivered = true;
    persist();
    if (!alreadyFinal) await delay(1200, undefined, { signal: stop.signal });
  }
  if (!record.delivered) {
    await publish(record, true);
    record.delivered = true;
    persist();
  }
  console.log(`${record.final.request_id}: ${record.final.status}`);
  return true;
}

async function check() {
  if (!connectionVerified) {
    if (!await api('GET', `${BASE}/branches/${encodeURIComponent(branch)}`)) {
      throw new Halt('Repository/branch inaccessible; check local token permissions.');
    }
    connectionVerified = true;
  }
  if (await finishPending()) return;
  const file = await readFile(COMMAND);
  if (!file) return; // Repository/branch access was verified; the inbox may not exist yet.
  const command = file.value;
  if (!command || typeof command !== 'object' || Array.isArray(command) ||
      typeof command.request_id !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(command.request_id || '')) {
    throw new Halt('Command requires a valid, bounded request_id.');
  }
  const digest = crypto.createHash('sha256').update(JSON.stringify(command)).digest('hex');
  const id = command.request_id;
  if (own(journal.records, id)) {
    if (journal.records[id].digest !== digest) throw new Halt('Request ID reused with different content. Use a new ID.');
    return;
  }
  if (Object.keys(journal.records).length >= 200) throw new Halt('200-request limit reached; retain the journal and stop.');
  const valid = command.schema_version === 1 && command.action === 'ping' &&
    Object.keys(command).length === 3;
  const at = new Date().toISOString();
  const common = { schema_version: 1, request_id: id };
  journal.records[id] = {
    digest, acknowledged: !valid, delivered: false,
    accepted: { ...common, status: 'accepted', accepted_at: at },
    final: { ...common, status: valid ? 'completed' : 'failed',
      accepted_at: at, completed_at: at,
      ...(valid ? { reply: 'pong' } : { error: 'UNSUPPORTED_COMMAND_OR_SCHEMA' }) }
  };
  // Cache both replies before any remote write. Retries only publish cached replies.
  persist();
  await finishPending();
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Halt('Use an existing Node.js 22+ installation.');
  if (!token || !branch || branch.length > 200) throw new Halt('Set ASTER_GITHUB_TOKEN and ASTER_RELAY_BRANCH.');
  acquire();
  if (fs.existsSync(JOURNAL)) {
    if (fs.statSync(JOURNAL).size > 1048576) throw new Halt('Journal exceeds 1 MiB; stop.');
    journal = JSON.parse(fs.readFileSync(JOURNAL, 'utf8'));
    if (journal.version !== 1 || journal.branch !== branch || journal.repository !== BASE ||
        !journal.records || typeof journal.records !== 'object' || Array.isArray(journal.records)) {
      throw new Halt('Journal identity/format mismatch. Do not delete it to bypass this check.');
    }
  } else {
    journal = { version: 1, repository: BASE, branch, records: {} };
    persist();
  }
  console.log(`Watching ${COMMAND} on ${branch} every 10 seconds. Ctrl+C stops.`);
  let failures = 0;
  while (!stop.signal.aborted) {
    let wait = 10000;
    try { await check(); failures = 0; }
    catch (e) {
      if (stop.signal.aborted) break;
      if (!(e instanceof Retry)) throw e;
      failures++;
      wait = Math.max(e.wait, Math.min(120000, 10000 * 2 ** Math.min(failures - 1, 4)));
      console.error(`${e.message} Retrying in ${Math.ceil(wait / 1000)}s.`);
    }
    await delay(wait, undefined, { signal: stop.signal }).catch(e => {
      if (!stop.signal.aborted) throw e;
    });
  }
}

process.on('SIGINT', () => stop.abort());
process.on('SIGTERM', () => stop.abort());
main().catch(e => {
  if (!stop.signal.aborted) { console.error(e instanceof Halt ? e.message : 'Local state error; stop and inspect the journal.'); process.exitCode = 1; }
}).finally(() => {
  if (ownsLock) {
    try { if (fs.readFileSync(LOCK, 'utf8') === String(process.pid)) fs.unlinkSync(LOCK); }
    catch { /* An abrupt close can require owner removal of the lock only. */ }
  }
});
