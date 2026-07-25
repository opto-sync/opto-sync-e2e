# Building a correct opto-sync server

How to write a sync server that the conformance suite in this repo would pass.

Every rule below is derived from the reference implementation
[`servers/node/src/index.ts`](../servers/node/src/index.ts) — the only server
here that round-trips every merge through real Postgres `jsonb` — and from the
scenarios in [`test/conformance/`](../test/conformance/) that hold it to those
rules. Where the reference server does something *because* a scenario would
otherwise catch it, the scenario is named.

Merge semantics themselves are not restated here. They are specified in
[`syncer.c/docs/MERGE_SEMANTICS.md`](../../syncer.c/docs/MERGE_SEMANTICS.md),
with versioning and ABI rules in
[`syncer.c/docs/COMPATIBILITY.md`](../../syncer.c/docs/COMPATIBILITY.md). This
document is about everything *around* the merge call.

---

## 1. The HTTP contract the suites assume

All shapes below are read off `servers/node/src/index.ts`. The conformance
client that speaks this contract is
[`test/conformance/lib/client.mjs`](../test/conformance/lib/client.mjs).

| Method | Path | Request | 2xx body | Non-2xx |
|---|---|---|---|---|
| `GET` | `/health` | — | `{status, server, syncer, coreVersion, testMode, defaultOptions}` | — |
| `GET` | `/docs` | — | array of `{id, data, version, updated_at, deleted_at}`, ordered by `id` | `500 {error}` |
| `GET` | `/doc/:id` | — | `{id, data, version, updated_at, deleted_at}` | `404 {error}`, `500 {error}` |
| `GET` | `/doc/:id/raw` | — | the stored `data::text` verbatim, `Content-Type: application/json` | `404 {error}`, `500` |
| `PUT` | `/doc/:id` | any JSON object (missing body treated as `{}`) | `{created: true, document: {id, data, version}}` | `500 {error}` |
| `DELETE` | `/doc/:id` | — | `{deleted: true, document: {id, version, deleted_at}}` | `404 {error}`, `500` |
| `POST` | `/doc/:id/sync[?noRetry=1]` | JSON object, schema-validated | `{merged: true, attempts, document: {id, data, version, updated_at}, mergedWith, resurrected}` | `400 {error, details?}`, `404`, `409 {error, conflict: true}`, `410 {error, deleted: true, tombstoneAt}` |
| `POST` | `/sync/batch` | `{mutations: [{docId, payload}]}` | `{applied: N, results: [{docId, applied, error?}]}` | `400 {error}`, `500 {error}` (after `ROLLBACK`) |
| `POST` | `/profile/sync` | JSON object containing a non-empty `email` string | `{merged: true, created, attempts, profile: {id, email, data, version}}` | `400 {error}`, `409 {error, conflict: true}`, `500` |
| `GET` | `/profile/:email` | — | `{id, email, data, version}` | `404 {error}`, `500` |
| `POST` | `/reset` | — | `{reset: true, seeded: 4}` | `403 {error}` outside test mode, `500` |

Notes that matter for compatibility:

- **`/health` is a capability probe, not a liveness probe.** The suite refuses
  to run unless it reports `syncer: "native"` and `testMode: true`
  (`test/conformance/run.mjs`, lines 94–109), and scenario `01-health` asserts
  `defaultOptions` deep-equals the documented policy. Publish your real merge
  policy there; a server that hides it cannot be conformance-tested.
- **`GET /doc/:id/raw` exists so tests can see what the database did to your
  JSON.** It selects `data::text`, not a re-serialized object. Without it,
  scenario `04-jsonb-fidelity` cannot distinguish "the value survived" from
  "our JSON layer rounded it and then printed it back consistently".
- **`PUT` is deliberately not a merge.** It replaces `data` wholesale, sets
  `version = 1` on insert or `version + 1` on conflict, and clears
  `deleted_at`. It exists as test setup. Scenario `09-tombstones` pins that
  `PUT` over a tombstone resurrects the row outright.
- **`?noRetry=1` caps the CAS loop at one attempt.** It is how scenario
  `07-concurrency` observes the 409 path at all; with the production retry
  budget the conflict is normally absorbed.
- The in-memory servers implement only `GET /`, `/health`, `/docs`,
  `/doc/:id` and `POST /doc/:id/sync` (plus `PUT /doc/:id` on `rust-mash`).
  A new server needs the full table above only if you want it to run the
  conformance suite; `run_e2e_full.sh` and `test/cross-server/` need just
  `/health`, `/doc/:id` and `/doc/:id/sync`.

---

## 2. The server owns the merge policy

`DEFAULT_MERGE_OPTIONS` is a module-level constant in the reference server:

```ts
const DEFAULT_MERGE_OPTIONS = {
  arrayStrategy: ArrayStrategy.MERGE_BY_KEY,
  arrayMatchKeys: "id",
  resolveByTimestamp: true,
  lwwKeys: "updatedAt,syncedAt",
  fwwKeys: "createdAt",
};
```

Conflict resolution is a **correctness and trust** decision, and neither
property survives letting the client choose:

- **Correctness.** Convergence is a property of *one* policy applied to *all*
  writes. If client A reconciles arrays with `MERGE_BY_KEY` and client B with
  `REPLACE`, the final document depends on which client wrote last — the exact
  order-dependence the merge engine exists to remove.
  `test/clients/README.md` documents this happening for real: the TypeScript
  client's `DEFAULT_RECONCILE_OPTIONS` omits `arrayStrategy`, so it falls back
  to `REPLACE` and *drops server elements it has not seen while applying
  elements the timestamp guard should have rejected*. A server that accepted
  that client's policy per request would have persisted the data loss.
- **Trust.** A client-supplied `resolveByTimestamp: false` disables LWW/FWW
  gating entirely (asserted in scenario `11-strategies`). That turns "stale
  writes are rejected" into "stale writes are rejected unless the writer asks
  nicely" — i.e. any client can overwrite any newer value.

The reference server therefore honours a per-request override **only in test
mode**:

```ts
const TEST_MODE = process.env.E2E_ALLOW_OPTION_OVERRIDE === "1";

function optionsFromRequest(req) {
  if (!TEST_MODE) return DEFAULT_MERGE_OPTIONS;      // production: ignored outright
  const raw = req.header("X-Syncer-Options");
  if (!raw) return DEFAULT_MERGE_OPTIONS;
  try { return { ...DEFAULT_MERGE_OPTIONS, ...JSON.parse(raw) }; }
  catch { throw Object.assign(new Error("X-Syncer-Options is not valid JSON"), { status: 400 }); }
}
```

Three properties worth copying:

1. Outside test mode the header is not merely rejected, it is **never read**.
2. In test mode the override is layered *over* the server defaults, so a
   scenario changes one knob without silently resetting the rest.
3. A malformed header is a `400` naming the header, not a `500` — pinned by the
   last case of scenario `11-strategies`.

The same helper is called from all three write paths (`/doc/:id/sync`,
`/sync/batch`, `/profile/sync`), which is why scenario `08-batch` can assert
`arrayStrategy: 0` takes effect through the batch endpoint too. If you add a
write path, route it through the same function or the policy will drift.

`/reset` is gated on the same flag and answers `403` otherwise. Any endpoint
that truncates tables belongs behind that gate.

---

## 3. Concurrency: compare-and-swap on a version column

### The failure mode without it

Two syncs for one document overlap:

```
T1: SELECT data, version -> (D, 7)
T2: SELECT data, version -> (D, 7)
T1: merge(D, a) = Da ; UPDATE ... SET data = Da        -- version now 8
T2: merge(D, b) = Db ; UPDATE ... SET data = Db        -- version now 9
```

`Db` was computed from `D`, not from `Da`. T1's merge is gone, and T1's client
got a `200`. The write was acknowledged and lost — the one outcome a sync
engine must never produce.

### The fix

Read the version, then make the write conditional on it:

```sql
UPDATE syncer_test_docs
   SET data = $1::jsonb, version = version + 1, updated_at = NOW(), deleted_at = NULL
 WHERE id = $3 AND version = $2
RETURNING id, data, version, updated_at
```

Zero rows returned means someone else committed in between: re-read, re-merge,
retry. The merge is a pure function of (base, incoming), so re-running it on
the new base is always safe.

### Retry budget and backoff

```ts
const MAX_CAS_ATTEMPTS = parseInt(process.env.SYNCER_CAS_ATTEMPTS || "12", 10);

/** Full-jitter exponential backoff, capped. */
function casBackoff(attempt: number): Promise<void> {
  const ceiling = Math.min(2 ** attempt, 40);
  return new Promise((resolve) => setTimeout(resolve, Math.random() * ceiling));
}
```

The measured history, recorded in the code comments at
`servers/node/src/index.ts:44-58` and in scenario `07-concurrency`:

| Configuration | Behaviour at 20-way contention on one document |
|---|---|
| 5 attempts, no backoff | **25–60% of writers returned `409`** — every loser retried in lockstep and collided again |
| 12 attempts, full-jitter backoff | all 20 writers acknowledged; **zero lost writes** |

Retrying immediately is the trap: all losers wake at the same instant and
re-collide, so a bigger budget alone buys little. Jitter de-synchronizes them,
which is what turns the budget into throughput. The identical pattern is used
on `/profile/sync`.

### A 409 is honest, not a bug

When the budget is exhausted the server answers
`409 {error: "Concurrent update, retry the sync", conflict: true}` and
**nothing was written**. Scenario `07-concurrency` asserts exactly three
invariants, and they are the right ones to hold yourself to:

1. every sync that returned `200` has its field present in the final document;
2. every sync that returned `409` has its field **absent** — no phantom or
   partial write;
3. `final version == initial version + (number of 200s)`.

Together: *the set of durable mutations is exactly the set of acknowledged
mutations.* "All N concurrent writers succeed" is a capacity goal; the three
invariants are the correctness contract. Report `attempts` in the response so
contention is observable rather than inferred.

Note the in-memory servers in this repo need none of this: `rust-fullstack`
takes a whole-store write lock (`db.write().await`) and the Dart servers are
single-isolate, so their writes are already serialized. CAS is what you need
once storage is shared.

---

## 4. Fail closed on a missing engine

```ts
if (!mergeJson && REQUIRE_NATIVE) {
  console.error("[syncer] FATAL: native addon required but not loaded. ...");
  process.exit(1);
}
```

`SYNCER_REQUIRE_NATIVE` defaults to on (`!== "0"`), and compose sets it
explicitly for the node service. The reasoning, from the code comment:

> A JS fallback merge would let the whole e2e suite pass without ever
> exercising the C core — precisely the false confidence these tests exist to
> prevent.

This is worth generalizing. A silent fallback engine converts a build failure
into a **semantics** failure that no test detects, because the fallback is
usually correct enough for the happy path. The reference server's own
`jsDeepMerge` is only ~20 lines and would satisfy scenario `02-deep-merge`
outright while getting every keyed-array, LWW and FWW case wrong.

The pattern has three parts, and all three are needed:

1. **Refuse to boot** without the real engine (opt out only via an explicit
   env var for local development).
2. **Advertise which engine is live** — `/health` reports
   `syncer: "native" | "js-fallback"` and each sync response carries
   `mergedWith: "native-c-ffi"`.
3. **Make the test suite refuse to run** against a fallback.
   `test/conformance/run.mjs` exits `2` if `/health` says otherwise, and
   `test/clients/run_all.sh` aborts on the same check. Scenario `01-health`
   asserts it a third time, and scenario `12-robustness` re-asserts it *after*
   the abuse cases.

One residual gap to be aware of if you copy the layout: `sagitta` boots with
`syncer: "unavailable"` when its FFI load fails and returns `500` per sync
request rather than refusing to start. That is weaker than the node server's
behaviour; prefer the node server's.

---

## 5. Tombstones and delete-vs-update

`DELETE` is a **soft** delete — it stamps `deleted_at` and bumps `version`,
leaving `data` in place:

```sql
UPDATE syncer_test_docs SET deleted_at = NOW(), version = version + 1
 WHERE id = $1 RETURNING id, version, deleted_at
```

A hard delete makes delete-vs-update unresolvable: an update arriving for a
row that no longer exists is indistinguishable from an update for a row that
never existed, so the server must either resurrect blindly or lose the write.

On sync, the incoming `updatedAt` is compared against the tombstone:

| Incoming `updatedAt` | Result |
|---|---|
| strictly newer than `deleted_at` | merged over the retained pre-delete data, `deleted_at` cleared, response `resurrected: true` |
| equal or older | `410 {error: "Document deleted", deleted: true, tombstoneAt}` |
| absent | `410` — a writer that cannot prove freshness does not win |
| unparseable | `410` — same reason |

Scenario `09-tombstones` pins all four rows, plus that a resurrection **merges
onto the retained data** (`metadata.owner.name` is still `"Bob"` afterwards, so
the row was resurrected rather than recreated), that a resurrected document
then behaves normally, and that re-deleting refreshes the tombstone.

### Timestamp normalization

`deleted_at` is a `TIMESTAMPTZ`; `updatedAt` is whatever the client sent. The
reference server normalizes to milliseconds by magnitude:

```ts
function parseTsToMs(value: unknown): number | null {
  if (value == null) return null;
  const s = String(value);
  if (/^\d+$/.test(s)) {
    if (s.length <= 10) return Number(s) * 1000;      // seconds
    if (s.length <= 13) return Number(s);             // milliseconds
    if (s.length <= 16) return Number(s) / 1000;      // microseconds
    return Number(BigInt(s) / 1000000n);              // nanoseconds
  }
  const parsed = Date.parse(s);
  return Number.isNaN(parsed) ? null : parsed;
}
```

Two things to copy: digit strings are classified by **length**, not guessed
from a configured unit (clients in different languages disagree about units,
and `1000` really does mean 1970 here — scenario `09` relies on it); and the
nanosecond branch goes through `BigInt` so a 19-digit value is not rounded
before the comparison.

This helper is only for the tombstone comparison. Timestamp resolution *inside*
a document is the C core's job and follows its own rules — see
[`MERGE_SEMANTICS.md`](../../syncer.c/docs/MERGE_SEMANTICS.md#comparison-rules).

---

## 6. Identity beyond the primary key

`POST /profile/sync` reconciles by a `UNIQUE` column while the primary key is
an unrelated surrogate:

```sql
CREATE TABLE IF NOT EXISTS syncer_test_docs_profiles (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  data JSONB NOT NULL DEFAULT '{}',
  version INT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ DEFAULT NOW()
)
```

This is the offline-first case a PK-only server cannot express: two clients
that were both offline each "create" the same user, and neither knows the
other's surrogate id. The loop:

```
for attempt in 1..MAX_CAS_ATTEMPTS:
    SELECT id, data::text, version WHERE email = $1
    if no row:
        try INSERT ... RETURNING -> respond {created: true}
        on error 23505 (unique_violation): continue     # someone else won; merge instead
    else:
        merged = merge(base, incoming, options)
        UPDATE ... WHERE email = $3 AND version = $2    # CAS as in §3
        if row updated: respond {created: false}
    backoff(attempt)
```

The load-bearing detail is that **the unique violation is a retry signal, not
an error**. `if (err.code === "23505") continue;` turns "I lost the create
race" into "so this is an update", and the next iteration finds the row and
merges into it. Scenario `10-identity` fires six simultaneous first-writes at a
brand-new email and asserts: exactly one response reports `created: true`,
every response references the same surrogate `id`, `version` equals the number
of acknowledged writes, and no acknowledged mutation is missing.

Do not substitute `ON CONFLICT DO UPDATE` for this loop. Upsert can resolve the
insert race but it cannot *merge* — it needs the current stored document as
input to the merge function before it can compute the new value.

---

## 7. Batch replay: one transaction, row locks

A client flushing an offline queue sends an ordered list of mutations. The
reference server applies them in a single transaction, locking each row:

```ts
await client.query("BEGIN");
for (const m of mutations) {
  const current = await client.query(
    "SELECT data::text AS raw_data, version FROM syncer_test_docs WHERE id = $1 FOR UPDATE",
    [m.docId]
  );
  if (current.rows.length === 0) { results.push({ docId: m.docId, applied: false, error: "not found" }); continue; }
  const mergedRaw = performMerge(current.rows[0].raw_data, JSON.stringify(m.payload ?? {}), options);
  await client.query("UPDATE ... SET data = $1::jsonb, version = version + 1, updated_at = NOW() WHERE id = $2", [mergedRaw, m.docId]);
  results.push({ docId: m.docId, applied: true });
}
await client.query("COMMIT");
```

Why all-or-nothing matters: the client's queue is *its* durability record. If a
flush is applied halfway and then fails, the client cannot tell which
mutations landed. Replaying the whole queue would double-apply the ones that
did (and `APPEND`-style strategies are not idempotent), while trimming it would
drop the ones that did not. Rollback makes "the flush failed" mean "nothing was
applied", so retrying the whole batch is always safe.

`SELECT … FOR UPDATE` replaces CAS inside the transaction: the lock serializes
concurrent batches per document, and holding it across the read-merge-write
removes the window CAS exists to detect.

Three behaviours the scenarios pin (`08-batch`):

- **Order inside a batch is honoured**: a later mutation on the same document
  wins the contended key, and both mutations' disjoint keys survive.
- **An unknown `docId` is reported, not fatal**: `{applied: false, error: "not found"}`,
  and mutations before *and* after it still apply. It does not create the row.
- **Replay is idempotent in value, not in version**: `data` is deep-equal after
  a second flush, `version` advances. Do not try to make the version stable —
  the second write really did execute, and hiding that would make CAS
  invariants unverifiable.

Note the batch path does **not** run payloads through the request schema — it
merges `m.payload` directly. That is a real difference in behaviour; see §9.

---

## 8. jsonb specifics

### Read the stored value as `TEXT`

Every read that feeds a merge selects `data::text`:

```sql
SELECT data::text AS raw_data, version, deleted_at FROM syncer_test_docs WHERE id = $1
```

The engine's interface is *string in, string out*, so this keeps the whole path
zero-deserialization: Postgres text → C core → text parameter cast back to
`jsonb`. Selecting `data` instead makes the driver parse the document into
host objects and forces a re-serialize before the merge — pure overhead, and in
a JavaScript host it also destroys any integer past 2^53 before the core sees
it.

### jsonb output is only *semantically* stable

`jsonb` is a parsed, normalized representation, not stored text. It:

- **reorders object keys** — by key length, then bytewise. Scenario
  `04-jsonb-fidelity` asserts `{zzz, aaa, mmm, bb, dddd, nested}` comes back as
  `["bb","aaa","mmm","zzz","dddd","nested"]`;
- **drops duplicate keys**;
- discards insignificant whitespace.

So: **never compare stored JSON as text.** Parse, then deep-compare. The
conformance harness provides `canon()` for order-insensitive structural
comparison (`test/conformance/lib/harness.mjs`), and
`test/clients/README.md` states the rule outright: "no assertion anywhere
compares raw JSON strings".

This has a real semantic consequence, not just a testing one. `UNION` dedup
compares elements structurally *precisely because* a text comparison would fail
to recognize a round-tripped element as a duplicate — see the case
"UNION dedup of MULTI-KEY objects" in scenario `11-strategies`, which documents
the earlier `strcmp`-based behaviour that jsonb's normalization defeated.

### Integers past 2^53

A JavaScript-hosted server rounds them: `1689940800123456789` becomes
`1689940800123456800`. Neither Postgres (`jsonb` numbers are `numeric`) nor the
C core (int64-exact via yyjson) is at fault — `express.json` → `JSON.parse` →
double → `JSON.stringify` is. Scenario `04-jsonb-fidelity` records this as a
`limitation()` (a warning, not a pass) so a future fix surfaces instead of
being locked in by a green test, and `test/cross-server/run.mjs` asserts it
per runtime via an `int64Exact` flag.

Guidance for API design: **carry sub-millisecond timestamps as digit strings.**
The core compares pure-digit strings numerically, so LWW/FWW resolution stays
exact and no host runtime can round them. Scenario `04` proves a 1-nanosecond
difference resolves correctly that way.

---

## 9. Validation and error handling

### Validate, but do not over-validate

The reference schema pins the fields the server has opinions about and passes
everything else through:

```ts
const DocumentPayloadSchema = z.object({
  id: z.string().optional(),
  title: z.string().optional(),
  metadata: z.record(z.any()).optional(),
  settings: z.record(z.any()).optional(),
  updatedAt: z.union([z.string(), z.number()]).optional(),
  syncedAt:  z.union([z.string(), z.number()]).optional(),
  createdAt: z.union([z.string(), z.number()]).optional(),
}).passthrough();
```

Timestamp fields accept **string or number** deliberately — ISO-8601,
epoch integers and digit strings are all legitimate, and a schema that demands
one shape breaks clients in other languages. Unknown fields of any type are
accepted verbatim (`.passthrough()`); a wrongly-typed *known* field is a `400`
carrying `details`. Both halves are asserted in scenario `12-robustness`.

Two consequences of *how* the schema is applied:

- `JSON.stringify(parsed.data)` is what reaches the merge, not the raw body.
  That is why a literal `__proto__` key is **dropped** on `/doc/:id/sync`
  (rebuilding the object by assignment discards it) while it **is stored, as
  inert data,** through `/sync/batch`, which skips the schema. Scenario
  `12-robustness` asserts both paths explicitly, and asserts no prototype
  pollution on either.
- A non-object top-level body (`[1,2,3]`, `"hello"`, `42`, `null`, `true`)
  fails the object schema and becomes a `400`.

### Return JSON errors, never stack traces

Express's default body-parser handler answers a parse failure with an **HTML
stack trace that leaks server paths**. Override it:

```ts
app.use((err, _req, res, next) => {
  if (err instanceof SyntaxError && "body" in err) {
    return res.status(400).json({ error: "Malformed JSON body", detail: err.message });
  }
  if (err?.type === "entity.too.large") {
    return res.status(413).json({ error: "Payload too large" });
  }
  return next(err);
});
```

and add a terminal handler so *any* unhandled route error answers JSON:

```ts
app.use((err, _req, res, _next) => {
  console.error("[node-server] unhandled error:", err?.message);
  if (res.headersSent) return;
  res.status(err?.status ?? 500).json({ error: err?.message ?? "internal error" });
});
```

### Status code discipline

| Code | Means | Where |
|---|---|---|
| `400` | malformed JSON, non-object body, wrongly-typed known field, bad `X-Syncer-Options`, `mutations` not an array, missing/empty/non-string `email` | all write paths |
| `403` | `/reset` outside test mode | `/reset` |
| `404` | no such document or profile — on `GET`, `GET …/raw`, `POST …/sync`, `DELETE` alike | read and write paths |
| `409` | CAS budget exhausted; **nothing was written**, retry | `/doc/:id/sync`, `/profile/sync` |
| `410` | tombstoned and the incoming write could not prove it is newer | `/doc/:id/sync` |
| `413` | body over the payload limit | body parser |
| `500` | genuine server/database fault, JSON body, batch already rolled back | anywhere |

Distinguishing `409` from `410` is the part that is easy to get wrong: `409`
means *try again unchanged*, `410` means *your write will never apply as-is*.
Collapsing them into one code makes a client either give up on a transient
conflict or spin forever against a tombstone.

### Payload limits

`app.use(express.json({ limit: "32mb" }))`. Scenario `12-robustness` proves a
5 MB string round-trips byte-identically and that a 2000-key object plus a
5000-element array is accepted. Set the limit explicitly — the framework
default is usually 100 kB, which silently breaks large offline flushes — and
map the overflow to `413`, not `500`.

### Residual gaps in the reference server

Reported honestly rather than presented as a pattern to copy:

- **Unknown routes fall through to Express's default 404**, whose body is HTML,
  not JSON. Scenario `12-robustness` only asserts the *status* is 404. If you
  want JSON everywhere, add a catch-all 404 handler.
- **`500` bodies echo `err.message` verbatim**, which for a database error can
  include SQL text or column names. Acceptable in a test fixture; log the
  detail and return an opaque message in production.

---

## 10. Checklist for a new server implementation

Each row names the suite that would catch the mistake. Suite invocations are
in [`TEST_TOPOLOGY.md`](./TEST_TOPOLOGY.md).

| # | Requirement | Caught by |
|---|---|---|
| 1 | Refuse to start without the real merge engine; report which engine is live on `/health` and per response | `01-health`; `run.mjs` pre-flight; `run_all.sh` abort |
| 2 | Publish the server-owned merge policy on `/health`, matching the documented default | `01-health` |
| 3 | Ignore client-supplied policy overrides outside test mode | `11-strategies` (contrast); `test/clients` scenario 0 |
| 4 | Object+object recurses; siblings survive at every level; type mismatch replaces; `null` is a value, not a delete | `02-deep-merge` |
| 5 | Keyed arrays reconcile by identity; a rejection is all-or-nothing for the element; new identities append at the tail | `03-keyed-arrays`, `run_e2e_full.sh`, `test/cross-server` |
| 6 | Read stored jsonb as `TEXT`; never compare output as text; document the int64 limit of your host | `04-jsonb-fidelity`, `test/cross-server` phase 1b |
| 7 | Replaying a payload is idempotent in value (version may advance) | `05-idempotency`, `08-batch` |
| 8 | Non-contending mutations converge in every apply order | `06-convergence`, `test/cross-server` phase 2 |
| 9 | CAS on a version column with bounded retry and full-jitter backoff; the three CAS invariants hold; `409` writes nothing | `07-concurrency` |
| 10 | Batch replay is one transaction with row locks; unknown `docId` reported, not fatal; per-item results | `08-batch` |
| 11 | Soft delete; newer update resurrects and merges onto retained data; older/absent/unparseable → `410` | `09-tombstones` |
| 12 | Reconcile by UNIQUE index where identity is not the PK; treat `23505` as a retry signal | `10-identity` |
| 13 | All five array strategies, `arrayMatchKeys` fallback order, `maxDepth`, custom `lwwKeys` behave as documented | `11-strategies` |
| 14 | JSON errors only; correct `400`/`404`/`409`/`410`/`413`; a rejected body never modifies the document; no `500` on abuse | `12-robustness` |
| 15 | No prototype pollution on any write path, including paths that bypass the request schema | `12-robustness` |
| 16 | Unicode keys/values, 40-level nesting and 2000-element arrays survive intact | `04-jsonb-fidelity` |
| 17 | Same merge policy as every other runtime, so cross-runtime expectations are uniform | `test/cross-server`, `test-differential/` |

### Fastest path to validating a new server

1. Implement `/health`, `GET /doc/:id`, `POST /doc/:id/sync`. Run
   `run_e2e_full.sh` and `test/cross-server/run.mjs` — that already covers
   deep merge, keyed arrays, LWW/FWW, convergence and int64 fidelity.
2. Add `PUT`, `DELETE`, `/doc/:id/raw`, `/sync/batch`, `/profile/sync`,
   `/reset`, `/docs`, and point the conformance suite at it with `BASE_URL`.
   Be aware the scenarios assume the reference server's seed fixtures
   (`doc-1`, `doc-2`, `doc-3`, `doc-rows`) and its `syncer_test_docs*` tables.
3. If your client libraries are in the loop, run `test/clients/run_all.sh` —
   that is the suite that catches a client whose *default policy* disagrees
   with yours, which no server-only test can.
