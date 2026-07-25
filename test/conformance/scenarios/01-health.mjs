/**
 * Scenario 1 — health / wiring.
 *
 * The single most important test in the suite: if the server fell back to a JS
 * merge, every other scenario could pass while the C core went completely
 * untested. Fail loudly here.
 */

function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? ""));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function gte(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return true;
}

export default {
  name: "1. Health & wiring (native core required)",
  cases: [
    {
      name: "syncer is the native C core, not the JS fallback",
      async fn(t, c) {
        const res = await c.health();
        t.status(res, 200, "GET /health responds 200");
        const h = res.body ?? {};
        t.eq(h.status, "ok", "health.status is ok");
        t.ne(
          h.syncer,
          "js-fallback",
          "health.syncer is NOT js-fallback (a JS merge would make this whole suite meaningless)"
        );
        t.eq(h.syncer, "native", "health.syncer is 'native'");
        t.eq(h.server, "node-postgres", "server identifies as node-postgres");
      },
    },
    {
      name: "coreVersion >= 0.2.0",
      async fn(t, c) {
        const h = (await c.health()).body ?? {};
        const parsed = parseSemver(h.coreVersion);
        t.ok(parsed, `coreVersion parses as semver (got ${h.coreVersion})`);
        if (parsed) {
          t.ok(
            gte(parsed, [0, 2, 0]),
            `coreVersion ${h.coreVersion} >= 0.2.0`
          );
        }
      },
    },
    {
      name: "test mode is on and default merge policy is the documented one",
      async fn(t, c) {
        const h = (await c.health()).body ?? {};
        t.eq(h.testMode, true, "testMode is true (enables /reset + X-Syncer-Options)");
        t.deepEq(
          h.defaultOptions,
          {
            arrayStrategy: 4,
            arrayMatchKeys: "id",
            resolveByTimestamp: true,
            lwwKeys: "updatedAt,syncedAt",
            fwwKeys: "createdAt",
          },
          "server-owned default policy is MERGE_BY_KEY/id + LWW(updatedAt,syncedAt) + FWW(createdAt)"
        );
      },
    },
    {
      name: "/reset restores the four seed documents",
      async fn(t, c) {
        const res = await c.request("/reset", { method: "POST" });
        t.status(res, 200, "POST /reset responds 200");
        t.eq(res.body?.seeded, 4, "reset seeds 4 documents");

        const docs = await c.docs();
        t.status(docs, 200, "GET /docs responds 200");
        t.deepEq(
          (docs.body ?? []).map((d) => d.id),
          ["doc-1", "doc-2", "doc-3", "doc-rows"],
          "seed doc ids are doc-1, doc-2, doc-3, doc-rows"
        );
        t.ok(
          (docs.body ?? []).every((d) => d.version === 1 && d.deleted_at === null),
          "every seed doc is at version 1 with no tombstone"
        );
      },
    },
  ],
};
