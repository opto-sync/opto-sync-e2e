# Client-in-the-loop e2e suites

The rest of the e2e suite exercises the **server**. These suites exercise the
**client libraries that external projects actually import** — `@opto-sync/client`,
`opto_sync_client` (Dart and Gleam) and the `opto-sync-client` crate — against
a live server, over HTTP, with every document round-tripping through Postgres
`jsonb`.

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
./run_all.sh                 # all four languages + three-client convergence
./run_all.sh ts              # one language only (ts | dart | rust | gleam)
./run_all.sh --no-converge   # scenarios 1-6 only
```

Individual suites, if you prefer:

```sh
(cd ts   && node --test)                                    # 10 tests
(cd dart && dart test)                                      # 10 tests
(cd rust && cargo test --offline --test scenarios)          # 10 tests
(cd gleam && gleam test)                                    # protocol lifecycle
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

The full reconciliation scenarios are implemented in TypeScript, Dart, and
Rust so
uniform behavior is provable rather than assumed. Scenarios 1–6 are one test
each (1 is split into `1a` individual / `1b` batched), test `0` pins the
client's default merge policy, scenario 7 is a cross-process orchestration, and
scenario 8 posts the exact protocol envelope produced by each SDK.

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
| 8 | **Protocol v1 SDK round trip** | Each SDK builds its own `operation` envelope, posts it unchanged, drains the queue through `lastMutationId`, retries the identical envelope after an ambiguous outcome, and receives `duplicate` without a second effect. |
| restart fault path | **Commit/ack and snapshot interruption** | Fresh processes reopen the durable queue after the server committed but before local acknowledgement. A deliberately partial snapshot replacement must leave checkpoint `"0"` and pending work intact; the next process repairs the snapshot, retries the identical envelope, receives `duplicate`, and persists both checkpoint and acknowledgement. TypeScript uses three Chromium processes with one native IndexedDB profile; Dart uses file-backed SQLite; Rust serializes `ProtocolQueue`. |
| SDK schedulers | **Live pull/push/pull orchestration** | TypeScript and Dart `ProtocolSyncLoop`, plus Rust `ProtocolSyncDriver`, drain their real queue representations through the protocol server, apply the PostgreSQL change-log echo, durably advance the checkpoint, and leave no pending mutation. |
| Gleam protocol lifecycle | **Typed SDK against live PostgreSQL** | The Gleam client builds and encodes its own queue envelope, receives a typed applied ack, retries the exact bytes for `duplicate`, pulls the captured change, invokes the NIF, then sends a tombstone with mutation id 2. |

Every suite also asserts the server reported `mergedWith: "native-c-ffi"`, and
`run_all.sh` aborts if `/health` says the server fell back to the JS merge —
against a JS fallback these convergence assertions would be false confidence.
The complete runner contains 13 orchestration steps.

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

* each payload has a deterministic root `updatedAt` (`2000`, `3000`, `4000`),
  so root LWW accepts all three in order and `rust`'s title wins.
* `revision` is a guarded object → `dart` (`updatedAt` 4000) wins even though
  `rust` (`updatedAt` 3000) flushed **after** it, and `rust`'s whole `revision`
  object is dropped rather than partially applied.
* `items.shared` is contested by all three; only `dart`'s write is fresh enough,
  and it deep-merges onto the base element so the original `createdAt` survives.
* `createdAt` at the root survives every client because no payload sends one —
  it is an ordinary field, not a guarded key.

## Fixtures

`fixtures/scenarios.json` and `fixtures/cross_client.json` are read **verbatim by
all three languages** — same inputs, same expectations, no per-language
templating (document ids live in the URL, never in a payload). Each `expected`
value is derived by hand from the syncer.c merge policy and the derivation is
written out in the fixture's own `$comment`. If you change a payload, re-derive
every expectation.

The policy, shared by the server and all three clients:

```
arrayStrategy      = MERGE_BY_KEY (4)      lwwKeys = "updatedAt,syncedAt"
arrayMatchKeys     = "id"                  fwwKeys = (unset)
resolveByTimestamp = true
```

There is deliberately **no FWW key**. FWW in the core is a *node-level veto*: an
incoming node whose FWW key is newer is rejected **wholesale**, however new its
`updatedAt` is. With `createdAt` in this policy, a replica that ended up holding
a later `createdAt` for a record could never write to that record again —
silently, behind a 200. Callers opt into `fwwKeys` per merge instead.

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
* **The clients ship no transport.** All four libraries are queue + reconcile
  only, so the HTTP layer lives in each suite's support module. What is under test
  is the library's queue lifecycle (`pending → synced/failed`) and its reconcile
  output — never a re-implementation of merging in test code.
* **Queue access uses each library's public surface**: `pendingMutations()` /
  `markMutation()` (TS), Drift queries against the publicly exposed
  `OptoSyncDatabase` (Dart), `MutationStore` (Rust). Nothing was added to any
  client library to make these suites work.

## Cross-tier policy agreement (was: a known divergence)

`@opto-sync/client` once omitted `arrayStrategy` from its defaults and so fell
back to the binding's `REPLACE`, while the Dart client, the Rust client and every
server used `MERGE_BY_KEY` on `"id"`. Reconciling a server payload therefore
dropped local array elements the server had never seen and applied elements the
timestamp guard should have rejected.

That is **fixed**: `DEFAULT_RECONCILE_OPTIONS` in
`opto-sync-clients/clients/ts/src/reconcile-core.ts` now sets
`arrayStrategy: MERGE_BY_KEY` and `arrayMatchKeys: 'id'`. Scenario `0` in
`ts/scenarios.test.mjs` asserts the client's own defaults are equivalent to the
explicit `SERVER_POLICY`, so a future divergence fails loudly instead of
silently losing data.

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
  gleam/
    src/live_support.gleam      e2e-only Erlang `httpc` transport
    test/*                      live push/retry/pull/delete lifecycle
```
