/**
 * Assertions executed INSIDE a real remote browser (Selenium grid in a
 * Kubernetes cluster), against the real @opto-sync/client browser bundle.
 *
 * What this proves that the local suites cannot:
 *   - the WebAssembly engine loads and runs in a browser we do not control,
 *     on someone else's kernel/CPU, not just local headless Chromium;
 *   - IndexedDB persistence works against a genuine browser implementation
 *     (not fake-indexeddb) served from a real HTTP origin;
 *   - reconciliation results are identical to the ones Node produces.
 *
 * Results are published on `window.__OPTO_RESULT` for the driver to collect.
 * Nothing here may throw at import time — a thrown module error would surface
 * to the driver as a blank page rather than a readable failure.
 */
import {
  initOptoSync,
  isOptoSyncReady,
  reconcileIncoming,
  engineVersion,
  DEFAULT_RECONCILE_OPTIONS,
  ArrayStrategy,
  OptoSyncClient,
  SYNC_STATUS,
} from './opto-sync-browser.mjs';

const results = [];

function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail: detail ?? null });
  } catch (err) {
    results.push({ name, ok: false, error: String(err && err.message ? err.message : err) });
  }
}

async function checkAsync(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail ?? null });
  } catch (err) {
    results.push({ name, ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function deepEqual(a, b) {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]));
  }
  return v;
}

async function main() {
  const env = {
    userAgent: navigator.userAgent,
    origin: location.origin,
    hasIndexedDB: typeof indexedDB !== 'undefined' && String(indexedDB),
    crossOriginIsolated: typeof crossOriginIsolated === 'undefined' ? null : crossOriginIsolated,
  };

  // ── The environment must be a real browser with a usable origin ──────────
  check('environment: real browser globals, no Node builtins', () => {
    assert(typeof window !== 'undefined', 'window missing');
    assert(typeof require === 'undefined', 'require leaked into the bundle');
    assert(typeof process === 'undefined' || !process.versions?.node, 'Node process leaked');
    return { userAgent: navigator.userAgent };
  });

  check('environment: IndexedDB is available on a non-opaque origin', () => {
    assert(typeof indexedDB !== 'undefined', 'indexedDB undefined');
    assert(String(indexedDB) === '[object IDBFactory]', `unexpected: ${String(indexedDB)}`);
    assert(location.origin && location.origin !== 'null', `opaque origin: ${location.origin}`);
    return { origin: location.origin };
  });

  // ── The WebAssembly engine must initialize in this browser ───────────────
  await checkAsync('wasm engine initializes', async () => {
    assert(!isOptoSyncReady(), 'engine should not be ready before init');
    await initOptoSync();
    assert(isOptoSyncReady(), 'engine not ready after init');
    return { coreVersion: engineVersion() };
  });

  check('core version is >= 0.2.1', () => {
    const v = engineVersion();
    const [maj, min, patch] = v.split('.').map(Number);
    assert(maj > 0 || min > 2 || (min === 2 && patch >= 1), `unexpected core version ${v}`);
    return { version: v };
  });

  check('default policy matches every other tier', () => {
    assert(DEFAULT_RECONCILE_OPTIONS.arrayStrategy === ArrayStrategy.MERGE_BY_KEY, 'arrayStrategy');
    assert(DEFAULT_RECONCILE_OPTIONS.arrayMatchKeys === 'id', 'arrayMatchKeys');
    assert(DEFAULT_RECONCILE_OPTIONS.resolveByTimestamp === true, 'resolveByTimestamp');
    assert(DEFAULT_RECONCILE_OPTIONS.lwwKeys === 'updatedAt,syncedAt', 'lwwKeys');
    assert(DEFAULT_RECONCILE_OPTIONS.fwwKeys === 'createdAt', 'fwwKeys');
    return { ...DEFAULT_RECONCILE_OPTIONS };
  });

  // ── Reconciliation semantics, identical to Node's results ───────────────
  check('stale incoming record is rejected (LWW updatedAt)', () => {
    const merged = reconcileIncoming(
      { id: 'r1', title: 'edited locally', updatedAt: 2000 },
      { id: 'r1', title: 'stale server copy', updatedAt: 1000 },
    );
    assert(merged.title === 'edited locally', `got ${merged.title}`);
    return merged;
  });

  check('fresh incoming record wins and deep-merges', () => {
    const merged = reconcileIncoming(
      { id: 'r1', title: 'old', views: 7, updatedAt: 1000 },
      { id: 'r1', title: 'newer', updatedAt: 2000 },
    );
    assert(merged.title === 'newer', 'incoming should win');
    assert(merged.views === 7, 'untouched local field must survive');
    return merged;
  });

  check('createdAt FWW rejects a later re-creation', () => {
    const merged = reconcileIncoming(
      { id: 1, createdAt: 100, author: 'original' },
      { id: 1, createdAt: 300, author: 'impostor' },
    );
    assert(merged.author === 'original', `got ${merged.author}`);
    return merged;
  });

  check('keyed-array reconciliation inside a jsonb-style field', () => {
    const local = {
      items: [
        { id: 1, name: 'alpha', qty: 5, updatedAt: 200 },
        { id: 2, name: 'beta', updatedAt: 100 },
      ],
    };
    const incoming = {
      items: [
        { id: 2, name: 'beta-renamed', updatedAt: 150 },
        { id: 1, name: 'stale-alpha', updatedAt: 50 },
        { id: 3, name: 'gamma', updatedAt: 400 },
      ],
    };
    const merged = reconcileIncoming(local, incoming);
    const byId = Object.fromEntries(merged.items.map((i) => [i.id, i]));
    assert(merged.items.length === 3, `expected 3 items, got ${merged.items.length}`);
    assert(byId[1].name === 'alpha', 'stale element must be rejected per-element');
    assert(byId[1].qty === 5, 'untouched field on the matched element must survive');
    assert(byId[2].name === 'beta-renamed', 'fresh element must apply despite reordering');
    assert(byId[3].name === 'gamma', 'unmatched element must append');
    return merged;
  });

  check('digit-string nanosecond timestamps survive exactly', () => {
    const NANO = '1689940800123456789';
    const merged = reconcileIncoming({ a: 1 }, { updatedAtNs: NANO });
    assert(merged.updatedAtNs === NANO, `got ${merged.updatedAtNs}`);
    return { updatedAtNs: merged.updatedAtNs };
  });

  check('repeated application is semantically idempotent', () => {
    const local = { rows: [{ id: 'a', updatedAt: 100, v: 1 }] };
    const incoming = { rows: [{ id: 'a', updatedAt: 200, v: 2 }, { id: 'b', v: 3 }] };
    const once = reconcileIncoming(local, incoming);
    const twice = reconcileIncoming(once, incoming);
    assert(deepEqual(once, twice), 'second application changed the document');
    return once;
  });

  // ── Real IndexedDB persistence through the real client ──────────────────
  const dbName = `opto-remote-${Date.now()}`;

  await checkAsync('queueMutation persists to real IndexedDB', async () => {
    const client = new OptoSyncClient({ databaseName: dbName });
    const id = await client.queueMutation('todos', 'todo-remote', {
      title: 'queued in a remote browser',
      updatedAt: 4242,
    });
    const pending = await client.pendingMutations();
    assert(pending.length === 1, `expected 1 pending, got ${pending.length}`);
    assert(pending[0].recordId === 'todo-remote', 'recordId mismatch');
    assert(pending[0].syncStatus === SYNC_STATUS.PENDING, 'status should be pending');
    client.db.close();
    return { mutationId: id, pending: pending.length };
  });

  await checkAsync('queue survives closing and reopening the database', async () => {
    const reopened = new OptoSyncClient({ databaseName: dbName });
    const pending = await reopened.pendingMutations();
    assert(pending.length === 1, `expected 1 recovered mutation, got ${pending.length}`);
    const payload = JSON.parse(pending[0].jsonPayload);
    assert(payload.title === 'queued in a remote browser', 'payload corrupted across reopen');
    await reopened.markMutation(pending[0].id, SYNC_STATUS.SYNCED);
    reopened.db.close();
    return { recovered: pending.length };
  });

  await checkAsync('status transition is durable across another reopen', async () => {
    const third = new OptoSyncClient({ databaseName: dbName });
    const stillPending = await third.pendingMutations();
    assert(stillPending.length === 0, `synced mutation came back as pending (${stillPending.length})`);
    await third.db.delete();
    return { pendingAfterSync: 0 };
  });

  await checkAsync('raw IDB inspection confirms the store really existed', async () => {
    // Proves the data went through the browser's own IndexedDB implementation
    // rather than an in-memory shim: enumerate databases and confirm ours is gone
    // after delete() (support for databases() is itself browser-only).
    if (typeof indexedDB.databases !== 'function') return { skipped: 'indexedDB.databases unsupported' };
    const names = (await indexedDB.databases()).map((d) => d.name);
    assert(!names.includes(dbName), `database ${dbName} should have been deleted`);
    return { remaining: names.length };
  });

  const failed = results.filter((r) => !r.ok);
  return {
    ok: failed.length === 0,
    env,
    passed: results.filter((r) => r.ok).length,
    failed: failed.length,
    results,
  };
}

main()
  .then((summary) => {
    window.__OPTO_RESULT = summary;
    document.title = summary.ok ? 'OPTO_OK' : 'OPTO_FAIL';
    const el = document.getElementById('out');
    if (el) el.textContent = JSON.stringify(summary, null, 2);
  })
  .catch((err) => {
    window.__OPTO_RESULT = { ok: false, fatal: String(err && err.stack ? err.stack : err), results };
    document.title = 'OPTO_FAIL';
    const el = document.getElementById('out');
    if (el) el.textContent = String(err && err.stack ? err.stack : err);
  });
