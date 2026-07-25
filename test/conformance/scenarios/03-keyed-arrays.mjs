/**
 * Scenario 3 — keyed-array reconciliation (MERGE_BY_KEY), the headline feature.
 *
 * Seed fixture `doc-rows`:
 *   items: [
 *     { id:"a", createdAt:1000, updatedAt:2000, label:"alpha", qty:1 },
 *     { id:"b", createdAt:1000, updatedAt:2000, label:"beta",  qty:2 },
 *   ]
 *
 * Server policy: arrayStrategy=MERGE_BY_KEY, arrayMatchKeys="id",
 * resolveByTimestamp=true, lwwKeys="updatedAt,syncedAt", and NO fwwKeys.
 *
 * Three properties of the core that these cases pin down and that are easy to
 * get wrong when reading the output:
 *
 *  1. A timestamp rejection is ALL-OR-NOTHING for the matched element. The core
 *     does not descend and does not even copy incoming-only keys. So a stale
 *     element contributes literally nothing, not "everything except the
 *     conflicting fields".
 *
 *  2. lwwKeys is an OR-of-rejections, not a precedence list. If ANY lww key says
 *     the base is newer, the whole element is rejected — even if another lww key
 *     says the incoming is newer. The same holds ACROSS the lww and fww lists:
 *     either list can veto on its own.
 *
 *  3. Consequently `fwwKeys` is not field protection, it is a node-level VETO —
 *     which is why `createdAt` is NOT in the default policy. The FWW cases below
 *     therefore ask for it explicitly via X-Syncer-Options.
 */

const itemById = (items, id) =>
  (items ?? []).find((r) => String(r?.id) === String(id));

export default {
  name: "3. Keyed-array reconciliation (MERGE_BY_KEY)",
  cases: [
    {
      name: "stale element rejected while a FRESH SIBLING IN THE SAME ARRAY is accepted",
      async fn(t, c) {
        await c.reset();
        const res = await c.sync("doc-rows", {
          items: [
            // updatedAt 1000 < base 2000 -> stale, must be rejected entirely
            { id: "a", updatedAt: 1000, label: "STALE-a", sneakyNewField: "must-not-land" },
            // updatedAt 3000 > base 2000 -> fresh, must merge
            { id: "b", updatedAt: 3000, label: "FRESH-b" },
            // unknown id -> appended
            { id: "c", updatedAt: 5000, label: "NEW-c" },
          ],
        });
        t.status(res, 200, "mixed-freshness array sync succeeds");

        const items = (await c.data("doc-rows")).items;
        t.eq(items.length, 3, "array has 3 elements (2 base + 1 appended)");

        const a = itemById(items, "a");
        t.eq(a.label, "alpha", "STALE element `a` keeps its base label");
        t.eq(a.updatedAt, 2000, "stale element keeps its base updatedAt");
        t.lacksKey(
          a,
          "sneakyNewField",
          "rejection is ALL-OR-NOTHING: even incoming-only keys are dropped"
        );

        const b = itemById(items, "b");
        t.eq(b.label, "FRESH-b", "FRESH sibling in the SAME array is merged");
        t.eq(b.updatedAt, 3000, "fresh element takes the incoming updatedAt");
        t.eq(b.qty, 2, "fresh element retains base-only field `qty`");
        t.eq(b.createdAt, 1000, "fresh element retains base-only field `createdAt`");
      },
    },
    {
      name: "new id appended at the tail; existing-only id retained in place",
      async fn(t, c) {
        await c.reset();
        await c.sync("doc-rows", { items: [{ id: "z", updatedAt: 9000, label: "zeta" }] });
        const items = (await c.data("doc-rows")).items;
        t.eq(items.length, 3, "one element appended");
        t.deepEq(
          items.map((r) => r.id),
          ["a", "b", "z"],
          "base order preserved; new identity appended at the tail"
        );
        t.eq(itemById(items, "a").label, "alpha", "existing-only element `a` retained untouched");
        t.eq(itemById(items, "b").label, "beta", "existing-only element `b` retained untouched");
        t.eq(itemById(items, "z").label, "zeta", "appended element stored verbatim");
      },
    },
    {
      name: "reordered incoming array yields an identical result (order-independence)",
      async fn(t, c) {
        const incoming = [
          { id: "a", updatedAt: 4000, label: "A4" },
          { id: "b", updatedAt: 4000, label: "B4" },
          { id: "z", updatedAt: 4000, label: "Z4" },
          { id: "y", updatedAt: 4000, label: "Y4" },
        ];

        await c.reset();
        await c.sync("doc-rows", { items: incoming });
        const forward = (await c.data("doc-rows")).items;

        await c.reset();
        await c.sync("doc-rows", { items: [...incoming].reverse() });
        const reversed = (await c.data("doc-rows")).items;

        // Base-matched elements keep base order; appended ones follow incoming
        // order, so we compare as a set keyed by id plus assert base ordering.
        t.deepEq(
          Object.fromEntries(forward.map((r) => [r.id, r])),
          Object.fromEntries(reversed.map((r) => [r.id, r])),
          "reordering the incoming array produces the same element CONTENT"
        );
        t.deepEq(
          forward.slice(0, 2).map((r) => r.id),
          ["a", "b"],
          "base-matched elements stay in base order regardless of incoming order"
        );
        t.eq(forward.length, 4, "forward run has 4 elements");
        t.eq(reversed.length, 4, "reversed run has 4 elements");
      },
    },
    {
      name: "syncedAt acts as a second LWW key (OR-of-rejections, not precedence)",
      async fn(t, c) {
        await c.reset();
        // Establish a syncedAt on the base element.
        await c.sync("doc-rows", {
          items: [{ id: "a", updatedAt: 2500, syncedAt: 8000, label: "base-with-syncedAt" }],
        });
        let a = itemById((await c.data("doc-rows")).items, "a");
        t.eq(a.syncedAt, 8000, "base element now carries syncedAt=8000");
        t.eq(a.label, "base-with-syncedAt", "that first write landed");

        // updatedAt says incoming is NEWER (9999 > 2500) but syncedAt says the
        // base is newer (8000 > 100). Any lww key voting "base is newer" wins.
        await c.sync("doc-rows", {
          items: [{ id: "a", updatedAt: 9999, syncedAt: 100, label: "SHOULD-BE-REJECTED" }],
        });
        a = itemById((await c.data("doc-rows")).items, "a");
        t.eq(
          a.label,
          "base-with-syncedAt",
          "element rejected because syncedAt (2nd lww key) says base is newer"
        );
        t.eq(a.updatedAt, 2500, "rejected element keeps base updatedAt despite newer incoming");
        t.eq(a.syncedAt, 8000, "rejected element keeps base syncedAt");

        // Both lww keys newer -> accepted.
        await c.sync("doc-rows", {
          items: [{ id: "a", updatedAt: 10000, syncedAt: 9000, label: "ACCEPTED" }],
        });
        a = itemById((await c.data("doc-rows")).items, "a");
        t.eq(a.label, "ACCEPTED", "element accepted when BOTH lww keys are newer");
      },
    },
    {
      name: "syncedAt alone gates an element when updatedAt is absent on both sides",
      async fn(t, c) {
        await c.reset();
        await c.putDoc("sync-only", { rows: [{ id: "r1", syncedAt: 5000, v: "base" }] });
        await c.sync("sync-only", { rows: [{ id: "r1", syncedAt: 1000, v: "stale" }] });
        let r = itemById((await c.data("sync-only")).rows, "r1");
        t.eq(r.v, "base", "stale syncedAt rejected with no updatedAt anywhere");
        await c.sync("sync-only", { rows: [{ id: "r1", syncedAt: 6000, v: "fresh" }] });
        r = itemById((await c.data("sync-only")).rows, "r1");
        t.eq(r.v, "fresh", "newer syncedAt accepted");
      },
    },
    {
      name: "createdAt is FIRST-write-wins: a LATER creation claim is rejected",
      async fn(t, c) {
        await c.reset();
        // base a.createdAt = 1000. Incoming claims createdAt 5000 (later).
        // FWW rejects when base < incoming, so the whole element is dropped —
        // note this happens even though updatedAt(9000) says it is fresh.
        await c.sync("doc-rows", {
          items: [{ id: "a", createdAt: 5000, updatedAt: 9000, label: "CLAIMS-LATER-CREATION" }],
        });
        const a = itemById((await c.data("doc-rows")).items, "a");
        t.eq(a.label, "alpha", "element claiming a LATER createdAt is rejected");
        t.eq(a.createdAt, 1000, "original createdAt is preserved (first write wins)");
        t.eq(a.updatedAt, 2000, "FWW rejection also blocks the newer updatedAt");
      },
    },
    {
      name: "createdAt FWW: an EARLIER creation claim is accepted (it becomes the first write)",
      async fn(t, c) {
        await c.reset();
        await c.sync("doc-rows", {
          items: [{ id: "a", createdAt: 500, updatedAt: 9000, label: "CLAIMS-EARLIER" }],
        });
        const a = itemById((await c.data("doc-rows")).items, "a");
        t.eq(a.label, "CLAIMS-EARLIER", "element claiming an EARLIER createdAt is accepted");
        t.eq(a.createdAt, 500, "createdAt moves earlier — the true first write wins");
        t.eq(a.updatedAt, 9000, "accepted element takes the incoming updatedAt");
        t.eq(a.qty, 1, "base-only field retained through an accepted merge");
      },
    },
    {
      name: "numeric id 42 and string id \"42\" reconcile to ONE element (no duplicate)",
      async fn(t, c) {
        await c.reset();
        await c.sync("doc-rows", { items: [{ id: 42, updatedAt: 9000, label: "num-42" }] });
        let items = (await c.data("doc-rows")).items;
        t.eq(items.length, 3, "numeric id 42 appended as a new element");
        t.eq(typeof itemById(items, 42).id, "number", "id stored as a JSON number");

        // Same identity, spelled as a string. Must MATCH, not duplicate.
        await c.sync("doc-rows", { items: [{ id: "42", updatedAt: 9500, label: "str-42" }] });
        items = (await c.data("doc-rows")).items;
        t.eq(items.length, 3, "string id \"42\" did NOT create a duplicate element");
        t.eq(
          items.filter((r) => String(r.id) === "42").length,
          1,
          "exactly one element has identity 42"
        );
        const m = itemById(items, "42");
        t.eq(m.label, "str-42", "the matched element was merged");
        // The identity value takes on the incoming type after a matched merge.
        t.eq(typeof m.id, "string", "identity type follows the incoming element after merge");
      },
    },
    {
      name: "nested array-of-objects INSIDE a matched element also reconciles by key",
      async fn(t, c) {
        await c.reset();
        await c.sync("doc-rows", {
          items: [
            {
              id: "a",
              updatedAt: 3000,
              children: [
                { id: "c1", v: 1 },
                { id: "c2", v: 2 },
              ],
            },
          ],
        });
        let a = itemById((await c.data("doc-rows")).items, "a");
        t.eq(a.children.length, 2, "nested children array established");

        await c.sync("doc-rows", {
          items: [
            {
              id: "a",
              updatedAt: 4000,
              children: [
                { id: "c2", v: 22 }, // update existing child
                { id: "c3", v: 3 }, // append new child
              ],
            },
          ],
        });
        a = itemById((await c.data("doc-rows")).items, "a");
        t.eq(a.children.length, 3, "nested array reconciled: 2 base children + 1 appended");
        t.deepEq(
          a.children.map((ch) => ch.id),
          ["c1", "c2", "c3"],
          "nested base order preserved, new child appended"
        );
        t.eq(itemById(a.children, "c1").v, 1, "untouched nested child retained");
        t.eq(itemById(a.children, "c2").v, 22, "matched nested child updated");
        t.eq(itemById(a.children, "c3").v, 3, "new nested child appended");
      },
    },
    {
      name: "an element with no match key falls back to UNION (dedup by serialized form)",
      async fn(t, c) {
        await c.reset();
        // No `id` -> no identity -> union-append if not already present.
        await c.sync("doc-rows", { items: [{ noId: true, label: "keyless" }] });
        let items = (await c.data("doc-rows")).items;
        t.eq(items.length, 3, "keyless element appended");

        // Byte-identical repeat must NOT duplicate.
        await c.sync("doc-rows", { items: [{ noId: true, label: "keyless" }] });
        items = (await c.data("doc-rows")).items;
        t.eq(items.length, 3, "identical keyless element deduped by UNION fallback");
      },
    },
    {
      name: "equal timestamps merge (ties favour the incoming write)",
      async fn(t, c) {
        await c.reset();
        await c.sync("doc-rows", {
          items: [{ id: "a", updatedAt: 2000, label: "TIE", extra: "added-on-tie" }],
        });
        const a = itemById((await c.data("doc-rows")).items, "a");
        t.eq(a.label, "TIE", "an equal updatedAt is accepted, not rejected");
        t.eq(a.extra, "added-on-tie", "tie merge adds incoming-only keys");
      },
    },
    {
      name: "an element missing the lww key entirely is accepted (no gate to apply)",
      async fn(t, c) {
        await c.reset();
        await c.sync("doc-rows", { items: [{ id: "a", label: "NO-TIMESTAMP" }] });
        const a = itemById((await c.data("doc-rows")).items, "a");
        t.eq(
          a.label,
          "NO-TIMESTAMP",
          "incoming without updatedAt is accepted even though base has one"
        );
        t.eq(a.updatedAt, 2000, "base updatedAt survives (incoming did not carry one)");
      },
    },
  ],
};
