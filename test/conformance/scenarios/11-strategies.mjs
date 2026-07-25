/**
 * Scenario 11 — the merge-policy matrix, driven by the X-Syncer-Options header.
 *
 * The header is honoured only when the server runs with
 * E2E_ALLOW_OPTION_OVERRIDE=1; in production the server owns the policy and
 * clients cannot dictate conflict resolution. Values are merged OVER the server
 * defaults, so each case below sets `resolveByTimestamp:false` when it wants to
 * isolate array behaviour from timestamp gating.
 *
 * All five strategies are exercised on the SAME input so the differences are
 * directly comparable:
 *
 *   base     = [ {id:a,v:1}, {id:b,v:2} ]
 *   incoming = [ {id:b,v:22}, {id:c,v:3} ]
 *
 *   0 REPLACE        -> [ {b,22}, {c,3} ]                incoming wins wholesale
 *   1 APPEND         -> [ {a,1}, {b,2}, {b,22}, {c,3} ]  concatenation, no dedup
 *   2 UNION          -> [ {a,1}, {b,2}, {b,22}, {c,3} ]  dedup by SERIALIZED form,
 *                                                        so {b,2} != {b,22}
 *   3 MERGE_BY_INDEX -> [ {b,22}, {c,3} ]                positional merge
 *   4 MERGE_BY_KEY   -> [ {a,1}, {b,22}, {c,3} ]         reconciled by `id`
 */

const OBJ_BASE = [
  { id: "a", v: 1 },
  { id: "b", v: 2 },
];
const OBJ_INCOMING = [
  { id: "b", v: 22 },
  { id: "c", v: 3 },
];

/** Compare ignoring key order inside each element. */
const shape = (arr) => (arr ?? []).map((e) => `${e.id}:${e.v}`);

export default {
  name: "11. Strategy matrix via X-Syncer-Options",
  cases: [
    {
      name: "arrayStrategy 0 REPLACE — incoming array replaces the base wholesale",
      async fn(t, c) {
        await c.putDoc("s0", { arr: OBJ_BASE });
        const res = await c.sync("s0", { arr: OBJ_INCOMING }, {
          options: { arrayStrategy: 0, resolveByTimestamp: false },
        });
        t.status(res, 200, "REPLACE sync succeeds");
        t.deepEq(shape((await c.data("s0")).arr), ["b:22", "c:3"], "base elements discarded");
        t.eq((await c.data("s0")).arr.length, 2, "length is the incoming length");
      },
    },
    {
      name: "arrayStrategy 1 APPEND — concatenation with no deduplication",
      async fn(t, c) {
        await c.putDoc("s1", { arr: OBJ_BASE });
        await c.sync("s1", { arr: OBJ_INCOMING }, {
          options: { arrayStrategy: 1, resolveByTimestamp: false },
        });
        t.deepEq(
          shape((await c.data("s1")).arr),
          ["a:1", "b:2", "b:22", "c:3"],
          "base ++ incoming, duplicate identity b appears twice"
        );

        // APPEND is deliberately NOT idempotent — replaying doubles the array.
        await c.sync("s1", { arr: OBJ_INCOMING }, {
          options: { arrayStrategy: 1, resolveByTimestamp: false },
        });
        t.eq(
          (await c.data("s1")).arr.length,
          6,
          "APPEND is not idempotent: a replay grows the array again"
        );
      },
    },
    {
      name: "arrayStrategy 2 UNION — dedup by serialized form (objects included)",
      async fn(t, c) {
        await c.putDoc("s2", { arr: OBJ_BASE });
        await c.sync("s2", { arr: OBJ_INCOMING }, {
          options: { arrayStrategy: 2, resolveByTimestamp: false },
        });
        t.deepEq(
          shape((await c.data("s2")).arr),
          ["a:1", "b:2", "b:22", "c:3"],
          "UNION keeps {b:2} and {b:22}: they are different VALUES, not the same identity"
        );

        // Scalars: set semantics work exactly as documented, and are idempotent.
        await c.putDoc("s2s", { arr: [1, 2, 3] });
        await c.sync("s2s", { arr: [3, 4] }, {
          options: { arrayStrategy: 2, resolveByTimestamp: false },
        });
        t.deepEq((await c.data("s2s")).arr, [1, 2, 3, 4], "scalar UNION: [1,2,3] ∪ [3,4]");
        await c.sync("s2s", { arr: [3, 4] }, {
          options: { arrayStrategy: 2, resolveByTimestamp: false },
        });
        t.deepEq(
          (await c.data("s2s")).arr,
          [1, 2, 3, 4],
          "scalar UNION is idempotent on replay"
        );

        // Single-key objects also dedup reliably (no key order to disagree about).
        await c.putDoc("s2o", { arr: [{ only: 1 }] });
        await c.sync("s2o", { arr: [{ only: 1 }] }, {
          options: { arrayStrategy: 2, resolveByTimestamp: false },
        });
        t.eq((await c.data("s2o")).arr.length, 1, "a single-key object element is deduped");
      },
    },
    {
      name: "UNION dedup of MULTI-KEY objects is key-order sensitive through jsonb",
      async fn(t, c) {
        // The core dedups by comparing SERIALIZED forms (strcmp), not by
        // structural equality. Postgres jsonb re-orders object keys to
        // (length, then bytes), so a stored element's serialization generally
        // does NOT match the client's key order — and the "same" element is
        // appended again. Demonstrated both ways below.
        await c.putDoc("s2k", { arr: [{ id: "c", v: 3 }] });
        const raw = await c.rawDoc("s2k");
        t.contains(
          raw.text,
          '{"v": 3, "id": "c"}',
          "jsonb stored the element as {v, id} — shorter key first, not our {id, v}"
        );

        // Client key order id,v — differs from the stored form.
        await c.sync("s2k", { arr: [{ id: "c", v: 3 }] }, {
          options: { arrayStrategy: 2, resolveByTimestamp: false },
        });
        const mismatched = (await c.data("s2k")).arr.length;

        // Client key order v,id — matches the stored jsonb form exactly.
        await c.putDoc("s2k2", { arr: [{ id: "c", v: 3 }] });
        await c.sync("s2k2", { arr: [{ v: 3, id: "c" }] }, {
          options: { arrayStrategy: 2, resolveByTimestamp: false },
        });
        t.eq(
          (await c.data("s2k2")).arr.length,
          1,
          "dedup DOES work when the client's key order happens to match jsonb's"
        );

        t.limitation(
          mismatched === 2,
          "UNION failed to dedup a structurally identical object element (array grew to 2)",
          "Cause: the core's UNION dedup compares serialized JSON text (strcmp) rather than " +
            "structural equality, and Postgres jsonb normalizes key order to (length, bytes). " +
            "A client whose key order differs from jsonb's therefore gets duplicates, making " +
            "arrayStrategy=2 behave like APPEND and NOT idempotent for multi-key objects. " +
            "Unaffected: scalars, single-key objects, and MERGE_BY_KEY (strategy 4), which " +
            "matches on an identity key instead of on bytes."
        );
        if (mismatched !== 2) {
          t.eq(mismatched, 1, "UNION deduped the structurally identical element");
        }
      },
    },
    {
      name: "arrayStrategy 3 MERGE_BY_INDEX — positional merge, longer side preserved",
      async fn(t, c) {
        await c.putDoc("s3", { arr: OBJ_BASE });
        await c.sync("s3", { arr: OBJ_INCOMING }, {
          options: { arrayStrategy: 3, resolveByTimestamp: false },
        });
        t.deepEq(
          shape((await c.data("s3")).arr),
          ["b:22", "c:3"],
          "index 0 and 1 merged positionally — identity is ignored entirely"
        );

        // Base longer than incoming: the tail must survive, not be truncated.
        await c.putDoc("s3b", { arr: [{ id: "a", v: 1 }, { id: "b", v: 2 }, { id: "c", v: 3 }] });
        await c.sync("s3b", { arr: [{ v: 11 }] }, {
          options: { arrayStrategy: 3, resolveByTimestamp: false },
        });
        const longer = (await c.data("s3b")).arr;
        t.eq(longer.length, 3, "base tail preserved when incoming is shorter");
        t.eq(longer[0].v, 11, "index 0 merged");
        t.eq(longer[0].id, "a", "index 0 kept its base-only key (object-vs-object deep merge)");
        t.eq(longer[2].v, 3, "index 2 untouched");

        // Incoming longer than base: the extra elements are appended.
        await c.putDoc("s3c", { arr: [{ v: 1 }] });
        await c.sync("s3c", { arr: [{ v: 11 }, { v: 22 }, { v: 33 }] }, {
          options: { arrayStrategy: 3, resolveByTimestamp: false },
        });
        t.deepEq(
          (await c.data("s3c")).arr.map((e) => e.v),
          [11, 22, 33],
          "incoming tail appended when incoming is longer"
        );
      },
    },
    {
      name: "arrayStrategy 4 MERGE_BY_KEY — reconciled by identity (the default)",
      async fn(t, c) {
        await c.putDoc("s4", { arr: OBJ_BASE });
        await c.sync("s4", { arr: OBJ_INCOMING }, {
          options: { arrayStrategy: 4, resolveByTimestamp: false },
        });
        t.deepEq(
          shape((await c.data("s4")).arr),
          ["a:1", "b:22", "c:3"],
          "base-only `a` retained, `b` merged in place, `c` appended"
        );

        // And confirm this is what the server does with NO header at all.
        await c.putDoc("s4d", { arr: OBJ_BASE });
        await c.sync("s4d", { arr: OBJ_INCOMING });
        t.deepEq(
          shape((await c.data("s4d")).arr),
          ["a:1", "b:22", "c:3"],
          "MERGE_BY_KEY is the server default (identical result with no override header)"
        );
      },
    },
    {
      name: "all five strategies produce five documented results on identical input",
      async fn(t, c) {
        const observed = {};
        for (const strategy of [0, 1, 2, 3, 4]) {
          await c.putDoc("matrix", { arr: OBJ_BASE });
          await c.sync("matrix", { arr: OBJ_INCOMING }, {
            options: { arrayStrategy: strategy, resolveByTimestamp: false },
          });
          observed[strategy] = shape((await c.data("matrix")).arr);
        }
        t.deepEq(
          observed,
          {
            0: ["b:22", "c:3"],
            1: ["a:1", "b:2", "b:22", "c:3"],
            2: ["a:1", "b:2", "b:22", "c:3"],
            3: ["b:22", "c:3"],
            4: ["a:1", "b:22", "c:3"],
          },
          "the full 0..4 strategy matrix matches the documented contract"
        );
        t.ne(
          JSON.stringify(observed[1]),
          JSON.stringify(observed[4]),
          "APPEND and MERGE_BY_KEY are genuinely different (guards against a no-op override)"
        );
        t.ne(
          JSON.stringify(observed[0]),
          JSON.stringify(observed[4]),
          "REPLACE and MERGE_BY_KEY are genuinely different"
        );
      },
    },
    {
      name: "arrayMatchKeys 'uuid,id' matches on uuid (first key present on the element)",
      async fn(t, c) {
        await c.putDoc("umatch", {
          rows: [
            { uuid: "u1", id: "x", v: 1 },
            { uuid: "u2", id: "y", v: 2 },
          ],
        });
        await c.sync("umatch", { rows: [{ uuid: "u2", v: 222 }] }, {
          options: { arrayMatchKeys: "uuid,id", resolveByTimestamp: false },
        });
        const rows = (await c.data("umatch")).rows;
        t.eq(rows.length, 2, "matched on uuid — no element appended");
        t.eq(rows.find((r) => r.uuid === "u2").v, 222, "the uuid-matched element was updated");
        t.eq(
          rows.find((r) => r.uuid === "u2").id,
          "y",
          "the matched element kept its other identity field"
        );
        t.eq(rows.find((r) => r.uuid === "u1").v, 1, "the unmatched element is untouched");

        // With the DEFAULT match key (`id`), a uuid-only payload cannot match.
        await c.putDoc("umatch2", { rows: [{ uuid: "u1", id: "x", v: 1 }] });
        await c.sync("umatch2", { rows: [{ uuid: "u1", v: 999 }] }, {
          options: { resolveByTimestamp: false },
        });
        t.eq(
          (await c.data("umatch2")).rows.length,
          2,
          "with arrayMatchKeys='id', a uuid-only element has no identity and is appended"
        );
      },
    },
    {
      name: "arrayMatchKeys falls back to the second key when the first is absent",
      async fn(t, c) {
        await c.putDoc("umatch3", { rows: [{ id: "only-id", v: 1 }] });
        // The incoming element carries no `uuid`, so the identity key becomes `id`.
        await c.sync("umatch3", { rows: [{ id: "only-id", v: 77 }] }, {
          options: { arrayMatchKeys: "uuid,id", resolveByTimestamp: false },
        });
        const rows = (await c.data("umatch3")).rows;
        t.eq(rows.length, 1, "matched via the second key in the list");
        t.eq(rows[0].v, 77, "the element was merged, not duplicated");
      },
    },
    {
      name: "maxDepth truncates deep merging (the incoming subtree replaces the base)",
      async fn(t, c) {
        await c.putDoc("depth", {
          l1: { keepAtL1: 1, l2: { keepAtL2: 2, l3: { deep: "orig" } } },
        });
        await c.sync("depth", { l1: { l2: { l3: { deep: "new" } } } }, {
          options: { maxDepth: 2, resolveByTimestamp: false },
        });
        const d = await c.data("depth");
        t.eq(d.l1.keepAtL1, 1, "siblings above the depth limit are preserved");
        t.eq(d.l1.l2.l3.deep, "new", "the incoming value at depth landed");
        t.lacksKey(
          d.l1.l2,
          "keepAtL2",
          "AT the limit the incoming subtree REPLACES the base subtree (base keys are lost)"
        );

        // maxDepth 1 degenerates to a shallow, top-level-only merge.
        await c.putDoc("depth1", { l1: { keepMe: 1 }, other: "untouched" });
        await c.sync("depth1", { l1: { added: 9 } }, {
          options: { maxDepth: 1, resolveByTimestamp: false },
        });
        const d1 = await c.data("depth1");
        t.deepEq(d1.l1, { added: 9 }, "maxDepth=1 is a shallow merge: l1 replaced entirely");
        t.eq(d1.other, "untouched", "unmentioned top-level keys still survive");

        // Default (unlimited) reaches the bottom.
        await c.putDoc("depth0", { l1: { keepAtL1: 1, l2: { keepAtL2: 2 } } });
        await c.sync("depth0", { l1: { l2: { added: 3 } } }, {
          options: { resolveByTimestamp: false },
        });
        const d0 = await c.data("depth0");
        t.eq(d0.l1.l2.keepAtL2, 2, "with no maxDepth the merge recurses and preserves deep keys");
        t.eq(d0.l1.l2.added, 3, "…and adds the incoming deep key");
      },
    },
    {
      name: "resolveByTimestamp:false disables LWW/FWW gating entirely",
      async fn(t, c) {
        await c.reset();
        // Same stale element that scenario 3 proves is rejected by default.
        await c.sync("doc-rows", { items: [{ id: "a", updatedAt: 1000, label: "STALE-BUT-OK" }] }, {
          options: { resolveByTimestamp: false },
        });
        const a = (await c.data("doc-rows")).items.find((r) => r.id === "a");
        t.eq(a.label, "STALE-BUT-OK", "with resolution off, a stale element is applied");
        t.eq(a.updatedAt, 1000, "updatedAt moved backwards — no gate to stop it");
      },
    },
    {
      name: "lwwKeys can be retargeted to a custom field",
      async fn(t, c) {
        await c.putDoc("customlww", { rows: [{ id: "r", rev: 10, v: "base" }] });
        await c.sync("customlww", { rows: [{ id: "r", rev: 5, v: "stale" }] }, {
          options: { lwwKeys: "rev", fwwKeys: "" },
        });
        t.eq(
          (await c.data("customlww")).rows[0].v,
          "base",
          "a lower `rev` is rejected once lwwKeys='rev'"
        );
        await c.sync("customlww", { rows: [{ id: "r", rev: 20, v: "fresh" }] }, {
          options: { lwwKeys: "rev", fwwKeys: "" },
        });
        t.eq((await c.data("customlww")).rows[0].v, "fresh", "a higher `rev` is accepted");
        t.eq((await c.data("customlww")).rows[0].rev, 20, "`rev` advanced");
      },
    },
    {
      name: "an invalid X-Syncer-Options header is a 400, not a 500",
      async fn(t, c) {
        const res = await c.syncRaw("doc-1", '{"a":1}', {
          headers: { "X-Syncer-Options": "{not-json" },
        });
        t.status(res, 400, "malformed options header -> 400");
        t.ok(
          typeof res.body?.error === "string" && /X-Syncer-Options/.test(res.body.error),
          "the error names the offending header"
        );
      },
    },
  ],
};
