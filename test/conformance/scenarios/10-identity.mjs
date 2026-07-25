/**
 * Scenario 10 — identity by UNIQUE INDEX rather than primary key.
 *
 * `syncer_test_docs_profiles` has a BIGSERIAL surrogate primary key and a UNIQUE
 * `email` column. The row's real identity is the email, so two offline clients
 * that both "create" the same email must converge onto ONE row rather than
 * producing a duplicate or a unique-violation error.
 *
 * The reconcile loop is: SELECT by email -> if absent INSERT (catching 23505
 * unique_violation and looping to merge instead) -> else CAS-merge on version.
 *
 * NOTE the profile merge runs the same server policy as documents, which means
 * ROOT-level LWW on updatedAt is active on the payload root. That is what the
 * stale-update case exercises; cases that just want field union deliberately omit
 * updatedAt so nothing is gated.
 */

export default {
  name: "10. Unique-index identity (/profile/sync)",
  cases: [
    {
      name: "two 'creates' for the same email converge to ONE row with both payloads' fields",
      async fn(t, c) {
        await c.reset();
        const email = "converge@example.com";

        const first = await c.profileSync({ email, name: "Alice", fromClientA: 1 });
        t.status(first, 200, "first create responds 200");
        t.eq(first.body?.created, true, "first call reports created:true");
        t.eq(first.body?.profile?.version, 1, "new row starts at version 1");
        const id = first.body?.profile?.id;
        t.ok(id != null, "the row has a surrogate primary key");

        const second = await c.profileSync({ email, nickname: "Al", fromClientB: 2 });
        t.status(second, 200, "second create responds 200");
        t.eq(second.body?.created, false, "second call reports created:false — it MERGED");
        t.eq(second.body?.profile?.id, id, "SAME surrogate id: identity is the email, not the PK");
        t.eq(second.body?.profile?.version, 2, "version incremented to 2");

        const data = second.body?.profile?.data ?? {};
        t.eq(data.email, email, "email retained");
        t.eq(data.name, "Alice", "client A's field survived");
        t.eq(data.fromClientA, 1, "client A's second field survived");
        t.eq(data.nickname, "Al", "client B's field applied");
        t.eq(data.fromClientB, 2, "client B's second field applied");
        t.deepEq(
          Object.keys(data).sort(),
          ["email", "fromClientA", "fromClientB", "name", "nickname"],
          "the two payloads were merged, not replaced"
        );

        const fetched = await c.getProfile(email);
        t.status(fetched, 200, "GET /profile/:email finds the row");
        t.eq(fetched.body?.id, id, "GET returns the same single row");
        t.deepEq(fetched.body?.data, data, "GET data matches the sync response");
      },
    },
    {
      name: "a stale update (older updatedAt) is rejected wholesale",
      async fn(t, c) {
        await c.reset();
        const email = "stale@example.com";
        await c.profileSync({ email, stage: "initial" });
        await c.profileSync({ email, updatedAt: 5000, stage: "fresh", freshOnly: "kept" });
        const beforeStale = await c.getProfile(email);

        const res = await c.profileSync({
          email,
          updatedAt: 1000,
          stage: "STALE",
          staleOnly: "must-not-land",
        });
        t.status(res, 200, "stale profile sync still responds 200");

        const after = await c.getProfile(email);
        t.eq(after.body?.data?.stage, "fresh", "the stale value was rejected");
        t.eq(after.body?.data?.updatedAt, 5000, "the newer updatedAt is retained");
        t.lacksKey(
          after.body?.data ?? {},
          "staleOnly",
          "rejection is all-or-nothing: the stale payload's own field did not land"
        );
        t.eq(after.body?.data?.freshOnly, "kept", "the fresh writer's field is untouched");
        t.eq(
          after.body?.version,
          beforeStale.body.version + 1,
          "version still advances even though the merge changed nothing"
        );
        t.eq(after.body?.id, beforeStale.body.id, "still the same row");
      },
    },
    {
      name: "a newer update is applied and merges over the existing row",
      async fn(t, c) {
        await c.reset();
        const email = "fresh@example.com";
        await c.profileSync({ email, updatedAt: 1000, stage: "old", keepMe: "yes" });
        await c.profileSync({ email, updatedAt: 9000, stage: "new", alsoNew: "y" });
        const d = (await c.getProfile(email)).body?.data ?? {};
        t.eq(d.stage, "new", "newer updatedAt wins the contended key");
        t.eq(d.keepMe, "yes", "the older writer's disjoint field survives (it applied first)");
        t.eq(d.alsoNew, "y", "the newer writer's own field applied");
        t.eq(d.updatedAt, 9000, "updatedAt advanced");
      },
    },
    {
      name: "parallel first-writes for a BRAND-NEW email produce exactly one row",
      async fn(t, c) {
        await c.reset();
        const email = "race@example.com";
        const N = 6;

        // All six believe they are creating the row. Exactly one INSERT can win;
        // the others must hit 23505 and fall through to a merge.
        const results = await Promise.all(
          Array.from({ length: N }, (_, i) => c.profileSync({ email, [`k${i}`]: i }))
        );

        const okResults = results.filter((r) => r.status === 200);
        t.eq(okResults.length, N, `all ${N} parallel first-writes return 200`);

        const created = results.filter((r) => r.body?.created === true);
        t.eq(created.length, 1, "EXACTLY ONE request reports created:true (the INSERT winner)");

        const ids = new Set(okResults.map((r) => r.body?.profile?.id));
        t.eq(ids.size, 1, "every response references the SAME surrogate id — one row, not six");

        const fetched = await c.getProfile(email);
        t.status(fetched, 200, "the single row is retrievable by email");
        t.eq(
          fetched.body?.version,
          N,
          `version == ${N}: every one of the parallel writes landed on the one row`
        );

        const data = fetched.body?.data ?? {};
        const missing = Array.from({ length: N }, (_, i) => `k${i}`).filter(
          (k) => !Object.prototype.hasOwnProperty.call(data, k)
        );
        t.deepEq(
          missing,
          [],
          "no mutation was lost in the unique-violation retry path (all k0..k5 present)"
        );
        t.eq(data.email, email, "email field present on the merged row");
      },
    },
    {
      name: "parallel writes to an EXISTING email also converge on one row",
      async fn(t, c) {
        await c.reset();
        const email = "existing@example.com";
        await c.profileSync({ email, base: true });
        const id = (await c.getProfile(email)).body.id;

        const results = await Promise.all(
          Array.from({ length: 5 }, (_, i) => c.profileSync({ email, [`p${i}`]: i }))
        );
        const ok = results.filter((r) => r.status === 200);
        const conflicted = results.filter((r) => r.status === 409);
        t.eq(ok.length + conflicted.length, 5, "every request resolved as 200 or 409");
        t.eq(
          new Set(ok.map((r) => r.body?.profile?.id)).size,
          1,
          "all successful writes hit the same row"
        );

        const after = await c.getProfile(email);
        t.eq(after.body.id, id, "the surrogate id never changed");
        t.eq(after.body.data.base, true, "the pre-existing field survived");
        t.eq(
          after.body.version,
          1 + ok.length,
          "version advanced exactly once per acknowledged write"
        );
        const ackedKeys = results
          .map((r, i) => (r.status === 200 ? `p${i}` : null))
          .filter(Boolean);
        t.deepEq(
          ackedKeys.filter((k) => !Object.prototype.hasOwnProperty.call(after.body.data, k)),
          [],
          "every acknowledged parallel write is present in the final row"
        );
        const rejectedKeys = results
          .map((r, i) => (r.status === 409 ? `p${i}` : null))
          .filter(Boolean);
        t.deepEq(
          rejectedKeys.filter((k) => Object.prototype.hasOwnProperty.call(after.body.data, k)),
          [],
          "no 409-rejected write was partially applied"
        );
      },
    },
    {
      name: "distinct emails create distinct rows",
      async fn(t, c) {
        await c.reset();
        const a = await c.profileSync({ email: "a@example.com", who: "a" });
        const b = await c.profileSync({ email: "b@example.com", who: "b" });
        t.eq(a.body?.created, true, "first email created");
        t.eq(b.body?.created, true, "second email created");
        t.ne(a.body?.profile?.id, b.body?.profile?.id, "different emails get different rows");
        t.eq((await c.getProfile("a@example.com")).body?.data?.who, "a", "row A intact");
        t.eq((await c.getProfile("b@example.com")).body?.data?.who, "b", "row B intact");
      },
    },
    {
      name: "profile requests without an email string are rejected; unknown email is 404",
      async fn(t, c) {
        await c.reset();
        t.status(await c.profileSync({ name: "no-email" }), 400, "missing email -> 400");
        t.status(await c.profileSync({ email: "" }), 400, "empty email -> 400");
        t.status(await c.profileSync({ email: 42 }), 400, "non-string email -> 400");
        t.status(
          await c.getProfile("nobody@nowhere.invalid"),
          404,
          "GET unknown profile -> 404"
        );
      },
    },
  ],
};
