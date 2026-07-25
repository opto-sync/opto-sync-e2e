/**
 * Scenario 7 phase runner for @opto-sync/client — cross-client convergence.
 *
 * Invoked by run_all.sh as one step of an orchestrated sequence:
 *
 *   node converge.mjs setup    # PUT the fresh fixture document
 *   node converge.mjs flush    # queue this client's payload and flush it
 *   node converge.mjs verify   # assert the final server doc + local reconcile
 *
 * Split into phases on purpose: `flush` must run once per language, in the
 * fixture's declared order, against the SAME document, so the phases cannot
 * live inside a single language's test process.
 */
import '../../../../opto-sync-clients/clients/ts/node_modules/fake-indexeddb/auto/index.mjs';
import {
  OptoSyncClient,
  SYNC_STATUS,
} from '../../../../opto-sync-clients/clients/ts/dist/index.js';

import {
  BASE_URL,
  CROSS_CLIENT as FX,
  SERVER_POLICY,
  assertDeepEqual,
  assertDeepEqualKeyed,
  getDocData,
  probeServer,
  putDoc,
  statusCounts,
  syncDoc,
} from './support.mjs';

const LANG = 'ts';
const phase = process.argv[2];
let checks = 0;

function ok(what) {
  checks += 1;
  console.log(`ok - [${LANG}/converge/${phase}] ${what}`);
}

function check(condition, what) {
  if (!condition) throw new Error(what);
  ok(what);
}

function checkEqual(actual, expected, what) {
  assertDeepEqual(actual, expected, what);
  ok(what);
}

async function setup() {
  await putDoc(FX.docId, FX.base);
  checkEqual(await getDocData(FX.docId), FX.base, `fresh document ${FX.docId} written`);
}

async function flush() {
  const payload = FX.payloads[LANG];
  if (!payload) throw new Error(`fixture has no payload for "${LANG}"`);

  // fake-indexeddb is per-process, but name the DB uniquely anyway so a rerun
  // can never observe a previous run's queue.
  const client = new OptoSyncClient({
    ...SERVER_POLICY,
    databaseName: `opto-e2e-converge-${LANG}-${Date.now()}`,
  });

  const mid = await client.queueMutation('docs', FX.docId, payload);
  check((await client.pendingMutations()).length === 1, 'payload queued as pending');

  const [queued] = await client.pendingMutations();
  const res = await syncDoc(FX.docId, JSON.parse(queued.jsonPayload));
  await client.markMutation(mid, res.ok ? SYNC_STATUS.SYNCED : SYNC_STATUS.FAILED);
  check(res.status === 200, `flushed to ${FX.docId} (HTTP ${res.status})`);
  check(res.json?.mergedWith === 'native-c-ffi', 'server merged with the native C core');

  const counts = await statusCounts(client);
  check(counts.synced === 1 && counts.pending === 0 && counts.failed === 0,
    `queue drained (${JSON.stringify(counts)})`);
  await client.db.delete();
}

async function verify() {
  const serverFinal = await getDocData(FX.docId);

  // (a) strict, order-sensitive: the server document is fully determined.
  checkEqual(serverFinal, FX.expectedFinal, 'final server document matches the predicted merge exactly');

  // Spot-check the load-bearing policy claims, so a failure names the rule.
  check(serverFinal.title === 'rust title',
    'unguarded root scalar follows arrival order (last flusher wins)');
  check(serverFinal.revision.owner === 'dart' && serverFinal.revision.updatedAt === 4000,
    'guarded object follows updatedAt, NOT flush order: rust flushed last but is stale');
  check(serverFinal.revision.priority === 2, "rust's stale revision was rejected WHOLESALE");
  // Base-only root scalar: no client payload sends a root `createdAt`, so
  // nothing can overwrite it. (This used to be attributed to FWW; `createdAt` is
  // no longer a guarded key on any tier — see SERVER_POLICY.)
  check(serverFinal.createdAt === 1000, 'base-only root createdAt untouched by every client');
  check(serverFinal.items.length === 5, 'exactly three new identities appended');
  const shared = serverFinal.items.find((i) => i.id === 'shared');
  check(shared.label === 'dart-shared' && shared.qty === 20 && shared.createdAt === 1000,
    "the shared element carries dart's write deep-merged onto the base element");
  check(serverFinal.items.find((i) => i.id === 'keep').label === 'untouched',
    'the element nobody touched is preserved verbatim');
  check(serverFinal.items.map((i) => i.id).join(',') === 'keep,shared,ts-new,dart-new,rust-new',
    'appended identities appear in flush order at the end of the array');

  // (b) this client's own local reconcile of the final state.
  const client = new OptoSyncClient({
    ...SERVER_POLICY,
    databaseName: `opto-e2e-verify-${LANG}-${Date.now()}`,
  });
  const localCopy = FX.payloads[LANG];
  const reconciled = client.reconcileIncoming('docs', FX.docId, serverFinal, localCopy);
  assertDeepEqualKeyed(reconciled, FX.expectedFinal,
    `${LANG} local reconcile of the final server state`);
  ok(`${LANG} local reconcile of the final server state agrees with every other client`);
  await client.db.delete();
}

const phases = { setup, flush, verify };

async function main() {
  if (!phases[phase]) {
    console.error(`usage: node converge.mjs <${Object.keys(phases).join('|')}>`);
    process.exit(2);
  }
  const reason = await probeServer();
  if (reason) {
    console.error(`[${LANG}] SKIP converge/${phase} — server unavailable: ${reason}`);
    process.exit(0);
  }
  await phases[phase]();
  console.log(`# [${LANG}] converge/${phase}: ${checks} checks passed against ${BASE_URL}`);
}

main().catch((err) => {
  console.error(`not ok - [${LANG}/converge/${phase}] ${err.message}`);
  process.exit(1);
});
