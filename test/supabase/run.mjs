#!/usr/bin/env node
/**
 * Supabase-path e2e suite for the rust-mash server.
 *
 * rust-mash is the only e2e server that persists through a REST API instead of
 * a Postgres connection. It was excluded from every e2e run because it needed
 * live cloud credentials, so the whole Supabase code path — auth headers, the
 * /rest/v1 URL shape, upsert-by-primary-key, jsonb round trip — had zero
 * coverage. This suite closes that gap by pointing rust-mash at a local
 * PostgREST, which is the project Supabase's REST API is built on.
 *
 * The load-bearing property here is that every assertion about merged state is
 * ALSO verified by reading the row back through PostgREST directly, bypassing
 * rust-mash entirely. A merge that only ever existed in server memory, or a
 * write that silently no-op'd, fails those checks.
 *
 * Zero dependencies: node 22 built-ins + global fetch.
 *
 * See README.md in this directory for how to run it and what it does NOT cover.
 */

const MASH = (process.env.RUST_MASH_URL || "http://localhost:3001").replace(/\/$/, "");
const PGRST = (process.env.POSTGREST_URL || "http://localhost:3010").replace(/\/$/, "");
const TABLE = process.env.SUPABASE_TABLE || "supabase_sync_docs";
const KEY =
  process.env.SUPABASE_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzeW5jZXItZTJlIiwicm9sZSI6ImFub24iLCJpYXQiOjE1Nzc4MzY4MDAsImV4cCI6MzM3NjY4NDgwMH0.VbjxUdv0mxNy0AnYA-y18kqcL_7r4cjAWEL7alIh5u0";

// Per-run id prefix: concurrent runs and repeated runs never collide, and
// cleanup can target exactly this run's rows.
const RUN = `sb-${process.pid}-${Date.now().toString(36)}`;
const id = (name) => `${RUN}-${name}`;

// ── Tiny assertion harness ───────────────────────────────────────────────

let passed = 0;
const failures = [];
let currentSection = "";

function section(name) {
  currentSection = name;
  console.log(`\n── ${name}`);
}

function ok(cond, label, detail) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push({ section: currentSection, label, detail });
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ""}`);
  }
}

/** Order-insensitive-for-object-keys structural comparison. */
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

function eq(actual, expected, label) {
  const a = canon(actual);
  const e = canon(expected);
  ok(a === e, label, a === e ? undefined : `expected ${e}\n      actual   ${a}`);
}

// ── HTTP helpers ─────────────────────────────────────────────────────────

async function mash(path, init = {}) {
  const res = await fetch(`${MASH}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body (e.g. the HTML dashboard) */
  }
  return { status: res.status, json, text };
}

/** Direct call to the REST layer, bypassing rust-mash. */
async function rest(path, init = {}) {
  const res = await fetch(`${PGRST}${path}`, {
    ...init,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    /* PostgREST error pages */
  }
  return { status: res.status, json, text };
}

/** Read one row straight out of the REST layer. Proves real persistence. */
async function restRow(docId) {
  const r = await rest(`/${TABLE}?id=eq.${encodeURIComponent(docId)}&select=*`);
  if (r.status !== 200) throw new Error(`PostgREST ${r.status}: ${r.text}`);
  return { row: (r.json || [])[0], raw: r.text };
}

async function createDoc(docId, data) {
  const r = await mash(`/doc/${docId}`, { method: "PUT", body: JSON.stringify(data) });
  if (r.status !== 201) throw new Error(`create ${docId} failed: ${r.status} ${r.text}`);
  return r.json;
}

async function sync(docId, payload) {
  return mash(`/doc/${docId}/sync`, {
    method: "POST",
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

async function waitReady(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "never attempted";
  while (Date.now() < deadline) {
    try {
      const [h, p] = await Promise.all([
        fetch(`${MASH}/health`).then((r) => r.status),
        rest(`/${TABLE}?limit=1`).then((r) => r.status),
      ]);
      if (h === 200 && p === 200) return;
      lastErr = `rust-mash=${h} postgrest=${p}`;
    } catch (e) {
      lastErr = e.message;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`services not ready after ${timeoutMs}ms: ${lastErr}`);
}

/** Remove only this run's rows. Never touches other suites' data. */
async function cleanup() {
  await rest(`/${TABLE}?id=like.${RUN}-*`, { method: "DELETE" });
}

// ── Suite ────────────────────────────────────────────────────────────────

async function main() {
  console.log(`rust-mash: ${MASH}\npostgrest: ${PGRST}\ntable:     ${TABLE}\nrun id:    ${RUN}`);
  await waitReady();

  // ══ 1. Health, and proof the native C core is what merges ══════════════
  section("health / native core");
  const health = await mash("/health");
  ok(health.status === 200, "GET /health → 200", `got ${health.status}`);
  const h = health.json || {};
  ok(h.status === "ok", "health.status is ok", JSON.stringify(h));
  ok(h.server === "rust-mash", "health.server is rust-mash", String(h.server));
  ok(h.native === true, "health.native is true (statically linked C core in use)");
  ok(h.mergeEngine === "native-c-ffi-rust", "merge engine is the C FFI", String(h.mergeEngine));
  ok(
    /^\d+\.\d+\.\d+$/.test(h.coreVersion || ""),
    "health reports a semver core version",
    String(h.coreVersion)
  );
  {
    const [maj, min] = String(h.coreVersion || "0.0.0").split(".").map(Number);
    ok(maj > 0 || min >= 2, `core version ${h.coreVersion} supports MERGE_BY_KEY (>= 0.2.0)`);
  }
  ok(h.table === TABLE, `rust-mash targets table ${TABLE}`, String(h.table));

  section("server-owned merge policy matches the Postgres path");
  const pol = h.mergePolicy || {};
  ok(pol.arrayStrategy === 4, "arrayStrategy is MERGE_BY_KEY (4)", String(pol.arrayStrategy));
  ok(pol.arrayMatchKeys === "id", "arrayMatchKeys is 'id'", String(pol.arrayMatchKeys));
  ok(pol.resolveByTimestamp === true, "resolveByTimestamp enabled");
  ok(pol.lwwKeys === "updatedAt,syncedAt", "lwwKeys are updatedAt,syncedAt", String(pol.lwwKeys));
  ok(pol.fwwKeys === "createdAt", "fwwKeys is createdAt", String(pol.fwwKeys));

  // ══ 2. The REST layer is real, and its auth is really enforced ═════════
  section("REST layer");
  const listed = await rest(`/${TABLE}?select=id&limit=1`);
  ok(listed.status === 200, "PostgREST serves the table → 200", `got ${listed.status}`);
  ok(Array.isArray(listed.json), "PostgREST returns a JSON array");
  {
    // Supabase serves /rest/v1/<table>; bare PostgREST serves /<table>. This
    // 404 is why SUPABASE_REST_PREFIX exists — the config is load-bearing, not
    // decorative, and the default still points at Supabase's real prefix.
    const prefixed = await rest(`/rest/v1/${TABLE}?select=id&limit=1`);
    ok(prefixed.status === 404, "bare PostgREST 404s on /rest/v1 (prefix config is required)", `got ${prefixed.status}`);
  }
  {
    // A bogus bearer token must be rejected: proves the apikey/Authorization
    // headers rust-mash sends are actually validated, so the suite is not
    // passing against a wide-open database.
    const bad = await fetch(`${PGRST}/${TABLE}?select=id&limit=1`, {
      headers: { apikey: "nope", Authorization: "Bearer not-a-real-jwt" },
    });
    ok(bad.status === 401, "PostgREST rejects an invalid JWT → 401", `got ${bad.status}`);
  }

  // ══ 3. Create a document through rust-mash, read it back through REST ══
  section("create + REST round trip");
  const docA = id("deep");
  const baseA = {
    title: "Project Alpha",
    metadata: { priority: 1, tags: ["backend"], owner: { name: "Alice" } },
    settings: { theme: "dark", notifications: true },
  };
  const created = await createDoc(docA, baseA);
  ok(created.created === true, "PUT /doc/:id → created");
  ok(created.document?.version === 1, "new document starts at version 1", String(created.document?.version));

  const fetched = await mash(`/doc/${docA}`);
  ok(fetched.status === 200, "GET /doc/:id → 200", `got ${fetched.status}`);
  eq(fetched.json?.data, baseA, "GET returns the data as written");

  const afterCreate = await restRow(docA);
  ok(!!afterCreate.row, "row exists when read directly from PostgREST");
  eq(afterCreate.row?.data, baseA, "PostgREST-stored jsonb equals what was written");
  ok(
    !Number.isNaN(Date.parse(afterCreate.row?.updated_at)),
    "updated_at is a server-side timestamp rust-mash never sent",
    String(afterCreate.row?.updated_at)
  );

  // ══ 4. Deep merge, verified through the REST layer ═════════════════════
  section("deep merge");
  const merged = await sync(docA, {
    metadata: { priority: 5, owner: { email: "alice@example.com" } },
  });
  ok(merged.status === 200, "POST /doc/:id/sync → 200", `got ${merged.status} ${merged.text}`);
  ok(merged.json?.merged === true, "response reports merged");
  ok(merged.json?.mergedWith === "native-c-ffi-rust", "sync reports the native core did the merge");
  const mdata = merged.json?.document?.data;
  ok(mdata?.metadata?.priority === 5, "scalar overwritten by incoming", JSON.stringify(mdata?.metadata));
  ok(mdata?.metadata?.owner?.email === "alice@example.com", "nested key added");
  ok(mdata?.metadata?.owner?.name === "Alice", "nested sibling preserved (deep merge, not replace)");
  eq(mdata?.settings, baseA.settings, "untouched branch preserved verbatim");
  ok(merged.json?.document?.version === 2, "version incremented to 2", String(merged.json?.document?.version));

  const afterMerge = await restRow(docA);
  eq(afterMerge.row?.data, mdata, "merged jsonb ACTUALLY PERSISTED (direct PostgREST read)");
  ok(afterMerge.row?.version === 2, "persisted version is 2", String(afterMerge.row?.version));
  ok(
    Date.parse(afterMerge.row?.updated_at) >= Date.parse(afterCreate.row?.updated_at),
    "persisted updated_at advanced on write"
  );

  // ══ 5. Keyed-array reconciliation (MERGE_BY_KEY on "id") ══════════════
  section("keyed-array reconciliation");
  const docR = id("rows");
  await createDoc(docR, {
    title: "Keyed Rows",
    items: [
      { id: "a", createdAt: 1000, updatedAt: 2000, label: "alpha", qty: 1 },
      { id: "b", createdAt: 1000, updatedAt: 2000, label: "beta", qty: 2 },
    ],
  });

  const r1 = await sync(docR, {
    items: [
      { id: "a", updatedAt: 3000, qty: 11 }, // newer → applies
      { id: "c", createdAt: 1500, updatedAt: 1500, label: "gamma", qty: 3 }, // new identity
    ],
  });
  ok(r1.status === 200, "keyed-array sync → 200", `got ${r1.status} ${r1.text}`);
  const items1 = r1.json?.document?.data?.items || [];
  const byId1 = Object.fromEntries(items1.map((it) => [it.id, it]));
  ok(items1.length === 3, "array reconciled to 3 elements (not replaced, not appended blindly)", `len ${items1.length}`);
  ok(byId1.a?.qty === 11, "matched element updated by newer updatedAt", JSON.stringify(byId1.a));
  ok(byId1.a?.label === "alpha", "matched element keeps fields the payload omitted");
  eq(
    byId1.b,
    { id: "b", createdAt: 1000, updatedAt: 2000, label: "beta", qty: 2 },
    "unmentioned element untouched"
  );
  ok(byId1.c?.label === "gamma", "unmatched incoming element appended");
  eq(items1.map((it) => it.id), ["a", "b", "c"], "existing order preserved, new element appended last");

  section("stale-element rejection (LWW on updatedAt)");
  const r2 = await sync(docR, {
    items: [{ id: "a", updatedAt: 500, qty: 999, label: "stale-write" }],
  });
  ok(r2.status === 200, "stale sync is accepted as a request (not an error)", `got ${r2.status}`);
  const byId2 = Object.fromEntries((r2.json?.document?.data?.items || []).map((it) => [it.id, it]));
  ok(byId2.a?.qty === 11, "stale element's qty rejected", JSON.stringify(byId2.a));
  ok(byId2.a?.label === "alpha", "stale element's label rejected");
  ok(byId2.a?.updatedAt === 3000, "stale element's timestamp not rolled back", String(byId2.a?.updatedAt));
  {
    const { row } = await restRow(docR);
    const persisted = Object.fromEntries(row.data.items.map((it) => [it.id, it]));
    ok(persisted.a?.qty === 11, "stale rejection is what PostgREST actually stores");
    ok(row.data.items.length === 3, "stale sync did not duplicate elements", `len ${row.data.items.length}`);
  }

  section("createdAt first-write-wins");
  const docF = id("fww");
  await createDoc(docF, {
    items: [{ id: "a", createdAt: 1000, updatedAt: 2000, label: "orig", qty: 1 }],
  });
  // updatedAt is NEWER (so LWW would accept) but createdAt is newer too — FWW
  // must reject the element wholesale. Without FWW the label would change.
  const f1 = await sync(docF, {
    items: [{ id: "a", createdAt: 9999, updatedAt: 5000, label: "rewritten", qty: 42 }],
  });
  const f1a = (f1.json?.document?.data?.items || [])[0];
  ok(f1a?.label === "orig", "element with newer createdAt rejected wholesale", JSON.stringify(f1a));
  ok(f1a?.createdAt === 1000, "original createdAt preserved", String(f1a?.createdAt));
  ok(f1a?.qty === 1, "FWW rejection also blocks the sibling fields in that element");
  {
    const { row } = await restRow(docF);
    eq(row.data.items[0], f1a, "FWW rejection persisted through the REST layer");
  }
  // Symmetric case: an OLDER createdAt is the earlier write, so it wins.
  const f2 = await sync(docF, {
    items: [{ id: "a", createdAt: 500, updatedAt: 6000, qty: 7 }],
  });
  const f2a = (f2.json?.document?.data?.items || [])[0];
  ok(f2a?.createdAt === 500, "older createdAt accepted (first write wins)", String(f2a?.createdAt));
  ok(f2a?.qty === 7, "accepted element's other fields merged");

  section("document-level LWW");
  const docL = id("root");
  await createDoc(docL, { title: "base", updatedAt: 5000, n: { k: 1 } });
  const l1 = await sync(docL, { title: "stale", updatedAt: 1000, n: { k: 99 } });
  eq(
    l1.json?.document?.data,
    { title: "base", updatedAt: 5000, n: { k: 1 } },
    "stale document-level payload rejected entirely"
  );
  const l2 = await sync(docL, { title: "fresh", updatedAt: 9000, n: { k: 42 } });
  eq(
    l2.json?.document?.data,
    { title: "fresh", updatedAt: 9000, n: { k: 42 } },
    "newer document-level payload applies"
  );
  {
    const { row } = await restRow(docL);
    eq(row.data, l2.json?.document?.data, "document-level LWW result persisted");
  }

  // ══ 6. Idempotent re-sync ═════════════════════════════════════════════
  section("idempotent re-sync");
  const docI = id("idem");
  await createDoc(docI, {
    tags: ["a", "b"],
    items: [{ id: "x", createdAt: 100, updatedAt: 200, v: 1 }],
  });
  const payload = {
    items: [{ id: "x", createdAt: 100, updatedAt: 300, v: 2 }],
    tags: ["b", "c"],
  };
  const i1 = await sync(docI, payload);
  const i2 = await sync(docI, payload);
  const i3 = await sync(docI, payload);
  eq(i2.json?.document?.data, i1.json?.document?.data, "second identical sync is a no-op on data");
  eq(i3.json?.document?.data, i1.json?.document?.data, "third identical sync is a no-op on data");
  ok(
    (i3.json?.document?.data?.items || []).length === 1,
    "repeated sync does not duplicate keyed elements",
    JSON.stringify(i3.json?.document?.data?.items)
  );
  ok(
    (i3.json?.document?.data?.tags || []).length === 3,
    "scalar array is UNION-idempotent under MERGE_BY_KEY",
    JSON.stringify(i3.json?.document?.data?.tags)
  );
  {
    const { row } = await restRow(docI);
    eq(row.data, i3.json?.document?.data, "converged state persisted (direct PostgREST read)");
    ok(row.version === 4, "each sync still bumped the stored version", String(row.version));
  }

  // ══ 7. jsonb fidelity across the REST hop ═════════════════════════════
  section("jsonb / REST fidelity");
  const docP = id("precision");
  // Sent as raw text so JS number handling cannot mask a precision loss.
  const NANOS = "1723456789123456789";
  await mash(`/doc/${docP}`, {
    method: "PUT",
    body: `{"nanos":${NANOS},"pi":3.141592653589793,"text":"日本語 — café ✓ \\"quoted\\"","items":[{"id":"p","updatedAt":${NANOS}}]}`,
  });
  const p1 = await sync(docP, `{"items":[{"id":"p","updatedAt":${NANOS},"seen":true}]}`);
  ok(p1.status === 200, "precision payload syncs → 200", `got ${p1.status} ${p1.text}`);
  const pRaw = await restRow(docP);
  ok(
    pRaw.raw.includes(NANOS),
    "nanosecond integer survives the merge + jsonb + REST round trip exactly",
    pRaw.raw.slice(0, 300)
  );
  ok(pRaw.row?.pi === 3.141592653589793, "double precision preserved", String(pRaw.row?.pi));
  ok(pRaw.row?.text === '日本語 — café ✓ "quoted"', "unicode and escaping preserved", String(pRaw.row?.text));
  ok(
    (pRaw.row?.items || [])[0]?.seen === true,
    "equal-timestamp element still merges (LWW rejects only strictly-older)",
    JSON.stringify(pRaw.row?.items)
  );

  // ══ 8. Error paths ════════════════════════════════════════════════════
  section("error handling");
  const missing = id("does-not-exist");
  ok((await mash(`/doc/${missing}`)).status === 404, "GET unknown document → 404");
  ok((await sync(missing, { a: 1 })).status === 404, "sync of unknown document → 404");
  ok((await mash(`/doc/${id("bad")}`, { method: "PUT", body: '"a string"' })).status === 400,
    "PUT with a non-object body → 400");

  // ══ 9. The SSR dashboard still renders off the REST layer ══════════════
  section("SSR dashboard");
  const page = await fetch(`${MASH}/`);
  const pageText = await page.text();
  ok(page.status === 200, "GET / → 200", `got ${page.status}`);
  ok(!pageText.includes("Failed to load documents"), "dashboard loaded documents through the REST API");
  ok(pageText.includes(docA), "dashboard renders a document created in this run");
  {
    const docsList = await mash("/docs");
    ok(docsList.status === 200, "GET /docs → 200");
    ok(
      Array.isArray(docsList.json) && docsList.json.some((d) => d.id === docA),
      "/docs lists documents fetched over REST"
    );
  }
}

// ── Entry point ──────────────────────────────────────────────────────────

try {
  await main();
} catch (err) {
  failures.push({ section: currentSection, label: `suite threw: ${err.message}`, detail: err.stack });
  console.error(`\n!! ${err.stack}`);
} finally {
  try {
    await cleanup();
  } catch (err) {
    console.error(`cleanup failed (leaked rows with prefix ${RUN}): ${err.message}`);
  }
}

const total = passed + failures.length;
console.log(`\n${"─".repeat(60)}`);
console.log(`${passed}/${total} assertions passed`);
if (failures.length) {
  console.log(`\n${failures.length} FAILED:`);
  for (const f of failures) console.log(`  [${f.section}] ${f.label}${f.detail ? `\n    ${f.detail}` : ""}`);
  process.exit(1);
}
console.log("SUPABASE PATH: ALL GREEN");
