import 'fake-indexeddb/auto';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const profilePath = process.env.OPTO_SYNC_PROFILE;
assert.ok(profilePath, 'OPTO_SYNC_PROFILE is required');
const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
const require = createRequire(import.meta.url);
const sdk = require('../dist/index.js');
const {
  OptoSyncClient,
  QueueQuotaError,
  SYNC_STATUS,
  createOptoSyncClient,
  initOptoSync,
  reconcileIncoming,
} = sdk;

async function deleteDatabase(name) {
  await new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  });
}

async function openClient(databaseName, options = {}) {
  if (typeof initOptoSync === 'function') await initOptoSync();
  if (typeof createOptoSyncClient === 'function') {
    return createOptoSyncClient({ databaseName, stampUpdatedAt: false, ...options });
  }
  return new OptoSyncClient({ databaseName, stampUpdatedAt: false, ...options });
}

function databaseName(suffix) {
  return `opto-chaos-${profile.repository.replaceAll('/', '-')}-${suffix}`;
}

const collection = profile.collections[0];

test('ambiguous push failure replays the exact immutable batch', async (t) => {
  const name = databaseName('ack-loss');
  await deleteDatabase(name);
  t.after(() => deleteDatabase(name));
  const client = await openClient(name);
  const rowId = await client.queueMutation(
    collection,
    'ack-loss-1',
    { id: 'ack-loss-1', value: 'once', updatedAt: 10 },
    { baseRevision: '7' },
  );
  const first = await client.protocolPushRequest();
  await client.recordPushFailure(rowId, 'gateway timeout after commit');
  const replay = await client.protocolPushRequest();
  assert.deepEqual(replay, first);
  assert.equal(replay.mutations.length, 1);
  assert.equal(replay.mutations[0].baseRevision, '7');
  const pending = await client.pendingMutations();
  assert.equal(pending[0].attempts, 1);
  assert.match(pending[0].lastError, /gateway timeout/);
  client.db.close();
});

test('restart preserves client identity, sequence, queue, and checkpoint', async (t) => {
  const name = databaseName('restart');
  await deleteDatabase(name);
  t.after(() => deleteDatabase(name));
  const first = await openClient(name);
  await first.queueMutation(collection, 'r1', { id: 'r1', value: 1, updatedAt: 1 });
  const identity = await first.clientId();
  await first.setPullCheckpoint('41');
  first.db.close();

  const reopened = new OptoSyncClient({ databaseName: name, stampUpdatedAt: false });
  assert.equal(await reopened.clientId(), identity);
  assert.equal(await reopened.pullCheckpoint(), '41');
  assert.equal((await reopened.pendingMutations()).length, 1);
  await reopened.queueMutation(collection, 'r2', { id: 'r2', value: 2, updatedAt: 2 });
  const request = await reopened.protocolPushRequest();
  assert.deepEqual(request.mutations.map((m) => m.mutationId), ['1', '2']);
  reopened.db.close();
});

test('concurrent writers sharing one IndexedDB allocate unique monotonic ids', async (t) => {
  const name = databaseName('concurrent');
  await deleteDatabase(name);
  t.after(() => deleteDatabase(name));
  const a = await openClient(name);
  const b = new OptoSyncClient({ databaseName: name, stampUpdatedAt: false });
  await Promise.all([
    a.queueMutation(collection, 'a', { id: 'a', updatedAt: 1 }),
    b.queueMutation(collection, 'b', { id: 'b', updatedAt: 2 }),
  ]);
  const request = await a.protocolPushRequest();
  const ids = request.mutations.map((m) => BigInt(m.mutationId));
  assert.equal(new Set(ids.map(String)).size, 2);
  assert.deepEqual(ids.sort((x, y) => (x < y ? -1 : 1)), [1n, 2n]);
  a.db.close();
  b.db.close();
});

test('local view rebases pending work over newer server state without flicker', async (t) => {
  const name = databaseName('rebase');
  await deleteDatabase(name);
  t.after(() => deleteDatabase(name));
  const client = await openClient(name);
  await client.queueMutation(collection, 'view-1', {
    id: 'view-1',
    title: 'edited offline',
    nested: { local: true },
    updatedAt: 10,
  });
  const visible = await client.localView(collection, 'view-1', {
    id: 'view-1',
    title: 'stale server echo',
    nested: { remote: true },
    updatedAt: 100,
  });
  assert.equal(visible.title, 'edited offline');
  assert.equal(visible.nested.local, true);
  assert.equal(visible.nested.remote, true);
  client.db.close();
});

test('queue pressure fails closed without consuming ids or pruning pending work', async (t) => {
  const name = databaseName('quota');
  await deleteDatabase(name);
  t.after(() => deleteDatabase(name));
  const client = await openClient(name, {
    maxPendingMutations: 2,
    maxQueuedPayloadBytes: 128,
  });
  await client.queueMutation(collection, 'q1', { id: 'q1', updatedAt: 1 });
  await client.queueMutation(collection, 'q2', { id: 'q2', updatedAt: 2 });
  await assert.rejects(
    () => client.queueMutation(collection, 'q3', { id: 'q3', updatedAt: 3 }),
    (error) => error instanceof QueueQuotaError && error.code === 'QUEUE_FULL',
  );
  assert.equal(await client.pruneConfirmed(0), 0);
  const request = await client.protocolPushRequest();
  assert.deepEqual(request.mutations.map((m) => m.mutationId), ['1', '2']);
  client.db.close();
});

test('oversized payload is rejected before sequence allocation', async (t) => {
  const name = databaseName('payload');
  await deleteDatabase(name);
  t.after(() => deleteDatabase(name));
  const client = await openClient(name, { maxQueuedPayloadBytes: 64 });
  await assert.rejects(
    () => client.queueMutation(collection, 'too-big', {
      id: 'too-big',
      body: 'x'.repeat(256),
      updatedAt: 1,
    }),
    (error) => error instanceof QueueQuotaError && error.code === 'PAYLOAD_TOO_LARGE',
  );
  await client.queueMutation(collection, 'fits', { id: 'fits', updatedAt: 2 });
  const request = await client.protocolPushRequest();
  assert.equal(request.mutations[0].mutationId, '1');
  client.db.close();
});

test('delete remains an explicit tombstone and cannot be mistaken for an upsert', async (t) => {
  const name = databaseName('delete');
  await deleteDatabase(name);
  t.after(() => deleteDatabase(name));
  const client = await openClient(name);
  await client.queueDelete(collection, 'gone', { baseRevision: '12' });
  const request = await client.protocolPushRequest();
  assert.equal(request.mutations[0].operation, 'delete');
  assert.equal(request.mutations[0].recordId, 'gone');
  assert.equal(request.mutations[0].baseRevision, '12');
  assert.equal('payload' in request.mutations[0], false);
  client.db.close();
});

test('failed snapshot install keeps checkpoint and optimistic queue intact', async (t) => {
  const name = databaseName('snapshot');
  await deleteDatabase(name);
  t.after(() => deleteDatabase(name));
  const client = await openClient(name);
  await client.queueMutation(collection, 'pending', { id: 'pending', updatedAt: 1 });
  await assert.rejects(
    () => client.installSnapshot(
      {
        protocolVersion: 1,
        checkpoint: '99',
        records: [{
          table: collection,
          recordId: 'server',
          revision: '1',
          record: { id: 'server', updatedAt: 2 },
        }],
      },
      async () => { throw new Error('authoritative replace failed'); },
    ),
    /authoritative replace failed/,
  );
  assert.equal(await client.pullCheckpoint(), '0');
  assert.equal((await client.pendingMutations()).length, 1);
  client.db.close();
});

test('collection filters and acknowledgements never confirm unrelated work', async (t) => {
  const name = databaseName('isolation');
  await deleteDatabase(name);
  t.after(() => deleteDatabase(name));
  const client = await openClient(name);
  const other = `${collection}_other`;
  const firstId = await client.queueMutation(collection, 'one', { id: 'one', updatedAt: 1 });
  await client.queueMutation(other, 'two', { id: 'two', updatedAt: 2 });
  assert.equal((await client.pendingMutations(collection)).length, 1);
  assert.equal((await client.pendingMutations(other)).length, 1);
  await client.markMutation(firstId, SYNC_STATUS.SYNCED);
  assert.equal((await client.pendingMutations(collection)).length, 0);
  assert.equal((await client.pendingMutations(other)).length, 1);
  client.db.close();
});

test('timestamp winner converges independent of merge direction', async () => {
  if (typeof initOptoSync === 'function') await initOptoSync();
  const older = {
    id: 'converge',
    value: 'older',
    nested: { left: true },
    updatedAt: 10,
  };
  const newer = {
    id: 'converge',
    value: 'newer',
    nested: { right: true },
    updatedAt: 20,
  };
  const left = reconcileIncoming(older, newer);
  const right = reconcileIncoming(newer, older);
  assert.deepEqual(left, right);
  assert.equal(left.value, 'newer');
  assert.equal(left.nested.left, true);
  assert.equal(left.nested.right, true);
});
