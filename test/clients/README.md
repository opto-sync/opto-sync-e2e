# Client-in-the-loop e2e suites

The rest of the e2e suite exercises the **server**. These suites exercise the
**client libraries that external projects actually import** — `@opto-sync/client`,
`opto_sync_client` (Dart) and the `opto-sync-client` crate — against a live
server, over HTTP, with every document round-tripping through Postgres `jsonb`.

Before this directory existed, the client libraries were never run against a real
server at all. Their own unit tests only prove the native merge does what the
native merge does; they cannot catch a client whose *default policy* disagrees
with the server's. That is the gap these suites close — and the first thing they
found was exactly such a disagreement (see
[Known divergence](#known-divergence-opto-syncclient-defaults-to-arraystrategyreplace)).

## Running

The server must already be running. These suites never start, stop, reset or
otherwise touch the stack.

```sh
cd opto-sync-e2e/test/clients
./run_all.sh                 # all three languages + cross-client convergence
./run_all.sh ts              # one language only (ts | dart | rust)
./run_all.sh --no-converge   # scenarios 1-6 only
```

Individual suites, if you prefer:

```sh
(cd ts   && node --test)                                    # 8 tests
(cd dart && dart test)                                      # 8 tests
(cd rust && cargo test --offline --test scenarios)          # 8 tests
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPTO_SYNC_SERVER_URL` | `http://localhost:3003` | Server to test against |
| `OPTO_SYNC_REQUIRE_SERVER` | `0` | `1` makes an unreachable server a failure instead of a skip |
| `SYNCER_LIB_PATH` | auto-discovered | Path to the syncer.c core shared library (Dart FFI) |

If the server is unreachable every suite **skips with a clear message** and exits
0 — nothing hangs on a dead socket. `run_all.sh` prints the exact
`docker compose up` command; `OPTO_SYNC_REQUIRE_SERVER=1` turns that skip into a
CI failure.

### Prerequisites

Host toolchains only — no new Docker images.

* **node** ≥ 18 (uses the built-in test runner and `fetch`). The suite imports the
  client's **built `dist/`** and borrows its own `fake-indexeddb` devDependency
  through relative paths, so there is deliberately **no `package.json` and no
  `npm install` here**: the suite cannot drift from the library it tests. If
  `dist/` is missing, `run_all.sh` builds it.
* **dart** ≥ 3.12. `run_all.sh` runs `dart pub get --offline` on first use.
* **cargo**. Everything resolves from the local registry cache
  (`cargo test --offline`); `ureq` is built with `default-features = false` so no
  TLS stack is needed for a localhost-only suite.

## What is covered

Seven scenarios, implemented in **all three languages** so uniform behavior is
provable rather than assumed. Scenarios 1–6 are one test each (1 is split into
`1a` individual / `1b` batched), plus a test `0` per language that pins the
client's default merge policy. Scenario 7 is a cross-process orchestration.

| # | Scenario | What it proves |
| --- | --- | --- |
| 0 | Default merge policy | Each client's out-of-the-box reconcile options vs. the server's policy. The **Dart and Rust** tests assert the defaults already match; the **TypeScript** test pins the divergence described below. |
| 1 | Offline queue → flush → server merge | Three mutations are queued while "offline" with nothing sent; the server is verified untouched; then the queue is drained (**1a** one-by-one via `POST /doc/:id/sync`, **1b** atomically via `POST /sync/batch`). All mutations end up `SYNCED` locally and every contribution is present server-side. |
| 2 | Optimistic write → pull-back reconcile | The mutation is applied to the local copy **through the client's own reconcile path**, pushed, pulled back, and reconciled in again. Local and server must agree semantically. Also compares `GET /doc/:id/raw` — the stored `jsonb` text is *not* the string that was sent, which is why nothing here ever compares raw strings. |
| 3 | Stale-write rejection, both directions | Server holds an **older** state → pulling it in changes nothing at all (whole-object rejection: not even the server's extra key leaks in). Server holds a **newer** state → it wins, the merge descends, and local-only keys survive. Both directions are round-tripped through the real server. |
| 4 | Keyed-array reconciliation, full stack | A `jsonb` array of `{id, createdAt, updatedAt, …}`. One element is left alone (preserved), one is updated with a fresher `updatedAt` (applied), one with a staler `updatedAt` (rejected), one is new (appended **at the end**). Asserted on the server document *and* on the client's reconcile of the pulled state. |
| 5 | Replay / retry idempotency | The same queued mutation is flushed twice, as a client would after an ambiguous network failure. The document **version advances** (proving the second write really executed) while the data stays semantically identical — no duplicated keyed elements, no duplicated identity-less `tags` entries. |
| 6 | Failure marking | A mutation against a document that does not exist returns 404 and is marked `FAILED`, never `SYNCED`. A following good mutation then proves pending/synced/failed accounting is per-mutation and not sticky. |
| 7 | **Cross-client convergence** | All three clients queue **different** payloads against **one** fresh document, flushed `ts → dart → rust`. The final server document must be exactly what the merge policy predicts, and **each client's local reconcile of that final state must agree**. |

Every suite also asserts the server reported `mergedWith: "native-c-ffi"`, and
`run_all.sh` aborts if `/health` says the server fell back to the JS merge —
against a JS fallback these convergence assertions would be false confidence.

### Scenario 7 in detail

`run_all.sh` orchestrates it as separate processes, because the flushes have to
happen one language at a time against the same document:

```
converge/setup   ts    PUT the fresh fixture document
converge/flush   ts    queue payload, flush, assert queue drained
converge/flush   dart      "
converge/flush   rust      "
converge/verify  ts    assert final server doc + reconcile it into ts's local copy
converge/verify  dart      "
converge/verify  rust      "
```

The payloads are designed so that **flush order and timestamp order disagree**,
which is the load-bearing part:

* `title` is an unguarded root scalar → plain last-writer-wins → `rust` (flushed
  last) wins.
* `revision` is a guarded object → `dart` (`updatedAt` 4000) wins even though
  `rust` (`updatedAt` 3000) flushed **after** it, and `rust`'s whole `revision`
  object is dropped rather than partially applied.
* `items.shared` is contested by all three; only `dart`'s write is fresh enough,
  and it deep-merges onto the base element so the original `createdAt` survives.
* `createdAt` at the root is First-Write-Wins and survives every client.

## Fixtures

`fixtures/scenarios.json` and `fixtures/cross_client.json` are read **verbatim by
all three languages** — same inputs, same expectations, no per-language
templating (document ids live in the URL, never in a payload). Each `expected`
value is derived by hand from the syncer.c v0.2.0 policy and the derivation is
written out in the fixture's own `$comment`. If you change a payload, re-derive
every expectation.

The policy, shared by the server and all three clients:

```
arrayStrategy      = MERGE_BY_KEY (4)      lwwKeys = "updatedAt,syncedAt"
arrayMatchKeys     = "id"                  fwwKeys = "createdAt"
resolveByTimestamp = true
```

Three properties of the core that the fixtures lean on:

1. **Rejection is whole-object and per level.** If the base has a strictly newer
   `lwwKey`, the entire incoming object at that level is dropped — keys present
   only in the incoming object are *not* copied.
2. **A guard only applies when both sides carry the key.** An object with no
   `updatedAt` on either side is a plain last-writer-wins deep merge, so arrival
   order decides. Scenario 7 deliberately exercises both.
3. **`MERGE_BY_KEY` appends unmatched identities at the end** of the base array,
   so array order in the server document is deterministic and asserted strictly.

## Comparison rules

Postgres `jsonb` reorders object keys, so **no assertion anywhere compares raw
JSON strings** — everything is parsed first. Two flavors of equality are used:

* **Strict** (`assertDeepEqual` / `expectDeepEqual` / `assert_json_eq`), including
  array order. Used for the server document, whose order is fully determined.
* **Keyed** (`…Keyed`), which sorts arrays of objects carrying an `id` before
  comparing. Used only in scenario 7's step (b): `MERGE_BY_KEY` matches by
  *identity, not position*, so a client whose local array started as
  `[shared, ts-new]` legitimately ends up with the other identities appended
  after its own. The identity set and every element's content must still match
  exactly.

## Design notes

* **No `POST /reset`.** `/reset` `TRUNCATE`s the shared tables and would yank the
  ground out from under any other suite running concurrently. Every document here
  is namespaced — `cl-<lang>-<scenario>` for scenarios 1–6, `cl-converge` for
  scenario 7 — and created with `PUT /doc/:id` immediately before use. As a
  bonus, the three language suites are independent and can run in parallel.
* **The clients ship no transport.** All three libraries are queue + reconcile
  only, so the HTTP layer lives in each suite's support module. What is under test
  is the library's queue lifecycle (`pending → synced/failed`) and its reconcile
  output — never a re-implementation of merging in test code.
* **Queue access uses each library's public surface**: `pendingMutations()` /
  `markMutation()` (TS), Drift queries against the publicly exposed
  `OptoSyncDatabase` (Dart), `MutationStore` (Rust). Nothing was added to any
  client library to make these suites work.

## Known divergence: `@opto-sync/client` defaults to `ArrayStrategy.REPLACE`

**This is a real bug, found by these suites, and it is not worked around
silently.**

`DEFAULT_RECONCILE_OPTIONS` in `clients/ts/src/reconcile.ts` sets only
`resolveByTimestamp`, `lwwKeys` and `fwwKeys`. It does **not** set
`arrayStrategy` or `arrayMatchKeys`, so the native core falls back to
`ArrayStrategy.REPLACE` — while the server, the Dart client (`FfiSyncer` defaults
to `mergeByKey` + `'id'`) and the Rust client
(`ReconcileOptions::default()` → `MergeByKey` + `"id"`) all use `MERGE_BY_KEY` on
`"id"`.

Out of the box the TypeScript client therefore reconciles arrays by wholesale
replacement. Reconciling a server pull **silently drops local elements the server
has not seen and applies elements the timestamp guard should have rejected**:

```js
const local    = { rows: [{ id: 'r1', label: 'local-only' },
                          { id: 'r2', updatedAt: 9000, label: 'fresh' }] };
const incoming = { rows: [{ id: 'r2', updatedAt: 1, label: 'stale' }] };

reconcileIncoming(local, incoming);
// => { rows: [ { id: 'r2', updatedAt: 1, label: 'stale' } ] }
//    r1 is GONE and the stale r2 was APPLIED.

reconcileIncoming(local, incoming, { arrayStrategy: 4, arrayMatchKeys: 'id' });
// => local, unchanged (correct: identity-matched, stale write rejected)
```

Handling here, pending a decision by the library's owner:

* `ts/support.mjs` exports `SERVER_POLICY` and every TypeScript client in the
  suite is constructed with it, so all three languages are compared on equal
  terms rather than one being scored against a different policy.
* Test `0. KNOWN DIVERGENCE` in `ts/scenarios.test.mjs` **pins the current
  default** and demonstrates the data loss. It is pure library behavior, so it
  runs even when the server is down. **The moment the client default is fixed,
  that test fails loudly** — at which point delete it and drop `SERVER_POLICY`.

## Minor API asymmetry (not a bug)

The Rust `Mutation` records only `{ id, payload, status }`, while the TypeScript
(`tableName` / `recordId`) and Dart (`table_name` / `record_id`) queues also
record what the mutation targets. The Rust suite therefore keeps a small
`Routes` map from mutation id → document id (`rust/src/lib.rs`) so the flush loop
can still be driven entirely through the crate's public queue API. Worth
considering for the crate, but nothing was changed to accommodate it.

## Layout

```
test/clients/
  run_all.sh                    orchestrator; non-zero on any failure
  fixtures/
    scenarios.json              scenarios 1-6, shared by all three languages
    cross_client.json           scenario 7: payloads + predicted final state
  ts/
    support.mjs                 HTTP, fixtures, comparison, SERVER_POLICY
    scenarios.test.mjs          scenarios 0-6   (node --test)
    converge.mjs                scenario 7 phase runner (setup|flush|verify)
  dart/
    pubspec.yaml
    lib/support.dart            HTTP, fixtures, comparison, queue helpers
    test/scenarios_test.dart    scenarios 0-6   (dart test)
    bin/converge.dart           scenario 7 phase runner
  rust/
    Cargo.toml
    src/lib.rs                  HTTP, fixtures, comparison, Routes/flush helpers
    tests/scenarios.rs          scenarios 0-6   (cargo test)
    src/bin/converge.rs         scenario 7 phase runner
```
