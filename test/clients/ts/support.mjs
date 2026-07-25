/**
 * Shared support for the @opto-sync/client client-in-the-loop e2e suite.
 *
 * Everything here is deliberately dependency-free: the client library is
 * imported straight from its BUILT dist/ output — exactly the artifact external
 * projects consume — via a relative path, and fake-indexeddb comes from the
 * client's own node_modules. No `npm install` in this directory, so the suite
 * cannot drift from the library it is supposed to be testing.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { inspect } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));

/** test/clients/ts -> .../opto-sync-clients/clients/ts */
export const TS_CLIENT_DIR = resolve(HERE, '../../../../opto-sync-clients/clients/ts');
export const FIXTURES_DIR = resolve(HERE, '../fixtures');

export const BASE_URL = (process.env.OPTO_SYNC_SERVER_URL || 'http://localhost:3003').replace(/\/$/, '');
export const LANG = 'ts';

/**
 * The server's merge policy, stated explicitly (see GET /health defaultOptions).
 *
 * !! WHY THIS OBJECT HAS TO EXIST !!
 *
 * @opto-sync/client's DEFAULT_RECONCILE_OPTIONS sets only resolveByTimestamp /
 * lwwKeys / fwwKeys. It does NOT set arrayStrategy or arrayMatchKeys, so the
 * native core falls back to ArrayStrategy.REPLACE — while the server, the Dart
 * client (FfiSyncer defaults to mergeByKey + 'id') and the Rust client
 * (ReconcileOptions::default() -> MergeByKey + "id") all use MERGE_BY_KEY on
 * "id". Out of the box the TypeScript client therefore reconciles arrays by
 * wholesale replacement: pulling a server document silently DROPS local
 * elements the server has not seen and APPLIES elements the timestamp guard
 * should have rejected.
 *
 * See the "KNOWN DIVERGENCE" test in scenarios.test.mjs, which pins the current
 * default so that fixing the client fails loudly here instead of drifting.
 *
 * Every client in this suite is configured with the server's policy so the three
 * languages are compared on equal terms.
 */
export const SERVER_POLICY = Object.freeze({
  arrayStrategy: 4, // ArrayStrategy.MERGE_BY_KEY
  arrayMatchKeys: 'id',
  resolveByTimestamp: true,
  lwwKeys: 'updatedAt,syncedAt',
  fwwKeys: 'createdAt',
});

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

export function loadFixture(name) {
  return JSON.parse(readFileSync(resolve(FIXTURES_DIR, name), 'utf8'));
}

export const SCENARIOS = loadFixture('scenarios.json');
export const CROSS_CLIENT = loadFixture('cross_client.json');

/** Namespaced document id so the three language suites never collide. */
export function docId(suffix) {
  return `${SCENARIOS.docIdPrefix}-${LANG}-${suffix}`;
}

/* ------------------------------------------------------------------ */
/* HTTP                                                               */
/* ------------------------------------------------------------------ */

const TIMEOUT_MS = 10_000;

async function request(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body (shouldn't happen) — surfaced via .text */
  }
  return { status: res.status, ok: res.ok, json, text };
}

/**
 * Probe the server. Returns null when healthy, otherwise a human-readable
 * reason so the suite can SKIP with a clear message instead of hanging.
 */
export async function probeServer() {
  try {
    const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return `${BASE_URL}/health returned HTTP ${res.status}`;
    const health = await res.json();
    if (health.status !== 'ok') return `${BASE_URL}/health reported status=${health.status}`;
    if (health.syncer !== 'native') {
      return `server is running the ${health.syncer} merge, not the native syncer.c core — client/server convergence would be meaningless`;
    }
    return null;
  } catch (err) {
    return `${BASE_URL} is unreachable (${err?.cause?.code || err?.name || err?.message}). ` +
      `Start the stack (docker compose up -d postgres node) or set OPTO_SYNC_SERVER_URL.`;
  }
}

/** Create-or-replace a document outright (test setup, not a merge). */
export async function putDoc(id, payload) {
  const res = await request('PUT', `/doc/${encodeURIComponent(id)}`, payload);
  if (!res.ok) throw new Error(`PUT /doc/${id} failed: HTTP ${res.status} ${res.text}`);
  return res.json;
}

/** GET the parsed document body (the jsonb `data` column). */
export async function getDocData(id) {
  const res = await request('GET', `/doc/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`GET /doc/${id} failed: HTTP ${res.status} ${res.text}`);
  return res.json.data;
}

/** GET the full row: { id, data, version, updated_at, deleted_at }. */
export async function getDocRow(id) {
  const res = await request('GET', `/doc/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`GET /doc/${id} failed: HTTP ${res.status} ${res.text}`);
  return res.json;
}

/** Exact stored jsonb text — proves we never depend on key ordering. */
export async function getDocRaw(id) {
  const res = await request('GET', `/doc/${encodeURIComponent(id)}/raw`);
  if (!res.ok) throw new Error(`GET /doc/${id}/raw failed: HTTP ${res.status} ${res.text}`);
  return res.text;
}

/** POST /doc/:id/sync. Returns { status, ok, json } — never throws on 4xx, so
 *  failure-marking scenarios can inspect the status the way a client would. */
export function syncDoc(id, payload, { noRetry = false } = {}) {
  const q = noRetry ? '?noRetry=1' : '';
  return request('POST', `/doc/${encodeURIComponent(id)}/sync${q}`, payload);
}

/** POST /sync/batch — the shape an offline queue flushes in. */
export async function syncBatch(mutations) {
  const res = await request('POST', '/sync/batch', { mutations });
  if (!res.ok) throw new Error(`POST /sync/batch failed: HTTP ${res.status} ${res.text}`);
  return res.json;
}

/* ------------------------------------------------------------------ */
/* Semantic comparison                                                */
/* ------------------------------------------------------------------ */

/**
 * Structural equality over PARSED JSON values. Postgres jsonb reorders object
 * keys, so raw strings are never compared anywhere in this suite.
 */
export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object') {
    const ak = Object.keys(a).sort();
    const bk = Object.keys(b).sort();
    if (ak.length !== bk.length || ak.some((k, i) => k !== bk[i])) return false;
    return ak.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

/**
 * Sort every array-of-objects-with-`id` by id, recursively.
 *
 * MERGE_BY_KEY matches array elements by IDENTITY, not position, so when a
 * client merges the server's document into a local copy that started with a
 * different subset of identities, the resulting order legitimately differs
 * while the identity set and each element's content must match exactly. Use
 * this only where order is genuinely undetermined; the server document is
 * compared strictly.
 */
export function normalizeKeyedArrays(value) {
  if (Array.isArray(value)) {
    const mapped = value.map(normalizeKeyedArrays);
    const allKeyed = mapped.length > 0 && mapped.every(
      (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && v.id !== undefined,
    );
    if (allKeyed) mapped.sort((x, y) => String(x.id).localeCompare(String(y.id)));
    return mapped;
  }
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = normalizeKeyedArrays(value[k]);
    return out;
  }
  return value;
}

function render(value) {
  return inspect(value, { depth: null, sorted: true, breakLength: 100 });
}

export function assertDeepEqual(actual, expected, what) {
  if (deepEqual(actual, expected)) return;
  throw new Error(
    `${what}: parsed values differ.\n--- expected ---\n${render(expected)}\n--- actual ---\n${render(actual)}`,
  );
}

/** Deep equality that treats keyed arrays as identity sets. */
export function assertDeepEqualKeyed(actual, expected, what) {
  const na = normalizeKeyedArrays(actual);
  const ne = normalizeKeyedArrays(expected);
  if (deepEqual(na, ne)) return;
  throw new Error(
    `${what}: parsed values differ (keyed arrays normalized by id).\n` +
      `--- expected ---\n${render(ne)}\n--- actual ---\n${render(na)}`,
  );
}

/* ------------------------------------------------------------------ */
/* Client-store accounting                                            */
/* ------------------------------------------------------------------ */

/** Count mutations per syncStatus straight out of the client's Dexie table. */
export async function statusCounts(client) {
  const all = await client.db.localMutations.toArray();
  return {
    total: all.length,
    pending: all.filter((m) => m.syncStatus === 0).length,
    synced: all.filter((m) => m.syncStatus === 1).length,
    failed: all.filter((m) => m.syncStatus === 2).length,
  };
}
