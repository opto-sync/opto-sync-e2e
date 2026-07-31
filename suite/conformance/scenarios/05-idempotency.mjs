/**
 * Scenario 5 — semantic idempotency.
 *
 * Replaying the same payload must not accumulate change. The comparison is
 * SEMANTIC (deep-equal), never byte-identity: the document is stored in jsonb,
 * which normalizes key order, so the raw text of two "identical" documents is
 * allowed to differ. `version` is expected to advance on every apply — each
 * replay is a real write, it just has no effect on the value.
 */

export default {
  name: "5. Semantic idempotency (replay N times)",
  cases: [
    {
      name: "same payload applied 5x converges after the first apply",
      async fn(t, c) {
        await c.reset();
        const payload = {
          title: "Idempotent",
          metadata: {
            priority: 7,
            tags: ["x", "y"],
            owner: { name: "Zed", email: "zed@example.com" },
            nested: { a: { b: { c: [1, 2, 3] } } },
          },
          settings: { theme: "auto" },
        };

        const snapshots = [];
        for (let i = 0; i < 5; i++) {
          const res = await c.sync("doc-1", payload);
          t.status(res, 200, `apply #${i + 1} succeeds`);
          snapshots.push(await c.data("doc-1"));
        }

        for (let i = 1; i < snapshots.length; i++) {
          t.deepEq(
            snapshots[i],
            snapshots[0],
            `apply #${i + 1} is deep-equal to apply #1 (semantically idempotent)`
          );
        }
        t.eq(
          (await c.version("doc-1")),
          1 + 5,
          "version advanced once per apply (each replay is a real write)"
        );
      },
    },
    {
      name: "keyed-array payload replayed 4x does not duplicate elements",
      async fn(t, c) {
        await c.reset();
        const payload = {
          items: [
            { id: "a", updatedAt: 5000, label: "A-new" },
            { id: "c", updatedAt: 5000, label: "C-new" },
            { id: "d", updatedAt: 5000, label: "D-new", children: [{ id: "d1", v: 1 }] },
          ],
        };

        const lengths = [];
        const snaps = [];
        for (let i = 0; i < 4; i++) {
          await c.sync("doc-rows", payload);
          const items = (await c.data("doc-rows")).items;
          lengths.push(items.length);
          snaps.push(items);
        }
        t.deepEq(lengths, [4, 4, 4, 4], "array length is stable at 4 across all 4 replays");
        for (let i = 1; i < snaps.length; i++) {
          t.deepEq(snaps[i], snaps[0], `replay #${i + 1} array is deep-equal to replay #1`);
        }
        t.deepEq(
          snaps[0].map((r) => r.id),
          ["a", "b", "c", "d"],
          "element identities and order are stable under replay"
        );
        t.eq(snaps[0][3].children.length, 1, "nested keyed child array did not duplicate");
      },
    },
    {
      name: "idempotent through jsonb: byte-identity is NOT expected, deep-equality IS",
      async fn(t, c) {
        await c.reset();
        // Insertion order chosen so jsonb must reorder it.
        const payload = { zzShort: 1, aLongerKeyName: 2, mid: 3 };
        await c.sync("doc-2", payload);
        const raw1 = (await c.rawDoc("doc-2")).text;
        await c.sync("doc-2", payload);
        const raw2 = (await c.rawDoc("doc-2")).text;

        t.deepEq(
          JSON.parse(raw2),
          JSON.parse(raw1),
          "replayed document is semantically identical"
        );
        // In practice jsonb is deterministic, so raw text also matches here —
        // assert that explicitly rather than leaving it ambiguous.
        t.eq(
          raw2,
          raw1,
          "jsonb normalization is deterministic, so raw text happens to match too"
        );
        t.ne(
          raw1,
          JSON.stringify(payload),
          "…but neither matches the byte order we submitted"
        );
      },
    },
    {
      name: "replaying a STALE payload is idempotent (rejected every time)",
      async fn(t, c) {
        await c.reset();
        await c.sync("doc-rows", { items: [{ id: "a", updatedAt: 8000, label: "fresh" }] });
        const baseline = await c.data("doc-rows");

        for (let i = 0; i < 3; i++) {
          const res = await c.sync("doc-rows", {
            items: [{ id: "a", updatedAt: 1000, label: `stale-${i}` }],
          });
          t.status(res, 200, `stale replay #${i + 1} still returns 200 (merge ran, changed nothing)`);
          t.deepEq(
            await c.data("doc-rows"),
            baseline,
            `stale replay #${i + 1} left the document unchanged`
          );
        }
      },
    },
  ],
};
