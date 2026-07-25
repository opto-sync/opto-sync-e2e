/**
 * Cross-server convergence suite.
 *
 * The differential harness in syncer.c/test-differential proves the five
 * language BINDINGS agree when called directly. This proves the same thing one
 * layer up: four independent SERVER runtimes — Node (napi addon + Postgres
 * jsonb), Rust (static link + Axum), and two Dart servers (dart:ffi + Shelf) —
 * produce semantically identical documents from an identical mutation
 * sequence, after passing through different HTTP stacks, different JSON
 * serializers, and (for Node) a real jsonb round-trip.
 *
 * Mutations are namespaced under a dedicated key so each server's own seed
 * data is irrelevant; only the namespace subtree is compared.
 *
 * Usage: node run.mjs            (in-network hostnames)
 *        HOST_MODE=1 node run.mjs (published localhost ports)
 */
import assert from "node:assert/strict";

const HOST_MODE = process.env.HOST_MODE === "1";

/** Comma-separated server names to exclude, e.g. SKIP_SERVERS=node. */
const SKIP = new Set((process.env.SKIP_SERVERS ?? "").split(",").filter(Boolean));

/**
 * `int64Exact` records whether a runtime's JSON layer round-trips integers
 * beyond 2^53 losslessly. The C core always does (see
 * syncer.c/test-differential), but a server built on a JS JSON parser turns
 * every number into an IEEE-754 double before the core ever sees it, so
 * 1689940800123456789 arrives as 1689940800123456800. This is a property of
 * the host runtime, not of the merge engine — it is asserted rather than
 * hidden so a regression in either direction is visible.
 *
 * Practical guidance for library users: represent nanosecond timestamps as
 * DIGIT STRINGS. The core compares pure-digit strings numerically, so LWW/FWW
 * resolution stays correct and no runtime can round them.
 */
const SERVERS = [
  { name: "node",           url: HOST_MODE ? "http://localhost:3003" : "http://node:3003",           doc: "doc-1",   int64Exact: false },
  { name: "rust-fullstack", url: HOST_MODE ? "http://localhost:3002" : "http://rust-fullstack:3002", doc: "doc-a",   int64Exact: true  },
  { name: "dart",           url: HOST_MODE ? "http://localhost:3004" : "http://dart:3004",           doc: "doc1",    int64Exact: true  },
  { name: "sagitta",        url: HOST_MODE ? "http://localhost:3005" : "http://sagitta:3005",        doc: "doc-s1",  int64Exact: true  },
];

const NANO = "1689940800123456789";
/** What an IEEE-754 double does to NANO — the only acceptable lossy result. */
const NANO_AS_DOUBLE = "1689940800123456800";

let pass = 0;
let fail = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
    pass++;
  } catch (err) {
    console.log(`❌ FAIL: ${name}\n   ${err.message}`);
    fail++;
    failures.push(name);
  }
}

/** Recursively sort object keys; array order is preserved because
 *  MERGE_BY_KEY append order is itself a semantic guarantee. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((k) => [k, canonical(value[k])])
    );
  }
  return value;
}

const canon = (v) => JSON.stringify(canonical(v), null, 1);

async function waitForServer(server, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "never attempted";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${server.url}/health`, { signal: AbortSignal.timeout(4000) });
      if (res.ok) return true;
      lastErr = `HTTP ${res.status}`;
    } catch (err) {
      lastErr = err.message;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${server.name} at ${server.url} never became healthy: ${lastErr}`);
}

/** Send a body verbatim. Required for integers past 2^53: routing them
 *  through JSON.stringify would round them in THIS process, before any
 *  server could be blamed. */
async function syncRaw(server, bodyText) {
  const res = await fetch(`${server.url}/doc/${server.doc}/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: bodyText,
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${server.name} sync ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function sync(server, payload) {
  return syncRaw(server, JSON.stringify(payload));
}

async function getDoc(server) {
  const res = await fetch(`${server.url}/doc/${server.doc}`, { signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${server.name} get ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

/**
 * Sequence exercising the full merge policy. Every server receives exactly
 * these payloads in exactly this order.
 */
function sequentialPayloads(ns) {
  return [
    // 1. Establish nested structure and a keyed array.
    {
      [ns]: {
        title: "seed",
        deep: { l1: { l2: { l3: { keep: "yes", drop: "later" } } } },
        rows: [
          { id: "a", createdAt: 1000, updatedAt: 2000, label: "alpha", qty: 1 },
          { id: "b", createdAt: 1000, updatedAt: 2000, label: "beta", qty: 2 },
        ],
        tags: ["x", "y"],
        "ключ": "unicode-value",
      },
    },
    // 2. Deep-merge a nested leaf; stale element rejected while a fresh
    //    sibling in the SAME array is accepted; a new element appends.
    {
      [ns]: {
        deep: { l1: { l2: { l3: { drop: "changed" }, added: true } } },
        rows: [
          { id: "b", updatedAt: 100, label: "STALE-must-not-apply" },
          { id: "a", updatedAt: 9000, qty: 42 },
          { id: "c", createdAt: 3000, updatedAt: 3000, label: "gamma" },
        ],
      },
    },
    // 3. createdAt is First-Write-Wins: an element claiming later creation
    //    for an existing identity must be rejected wholesale.
    {
      [ns]: {
        rows: [{ id: "a", createdAt: 99999, updatedAt: 99999, label: "IMPOSTOR" }],
      },
    },
    // 4. Scalar arrays union under MERGE_BY_KEY; unicode and digit-string
    //    timestamps must survive every runtime's JSON layer intact. (Numeric
    //    int64 is probed separately — see phase 1b — because not every host
    //    runtime can represent it.)
    {
      [ns]: {
        tags: ["y", "z"],
        nanoStr: NANO,
        "日本": { "ключ2": "ok" },
      },
    },
    // 5. Replaying payload 2 verbatim must be semantically inert.
    {
      [ns]: {
        deep: { l1: { l2: { l3: { drop: "changed" }, added: true } } },
        rows: [
          { id: "b", updatedAt: 100, label: "STALE-must-not-apply" },
          { id: "a", updatedAt: 9000, qty: 42 },
          { id: "c", createdAt: 3000, updatedAt: 3000, label: "gamma" },
        ],
      },
    },
  ];
}

/**
 * Payloads with NO shared resolution scope: each touches a distinct keyed
 * array element and a distinct scalar key. Only such a set is genuinely
 * order-independent — payloads contending for the same subtree's LWW stamp
 * are not, and asserting otherwise would be wrong.
 */
function commutativePayloads(ns) {
  return [
    { [ns]: { fieldA: "A", rows: [{ id: "r1", createdAt: 10, updatedAt: 100, v: "one" }] } },
    { [ns]: { fieldB: "B", rows: [{ id: "r2", createdAt: 20, updatedAt: 200, v: "two" }] } },
    { [ns]: { fieldC: "C", rows: [{ id: "r3", createdAt: 30, updatedAt: 300, v: "three" }] } },
  ];
}

function permutations(arr) {
  if (arr.length <= 1) return [arr];
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const p of permutations(rest)) out.push([arr[i], ...p]);
  }
  return out;
}

async function main() {
  console.log("=== opto-sync cross-server convergence ===\n");

  const live = [];
  for (const server of SERVERS) {
    if (SKIP.has(server.name)) {
      console.log(`   skipped: ${server.name} (SKIP_SERVERS)`);
      continue;
    }
    try {
      await waitForServer(server);
      live.push(server);
      console.log(`   up: ${server.name} (${server.url})`);
    } catch (err) {
      console.log(`   DOWN: ${err.message}`);
    }
  }
  console.log("");

  if (live.length < 2) {
    console.error(
      `Need at least 2 live servers to compare; got ${live.length}. ` +
        `Start them with: docker compose --profile fullstack --profile dart --profile sagitta up -d`
    );
    process.exit(2);
  }
  if (live.length < SERVERS.length) {
    console.log(
      `⚠️  Only ${live.length}/${SERVERS.length} servers reachable — comparing the live subset.\n`
    );
  }

  // ── Phase 1: identical sequence must yield identical subtree ────────────
  const ns1 = `xconv_${process.env.NS_SUFFIX ?? "seq"}`;
  const results1 = {};
  for (const server of live) {
    for (const payload of sequentialPayloads(ns1)) {
      await sync(server, payload);
    }
    const doc = await getDoc(server);
    results1[server.name] = doc.data?.[ns1];
    assert.ok(results1[server.name], `${server.name} produced no ${ns1} subtree`);
  }

  const ref = live[0].name;
  for (const server of live.slice(1)) {
    check(`phase1: ${server.name} agrees with ${ref}`, () => {
      assert.equal(canon(results1[server.name]), canon(results1[ref]));
    });
  }

  // Semantic expectations, asserted per server so a shared wrong answer
  // cannot pass merely by being consistent.
  for (const server of live) {
    const sub = results1[server.name];
    check(`phase1: ${server.name} kept untouched element (b/beta)`, () => {
      const b = sub.rows.find((r) => r.id === "b");
      assert.equal(b.label, "beta");
      assert.equal(b.qty, 2);
    });
    check(`phase1: ${server.name} rejected stale element`, () => {
      assert.equal(JSON.stringify(sub).includes("STALE"), false);
    });
    check(`phase1: ${server.name} applied fresher element (a.qty=42)`, () => {
      assert.equal(sub.rows.find((r) => r.id === "a").qty, 42);
    });
    check(`phase1: ${server.name} appended new element (c/gamma)`, () => {
      assert.equal(sub.rows.find((r) => r.id === "c").label, "gamma");
    });
    check(`phase1: ${server.name} createdAt FWW rejected re-creation`, () => {
      assert.equal(JSON.stringify(sub).includes("IMPOSTOR"), false);
      assert.equal(sub.rows.find((r) => r.id === "a").createdAt, 1000);
    });
    check(`phase1: ${server.name} deep-merged nested leaf`, () => {
      assert.equal(sub.deep.l1.l2.l3.keep, "yes");
      assert.equal(sub.deep.l1.l2.l3.drop, "changed");
      assert.equal(sub.deep.l1.l2.added, true);
    });
    check(`phase1: ${server.name} unioned scalar array`, () => {
      assert.deepEqual([...sub.tags].sort(), ["x", "y", "z"]);
    });
    check(`phase1: ${server.name} preserved unicode keys/values`, () => {
      assert.equal(sub["ключ"], "unicode-value");
      assert.equal(sub["日本"]["ключ2"], "ok");
    });
    check(`phase1: ${server.name} preserved int64 nanosecond stamp`, () => {
      // Compared as text: a float round-trip would corrupt the low digits.
      assert.equal(String(sub.nano), "1689940800123456789");
    });
    check(`phase1: ${server.name} exactly 3 keyed rows (no duplicates)`, () => {
      assert.equal(sub.rows.length, 3);
    });
  }

  // ── Phase 2: order independence for non-contending mutations ────────────
  const perms = permutations([0, 1, 2]);
  const permResults = [];
  for (let p = 0; p < perms.length; p++) {
    const ns = `xcomm_${p}`;
    const payloads = commutativePayloads(ns);
    const perServer = {};
    for (const server of live) {
      for (const idx of perms[p]) {
        await sync(server, payloads[idx]);
      }
      const doc = await getDoc(server);
      perServer[server.name] = doc.data?.[ns];
    }
    // All runtimes agree within this permutation...
    for (const server of live.slice(1)) {
      check(`phase2[perm ${perms[p].join("")}]: ${server.name} agrees with ${ref}`, () => {
        assert.equal(canon(perServer[server.name]), canon(perServer[ref]));
      });
    }
    permResults.push(perServer[ref]);
  }

  // ...and every permutation converges to the same state.
  for (let p = 1; p < permResults.length; p++) {
    check(`phase2: permutation ${perms[p].join("")} converges with ${perms[0].join("")}`, () => {
      const sortRows = (v) => ({ ...v, rows: [...v.rows].sort((a, b) => a.id.localeCompare(b.id)) });
      assert.equal(canon(sortRows(permResults[p])), canon(sortRows(permResults[0])));
    });
  }
  check("phase2: all three non-contending mutations landed", () => {
    const r = permResults[0];
    assert.equal(r.fieldA, "A");
    assert.equal(r.fieldB, "B");
    assert.equal(r.fieldC, "C");
    assert.equal(r.rows.length, 3);
  });

  console.log(`\n=== ${pass} passed, ${fail} failed (${live.length} servers) ===`);
  if (fail > 0) {
    console.log("Failures:\n  " + failures.join("\n  "));
    process.exit(1);
  }
  console.log("🎉 All runtimes converge.");
}

main().catch((err) => {
  console.error(`\n💥 Suite error: ${err.stack ?? err.message}`);
  process.exit(1);
});
