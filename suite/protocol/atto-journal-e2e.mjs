import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPullIsolation, decimal } from './refinement-oracle.mjs';

// Real PostgreSQL/native-backed protocol replay using a durable Node reference
// client in separate OS processes. This is NOT an AttoLang guest binary.
const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const baseUrl = (process.env.BASE_URL || 'http://localhost:3003').replace(/\/$/, '');
const tenant = 'atto-journal-tenant';
const headers = {
  'x-syncer-test-tenant': tenant,
  'x-syncer-test-subject': 'atto-journal-subject',
  'x-syncer-test-client-id': 'atto-journal-client',
};
async function get(path) {
  const response = await fetch(`${baseUrl}${path}`, { headers, signal: AbortSignal.timeout(10000) });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}
const root = await mkdtemp(join(tmpdir(), 'atto-journal-e2e-'));
const journal = join(root, 'client.json');
let cases = 0;
async function phase(name, exit = 0) {
  try {
    const output = await exec(process.execPath, [join(here, 'atto-journal-worker.mjs'), name, journal], {
      env: { ...process.env, BASE_URL: baseUrl }, timeout: 15000, maxBuffer: 32 * 1024,
    });
    assert.equal(exit, 0, `${name}: expected injected crash exit ${exit}, got success`);
    assert.match(output.stdout, /"phase"/);
  } catch (error) {
    if (exit === 0 || error.code !== exit) throw error;
    assert.match(error.stdout, /INJECTED_ACK_PERSIST_CRASH/);
  }
  cases++;
}
try {
  const health = await get('/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.syncer, 'native');
  const reset = await fetch(`${baseUrl}/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(10000) });
  assert.equal(reset.status, 200);
  cases++;

  await phase('stage-1');
  await phase('lose-response');
  await phase('recover-1');
  await phase('stage-2');
  await phase('ack-crash', 27);
  await phase('recover-2');
  await phase('stage-3');
  await phase('forged-ack');
  await phase('recover-3');
  await phase('verify');

  const page = await get('/v1/sync/pull?checkpoint=0&limit=100');
  assertPullIsolation(page, { tenant, minimumChanges: 3 });
  assert.equal(page.json.changes.length, 3, 'lost ACK or restart duplicated server effects');
  assert.deepEqual(page.json.changes.map(c => c.source.mutationId), ['1', '2', '3']);
  cases++;
  const snapshot = await get('/v1/sync/snapshot');
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.json.records.length, 1);
  assert.equal(snapshot.json.records[0].record.value, 'durable-3');
  assert.ok(decimal(snapshot.json.checkpoint, 'snapshot checkpoint') >= decimal(page.json.checkpoint, 'page checkpoint'));
  cases++;
  console.log(JSON.stringify({ result: 'PASS', layer: 'separate-process-journal-postgresql-native-e2e', cases, attoGuest: 'NOT_EXECUTED', compilerParity: 'NOT_CERTIFIED' }));
} finally {
  await rm(root, { recursive: true, force: true });
}
