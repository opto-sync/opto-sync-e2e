/**
 * Scenario 6 — convergence / order-independence. The core CRDT promise.
 *
 * Four "concurrent" client mutations are applied in EVERY one of the 4! = 24
 * orders, with a /reset between runs, and all 24 final documents must be
 * deep-equal.
 *
 * ── Designing a mutation set that CAN converge ────────────────────────────
 * This is the subtle part, and getting it wrong produces a test that fails for
 * reasons that have nothing to do with a bug. Two properties of the merge policy
 * constrain the design:
 *
 *   (a) A timestamp rejection is ALL-OR-NOTHING for the object node it applies
 *       to. A stale writer contributes nothing — not even keys that only it has.
 *   (b) Plain scalars with no lww key on their enclosing object are resolved by
 *       ARRIVAL order (last write wins), which is inherently order-dependent.
 *
 * So a set of mutations converges iff, for every object node, either:
 *   1. only ONE mutation writes that node (disjoint — trivially convergent), or
 *   2. several write it, they carry lww timestamps, AND the older writer's key
 *      set is a SUBSET of the newer writer's key set.
 *
 * Why (2) works: apply-old-then-new, the old keys land and the new writer
 * overwrites every one of them. Apply-new-then-old, the old writer is rejected
 * wholesale. Both orders end at the newer writer's values — provided the older
 * writer had no key of its own to lose.
 *
 * The mutation set below exercises BOTH shapes: disjoint nested objects,
 * disjoint keyed-array elements, a new keyed element, and two genuinely
 * contending writes (on nested object `shared` and on array element `a`) where
 * the stale writer is subset-dominated.
 *
 * The payload roots deliberately carry NO updatedAt/syncedAt/createdAt: a
 * root-level lww key would gate the entire document and make ordering matter for
 * everything at once. That boundary is asserted explicitly in the last case.
 */

import { canon } from "../lib/harness.mjs";

/** All permutations of an array (n! — used with n=4). */
function permutations(arr) {
  if (arr.length <= 1) return [arr];
  return arr.flatMap((x, i) =>
    permutations([...arr.slice(0, i), ...arr.slice(i + 1)]).map((rest) => [x, ...rest])
  );
}

const MUTATIONS = {
  // Disjoint nested object + disjoint array element.
  M1: {
    alpha: { updatedAt: 1000, a1: "x" },
    items: [{ id: "a", updatedAt: 3000, label: "from-M1", qty: 11 }],
  },
  // Disjoint nested object, a CONTENDING write on `shared` (older, subset), and
  // a disjoint array element.
  M2: {
    beta: { updatedAt: 2000, b1: "y" },
    shared: { updatedAt: 2000, s: "M2", only2: "k" },
    items: [{ id: "b", updatedAt: 3000, label: "from-M2" }],
  },
  // The WINNING write on `shared` (newer, and a superset of M2's keys), plus a
  // brand-new array element.
  M3: {
    shared: { updatedAt: 7000, s: "M3", only2: "K3", extra: "e" },
    items: [{ id: "c", updatedAt: 5000, label: "new-c" }],
  },
  // The WINNING write on array element `a` (newer, superset of M1's keys).
  M4: {
    items: [{ id: "a", updatedAt: 9000, label: "from-M4", qty: 99 }],
  },
};

const NAMES = ["M1", "M2", "M3", "M4"];

export default {
  name: "6. Convergence under reordering (CRDT promise)",
  cases: [
    {
      name: "all 24 permutations of 4 concurrent mutations converge to one document",
      async fn(t, c) {
        const perms = permutations(NAMES);
        t.eq(perms.length, 24, "testing all 4! = 24 apply orders");

        const outcomes = new Map(); // canonical form -> [order strings]
        for (const order of perms) {
          await c.reset();
          for (const name of order) {
            const res = await c.sync("doc-rows", MUTATIONS[name]);
            if (res.status !== 200) {
              t.status(res, 200, `apply ${name} in order ${order.join(">")} succeeds`);
            }
          }
          const doc = await c.data("doc-rows");
          const key = canon(doc);
          if (!outcomes.has(key)) outcomes.set(key, []);
          outcomes.get(key).push(order.join(">"));
        }

        t.eq(
          outcomes.size,
          1,
          `all 24 permutations produce ONE outcome (got ${outcomes.size} distinct)`
        );
        if (outcomes.size > 1) {
          let i = 0;
          for (const [form, orders] of outcomes) {
            t.info(`outcome ${++i} from ${orders.length} order(s), e.g. ${orders[0]}: ${form}`);
          }
        }

        // Pin the converged value so a change in merge semantics is visible,
        // not just "still self-consistent".
        const final = await c.data("doc-rows");
        t.deepEq(
          final.alpha,
          { updatedAt: 1000, a1: "x" },
          "disjoint object from M1 present"
        );
        t.deepEq(final.beta, { updatedAt: 2000, b1: "y" }, "disjoint object from M2 present");
        t.deepEq(
          final.shared,
          { updatedAt: 7000, s: "M3", only2: "K3", extra: "e" },
          "contended object `shared` resolved to the newer writer M3 (M2 subset-dominated)"
        );
        t.eq(final.title, "Keyed Rows", "untouched seed field preserved in every order");

        t.deepEq(
          final.items.map((r) => r.id),
          ["a", "b", "c"],
          "array identities and order converge"
        );
        t.deepEq(
          final.items.find((r) => r.id === "a"),
          { id: "a", createdAt: 1000, updatedAt: 9000, label: "from-M4", qty: 99 },
          "contended element `a` resolved to newer writer M4, base createdAt retained"
        );
        t.deepEq(
          final.items.find((r) => r.id === "b"),
          { id: "b", createdAt: 1000, updatedAt: 3000, label: "from-M2", qty: 2 },
          "disjointly-written element `b` merged over its seed values"
        );
        t.deepEq(
          final.items.find((r) => r.id === "c"),
          { id: "c", updatedAt: 5000, label: "new-c" },
          "newly-created element `c` present exactly once"
        );
      },
    },
    {
      name: "convergence also holds when the same mutations arrive in PARALLEL",
      async fn(t, c) {
        // Same set, but fired concurrently so the server's CAS retry decides the
        // interleaving. The result must still equal the sequential outcome.
        await c.reset();
        for (const name of NAMES) await c.sync("doc-rows", MUTATIONS[name]);
        const sequential = await c.data("doc-rows");

        let matched = 0;
        const ROUNDS = 3;
        for (let round = 0; round < ROUNDS; round++) {
          await c.reset();
          const results = await Promise.all(
            NAMES.map((name) => c.sync("doc-rows", MUTATIONS[name]))
          );
          const failed = results.filter((r) => r.status !== 200);
          t.eq(failed.length, 0, `round ${round + 1}: all 4 parallel syncs return 200`);
          if (canon(await c.data("doc-rows")) === canon(sequential)) matched++;
        }
        t.eq(
          matched,
          ROUNDS,
          `parallel application converged to the sequential outcome in all ${ROUNDS} rounds`
        );
      },
    },
    {
      name: "order-dependence boundary: a root-level lww key gates the WHOLE document",
      async fn(t, c) {
        // Documented consequence of all-or-nothing rejection at the root object:
        // once a document root carries updatedAt, an older root write is dropped
        // entirely — including its otherwise-disjoint fields. This is why the
        // convergent mutation set above keeps timestamps off the payload root.
        const fresh = { updatedAt: 5000, title: "T5000", onlyInFresh: "yes" };
        const stale = { updatedAt: 1000, title: "T1000", onlyInStale: "lost" };

        await c.reset();
        await c.sync("doc-1", stale);
        await c.sync("doc-1", fresh);
        const staleFirst = await c.data("doc-1");

        await c.reset();
        await c.sync("doc-1", fresh);
        const res = await c.sync("doc-1", stale);
        const freshFirst = await c.data("doc-1");

        t.status(res, 200, "the rejected-by-LWW root write still reports HTTP 200");
        t.eq(
          res.body?.merged,
          true,
          "…and reports merged:true even though nothing changed (the core returns base)"
        );

        t.eq(staleFirst.onlyInStale, "lost", "applying stale FIRST does land its disjoint field");
        t.eq(
          freshFirst.onlyInStale,
          undefined,
          "applying stale SECOND drops it entirely — whole-root rejection"
        );
        t.ne(
          canon(staleFirst),
          canon(freshFirst),
          "so root-level lww keys make the document order-DEPENDENT (by design, not a bug)"
        );
        t.eq(staleFirst.title, "T5000", "the newer title wins in both orders");
        t.eq(freshFirst.title, "T5000", "the newer title wins in both orders");
        t.eq(freshFirst.onlyInFresh, "yes", "the newer writer's own fields always land");
      },
    },
    {
      name: "disjoint documents converge trivially in any order (multi-doc)",
      async fn(t, c) {
        const apply = async (order) => {
          await c.reset();
          for (const [doc, payload] of order) await c.sync(doc, payload);
          return canon([
            await c.data("doc-1"),
            await c.data("doc-2"),
            await c.data("doc-3"),
          ]);
        };
        const muts = [
          ["doc-1", { settings: { theme: "one" } }],
          ["doc-2", { settings: { theme: "two" } }],
          ["doc-3", { metadata: { priority: 33 } }],
        ];
        const a = await apply(muts);
        const b = await apply([...muts].reverse());
        const d = await apply([muts[1], muts[2], muts[0]]);
        t.eq(a, b, "reversed multi-doc order converges");
        t.eq(a, d, "rotated multi-doc order converges");
      },
    },
  ],
};
