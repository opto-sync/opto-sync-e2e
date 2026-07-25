/**
 * CLIENT-IN-THE-LOOP e2e: @opto-sync/client against the live node+Postgres server.
 *
 * What makes these different from the library's own unit tests: the real Dexie
 * mutation queue and the real reconcile path are driven against a REAL server
 * that merges with the same syncer.c core, over HTTP, with the document
 * round-tripping through Postgres jsonb. The library ships no transport, so the
 * transport lives here — the library's queue lifecycle (pending -> synced/failed)
 * and its reconcile output are what is under test.
 */
import '../../../../opto-sync-clients/clients/ts/node_modules/fake-indexeddb/auto/index.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import {
  ArrayStrategy,
  DEFAULT_RECONCILE_OPTIONS,
  OptoSyncClient,
  SYNC_STATUS,
  engineVersion,
  reconcileIncoming,
} from '../../../../opto-sync-clients/clients/ts/dist/index.js';

import {
  SCENARIOS,
  SERVER_POLICY,
  assertDeepEqual,
  docId,
  getDocData,
  getDocRaw,
  getDocRow,
  probeServer,
  putDoc,
  statusCounts,
  syncBatch,
  syncDoc,
  BASE_URL,
} from './support.mjs';

/* Probe ONCE, up front. Every test is skipped with the same clear reason if the
 * server is not there — the suite must never hang waiting on a dead socket. */
const skipReason = await probeServer();
const opts = skipReason ? { skip: `server unavailable: ${skipReason}` } : {};

if (skipReason) {
  console.error(`\n[ts] SKIPPING client-in-the-loop e2e — ${skipReason}\n`);
} else {
  console.error(`[ts] client-in-the-loop e2e against ${BASE_URL} (core ${engineVersion()})`);
}

const S = SCENARIOS.scenarios;

let dbSeq = 0;
const openClients = [];

/**
 * A fresh client with an isolated IndexedDB, so no test can see another's queue,
 * configured with the SERVER's merge policy (see SERVER_POLICY for why that has
 * to be spelled out for the TypeScript client but not for Dart/Rust).
 */
function freshClient() {
  const client = new OptoSyncClient({
    ...SERVER_POLICY,
    databaseName: `opto-e2e-ts-${++dbSeq}`,
  });
  openClients.push(client);
  return client;
}

after(async () => {
  for (const c of openClients) {
    try {
      await c.db.delete();
    } catch {
      /* best effort */
    }
  }
});

/**
 * Flush one queued mutation through the real client lifecycle:
 * read it back out of the queue, push it, then mark it synced or failed
 * according to what the server actually said.
 */
async function flushOne(client, mutation, id) {
  const res = await syncDoc(id, JSON.parse(mutation.jsonPayload));
  await client.markMutation(mutation.id, res.ok ? SYNC_STATUS.SYNCED : SYNC_STATUS.FAILED);
  return res;
}

/* ==================================================================== */
/* Cross-tier policy agreement                                          */
/* ==================================================================== */

test('0. client defaults match the server policy on every tier', async () => {
  // Pure library behavior, so it runs even with the server down. This started
  // life as a bug pin: @opto-sync/client omitted arrayStrategy and so fell
  // back to the binding's REPLACE default, which dropped local-only array
  // elements and applied stale ones. The default now matches the server and
  // the Dart/Rust clients; this test keeps all four tiers locked together.
  assert.equal(DEFAULT_RECONCILE_OPTIONS.arrayStrategy, ArrayStrategy.MERGE_BY_KEY);
  assert.equal(DEFAULT_RECONCILE_OPTIONS.arrayMatchKeys, 'id');
  assert.equal(DEFAULT_RECONCILE_OPTIONS.resolveByTimestamp, true);
  assert.equal(DEFAULT_RECONCILE_OPTIONS.lwwKeys, 'updatedAt,syncedAt');
  // No FWW key on any tier: FWW is a node-level veto, so a default FWW key
  // lets a replica holding a later `createdAt` lock a record forever.
  assert.equal(DEFAULT_RECONCILE_OPTIONS.fwwKeys, undefined);

  // Explicit SERVER_POLICY and the client's own defaults must be equivalent:
  // local-only rows survive and a stale incoming element is rejected.
  const localCopy = {
    rows: [
      { id: 'r1', label: 'local-only-row' },
      { id: 'r2', updatedAt: 9000, label: 'fresh-local' },
    ],
  };
  const staleIncoming = { rows: [{ id: 'r2', updatedAt: 1, label: 'stale-server' }] };

  assert.deepEqual(reconcileIncoming(localCopy, staleIncoming), localCopy);
  assert.deepEqual(
    reconcileIncoming(localCopy, staleIncoming, SERVER_POLICY),
    reconcileIncoming(localCopy, staleIncoming),
  );
});

/* ==================================================================== */
/* Scenario 1 — offline queue -> flush -> server merge                  */
/* ==================================================================== */

test('1a. offline queue flushed one-by-one: all synced, server has every contribution', opts, async () => {
  const fx = S.offlineQueue;
  const id = docId(fx.docSuffixIndividual);
  await putDoc(id, fx.base);

  const client = freshClient();

  // "Offline": queue everything, send nothing.
  const queuedIds = [];
  for (const m of fx.mutations) queuedIds.push(await client.queueMutation('docs', id, m));

  let pending = await client.pendingMutations();
  assert.equal(pending.length, fx.mutations.length, 'all mutations must be queued as pending');
  assert.deepEqual(
    (await statusCounts(client)),
    { total: 3, pending: 3, synced: 0, failed: 0 },
    'nothing may be marked synced before a flush',
  );
  assert.equal(await getDocData(id).then((d) => d.m1), undefined, 'server must be untouched while offline');

  // Back online: flush in queue order.
  pending = (await client.pendingMutations()).sort((a, b) => a.id - b.id);
  for (const m of pending) {
    const res = await flushOne(client, m, id);
    assert.equal(res.status, 200, `sync of mutation ${m.id} should succeed: ${res.text}`);
    assert.equal(res.json.merged, true);
    assert.equal(res.json.mergedWith, 'native-c-ffi', 'the server must merge with the C core');
  }

  assert.equal((await client.pendingMutations()).length, 0, 'queue must be drained');
  assert.deepEqual(await statusCounts(client), { total: 3, pending: 0, synced: 3, failed: 0 });
  assert.deepEqual(queuedIds.length, 3);

  assertDeepEqual(await getDocData(id), fx.expected, 'server document after individual flush');
});

test('1b. offline queue flushed atomically via /sync/batch: same result', opts, async () => {
  const fx = S.offlineQueue;
  const id = docId(fx.docSuffixBatch);
  await putDoc(id, fx.base);

  const client = freshClient();
  for (const m of fx.mutations) await client.queueMutation('docs', id, m);

  const pending = (await client.pendingMutations()).sort((a, b) => a.id - b.id);
  assert.equal(pending.length, 3);

  const result = await syncBatch(
    pending.map((m) => ({ docId: id, payload: JSON.parse(m.jsonPayload) })),
  );
  assert.equal(result.applied, 3, `all three mutations must apply: ${JSON.stringify(result)}`);

  for (const m of pending) await client.markMutation(m.id, SYNC_STATUS.SYNCED);
  assert.deepEqual(await statusCounts(client), { total: 3, pending: 0, synced: 3, failed: 0 });

  assertDeepEqual(await getDocData(id), fx.expected, 'server document after batch flush');
});

/* ==================================================================== */
/* Scenario 2 — optimistic local write, then pull-back reconcile        */
/* ==================================================================== */

test('2. optimistic local write then server pull-back reconcile converges', opts, async () => {
  const fx = S.optimisticPullback;
  const id = docId(fx.docSuffix);
  await putDoc(id, fx.base);

  const client = freshClient();

  // Optimistic: apply the mutation to the local copy through the client's own
  // reconcile path (NOT a hand-rolled object spread) before any network I/O.
  const localAfterOptimistic = client.reconcileIncoming('docs', id, fx.mutation, fx.base);
  assertDeepEqual(localAfterOptimistic, fx.expected, 'local copy after optimistic apply');

  // Push, then pull the server's own view back.
  const mid = await client.queueMutation('docs', id, fx.mutation);
  const res = await syncDoc(id, fx.mutation);
  assert.equal(res.status, 200, res.text);
  await client.markMutation(mid, SYNC_STATUS.SYNCED);

  const serverData = await getDocData(id);
  assertDeepEqual(serverData, fx.expected, 'server document after push');

  // Reconcile the pulled server state back into the local copy.
  const localAfterPullback = client.reconcileIncoming('docs', id, serverData, localAfterOptimistic);
  assertDeepEqual(localAfterPullback, serverData, 'local copy after pull-back vs server');
  assertDeepEqual(localAfterPullback, fx.expected, 'local copy after pull-back vs expectation');

  // The stored jsonb text is NOT the string we sent — proof that comparing raw
  // strings would be wrong, and that we never do.
  const raw = await getDocRaw(id);
  assertDeepEqual(JSON.parse(raw), fx.expected, 'raw jsonb text parses to the same value');
});

/* ==================================================================== */
/* Scenario 3 — stale-write rejection round-trip, both directions       */
/* ==================================================================== */

test('3. stale server state loses to newer local; fresher server state wins', opts, async () => {
  const fx = S.staleRejection;
  const id = docId(fx.docSuffix);
  const client = freshClient();

  // Server holds an OLDER state than the local copy.
  await putDoc(id, fx.serverStale);
  const stale = await getDocData(id);
  assertDeepEqual(stale, fx.serverStale, 'server precondition (stale)');

  const survived = client.reconcileIncoming('docs', id, stale, fx.local);
  assertDeepEqual(survived, fx.expectedLocalSurvives, 'local value must survive a stale server pull');
  assert.equal(survived.sOnly, undefined, 'whole-object rejection: no key from the stale doc may leak in');

  // Now the server holds a NEWER state.
  await putDoc(id, fx.serverFresh);
  const fresh = await getDocData(id);
  const overwritten = client.reconcileIncoming('docs', id, fresh, fx.local);
  assertDeepEqual(overwritten, fx.expectedServerWins, 'fresher server state must win');
  assert.equal(overwritten.lOnly, 'local-marker', 'the accepted merge must descend and keep local-only keys');
});

/* ==================================================================== */
/* Scenario 4 — keyed-array reconciliation through the full stack       */
/* ==================================================================== */

test('4. keyed array: untouched kept, fresh applied, stale rejected, new appended', opts, async () => {
  const fx = S.keyedArray;
  const id = docId(fx.docSuffix);
  await putDoc(id, fx.base);

  const client = freshClient();
  const localCopy = client.reconcileIncoming('docs', id, fx.mutation, fx.base);
  assertDeepEqual(localCopy, fx.expected, 'client-side keyed-array reconcile');

  const mid = await client.queueMutation('docs', id, fx.mutation);
  const res = await syncDoc(id, fx.mutation);
  assert.equal(res.status, 200, res.text);
  await client.markMutation(mid, SYNC_STATUS.SYNCED);

  const serverData = await getDocData(id);
  assertDeepEqual(serverData, fx.expected, 'server keyed-array merge');

  const rows = serverData.rows;
  assert.equal(rows.length, 4, 'exactly one new identity may be appended');
  assert.equal(rows.filter((r) => r.id === 'r4').length, 1, 'r4 must not be duplicated');
  assert.equal(rows[3].id, 'r4', 'a new identity is appended at the END of the base array');
  assert.equal(rows.find((r) => r.id === 'r3').label, 'server-fresh', 'the stale element must not be applied');
  assert.equal(rows.find((r) => r.id === 'r1').label, 'untouched', 'the untouched element must be preserved');

  // And the client's reconcile of the pulled state agrees.
  assertDeepEqual(
    client.reconcileIncoming('docs', id, serverData, localCopy),
    fx.expected,
    'client reconcile of the pulled keyed array',
  );
});

/* ==================================================================== */
/* Scenario 5 — replay / retry idempotency                             */
/* ==================================================================== */

test('5. replaying the same queued mutation leaves the document semantically unchanged', opts, async () => {
  const fx = S.replayIdempotency;
  const id = docId(fx.docSuffix);
  await putDoc(id, fx.base);

  const client = freshClient();
  const mid = await client.queueMutation('docs', id, fx.mutation);
  const [queued] = await client.pendingMutations();
  const payload = JSON.parse(queued.jsonPayload);

  // First flush.
  assert.equal((await syncDoc(id, payload)).status, 200);
  const afterFirst = await getDocRow(id);
  assertDeepEqual(afterFirst.data, fx.expected, 'document after first flush');

  // Ambiguous network failure: the client never learned the first attempt
  // landed, so it replays the very same payload.
  assert.equal((await syncDoc(id, payload)).status, 200);
  const afterSecond = await getDocRow(id);

  assert.ok(
    afterSecond.version > afterFirst.version,
    `the replay must really have written (version ${afterFirst.version} -> ${afterSecond.version})`,
  );
  assertDeepEqual(afterSecond.data, afterFirst.data, 'replay must not change the document');
  assertDeepEqual(afterSecond.data, fx.expected, 'document after replay');
  assert.equal(afterSecond.data.tags.length, 2, 'identity-less array elements must not duplicate on replay');
  assert.equal(afterSecond.data.rows.length, 2, 'keyed array elements must not duplicate on replay');

  await client.markMutation(mid, SYNC_STATUS.SYNCED);
  assert.deepEqual(await statusCounts(client), { total: 1, pending: 0, synced: 1, failed: 0 });
});

/* ==================================================================== */
/* Scenario 6 — failure marking                                        */
/* ==================================================================== */

test('6. a mutation against a nonexistent document is marked failed, not synced', opts, async () => {
  const fx = S.failureMarking;
  const missingId = docId(fx.missingSuffix);
  const okId = docId(fx.okSuffix);
  await putDoc(okId, fx.okBase);

  const client = freshClient();
  const doomedId = await client.queueMutation('docs', missingId, fx.mutationDoomed);

  const doomed = (await client.pendingMutations()).find((m) => m.id === doomedId);
  const res = await flushOne(client, doomed, missingId);
  assert.equal(res.status, 404, `the server must reject an unknown document: ${res.text}`);

  assert.deepEqual(
    await statusCounts(client),
    { total: 1, pending: 0, synced: 0, failed: 1 },
    'the failed mutation must be FAILED and must not count as pending or synced',
  );
  const stored = await client.db.localMutations.get(doomedId);
  assert.equal(stored.syncStatus, SYNC_STATUS.FAILED);

  // A subsequent good mutation must not inherit the failure.
  const goodId = await client.queueMutation('docs', okId, fx.mutationOk);
  assert.deepEqual(
    await statusCounts(client),
    { total: 2, pending: 1, synced: 0, failed: 1 },
    'pending/failed accounting must be per-mutation',
  );
  const good = (await client.pendingMutations()).find((m) => m.id === goodId);
  assert.equal((await flushOne(client, good, okId)).status, 200);

  assert.deepEqual(
    await statusCounts(client),
    { total: 2, pending: 0, synced: 1, failed: 1 },
    'final accounting: one synced, one failed, nothing pending',
  );
  assertDeepEqual(await getDocData(okId), fx.expectedOk, 'the good mutation still landed');
});
