# opto-sync-e2e

[![E2E (docker)](https://github.com/opto-sync/opto-sync-e2e/actions/workflows/e2e-docker.yml/badge.svg)](https://github.com/opto-sync/opto-sync-e2e/actions/workflows/e2e-docker.yml)
[![E2E (client-in-the-loop)](https://github.com/opto-sync/opto-sync-e2e/actions/workflows/e2e-clients.yml/badge.svg)](https://github.com/opto-sync/opto-sync-e2e/actions/workflows/e2e-clients.yml)

End-to-end integration tests for [`syncer.c`](../syncer.c) — the zero-deserialization
JSONB deep-merge engine — exercised through real HTTP servers in several
languages, each merging documents via the native C core.

## Setup

The docker build context is the **parent** directory (so images can copy
`syncer.c/`). Docker only honors a `.dockerignore` at the context root, so
copy the tracked template there once per clone:

```sh
cp context.dockerignore ../.dockerignore
```

Without it, host `node_modules/`, `target/`, and `build/` trees leak into the
build context (slow) and can shadow in-image dependency installs.

## Documentation

- [Server guide](docs/SERVER_GUIDE.md) — how to build a sync server that is
  actually correct: CAS with jittered retry, tombstones, unique-index identity,
  batch replay, jsonb specifics
- [Test topology](docs/TEST_TOPOLOGY.md) — every server and suite, and what each
  uniquely catches
- [Remote browser e2e](test/remote-browser/README.md) — the suite that runs in a
  real browser on real Kubernetes clusters

## Servers

| Service          | Port | Stack                                                                  | Storage             |
|------------------|------|------------------------------------------------------------------------|---------------------|
| `rust-mash`      | 3001 | Rust: Maud + Axum + Supabase REST + HTMX, merges via `syncer-rs` C FFI | Supabase (REST API) |
| `rust-fullstack` | 3002 | Rust: Axum SSR + `syncer-rs` C FFI                                     | in-memory           |
| `node`           | 3003 | Node: Express + `@opto-sync/syncer` native C addon, raw `pg` + SQL     | Postgres            |
| `dart`           | 3004 | Dart: Shelf + `dart:ffi` to the C core                                 | in-memory           |
| `sagitta`        | 3005 | Dart: Sagitta SSR stack + `dart:ffi`                                   | in-memory           |

A `postgres:16` container backs the node server (exposed on host port 5433).

All five servers apply the **same merge policy**, so conformance expectations
are uniform across runtimes: `MERGE_BY_KEY` on `id`, `resolveByTimestamp` with
LWW keys `updatedAt,syncedAt`, and **no FWW key**. (`createdAt` used to be an
FWW key. FWW in the core is a node-level *veto* — an incoming node whose FWW key
is newer is dropped wholesale, however new its `updatedAt` is — so any replica
holding a later `createdAt` for a record could never write to it again.)

The node server **refuses to start without the native C addon**
(`SYNCER_REQUIRE_NATIVE=1`). A JS fallback merge would let the entire suite
pass without ever exercising the core — the false confidence these tests exist
to prevent.

The protocol reference routes are open only in the explicit e2e mode used by
the normal test stack. Outside e2e mode they fail closed until asymmetric JWT
or exact static identities are configured. Each verified identity binds a
subject and tenant to an exact set of client IDs; records, ledgers, pull pages,
and snapshots are tenant-scoped. Run the production-mode adversarial checks
with:

```sh
docker compose --profile auth up --build --exit-code-from auth-protocol
docker compose --profile jwt-auth up --build \
  --exit-code-from jwt-auth-protocol
```

See [Protocol authentication](docs/AUTHENTICATION.md) for locally verified
Supabase JWT/JWKS mode, signed tenant/client claim mapping, static credentials,
and rotation guidance. Applications with per-record ACLs must still enforce
them in the application path or with database RLS.

Protocol push/mutation/snapshot quotas, authenticated and unauthenticated rate
limits, protected Prometheus metrics, privacy-preserving JSON audit events, and
the concurrency probe are documented in [`docs/OPERATIONS.md`](docs/OPERATIONS.md).
Transactional schema evolution and the automated dump/restore drill are in
[`docs/MIGRATIONS_AND_RECOVERY.md`](docs/MIGRATIONS_AND_RECOVERY.md).

### Supabase / rust-mash

`rust-mash` can run against a real Supabase project *or* against the local
PostgREST stand-in used by `test/supabase/`. **It only works with one or the
other configured**: bringing it up from the main compose file alone leaves it
pointed at the `.env` placeholder and every request fails. For the local path,
always include the override:

```sh
docker compose -f docker-compose.yml -f docker-compose.supabase.yml \
  up -d --build postgrest rust-mash
```

`SUPABASE_REST_PREFIX` (default `/rest/v1`) is what makes both targets work
from the same code — real Supabase keeps the default; PostgREST serves tables
at the root. See `test/supabase/README.md`, which also states plainly which
Supabase features (RLS, GoTrue, realtime) that stand-in does **not** cover.

## Configuration

Copy `.env.example` to `.env` and fill in:

- `DATABASE_URL` — Postgres connection string for the node server.
- `SUPABASE_URL` — Supabase project base URL (REST) for rust-mash.
- `SUPABASE_KEY` — Supabase API key for rust-mash.

## Running the tests

Two curl-based test runners live in `test/` and run as compose profiles:

```sh
# Default profile: postgres + node, runs test/run_e2e.sh
docker compose --profile test up --build

# Full suite: also builds rust-fullstack, dart and sagitta,
# runs test/run_e2e_full.sh against every in-memory server
docker compose --profile fulltest --profile fullstack --profile dart --profile sagitta up --build
```

`run_e2e.sh` exercises the node server (health, seed docs, deep merge of
nested objects). `run_e2e_full.sh` covers node, rust-fullstack, dart and
sagitta, asserting element-level keyed-array behavior (stale element rejected,
untouched element kept, new element appended, and later `createdAt` accepted by
the default no-FWW policy)
rather than merely that a merge occurred.

### Deeper suites

| Suite | What it proves | Run |
|---|---|---|
| `test/conformance/` | Scenario-level behavior against the Postgres-backed node server: jsonb round-trip fidelity, tombstones, CAS conflicts, unique-index identity, strategy matrix, robustness | `docker compose --profile conformance up --exit-code-from conformance` |
| `test/protocol/run.mjs` | Protocol v1 idempotency, immutable mutation ids, transactional push, committed-but-response-lost retry recovery, durable rejection, commit-ordered protocol/direct-SQL capture through the canonical multi-table mirror, explicit tombstones, tenant-filtered pagination, compaction reset, and snapshot consistency | `docker compose --profile protocol up --exit-code-from protocol` |
| `test/protocol/auth.mjs` | Production-mode bearer authentication, exact client binding, durable subject ownership, token rotation, cross-tenant pull/snapshot isolation, and separate compaction administration | `docker compose --profile auth up --exit-code-from auth-protocol` |
| `test/protocol/operations.mjs` | Production-mode push/mutation/snapshot quotas, valid- and invalid-principal rate limiting, protected bounded-cardinality metrics, and structured audit paths | `docker compose --profile operations up --exit-code-from operations-protocol` |
| `test/protocol/load.mjs` | 96 concurrent writers and ambiguous retries, ordered-log/snapshot correctness first, then configurable p95/max latency bounds | `docker compose --profile load up --exit-code-from protocol-load` |
| `test/cross-server/` | Four runtimes produce semantically identical documents from one mutation sequence; non-contending mutations converge in any apply order | `docker compose --profile crossserver --profile fullstack --profile dart --profile sagitta up --exit-code-from cross-server` |
| `test/clients/` | The client libraries in `../opto-sync-clients` (ts/dart/rust) syncing against a live server: offline queue, replay, pull-back reconcile, cross-client convergence | `test/clients/run_all.sh` (from the host) |
| `test/supabase/` | The Supabase REST path end to end via a local PostgREST stand-in, with JWT auth enforced | see `test/supabase/README.md` |

Suites that need a specific server can also be iterated from the host against
the published ports (e.g. `HOST_MODE=1 node test/cross-server/run.mjs`).

### Known runtime limit: integer precision

Integers beyond 2^53 cannot survive an IEEE-754 double, so **JavaScript-based
components round them** — `1689940800123456789` becomes `...800` — while Rust
and Dart preserve them exactly. The C core is not at fault, and the
`cross-server` suite asserts this per runtime rather than hiding it. Represent
nanosecond timestamps as **digit strings**; the core compares pure-digit
strings numerically, so resolution stays correct.

## Clients

Client libraries (offline queue, merge strategies, transport) no longer live
here — they moved to [`../opto-sync-clients`](../opto-sync-clients). The
`clients/` directory in this repo only holds thin e2e consumer stubs that
path-depend on those packages (see `clients/README.md`) for future
browser/device end-to-end runs.

## CI

Two workflows run on `ubuntu-latest` for every push to `main`, every pull
request, and on demand. Both check out `syncer.c`, `opto-sync-clients` and this
repo as siblings and install `context.dockerignore` at the build-context root,
exactly as the Setup section above describes.

- [`.github/workflows/e2e-docker.yml`](.github/workflows/e2e-docker.yml) — one
  matrix leg per docker suite: `fulltest`, `conformance`, `protocol`, static
  `auth`, Supabase-compatible `jwt-auth`, `operations`, `load`, `recovery`,
  `crossserver`, and the Supabase/PostgREST path. Each leg tears the stack down
  with `docker compose down -v` and uploads full container logs on failure.
- [`.github/workflows/e2e-clients.yml`](.github/workflows/e2e-clients.yml) — the
  host-run `test/clients/run_all.sh` (ts + dart + rust clients against a live
  `postgres` + `node` stack), with `OPTO_SYNC_REQUIRE_SERVER=1` so an
  unreachable server fails instead of silently skipping.
