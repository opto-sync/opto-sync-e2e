# opto-sync-e2e

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

## Servers

| Service          | Port | Stack                                                                  | Storage             |
|------------------|------|------------------------------------------------------------------------|---------------------|
| `rust-mash`      | 3001 | Rust: Maud + Axum + Supabase REST + HTMX, merges via `syncer-rs` C FFI | Supabase (REST API) |
| `rust-fullstack` | 3002 | Rust: Axum SSR + `syncer-rs` C FFI                                     | in-memory           |
| `node`           | 3003 | Node: Express + `@opto-sync/syncer` native C addon + Drizzle           | Postgres            |
| `dart`           | 3004 | Dart: Shelf + `dart:ffi` to the C core                                 | in-memory           |
| `sagitta`        | 3005 | Dart: Sagitta SSR stack + `dart:ffi`                                   | in-memory           |

A `postgres:16` container backs the node server (exposed on host port 5433).

All five servers apply the **same merge policy**, so conformance expectations
are uniform across runtimes: `MERGE_BY_KEY` on `id`, `resolveByTimestamp` with
LWW keys `updatedAt,syncedAt` and FWW key `createdAt`.

The node server **refuses to start without the native C addon**
(`SYNCER_REQUIRE_NATIVE=1`). A JS fallback merge would let the entire suite
pass without ever exercising the core — the false confidence these tests exist
to prevent.

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
# Default profile: node + rust-mash servers, runs test/run_e2e.sh
docker compose --profile test up --build

# Full suite: also builds rust-fullstack, dart and sagitta,
# runs test/run_e2e_full.sh against every in-memory server
docker compose --profile fulltest --profile fullstack --profile dart --profile sagitta up --build
```

`run_e2e.sh` exercises the node server (health, seed docs, deep merge of
nested objects). `run_e2e_full.sh` covers node, rust-fullstack, dart and
sagitta with a shared merge scenario; rust-mash is validated separately by
the `--profile test` run because it needs live Supabase credentials.

## Clients

Client libraries (offline queue, merge strategies, transport) no longer live
here — they moved to [`../opto-sync-clients`](../opto-sync-clients). The
`clients/` directory in this repo only holds thin e2e consumer stubs that
path-depend on those packages (see `clients/README.md`) for future
browser/device end-to-end runs.
