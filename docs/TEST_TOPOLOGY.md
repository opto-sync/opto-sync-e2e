# E2E test topology

What runs where, what each suite proves, and the exact command lines. Sources:
[`docker-compose.yml`](../docker-compose.yml),
[`docker-compose.supabase.yml`](../docker-compose.supabase.yml), the servers
under [`servers/`](../servers/), the suites under [`test/`](../suite/), and
[`.github/workflows/`](../.github/workflows/).

---

## 1. Setup requirements

Two things must be true before anything builds.

**The docker build context is the PARENT directory.** Every `build:` block in
`docker-compose.yml` uses `context: ../` with
`dockerfile: opto-sync-e2e/servers/<name>/Dockerfile`, because the images
`COPY syncer.c/...` — the core lives in a sibling repo, not in this one.

**`context.dockerignore` must be copied to the context root.** Docker only
honours a `.dockerignore` at the context root, so `opto-sync-e2e/.dockerignore`
is never read by these builds:

```sh
cp context.dockerignore ../.dockerignore
```

Without it, host `node_modules/`, `target/`, `.dart_tool/`, `build/` and
`dist/` trees leak into the build context — slow, and they can shadow
in-image dependency installs. CI performs the same copy
(`.github/workflows/e2e-docker.yml`, "Install .dockerignore at the build
context root").

Expected sibling layout — the workflows check out all three as siblings:

```
opto-sync/
  .dockerignore        <- copied from opto-sync-e2e/context.dockerignore
  syncer.c/
  opto-sync-clients/
  opto-sync-e2e/
```

Also required: a `.env` file (copy `.env.example`) supplying `DATABASE_URL`,
`SUPABASE_URL`, `SUPABASE_KEY`.

---

## 2. The five servers

All five apply **one identical merge policy**, which is what makes conformance
expectations uniform across runtimes:

```
arrayStrategy      = MERGE_BY_KEY (4)      lwwKeys = "updatedAt,syncedAt"
arrayMatchKeys     = "id"                  fwwKeys = (unset)
resolveByTimestamp = true
```

There is deliberately no FWW key: FWW in the core is a node-level *veto*, so a
default `createdAt` would let a replica holding a later `createdAt` for a record
lock that record forever. The node server still accepts
`X-Syncer-Options: {"fwwKeys":"createdAt"}` per request in test mode, which is
how the conformance suite keeps covering the engine feature.

Verified per server: `servers/node/src/index.ts:159-164`,
`servers/rust-fullstack/src/main.rs:101-113`, `servers/rust/src/main.rs:174-197`,
`servers/dart/bin/server.dart:89-103`, `servers/sagitta/bin/server.dart:161-175`.

| Service | Port | Stack | Storage | Compose profile |
|---|---|---|---|---|
| `rust-mash` | 3001 | Rust: Maud + Axum + Supabase REST + HTMX, merges via `syncer-rs` C FFI | Supabase / PostgREST (REST API) | `mash` — plus `supabasetest` when the override file is included |
| `rust-fullstack` | 3002 | Rust: Axum SSR + `syncer-rs` C FFI | in-memory (`RwLock<HashMap>`) | `fullstack` |
| `node` | 3003 | Node: Express + `@opto-sync/syncer` native C addon | Postgres `jsonb` | **none — starts with every `up`** |
| `dart` | 3004 | Dart: Shelf + `dart:ffi` to the C core | in-memory | `dart` |
| `sagitta` | 3005 | Dart: Sagitta SSR stack + `dart:ffi` | in-memory | `sagitta` |

Supporting services:

| Service | Port | Image | Profile |
|---|---|---|---|
| `postgres` | 5433 → 5432 | `postgres:16-alpine` (`syncer`/`syncer_test`/`syncer_test`) | none |
| `node-auth` | 3013 | production-mode node with exact static identity mappings | `auth` |
| `node-ops` | 3023 | production-mode node with deliberately low operational limits | `operations` |
| `node-jwt-auth` | 3033 | production-mode node with Supabase-shaped asymmetric JWT verification | `jwt-auth` |
| `supabase-auth-hook-test` | — | migration/assertion runner for the deployable Custom Access Token Hook | `jwt-auth` |
| `postgrest` | 3010 → 3000 | `postgrest/postgrest:v12.2.3` | override file only |
| `supabase-init` | — | one-shot `psql` running `suite/supabase/init.sql` | override file only |

### Endpoint coverage differs per server

Only `node` implements the full contract described in
[`SERVER_GUIDE.md`](./SERVER_GUIDE.md).

| Server | Routes |
|---|---|
| `node` | `/health`, `/docs`, `/doc/:id` (GET), `/doc/:id/raw`, `PUT /doc/:id`, `DELETE /doc/:id`, `POST /doc/:id/sync`, `POST /sync/batch`, `POST /profile/sync`, `GET /profile/:email`, `POST /reset` |
| `rust-mash` | `/`, `/health`, `/docs`, `/doc/:id` (GET + PUT), `POST /doc/:id/sync` |
| `rust-fullstack` | `/`, `/health`, `/docs`, `/doc/:id`, `POST /doc/:id/sync` |
| `dart` | `/health`, `/docs`, `/doc/<id>`, `POST /doc/<id>/sync` |
| `sagitta` | `/health`, `/`, `/docs`, `/doc/<id>`, `POST /doc/<id>/sync` |

### Seed fixtures differ per server

Suites that talk to multiple runtimes must use the right document id.

| Server | Seed documents |
|---|---|
| `node` | `doc-1`, `doc-2`, `doc-3`, `doc-rows` (`doc-rows` is the keyed-array fixture) |
| `rust-fullstack` | `doc-a`, `doc-b` |
| `dart` | `doc1`, `doc2` |
| `sagitta` | `doc-s1`, `doc-s2` |
| `rust-mash` | none — the suite creates its own per-run documents |

### Fail-closed status

`node` refuses to boot without the native addon (`SYNCER_REQUIRE_NATIVE=1`, set
in compose) and reports `syncer: "native"` on `/health`; a JS fallback merge
would let the whole suite pass without exercising the core. `dart` constructs
its FFI `Syncer` eagerly during startup, so a load failure crashes the process.
`sagitta` is weaker: it boots with `syncer: "unavailable"` and answers `500`
per sync request instead.

---

## 3. The suites

| Suite | Runner | Target(s) | What it uniquely catches |
|---|---|---|---|
| `suite/run_e2e.sh` | `curlimages/curl:8.7.1`, service `test-runner`, profile `test` | `node` only | Smoke: the node server is up, seeded, and deep-merges. Fast enough to run on every change; grep-based, so it cannot distinguish *which* merge policy ran. |
| `suite/run_e2e_full.sh` | same image, service `test-runner-full`, profile `fulltest` | `node`, `rust-fullstack`, `dart`, `sagitta` | Element-level keyed-array behaviour on **all four** runtimes: stale element rejected (`check_absent 'STALE'`), untouched element kept, new element appended, and a later `createdAt` **not** vetoing a newer write (plus, on the node server only, an explicit `X-Syncer-Options: {"fwwKeys":"createdAt"}` request proving the veto is still reachable). Asserting only `"merged":true` would pass under `REPLACE`; these assertions do not. |
| `suite/conformance/` | `node:22-alpine`, service `conformance`, profile `conformance` | `node` + Postgres | 12 scenario groups (below). The only suite that inspects **stored jsonb text** via `/doc/:id/raw`, and the only one that exercises tombstones, CAS conflicts, unique-index identity, the strategy matrix and the robustness/prototype-pollution cases. |
| `suite/protocol/run.mjs` | `node:22-alpine`, service `protocol`, profile `protocol` | `node` + Postgres | Protocol ledger/effect/watermark atomicity, pre-commit rollback, committed-but-response-lost retry recovery, total commit order shared with trigger-captured direct SQL writes, tenant-filtered pull pagination, tombstones, compaction, and repeatable-read snapshots. |
| `suite/protocol/auth.mjs` | `node:22-alpine`, service `auth-protocol`, profile `auth` | production-mode `node-auth` + Postgres | Missing/wrong bearer rejection, exact client binding, durable subject ownership, safe token rotation, same-ID cross-tenant isolation, and a separate administrator credential for compaction. |
| `suite/protocol/jwt-auth.mjs` | `node:22-alpine`, service `jwt-auth-protocol`, profile `jwt-auth` | production-mode `node-jwt-auth` + Postgres | Asymmetric signature, expiry/nbf, issuer, audience, role and algorithm verification; server-owned tenant/client claims; spoofing, refreshed-token dedupe, durable ownership, and cross-tenant pull/snapshot isolation. |
| `suite/protocol/operations.mjs` | `node:22-alpine`, service `operations-protocol`, profile `operations` | low-limit production-mode `node-ops` + Postgres | Exact wire/mutation/batch quotas, snapshot refusal rather than partial reset, separate metrics authentication, valid-principal and invalid-bearer rate limiting, bounded metrics labels, and JSON audit paths. |
| `suite/protocol/load.mjs` | `node:22-alpine`, service `protocol-load`, profile `load` | `node` + Postgres | 96 concurrent writers merge into one record, 96 retries deduplicate, all 96 changes remain ordered, the snapshot converges, then p50/p95/p99/max latency bounds are enforced. |
| `suite/protocol/backup-restore.sh` | `postgres:16-alpine`, service `protocol-backup-restore`, profile `recovery` | compiled migration job + two concurrently migrating node replicas + Postgres | Advisory-locked migration convergence followed by a full custom-format dump/restore; validates migration checksums, checkpoint/change equality, ledger watermarks, tenant data, tombstones, nested JSONB, restored triggers, versioning, physical-delete protection, and generic arbitrary-table capture including whole-row objects and atomic rejection. |
| `suite/cross-server/` | `node:22-alpine`, service `cross-server`, profile `crossserver` | `node`, `rust-fullstack`, `dart`, `sagitta` | Four runtimes must produce **semantically identical** documents from one mutation sequence, after different HTTP stacks, different JSON serializers, and (for node) a real jsonb round trip. Also pins per-runtime int64 fidelity. |
| `suite/clients/` | host shell, `suite/clients/run_all.sh` | `node` (via published port) | The four **real client libraries** from `../opto-sync-clients` against a live server. TypeScript/Dart/Rust run the full scenario and convergence set; Gleam runs its typed push/retry/pull/delete lifecycle through the real NIF. |
| `suite/supabase/` | `node:22-alpine`, service `supabase-test`, profile `supabasetest` (override file) | `rust-mash` + `postgrest` | The REST persistence path end to end, with **JWT auth enforced**. Every claim about merged state is re-verified by reading the row back through PostgREST directly, bypassing `rust-mash`. |

### Conformance scenario groups

[`suite/conformance/run.mjs`](../suite/conformance/run.mjs) loads twelve groups
and `/reset`s the server between them. Positional args select groups by number
(`node run.mjs 3 6 7`).

| # | File | Proves |
|---|---|---|
| 1 | `01-health.mjs` | The native C core is live, not the JS fallback; `coreVersion` ≥ 0.2.0; `defaultOptions` is the documented policy; `/reset` restores four seed docs |
| 2 | `02-deep-merge.mjs` | Recursive object merge, sibling preservation at every level, type-change replacement, `null` as a value, empty-object/array no-ops |
| 3 | `03-keyed-arrays.mjs` | `MERGE_BY_KEY`: all-or-nothing element rejection, `lwwKeys` as an OR-of-rejections, the default policy accepting a later `createdAt` (no FWW veto), explicit `fwwKeys` vetoing in both directions via `X-Syncer-Options`, `42`/`"42"` identity normalization, nested keyed arrays, keyless UNION fallback |
| 4 | `04-jsonb-fidelity.mjs` | jsonb reorders keys but preserves semantics; `MAX_SAFE_INTEGER` exact; int64 rounding recorded as a `limitation()`; digit-string nanoseconds exact and LWW-correct; unicode; 40-level nesting; 2000-element arrays |
| 5 | `05-idempotency.mjs` | Replaying a payload is idempotent in value while `version` advances; stale replays stay inert |
| 6 | `06-convergence.mjs` | All 4! = 24 apply orders of four mutations converge to one document; parallel application matches the sequential outcome; and the documented boundary — a root-level `lww` key gates the whole document, making it order-*dependent* by design |
| 7 | `07-concurrency.mjs` | The three CAS invariants at 5-, 12- and 20-way contention; `?noRetry=1` surfaces `409`; concurrent syncs to different documents never conflict |
| 8 | `08-batch.mjs` | Multi-doc queue replay in one transaction, intra-batch ordering, unknown `docId` non-fatal, `X-Syncer-Options` honoured through the batch path, malformed bodies → 400 |
| 9 | `09-tombstones.mjs` | Soft delete retains data; older/absent/unparseable `updatedAt` → 410; strictly newer resurrects and merges onto pre-delete data; re-delete refreshes the tombstone; `PUT` resurrects outright |
| 10 | `10-identity.mjs` | Reconcile by UNIQUE `email` with a surrogate PK; six parallel first-writes collapse to one row with exactly one `created: true`; no acknowledged mutation lost through the `23505` retry path |
| 11 | `11-strategies.mjs` | The full 0–4 strategy matrix on identical input; `arrayMatchKeys` fallback order; `maxDepth` truncation; `resolveByTimestamp: false`; retargeted `lwwKeys`; malformed override header → 400 |
| 12 | `12-robustness.mjs` | Malformed/non-object bodies → 400 with the document untouched; 404 on every path for an unknown doc; URL-significant ids; 5 MB payload; 2000 keys + 5000 elements; **no prototype pollution on either write path**; no 500 on abuse; server still healthy afterwards |

The harness (`suite/conformance/lib/harness.mjs`) records assertions instead of
throwing, so one bad expectation does not hide the rest of a scenario. It also
has `limitation(holds, …)`, which records a **WARN** for a known, understood
defect — and prints loudly when the defect appears resolved, so the suite gets
tightened rather than silently over-passing.

### Cross-server phases

[`suite/cross-server/run.mjs`](../suite/cross-server/run.mjs) needs at least two
live servers (exits `2` otherwise) and compares the live subset.

| Phase | Asserts |
|---|---|
| 1 | One sequence of five payloads per server; every runtime's namespaced subtree is canonically equal, **and** each server independently satisfies the semantic expectations (stale rejected, fresher applied, new appended, FWW re-creation refused, deep leaf merged, scalar array unioned, unicode intact, digit-string nanosecond preserved, exactly 3 rows) |
| 1b | Per-runtime int64 fidelity, sent as raw text and asserted against the raw response text. `int64Exact: false` for `node` (expects `1689940800123456800`), `true` for the other three (expects `1689940800123456789`) |
| 2 | Order independence: all 3! = 6 permutations of three deliberately non-contending mutations agree across runtimes and converge with each other |

Payloads are sent verbatim (`syncRaw`) where int64 is involved, because routing
them through `JSON.stringify` would round them **in the test process** before
any server could be blamed.

### Client suites

[`suite/clients/`](../suite/clients/) runs on the host with host toolchains
(node ≥ 18, dart ≥ 3.12, cargo) — no new Docker images. Seven scenarios,
implemented in **TypeScript, Dart, and Rust** so uniform behaviour is provable rather
than assumed: default-policy pin (0), offline queue → flush → merge (1a
individual, 1b batched), optimistic write → pull-back reconcile (2), stale-write
rejection both directions (3), keyed-array reconciliation (4), replay
idempotency (5), failure marking (6), cross-client convergence (7), and exact
protocol-v1 envelope retry/deduplication (8).

Scenario 7 is orchestrated as separate processes because the flushes must happen
one language at a time against one document:
`setup(ts) → flush(ts) → flush(dart) → flush(rust) → verify(ts, dart, rust)`.
Payloads are designed so flush order and timestamp order **disagree**.

Three additional restart steps cover the commit/ack ambiguity and interrupted
snapshot installation in actual new processes. TypeScript closes and launches
Chromium three times with one persistent native IndexedDB profile; Dart reopens
file-backed SQLite; Rust reloads its serialized `ProtocolQueue`. Each path
injects a partial authoritative replacement, proves the checkpoint and pending
mutation were not advanced, repairs the full snapshot, receives `duplicate` for
the byte-identical push retry, and persists the final acknowledgement.

`run_all.sh` aborts if `/health` does not report `syncer: "native"`. If the
server is unreachable, every suite skips with a message and exits 0 —
`OPTO_SYNC_REQUIRE_SERVER=1` turns that skip into a CI failure, which is how
`.github/workflows/e2e-clients.yml` runs it.

---

## 4. Compose profile matrix

| Profile | Brings up |
|---|---|
| *(none)* | `postgres`, `node` |
| `mash` | `rust-mash` |
| `fullstack` | `rust-fullstack` |
| `dart` | `dart` |
| `sagitta` | `sagitta` |
| `test` | `test-runner` (runs `run_e2e.sh`) |
| `fulltest` | `test-runner-full` (runs `run_e2e_full.sh`) |
| `conformance` | `conformance` (runs `suite/conformance/run.mjs`) |
| `protocol` | `protocol` (runs `suite/protocol/run.mjs`) |
| `auth` | `node-auth`, `auth-protocol` |
| `operations` | `node-ops`, `operations-protocol` |
| `load` | `protocol-load` |
| `crossserver` | `cross-server` (runs `suite/cross-server/run.mjs`) |
| `supabasetest` | `supabase-test` — and, via the override file, `rust-mash` |

`rust-mash` is **opt-in behind the `mash` profile** and only functions with
Supabase credentials or the PostgREST override. Without either it is pointed at
the `.env` placeholder and every request fails; before the profile existed it
was built and started by the `fulltest`/`conformance`/`crossserver` runs that
never exercise it. The override file re-declares its `profiles:` as
`[mash, supabasetest]` so this suite's documented invocation still brings it up.

### Documented command lines

```sh
# Smoke: node + test-runner, runs suite/run_e2e.sh
docker compose --profile test up --build

# Full curl suite across every in-memory server
docker compose --profile fulltest --profile fullstack --profile dart --profile sagitta up --build

# Conformance (12 scenario groups vs the Postgres-backed node server)
docker compose --profile conformance up --exit-code-from conformance

# Protocol operational controls and bounded concurrency probe
docker compose --profile operations up --exit-code-from operations-protocol
docker compose --profile load up --exit-code-from protocol-load

# Cross-server convergence (four runtimes)
docker compose --profile crossserver --profile fullstack --profile dart --profile sagitta \
  up --exit-code-from cross-server

# Client-in-the-loop (host-run; the stack must already be up)
suite/clients/run_all.sh              # or: run_all.sh ts | dart | rust | --no-converge
```

Supabase path — **requires the override file**, and `postgres` must already be
running:

```sh
# 1. bring up ONLY these services (never `down` — other suites share postgres)
docker compose -f docker-compose.yml -f docker-compose.supabase.yml \
  up -d --build postgrest rust-mash

# 2. run the suite in-network
docker compose -f docker-compose.yml -f docker-compose.supabase.yml \
  --profile supabasetest run --rm supabase-test

# ...or from the host (ports 3001 and 3010 are published)
node suite/supabase/run.mjs

# teardown of just this stack
docker compose -f docker-compose.yml -f docker-compose.supabase.yml \
  stop postgrest rust-mash
```

Host-mode iteration against published ports:

```sh
HOST_MODE=1 node suite/cross-server/run.mjs
BASE_URL=http://localhost:3003 node suite/conformance/run.mjs 3 6 7
```

### CI legs

| Workflow | Legs |
|---|---|
| `.github/workflows/e2e-docker.yml` | one matrix leg each for `fulltest`, `conformance`, `protocol`, static `auth`, Supabase-compatible `jwt-auth`, `operations`, `load`, `recovery`, `crossserver`, and the Supabase/PostgREST path; each uploads full container logs on failure and tears down with `down -v` |
| `.github/workflows/e2e-clients.yml` | host-run `suite/clients/run_all.sh` (ts + dart + rust) against a live `postgres` + `node` stack, with `OPTO_SYNC_REQUIRE_SERVER=1` |

Note that CI's teardown step passes **both** compose files so it removes
containers from every profile regardless of which were selected for `up`.

---

## 5. Known limitations to respect when adding suites

**The in-memory servers never reset.** `rust-fullstack`, `dart` and `sagitta`
have no `/reset` and accumulate state for the lifetime of the container. A suite
that writes to a fixed key would compare a fresh server against one carrying
keys from an earlier run — a spurious "runtimes disagree" failure. This is why
`suite/cross-server/run.mjs` namespaces every run:

```js
const RUN = process.env.NS_SUFFIX ?? `p${process.pid}`;
// keys: xconv_<RUN>, xnum_<RUN>, xcomm_<RUN>_<perm>
```

Set `NS_SUFFIX` to pin it. Namespace, or restart the container.

**`/reset` truncates shared tables.** `POST /reset` on the node server runs
`TRUNCATE syncer_test_docs` and `TRUNCATE syncer_test_docs_profiles`, then
re-seeds. Any suite running concurrently loses its documents. Consequently:

- the conformance suite calls `/reset` freely — it owns the node server for its
  run and resets between scenario groups;
- `suite/clients/` **never** calls `/reset`. Every document is namespaced
  (`cl-<lang>-<scenario>`, `cl-converge`) and created with `PUT /doc/:id`
  immediately before use, which also makes the three language suites
  independent and parallel-safe;
- `suite/supabase/` uses its **own table** (`supabase_sync_docs`), prefixes every
  id with a per-run token (`sb-<pid>-<time>`), and cleans up only that prefix.
  It never reads, writes, drops or truncates `syncer_test_docs`.

New suites should namespace rather than reset unless they are the sole
consumer of the node server.

**Integers past 2^53 are rounded by JS-based components.**
`1689940800123456789` → `1689940800123456800`. Neither Postgres `jsonb`
(numbers are `numeric`) nor the C core (int64-exact via yyjson) loses it; the
node server's `express.json` → `JSON.parse` → double → `JSON.stringify` path
does. Rust and Dart preserve it exactly.

Consequences for test code:

- send int64 values as **raw body text** (`syncRaw`, `putDocRaw`, `batchRaw`) —
  a JS number literal is already truncated inside the test process before it
  reaches the wire;
- assert against **raw response text**, not `JSON.parse` output — parsing in the
  test process re-rounds an exact server's value and makes it look lossy;
- represent nanosecond timestamps as **digit strings** in real payloads. The
  core compares pure-digit strings numerically, so LWW/FWW resolution stays
  correct and no runtime can round them.

**Never `docker compose down` while iterating.** `postgres` is shared by the
node server, the conformance suite and the Supabase stand-in. Stop the specific
services instead.

**`postgrest` is pinned to v12.2.3** and is not Supabase. RLS is not enabled in
the stand-in — see `suite/supabase/README.md` and
[`syncer.c/docs/SECURITY.md`](../../syncer.c/docs/SECURITY.md) for what that
does and does not prove.
