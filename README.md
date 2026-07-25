# opto-sync-e2e

End-to-end integration tests for [`syncer.c`](../syncer.c) — the zero-deserialization
JSONB deep-merge engine — exercised through real HTTP servers in several
languages, each merging documents via the native C core.

## Servers

| Service          | Port | Stack                                                                  | Storage             |
|------------------|------|------------------------------------------------------------------------|---------------------|
| `rust-mash`      | 3001 | Rust: Maud + Axum + Supabase REST + HTMX, merges via `syncer-rs` C FFI | Supabase (REST API) |
| `rust-fullstack` | 3002 | Rust: Axum SSR + `syncer-rs` C FFI                                     | in-memory           |
| `node`           | 3003 | Node: Express + `@opto-sync/syncer` native C addon + Drizzle           | Postgres            |
| `dart`           | 3004 | Dart: Shelf + `dart:ffi` to the C core                                 | in-memory           |
| `sagitta`        | 3005 | Dart: Sagitta SSR stack + `dart:ffi`                                   | in-memory           |

A `postgres:16` container backs the node server (exposed on host port 5433).
`rust-mash` needs live Supabase credentials (see below).

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
