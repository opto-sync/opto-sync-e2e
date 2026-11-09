import assert from 'node:assert/strict';
import { assertPullIsolation, assertPushCorrelation, decimal } from './refinement-oracle.mjs';

// Live PostgreSQL/HTTP trace replay of the AttoLang reference invariants.
// This deliberately exercises the actual native-backed protocol server.
const baseUrl = (process.env.BASE_URL || 'http://localhost:3003').replace(/\/$/, '');
let checks = 0;

async function request(method, path, body, headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

const identity = (tenant) => ({
  'x-syncer-test-tenant': tenant,
  'x-syncer-test-subject': `atto-user-${tenant}`,
  'x-syncer-test-client-id': 'atto-shared-client',
});
const push = (mutationId, tenant, value, baseRevision) => ({
  protocolVersion: 1,
  clientId: 'atto-shared-client',
  mutations: [{ mutationId, table: 'docs', operation: 'upsert', recordId: 'atto-shared-record', baseRevision, payload: { tenant, value } }],
});
const a = 'atto-tenant-a';
const b = 'atto-tenant-b';

for (let attempt = 0; attempt < 80; attempt += 1) {
  try {
    const health = await request('GET', '/health');
    if (health.status === 200) {
      assert.equal(health.json.syncer, 'native', 'native engine required for E2E evidence');
      break;
    }
  } catch { /* not ready yet */ }
  if (attempt === 79) throw new Error('native protocol server did not become ready');
  await new Promise((resolve) => setTimeout(resolve, 250));
}

assert.equal((await request('POST', '/reset', {})).status, 200, 'fixture reset must succeed');
checks += 1;

const firstA = push('1', a, 'alpha-1', '0');
const firstB = push('1', b, 'bravo-1', '0');
assertPushCorrelation(firstA, await request('POST', '/v1/sync/push', firstA, identity(a)));
assertPushCorrelation(firstB, await request('POST', '/v1/sync/push', firstB, identity(b)));
checks += 2;

// A committed operation with its response lost must be retried unchanged.
const secondA = push('2', a, 'alpha-2', '1');
let responseLost = false;
try {
  await request('POST', '/v1/sync/push', secondA, {
    ...identity(a), 'x-syncer-failpoint': 'after-commit-response-loss',
  });
} catch {
  responseLost = true;
}
assert.ok(responseLost, 'post-commit loss must close the response before acknowledgement');
const replayed = await request('POST', '/v1/sync/push', secondA, identity(a));
assertPushCorrelation(secondA, replayed, { status: 'duplicate', originalStatus: 'applied' });
checks += 2;

// Replaying the same immutable mutation ID with changed content must not apply.
const forged = await request('POST', '/v1/sync/push', push('2', a, 'forged-content', '1'), identity(a));
assert.equal(forged.status, 409);
assert.equal(forged.json?.error, 'MUTATION_ID_REUSED');
checks += 1;

// Caller-controlled client IDs cannot override server-bound identity.
const spoofed = await request('POST', '/v1/sync/push', {
  ...push('3', a, 'spoofed-content', '2'), clientId: 'not-the-bound-client',
}, identity(a));
assert.equal(spoofed.status, 403);
assert.equal(spoofed.json?.error, 'CLIENT_ID_FORBIDDEN');
checks += 1;

for (const [tenant, expectedChanges, expectedValue] of [[a, 2, 'alpha-2'], [b, 1, 'bravo-1']]) {
  const page = await request('GET', '/v1/sync/pull?checkpoint=0&limit=100', undefined, identity(tenant));
  assertPullIsolation(page, { tenant, minimumChanges: expectedChanges });
  assert.equal(page.json.changes.length, expectedChanges, 'unexpected durable effect count');
  const snapshot = await request('GET', '/v1/sync/snapshot', undefined, identity(tenant));
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.json.records.length, 1, 'snapshot crossed tenant boundary');
  assert.equal(snapshot.json.records[0].record.tenant, tenant);
  assert.equal(snapshot.json.records[0].record.value, expectedValue);
  const checkpoint = decimal(snapshot.json.checkpoint, 'snapshot checkpoint');
  assert.ok(checkpoint >= decimal(page.json.checkpoint, 'pull checkpoint'));
  checks += 2;
}

const snapshot = await request('GET', '/v1/sync/snapshot', undefined, identity(a));
const future = (decimal(snapshot.json.checkpoint, 'snapshot checkpoint') + 1n).toString();
const deniedFuture = await request('GET', `/v1/sync/pull?checkpoint=${future}`, undefined, identity(a));
assert.equal(deniedFuture.status, 400, 'a future cursor must be rejected');
assert.equal(deniedFuture.json?.error, 'CHECKPOINT_AHEAD');
const negative = await request('GET', '/v1/sync/pull?checkpoint=-1', undefined, identity(a));
assert.equal(negative.status, 400);
assert.equal(negative.json?.error, 'INVALID_CHECKPOINT');
checks += 2;

console.log(JSON.stringify({ result: 'PASS', layer: 'real-http-postgresql-native-e2e', cases: checks, attoGuest: 'NOT_EXECUTED', compilerParity: 'NOT_CERTIFIED' }));
