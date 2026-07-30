/**
 * Scenario 7 — concurrency & compare-and-swap.
 *
 * The server does optimistic concurrency: read (data, version), merge, then
 * `UPDATE … WHERE version = <the version we read>`. Losing that race means
 * re-reading and merging again, bounded by MAX_CAS_ATTEMPTS = 12 (SYNCER_CAS_ATTEMPTS).
 *
 * ── The invariant that actually matters ───────────────────────────────────
 * "All 20 parallel writes succeed" is NOT a property this server has: with 20-way
 * contention and a 5-attempt budget, some writers exhaust their retries and get a
 * 409 telling them to retry at the application layer. That is a capacity limit,
 * not a correctness bug.
 *
 * The correctness invariant — and what these cases assert — is that CAS never
 * loses an ACKNOWLEDGED write and never half-applies a rejected one:
 *
 *   1. every sync that returned 200 has its field present in the final document
 *   2. every sync that returned 409 has its field ABSENT (no phantom write)
 *   3. final version == initial version + (number of 200s)
 *
 * Together those say: the set of durable mutations is exactly the set of
 * acknowledged mutations. The observed 409 rate is reported as an observation and
 * (when non-zero) as a known limitation, so the retry budget is visible rather
 * than silently tolerated.
 */

const codeHistogram = (results) => {
  const h = {};
  for (const r of results) h[r.status] = (h[r.status] ?? 0) + 1;
  return h;
};

/**
 * Fire N parallel syncs at one doc, each setting a distinct field `f<i>`, then
 * check the three CAS invariants. Payloads carry NO lww keys, so nothing can be
 * dropped by timestamp resolution — any missing field is a genuine lost update.
 */
async function contend(t, c, { n, noRetry, docId = "doc-1" }) {
  await c.reset();
  const startVersion = await c.version(docId);

  const results = await Promise.all(
    Array.from({ length: n }, (_, i) =>
      c.sync(docId, { [`f${i}`]: i }, { noRetry })
    )
  );

  const ok = [];
  const conflicted = [];
  const other = [];
  results.forEach((r, i) => {
    if (r.status === 200) ok.push(i);
    else if (r.status === 409) conflicted.push(i);
    else other.push({ i, status: r.status, body: r.body });
  });

  t.eq(other.length, 0, `no unexpected status codes (${JSON.stringify(codeHistogram(results))})`);

  const doc = await c.getDoc(docId);
  const data = doc.body.data;

  const lostAcked = ok.filter((i) => !Object.prototype.hasOwnProperty.call(data, `f${i}`));
  t.eq(
    lostAcked.length,
    0,
    `INVARIANT 1: no acknowledged write was lost (${ok.length} acked, missing: ${JSON.stringify(
      lostAcked.map((i) => `f${i}`)
    )})`
  );

  const phantom = conflicted.filter((i) =>
    Object.prototype.hasOwnProperty.call(data, `f${i}`)
  );
  t.eq(
    phantom.length,
    0,
    `INVARIANT 2: no 409-rejected write was partially applied (${conflicted.length} rejected)`
  );

  t.eq(
    doc.body.version,
    startVersion + ok.length,
    `INVARIANT 3: version advanced exactly once per acknowledged write (${startVersion} + ${ok.length})`
  );

  return { results, ok, conflicted, data, version: doc.body.version };
}

export default {
  name: "7. Concurrency & CAS retry",
  cases: [
    {
      name: "5 parallel syncs with retry: all succeed, retry absorbs the contention",
      async fn(t, c) {
        const { results, ok, conflicted } = await contend(t, c, { n: 5 });
        t.eq(ok.length, 5, "all 5 parallel syncs return 200");
        t.eq(conflicted.length, 0, "the CAS budget absorbs 5-way contention");
        const attempts = results.map((r) => r.body?.attempts);
        t.ok(
          attempts.every((a) => Number.isInteger(a) && a >= 1 && a <= 5),
          `every response reports attempts within the budget (got ${JSON.stringify(attempts)})`
        );
        t.ok(
          attempts.some((a) => a > 1),
          "at least one sync actually had to retry (proving the race is real, not serialized)"
        );
      },
    },
    {
      name: "20 parallel syncs with retry: CAS never loses or half-applies a write",
      async fn(t, c) {
        const { results, ok, conflicted, data } = await contend(t, c, { n: 20 });

        // Untouched seed fields must survive 20 concurrent merges.
        t.eq(data.title, "Project Alpha", "seed field `title` survived 20 concurrent merges");
        t.deepEq(
          data.metadata?.owner,
          { name: "Alice", email: "alice@example.com" },
          "nested seed object survived 20 concurrent merges intact"
        );
        t.eq(
          ok.length + conflicted.length,
          20,
          "every request resolved as either 200 or 409"
        );
        t.ok(ok.length > 0, "at least some writes succeeded");

        t.info(
          `status histogram: ${JSON.stringify(codeHistogram(results))} — ` +
            `${ok.length}/20 acknowledged`
        );

        // Was a known limitation: with a 5-attempt budget and no backoff, 20-way
        // contention produced 25-60% 409s because every loser retried in lockstep.
        // The server now uses a 12-attempt budget with full-jitter backoff, so
        // ordinary contention is absorbed server-side. Asserted, not merely warned,
        // so a regression in the retry policy is caught here.
        t.eq(
          conflicted.length,
          0,
          "no writer should exhaust the CAS budget under 20-way contention"
        );
        t.eq(ok.length, 20, "every concurrent writer is acknowledged")
      },
    },
    {
      name: "?noRetry=1 surfaces the 409 conflict instead of retrying",
      async fn(t, c) {
        // The race is expected to be reliable here (a single attempt, 12 writers),
        // but we retry a few rounds rather than assert on one sample — and if the
        // conflict genuinely never materialises we say so instead of failing flakily.
        const ROUNDS = 5;
        let sawConflict = false;
        let best = null;

        for (let round = 0; round < ROUNDS && !sawConflict; round++) {
          const { results, ok, conflicted } = await contend(t, c, { n: 12, noRetry: true });
          best = { histogram: codeHistogram(results), ok: ok.length, conflicted: conflicted.length };
          if (conflicted.length > 0) {
            sawConflict = true;
            t.ok(true, `409 conflict observed with ?noRetry=1 (round ${round + 1}: ${conflicted.length}/12)`);
            // Requests are launched together, but the server is free to begin
            // handling a later request after an earlier winner commits. More
            // than one 200 is therefore valid; the contract is that at least
            // one stale CAS is surfaced as 409 and every outcome satisfies the
            // durable-write invariants checked by contend().
            t.ok(
              ok.length >= 1 && ok.length < 12,
              `some writers win and some surface conflicts (${ok.length} ok, ${conflicted.length} conflict)`
            );
            const conflictBody = results.find((r) => r.status === 409)?.body;
            t.eq(conflictBody?.conflict, true, "409 body sets conflict:true");
            t.ok(
              typeof conflictBody?.error === "string" && conflictBody.error.length > 0,
              "409 body carries an error message"
            );
            t.info(`histogram: ${JSON.stringify(best.histogram)}`);
          }
        }

        if (!sawConflict) {
          // Reported honestly rather than asserted flakily.
          t.limitation(
            true,
            `no 409 observed with ?noRetry=1 across ${ROUNDS} rounds of 12 parallel syncs`,
            `The CAS race did not materialise — requests were effectively serialized. ` +
              `Last histogram: ${JSON.stringify(best?.histogram)}. This is NOT asserted as a ` +
              `failure because it depends on scheduling, but the conflict path went untested.`
          );
        }
      },
    },
    {
      name: "?noRetry=1 still succeeds when there is no contention",
      async fn(t, c) {
        await c.reset();
        const res = await c.sync("doc-1", { solo: true }, { noRetry: true });
        t.status(res, 200, "uncontended noRetry sync succeeds");
        t.eq(res.body?.attempts, 1, "reports exactly 1 attempt");
        t.eq((await c.data("doc-1")).solo, true, "the write landed");
      },
    },
    {
      name: "concurrent syncs to DIFFERENT documents never conflict",
      async fn(t, c) {
        await c.reset();
        const docs = ["doc-1", "doc-2", "doc-3", "doc-rows"];
        const results = await Promise.all(
          docs.flatMap((id) =>
            Array.from({ length: 3 }, (_, i) => c.sync(id, { [`p${i}`]: i }))
          )
        );
        t.eq(
          results.filter((r) => r.status === 200).length,
          12,
          "all 12 syncs across 4 documents succeed (3-way contention per row)"
        );
        for (const id of docs) {
          const d = await c.data(id);
          t.deepEq(
            [d.p0, d.p1, d.p2],
            [0, 1, 2],
            `${id} received all three of its mutations`
          );
        }
      },
    },
  ],
};
