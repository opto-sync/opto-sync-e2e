/**
 * Scenario 2 — deep object merge.
 *
 * Baseline behaviour every other scenario builds on: object+object recurses,
 * untouched siblings survive at every level, new keys are added, and anything
 * that is not object-vs-object is a leaf overwrite (incoming wins).
 *
 * NOTE on `resolveByTimestamp`: the server default is `true` with
 * lwwKeys=updatedAt,syncedAt. These cases therefore deliberately avoid carrying
 * `updatedAt` on the objects being merged — otherwise object-level LWW would
 * gate the merge and we would be testing conflict resolution, not deep merge.
 * Timestamp gating gets its own scenario (03).
 */

export default {
  name: "2. Deep merge semantics",
  cases: [
    {
      name: "nested 4+ levels deep merges, siblings preserved at every level",
      async fn(t, c) {
        await c.reset();
        // doc-3 seed: metadata.nested.level1.level2.level3.deep_value = "original"
        const before = await c.data("doc-3");
        t.eq(
          before.metadata.nested.level1.level2.level3.deep_value,
          "original",
          "seed has a 4-level-deep value"
        );

        const res = await c.sync("doc-3", {
          metadata: {
            nested: {
              level1: {
                level2: {
                  level3: { deep_value: "changed", level4: { level5: { deepest: "v5" } } },
                  sibling_at_l2: "kept",
                },
              },
            },
          },
        });
        t.status(res, 200, "deep sync succeeds");
        t.eq(res.body?.merged, true, "response reports merged:true");
        t.eq(res.body?.mergedWith, "native-c-ffi", "merge was performed by the native C FFI");

        const d = await c.data("doc-3");
        t.eq(
          d.metadata.nested.level1.level2.level3.deep_value,
          "changed",
          "level-5 scalar overwritten"
        );
        t.eq(
          d.metadata.nested.level1.level2.level3.level4.level5.deepest,
          "v5",
          "brand-new 7-level-deep subtree added"
        );
        t.eq(
          d.metadata.nested.level1.level2.sibling_at_l2,
          "kept",
          "new sibling added mid-tree"
        );
        // Siblings from the seed that the payload never mentioned:
        t.eq(d.metadata.priority, 3, "untouched sibling scalar `priority` preserved");
        t.deepEq(d.metadata.tags, ["devops"], "untouched sibling array `tags` preserved");
        t.deepEq(
          d.metadata.owner,
          { name: "Charlie", email: "charlie@example.com" },
          "untouched sibling object `owner` preserved whole"
        );
        t.eq(d.title, "Project Gamma", "untouched root-level sibling `title` preserved");
      },
    },
    {
      name: "new keys added at root and nested; scalar overwrite",
      async fn(t, c) {
        await c.reset();
        await c.sync("doc-1", {
          title: "Project Alpha v2",
          rootNewKey: "root-added",
          metadata: { priority: 42, nestedNewKey: { a: 1 } },
        });
        const d = await c.data("doc-1");
        t.eq(d.title, "Project Alpha v2", "root scalar overwritten");
        t.eq(d.rootNewKey, "root-added", "new root key added");
        t.eq(d.metadata.priority, 42, "nested scalar overwritten (1 -> 42)");
        t.deepEq(d.metadata.nestedNewKey, { a: 1 }, "new nested object added");
        t.deepEq(
          d.settings,
          { theme: "dark", notifications: true },
          "sibling object `settings` untouched"
        );
      },
    },
    {
      name: "type change object -> string replaces wholesale (no merge attempted)",
      async fn(t, c) {
        await c.reset();
        const res = await c.sync("doc-1", { metadata: { owner: "just-a-string" } });
        t.status(res, 200, "type-changing sync succeeds");
        const d = await c.data("doc-1");
        t.eq(d.metadata.owner, "just-a-string", "object replaced by a string leaf");
        t.eq(typeof d.metadata.owner, "string", "stored type is string");
        t.eq(d.metadata.priority, 1, "sibling of the replaced key survives");
      },
    },
    {
      name: "type change string -> object, array -> object, object -> array",
      async fn(t, c) {
        await c.reset();
        // NOTE: these use schema-unconstrained paths. The server's request schema
        // pins `title` to a string and `metadata`/`settings` to objects, so a
        // type change on THOSE keys is a 400 rather than a merge — asserted
        // separately in scenario 12. Everything else is passthrough.
        await c.sync("doc-1", { custom: "a string" });
        t.eq((await c.data("doc-1")).custom, "a string", "scalar established at a free key");

        await c.sync("doc-1", { custom: { now: "an-object" } });
        t.deepEq(
          (await c.data("doc-1")).custom,
          { now: "an-object" },
          "string replaced by an object"
        );

        await c.sync("doc-1", { metadata: { tags: { notAnArray: true } } });
        t.deepEq(
          (await c.data("doc-1")).metadata.tags,
          { notAnArray: true },
          "array replaced by an object (array strategies only apply array-vs-array)"
        );

        await c.sync("doc-1", { metadata: { owner: [1, 2, 3] } });
        t.deepEq(
          (await c.data("doc-1")).metadata.owner,
          [1, 2, 3],
          "object replaced by an array"
        );

        await c.sync("doc-1", { custom: 42 });
        t.eq((await c.data("doc-1")).custom, 42, "object replaced by a number");
        t.eq(
          (await c.data("doc-1")).metadata.priority,
          1,
          "siblings survive every type change above"
        );
      },
    },
    {
      name: "incoming null SETS the key to null (it does not delete, and is not ignored)",
      async fn(t, c) {
        await c.reset();
        await c.sync("doc-1", { metadata: { owner: null }, brandNewNull: null });
        const d = await c.data("doc-1");
        // The C core has no null-as-delete semantics; null is an ordinary leaf.
        t.hasKey(d.metadata, "owner", "`owner` key still exists after null merge");
        t.eq(d.metadata.owner, null, "existing object replaced by JSON null");
        t.hasKey(d, "brandNewNull", "a new key whose value is null is created");
        t.eq(d.brandNewNull, null, "new null-valued key stored as null");
        t.eq(d.metadata.priority, 1, "sibling survives a null overwrite");

        const raw = await c.rawDoc("doc-1");
        t.contains(raw.text, '"owner": null', "null is persisted as JSON null in jsonb");
      },
    },
    {
      name: "empty object payload {} is a no-op on data (version still advances)",
      async fn(t, c) {
        await c.reset();
        const before = await c.getDoc("doc-1");
        const res = await c.sync("doc-1", {});
        t.status(res, 200, "empty payload accepted");
        const after = await c.getDoc("doc-1");
        t.deepEq(after.body.data, before.body.data, "document data unchanged by {}");
        t.eq(
          after.body.version,
          before.body.version + 1,
          "version still advances (the write is applied, it is just empty)"
        );
      },
    },
    {
      name: "empty nested object / empty array payloads do not clobber existing values",
      async fn(t, c) {
        await c.reset();
        const before = await c.data("doc-1");
        await c.sync("doc-1", { settings: {}, metadata: { tags: [] } });
        const d = await c.data("doc-1");
        t.deepEq(
          d.settings,
          before.settings,
          "empty incoming object merges as a no-op over an existing object"
        );
        t.deepEq(
          d.metadata.tags,
          before.metadata.tags,
          "empty incoming array is a no-op under MERGE_BY_KEY (nothing to reconcile)"
        );
      },
    },
    {
      name: "empty object / empty array as NEW keys are stored as-is",
      async fn(t, c) {
        await c.reset();
        await c.sync("doc-1", { freshObj: {}, freshArr: [] });
        const d = await c.data("doc-1");
        t.deepEq(d.freshObj, {}, "new empty object stored");
        t.deepEq(d.freshArr, [], "new empty array stored");
      },
    },
  ],
};
