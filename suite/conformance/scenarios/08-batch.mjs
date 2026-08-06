/**
 * Scenario 8 — batch replay (/sync/batch).
 *
 * This is the shape a client's offline queue flushes in: an ordered list of
 * {docId, payload} mutations applied inside ONE transaction, each row taken with
 * `SELECT … FOR UPDATE` so concurrent batches serialize per document.
 *
 * Note the batch endpoint does NOT run payloads through the request schema that
 * /doc/:id/sync uses — it merges `m.payload` directly. Case coverage below
 * includes what that means for keys like `__proto__` (see also scenario 12).
 */

export default {
  name: "8. Batch replay (/sync/batch)",
  cases: [
    {
      name: "a multi-doc queue applies every mutation",
      async fn(t, c) {
        await c.reset();
        const res = await c.batch([
          { docId: "doc-1", payload: { metadata: { priority: 91 }, batched: "one" } },
          { docId: "doc-2", payload: { settings: { theme: "batched" } } },
          { docId: "doc-3", payload: { title: "Batched Gamma" } },
          { docId: "doc-rows", payload: { items: [{ id: "a", updatedAt: 9000, label: "batched-a" }] } },
        ]);
        t.status(res, 200, "POST /sync/batch responds 200");
        t.eq(res.body?.applied, 4, "reports 4 mutations applied");
        t.deepEq(
          res.body?.results,
          [
            { docId: "doc-1", applied: true },
            { docId: "doc-2", applied: true },
            { docId: "doc-3", applied: true },
            { docId: "doc-rows", applied: true },
          ],
          "per-item results all report applied:true"
        );

        t.eq((await c.data("doc-1")).metadata.priority, 91, "doc-1 nested merge applied");
        t.eq((await c.data("doc-1")).batched, "one", "doc-1 new root key applied");
        t.eq((await c.data("doc-1")).title, "Project Alpha", "doc-1 untouched field preserved");
        t.eq((await c.data("doc-2")).settings.theme, "batched", "doc-2 merge applied");
        t.eq(
          (await c.data("doc-2")).settings.notifications,
          false,
          "doc-2 sibling inside the merged object preserved"
        );
        t.eq((await c.data("doc-3")).title, "Batched Gamma", "doc-3 merge applied");
        t.eq(
          (await c.data("doc-rows")).items.find((r) => r.id === "a").label,
          "batched-a",
          "doc-rows keyed-array merge applied through the batch path"
        );
      },
    },
    {
      name: "replaying the SAME batch twice is semantically idempotent",
      async fn(t, c) {
        await c.reset();
        const batch = [
          { docId: "doc-1", payload: { metadata: { priority: 55, tags: ["b1"] } } },
          { docId: "doc-3", payload: { title: "Replay" } },
          {
            docId: "doc-rows",
            payload: {
              items: [
                { id: "a", updatedAt: 7000, label: "replay-a" },
                { id: "new", updatedAt: 7000, label: "replay-new" },
              ],
            },
          },
        ];

        const first = await c.batch(batch);
        t.eq(first.body?.applied, 3, "first replay applies 3");
        const snap1 = [await c.data("doc-1"), await c.data("doc-3"), await c.data("doc-rows")];
        const ver1 = await c.version("doc-1");

        const second = await c.batch(batch);
        t.eq(second.body?.applied, 3, "second replay also applies 3 (it is a real write)");
        const snap2 = [await c.data("doc-1"), await c.data("doc-3"), await c.data("doc-rows")];
        const ver2 = await c.version("doc-1");

        t.deepEq(snap2, snap1, "replayed batch leaves all documents deep-equal");
        t.eq(ver2, ver1 + 1, "version advances on replay (idempotent in VALUE, not in version)");
        t.eq(
          snap2[2].items.length,
          3,
          "the keyed array did not grow on replay (no duplicate `new` element)"
        );

        // A third replay for good measure.
        await c.batch(batch);
        t.deepEq(
          [await c.data("doc-1"), await c.data("doc-3"), await c.data("doc-rows")],
          snap1,
          "third replay still deep-equal"
        );
      },
    },
    {
      name: "an unknown docId is reported not-applied while its siblings still apply",
      async fn(t, c) {
        await c.reset();
        const res = await c.batch([
          { docId: "doc-1", payload: { before: "unknown" } },
          { docId: "does-not-exist", payload: { x: 1 } },
          { docId: "doc-3", payload: { after: "unknown" } },
        ]);
        t.status(res, 200, "batch with an unknown docId still responds 200");
        t.eq(res.body?.applied, 2, "reports 2 of 3 applied");
        t.deepEq(
          res.body?.results,
          [
            { docId: "doc-1", applied: true },
            { docId: "does-not-exist", applied: false, error: "not found" },
            { docId: "doc-3", applied: true },
          ],
          "the unknown docId is reported applied:false with error 'not found'"
        );
        t.eq(
          (await c.data("doc-1")).before,
          "unknown",
          "mutation BEFORE the unknown doc was applied"
        );
        t.eq(
          (await c.data("doc-3")).after,
          "unknown",
          "mutation AFTER the unknown doc was applied (the miss is skipped, not fatal)"
        );
        t.status(await c.getDoc("does-not-exist"), 404, "the unknown doc was not created");
      },
    },
    {
      name: "batch honours ordering within itself (later mutation wins on the same doc)",
      async fn(t, c) {
        await c.reset();
        const res = await c.batch([
          { docId: "doc-1", payload: { seq: "first", onlyFirst: 1 } },
          { docId: "doc-1", payload: { seq: "second", onlySecond: 2 } },
        ]);
        t.eq(res.body?.applied, 2, "both mutations on the same doc applied");
        const d = await c.data("doc-1");
        t.eq(d.seq, "second", "later mutation in the batch wins the contended key");
        t.eq(d.onlyFirst, 1, "earlier mutation's disjoint key survives");
        t.eq(d.onlySecond, 2, "later mutation's disjoint key present");
        t.eq(await c.version("doc-1"), 3, "version advanced twice (once per mutation)");
      },
    },
    {
      name: "batch respects timestamp resolution and X-Syncer-Options",
      async fn(t, c) {
        await c.reset();
        await c.batch([
          { docId: "doc-rows", payload: { items: [{ id: "a", updatedAt: 1000, label: "STALE" }] } },
        ]);
        t.eq(
          (await c.data("doc-rows")).items.find((r) => r.id === "a").label,
          "alpha",
          "stale element rejected through the batch path too"
        );

        // Same batch, but with REPLACE semantics forced per-request.
        await c.reset();
        await c.batch(
          [{ docId: "doc-rows", payload: { items: [{ id: "only", v: 1 }] } }],
          { options: { arrayStrategy: 0, resolveByTimestamp: false } }
        );
        const items = (await c.data("doc-rows")).items;
        t.eq(items.length, 1, "arrayStrategy=REPLACE via X-Syncer-Options honoured in batch");
        t.eq(items[0].id, "only", "array was replaced wholesale");
      },
    },
    {
      name: "malformed batch bodies are rejected with 400",
      async fn(t, c) {
        t.status(
          await c.batchRaw('{"notMutations":[]}'),
          400,
          "body without a `mutations` array -> 400"
        );
        t.status(await c.batchRaw('{"mutations":"nope"}'), 400, "`mutations` not an array -> 400");
        t.status(await c.batchRaw("{bad json"), 400, "malformed JSON -> 400");
        const empty = await c.batch([]);
        t.status(empty, 200, "an empty mutation list is valid");
        t.eq(empty.body?.applied, 0, "empty batch applies 0");
      },
    },
  ],
};
