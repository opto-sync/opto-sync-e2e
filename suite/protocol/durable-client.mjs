import assert from 'node:assert/strict';
import { open, lstat, readFile, rename, mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertPushCorrelation, decimal } from './refinement-oracle.mjs';

// Node reference adapter for a future AttoLang client. NOT compiled AttoLang.
// One owner/process per journal; a second concurrent writer requires a separate
// lease/fencing implementation and is explicitly outside this adapter's scope.
const textId = (s, field) => {
  assert.equal(typeof s, 'string', `${field} must be text`);
  assert.ok(s.length > 0 && s.length <= 128, `${field} must be 1..128 characters`);
  return s;
};
const maxId = (1n << 63n) - 1n;
const mutationId = (value, field) => {
  const id = decimal(value, field);
  assert.ok(id <= maxId, `${field} exceeds signed i64 maximum`);
  return id;
};
const cloneJson = (x) => {
  const encoded = JSON.stringify(x);
  assert.equal(typeof encoded, 'string', 'value is not JSON');
  const result = JSON.parse(encoded);
  assert.deepEqual(result, x, 'value is not losslessly JSON serializable');
  return result;
};
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

function validate(state, identity) {
  assert.ok(isObject(state), 'invalid journal object');
  assert.deepEqual(Object.keys(state).sort(), ['clientId', 'lastAck', 'pending', 'schema', 'tenant'].sort(), 'unexpected journal keys');
  assert.equal(state.schema, 1, 'unsupported journal format');
  assert.equal(state.tenant, identity.tenant, 'journal tenant mismatch');
  assert.equal(state.clientId, identity.clientId, 'journal client mismatch');
  const ack = mutationId(state.lastAck, 'lastAck');
  if (state.pending !== null) {
    const p = state.pending;
    assert.ok(isObject(p), 'invalid pending mutation');
    assert.deepEqual(Object.keys(p).sort(), ['baseRevision', 'mutationId', 'payload', 'recordId'].sort(), 'unexpected pending fields');
    assert.equal(mutationId(p.mutationId, 'pending mutationId'), ack + 1n, 'pending ID not next sequential ID');
    textId(p.recordId, 'recordId');
    mutationId(p.baseRevision, 'baseRevision');
    assert.ok(isObject(p.payload), 'payload must be an object');
    cloneJson(p.payload);
  }
  cloneJson(state);
  return state;
}

async function persist(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(data)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    // Sync directory entry: the journal must be durable before any send.
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    if (handle) await handle.close();
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

export async function openDurableClient(path, { tenant, clientId }) {
  const identity = { tenant: textId(tenant, 'tenant'), clientId: textId(clientId, 'clientId') };
  await mkdir(dirname(path), { recursive: true });
  let state;
  try {
    const stat = await lstat(path);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'journal must be a regular file');
    state = validate(JSON.parse(await readFile(path, 'utf8')), identity);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    state = { schema: 1, ...identity, lastAck: '0', pending: null };
    await persist(path, state);
  }
  let active = false;
  const locked = async (fn) => {
    assert.ok(!active, 'reentrant journal use forbidden');
    active = true;
    try { return await fn(); } finally { active = false; }
  };
  return {
    snapshot() { return cloneJson(state); },
    async stage({ recordId, baseRevision, payload }) {
      return locked(async () => {
        assert.equal(state.pending, null, 'previous mutation must be acknowledged first');
        assert.ok(isObject(payload), 'payload must be an object');
        const next = mutationId(state.lastAck, 'lastAck') + 1n;
        assert.ok(next <= maxId, 'mutation ID exhausted');
        const pending = {
          mutationId: next.toString(), recordId: textId(recordId, 'recordId'),
          baseRevision: baseRevision ?? '0', payload: cloneJson(payload),
        };
        validate({ ...state, pending }, identity);
        await persist(path, { ...state, pending });
        state = { ...state, pending };
        return cloneJson(pending);
      });
    },
    envelope() {
      assert.ok(state.pending, 'no durable pending mutation');
      const { mutationId: id, recordId, baseRevision, payload } = state.pending;
      return cloneJson({ protocolVersion: 1, clientId, mutations: [{
        mutationId: id, operation: 'upsert', table: 'docs', recordId, baseRevision, payload,
      }] });
    },
    async replay(send, { beforeAckPersist } = {}) {
      return locked(async () => {
        assert.ok(state.pending, 'no pending mutation to replay');
        const envelope = this.envelope();
        let reply;
        try { reply = await send(envelope); }
        catch { return { kind: 'unknown', mutationId: state.pending.mutationId }; }
        if (reply.status !== 200) return { kind: 'not_acknowledged', status: reply.status };
        // Reject malformed, stale, forged and future responses BEFORE clearing
        // the local write-ahead journal. No optimistic local ACK is permitted.
        const result = reply.json?.results?.[0];
        assert.ok(['applied', 'rejected', 'duplicate'].includes(result?.status), 'unexpected ACK outcome');
        if (result.status === 'duplicate') {
          assert.ok(['applied', 'rejected'].includes(result.originalStatus), 'duplicate missing original outcome');
        }
        const checkpoint = assertPushCorrelation(envelope, reply, { status: result.status, originalStatus: result.status === 'duplicate' ? result.originalStatus : undefined });
        if (beforeAckPersist) await beforeAckPersist();
        const next = validate({ ...state, lastAck: state.pending.mutationId, pending: null }, identity);
        await persist(path, next);
        state = next;
        return { kind: 'acknowledged', status: result.status, checkpoint: checkpoint.toString() };
      });
    },
  };
}
