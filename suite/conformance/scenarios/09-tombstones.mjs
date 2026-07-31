/**
 * Scenario 9 — tombstones (delete-vs-update).
 *
 * DELETE is a SOFT delete: it stamps `deleted_at` and bumps `version`, leaving
 * the row (and its data) in place so a delete-vs-update conflict is observable.
 *
 * The server compares the incoming payload's `updatedAt` against the tombstone
 * time, normalizing epoch values by magnitude (<=10 digits = seconds, <=13 = ms,
 * <=16 = µs, else ns) and falling back to Date.parse for anything else:
 *
 *   incoming updatedAt <= tombstone, or absent/unparseable  ->  410 Gone
 *   incoming updatedAt  > tombstone                         ->  resurrected
 */

const nowMs = () => Date.now();

export default {
  name: "9. Tombstones (delete vs update)",
  cases: [
    {
      name: "DELETE creates a tombstone and bumps the version",
      async fn(t, c) {
        await c.reset();
        const before = await c.getDoc("doc-2");
        const res = await c.deleteDoc("doc-2");
        t.status(res, 200, "DELETE /doc/:id responds 200");
        t.eq(res.body?.deleted, true, "response reports deleted:true");

        const after = await c.getDoc("doc-2");
        t.status(after, 200, "the row still exists (soft delete, not a hard delete)");
        t.ne(after.body.deleted_at, null, "deleted_at is stamped");
        t.eq(
          after.body.version,
          before.body.version + 1,
          "the tombstone advanced the version"
        );
        t.deepEq(
          after.body.data,
          before.body.data,
          "the data is retained behind the tombstone"
        );
      },
    },
    {
      name: "DELETE of an unknown document is 404",
      async fn(t, c) {
        await c.reset();
        t.status(await c.deleteDoc("no-such-doc"), 404, "DELETE unknown id -> 404");
      },
    },
    {
      name: "sync with an OLDER updatedAt -> 410 Gone, and the doc stays deleted",
      async fn(t, c) {
        await c.reset();
        await c.deleteDoc("doc-2");

        // 1000 -> 10 digits or fewer -> treated as epoch SECONDS -> 1970.
        const res = await c.sync("doc-2", { updatedAt: 1000, title: "stale-resurrect-attempt" });
        t.status(res, 410, "older-than-tombstone sync -> HTTP 410");
        t.eq(res.body?.deleted, true, "410 body reports deleted:true");
        t.ok(typeof res.body?.tombstoneAt === "string", "410 body carries tombstoneAt");

        const doc = await c.getDoc("doc-2");
        t.ne(doc.body.deleted_at, null, "document is STILL deleted");
        t.eq(doc.body.data.title, "Project Beta", "the stale payload did not modify the data");

        // An old ISO timestamp goes down the Date.parse path.
        const iso = await c.sync("doc-2", { updatedAt: "2001-01-01T00:00:00.000Z", title: "iso" });
        t.status(iso, 410, "older ISO-8601 updatedAt -> 410");
        t.ne((await c.getDoc("doc-2")).body.deleted_at, null, "still deleted after the ISO attempt");
      },
    },
    {
      name: "sync with NO updatedAt against a tombstone -> 410 (cannot prove freshness)",
      async fn(t, c) {
        await c.reset();
        await c.deleteDoc("doc-2");
        const res = await c.sync("doc-2", { title: "no-timestamp" });
        t.status(res, 410, "payload without updatedAt -> 410");
        t.ne((await c.getDoc("doc-2")).body.deleted_at, null, "document stays deleted");

        const junk = await c.sync("doc-2", { updatedAt: "not-a-date", title: "junk-ts" });
        t.status(junk, 410, "unparseable updatedAt -> 410");
      },
    },
    {
      name: "sync with a strictly NEWER updatedAt -> resurrected:true with merged data",
      async fn(t, c) {
        await c.reset();
        await c.deleteDoc("doc-2");
        const versionAtTombstone = (await c.getDoc("doc-2")).body.version;

        const future = nowMs() + 600_000; // 13-digit ms, comfortably after the tombstone
        const res = await c.sync("doc-2", {
          updatedAt: future,
          title: "RESURRECTED",
          freshField: "yes",
        });
        t.status(res, 200, "newer-than-tombstone sync responds 200");
        t.eq(res.body?.resurrected, true, "response reports resurrected:true");
        t.eq(res.body?.merged, true, "response reports merged:true");

        const doc = await c.getDoc("doc-2");
        t.eq(doc.body.deleted_at, null, "the tombstone was cleared");
        t.eq(doc.body.data.title, "RESURRECTED", "the incoming field was applied");
        t.eq(doc.body.data.freshField, "yes", "a brand-new field was applied");
        t.eq(
          doc.body.data.metadata?.owner?.name,
          "Bob",
          "PRE-DELETE data was merged back, not discarded — the row was resurrected, not recreated"
        );
        t.deepEq(
          doc.body.data.settings,
          { theme: "light", notifications: false },
          "nested pre-delete object survived the resurrection merge"
        );
        t.eq(
          doc.body.version,
          versionAtTombstone + 1,
          "resurrection advanced the version once"
        );
      },
    },
    {
      name: "a resurrected document behaves normally afterwards",
      async fn(t, c) {
        await c.reset();
        await c.deleteDoc("doc-rows");
        await c.sync("doc-rows", { updatedAt: nowMs() + 600_000, marker: "back" });
        t.eq((await c.getDoc("doc-rows")).body.deleted_at, null, "doc is live again");

        // Ordinary keyed-array reconciliation must work post-resurrection.
        const res = await c.sync("doc-rows", {
          items: [
            { id: "a", updatedAt: 9000, label: "post-resurrect" },
            { id: "new", updatedAt: 9000, label: "added" },
          ],
        });
        t.status(res, 200, "post-resurrection sync succeeds");
        t.eq(res.body?.resurrected, false, "resurrected:false once the doc is live");
        const items = (await c.data("doc-rows")).items;
        t.eq(items.length, 3, "keyed reconciliation works normally after resurrection");
        t.eq(
          items.find((r) => r.id === "a").label,
          "post-resurrect",
          "existing element merged post-resurrection"
        );
      },
    },
    {
      name: "re-deleting a live document is allowed and re-stamps the tombstone",
      async fn(t, c) {
        await c.reset();
        await c.deleteDoc("doc-2");
        const first = (await c.getDoc("doc-2")).body.deleted_at;
        await c.sync("doc-2", { updatedAt: nowMs() + 600_000, marker: 1 });
        const second = await c.deleteDoc("doc-2");
        t.status(second, 200, "second DELETE succeeds");
        const doc = await c.getDoc("doc-2");
        t.ne(doc.body.deleted_at, null, "tombstone re-applied");
        t.ne(doc.body.deleted_at, first, "the tombstone timestamp was refreshed");
        t.eq(doc.body.data.marker, 1, "data written between the deletes is retained");
      },
    },
    {
      name: "PUT resurrects a tombstoned document outright (test-setup escape hatch)",
      async fn(t, c) {
        await c.reset();
        await c.deleteDoc("doc-2");
        const res = await c.putDoc("doc-2", { replaced: true });
        t.status(res, 200, "PUT over a tombstone succeeds");
        const doc = await c.getDoc("doc-2");
        t.eq(doc.body.deleted_at, null, "PUT clears the tombstone");
        t.deepEq(doc.body.data, { replaced: true }, "PUT replaces data wholesale (no merge)");
      },
    },
  ],
};
