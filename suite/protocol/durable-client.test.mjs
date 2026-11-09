import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDurableClient } from './durable-client.mjs';

const id = { tenant: 'tenant-a', clientId: 'client-a' };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'atto-client-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'journal.json');
  const client = await openDurableClient(path, id);
  return { path, client };
}
const sample = { recordId: 'record-1', baseRevision: '0', payload: { value: 'alpha' } };
function reply(envelope, status = 'applied', overrides = {}) {
  return { status: 200, json: { protocolVersion: 1, clientId: envelope.clientId, lastMutationId: envelope.mutations[0].mutationId,
    checkpoint: '1', results: [{ mutationId: envelope.mutations[0].mutationId, status, ...(status === 'duplicate' ? { originalStatus: 'applied' } : {}) }], ...overrides } };
}

test('journal survives restart and keeps an exact immutable pending envelope', async t => {
  const { path, client } = await fixture(t);
  const original = sample;
  await client.stage(original);
  original.payload.value = 'local mutated object';
  const envelope = client.envelope();
  assert.equal(envelope.mutations[0].payload.value, 'alpha');
  envelope.mutations[0].payload.value = 'mutated copy';
  const reopened = await openDurableClient(path, id);
  assert.equal(reopened.envelope().mutations[0].payload.value, 'alpha');
  assert.equal(reopened.envelope().mutations[0].mutationId, '1');
});

test('loss of response preserves the write-ahead mutation for identical replay', async t => {
  const { path, client } = await fixture(t);
  await client.stage({ recordId: 'r', payload: { x: 1 } });
  assert.deepEqual(await client.replay(async () => { throw new Error('connection lost'); }), { kind: 'unknown', mutationId: '1' });
  const recovered = await openDurableClient(path, id);
  const envelope = recovered.envelope();
  assert.equal((await recovered.replay(async sent => reply(sent, 'duplicate'))).kind, 'acknowledged');
  assert.equal(recovered.snapshot().lastAck, '1');
  assert.equal(recovered.snapshot().pending, null);
  assert.equal(envelope.mutations[0].mutationId, '1');
});

test('acked outcome is durable across another restart; next id is monotonic', async t => {
  const { path, client } = await fixture(t);
  await client.stage({ recordId: 'r', payload: { x: 1 } });
  assert.equal((await client.replay(async sent => reply(sent))).status, 'applied');
  const recovered = await openDurableClient(path, id);
  assert.equal(recovered.snapshot().lastAck, '1');
  await recovered.stage({ recordId: 'r', baseRevision: '1', payload: { x: 2 } });
  assert.equal(recovered.envelope().mutations[0].mutationId, '2');
});

test('crash after server ACK but before local ack write replays unmodified', async t => {
  const { path, client } = await fixture(t);
  await client.stage({ recordId: 'r', payload: { x: 1 } });
  await assert.rejects(client.replay(async sent => reply(sent), { beforeAckPersist: () => { throw Error('simulated process crash'); } }), /simulated process crash/);
  const recovered = await openDurableClient(path, id);
  assert.equal(recovered.envelope().mutations[0].mutationId, '1');
  assert.equal((await recovered.replay(async sent => reply(sent, 'duplicate'))).status, 'duplicate');
});

test('tenant/client identity cannot be changed on an existing journal', async t => {
  const { path } = await fixture(t);
  await assert.rejects(openDurableClient(path, { ...id, tenant: 'tenant-b' }), /journal tenant mismatch/);
  await assert.rejects(openDurableClient(path, { ...id, clientId: 'client-b' }), /journal client mismatch/);
});

test('an outstanding operation fences the next mutation', async t => {
  const { client } = await fixture(t);
  await client.stage({ recordId: 'r', payload: { x: 1 } });
  await assert.rejects(client.stage({ recordId: 'r', payload: { x: 2 } }), /previous mutation must be acknowledged/);
});

test('fake client identity and stale mutation ACKs do not clear the journal', async t => {
  const { path, client } = await fixture(t);
  await client.stage({ recordId: 'r', payload: { x: 1 } });
  await assert.rejects(client.replay(async sent => reply(sent, 'applied', { clientId: 'forged-client' })), /client ID miscorrelation/);
  await assert.rejects(client.replay(async sent => reply(sent, 'applied', { lastMutationId: '0' })), /ledger watermark miscorrelation/);
  await assert.rejects(client.replay(async sent => reply(sent, 'applied', { results: [{ mutationId: '2', status: 'applied' }] })), /mutation ACK miscorrelation/);
  assert.equal((await openDurableClient(path, id)).snapshot().pending.mutationId, '1');
});

test('noncanonical checkpoint and phantom success cannot acknowledge', async t => {
  const { path, client } = await fixture(t);
  await client.stage({ recordId: 'r', payload: { x: 1 } });
  await assert.rejects(client.replay(async sent => reply(sent, 'applied', { checkpoint: '01' })), /canonical/);
  await assert.rejects(client.replay(async sent => reply(sent, 'applied', { results: [] })), /unexpected ACK outcome/);
  assert.equal((await openDurableClient(path, id)).snapshot().lastAck, '0');
});

test('non-200 response never removes pending mutation', async t => {
  const { path, client } = await fixture(t);
  await client.stage({ recordId: 'r', payload: { x: 1 } });
  assert.deepEqual(await client.replay(async () => ({ status: 409, json: { error: 'MUTATION_ID_REUSED' } })), { kind: 'not_acknowledged', status: 409 });
  assert.equal((await openDurableClient(path, id)).snapshot().pending.mutationId, '1');
});

test('tampered journal, illegal IDs and unsupported schema fail closed', async t => {
  const { path } = await fixture(t);
  let stored = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...stored, schema: 2 }));
  await assert.rejects(openDurableClient(path, id), /unsupported journal format/);
  await writeFile(path, JSON.stringify({ ...stored, lastAck: '01' }));
  await assert.rejects(openDurableClient(path, id), /canonical/);
  await writeFile(path, JSON.stringify({ ...stored, lastAck: '9223372036854775808' }));
  await assert.rejects(openDurableClient(path, id), /exceeds signed i64/);
  await writeFile(path, '{bad json');
  await assert.rejects(openDurableClient(path, id), /Unexpected token|Expected property name/);
});

test('payload must serialize without loss and baseRevision must be canonical', async t => {
  const { client } = await fixture(t);
  await assert.rejects(client.stage({ recordId: 'r', payload: { number: Number.NaN } }), /losslessly JSON/);
  await assert.rejects(client.stage({ recordId: 'r', payload: { undef: undefined } }), /losslessly JSON/);
  await assert.rejects(client.stage({ recordId: 'r', baseRevision: '01', payload: { value: 1 } }), /canonical/);
  assert.equal(client.snapshot().pending, null);
});

test('concurrent replay invocation is fenced within a process', async t => {
  const { client } = await fixture(t);
  await client.stage({ recordId: 'r', payload: { x: 1 } });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const inflight = client.replay(async sent => { await gate; return reply(sent); });
  await assert.rejects(client.replay(async sent => reply(sent)), /reentrant journal use forbidden/);
  release();
  assert.equal((await inflight).kind, 'acknowledged');
});
