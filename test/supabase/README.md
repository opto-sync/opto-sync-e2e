# Supabase-path e2e suite

Covers the `rust-mash` server (`servers/rust`) — the only component in this
repo that persists through a **REST API** instead of a Postgres connection.

## Why this exists

`rust-mash` reads and writes documents by calling
`{SUPABASE_URL}/rest/v1/<table>` with `apikey` + `Authorization: Bearer`
headers, and merges the jsonb payload through the statically linked syncer C
core. Because it needed live cloud credentials, it was **excluded from every
e2e run** — so the entire Supabase code path (auth headers, URL shape,
upsert-by-primary-key, jsonb round trip, merge policy) had **zero coverage**.

Supabase's REST API *is* [PostgREST](https://postgrest.org) — same project,
same wire protocol. So the suite runs a local PostgREST container against the
existing `postgres` service and points `rust-mash` at it. No cloud project, no
secrets, and the code under test is unmodified production code paths.

## Running it

Prerequisite: the `postgres` service from the main compose file is up. Never
run `docker compose down` — other suites share that database.

```bash
cd opto-sync-e2e

# 1. bring up ONLY the Supabase-path services
#    (supabase-init runs first as a one-shot: creates the anon/authenticator
#     roles and the supabase_sync_docs table; it never restarts postgres)
docker compose -f docker-compose.yml -f docker-compose.supabase.yml \
  up -d --build postgrest rust-mash

# 2a. run the suite in-network
docker compose -f docker-compose.yml -f docker-compose.supabase.yml \
  --profile supabasetest run --rm supabase-test

# 2b. ...or from the host (ports 3001 and 3010 are published)
node test/supabase/run.mjs

# teardown of just this stack (leaves postgres and node running)
docker compose -f docker-compose.yml -f docker-compose.supabase.yml \
  stop postgrest rust-mash
```

Exit code is 0 only if every assertion passes. The suite is
zero-dependency: node 22 built-ins and global `fetch`.

Overridable env: `RUST_MASH_URL`, `POSTGREST_URL`, `SUPABASE_TABLE`,
`SUPABASE_KEY`.

Rust-side unit tests (prefix normalization, merge policy) run with
`cd servers/rust && cargo test`.

## What it asserts

77 assertions:

| Group | Asserts |
| --- | --- |
| health / native core | `/health` is 200; the **native C core** is what merges (`native: true`, `mergeEngine: native-c-ffi-rust`, semver `coreVersion` ≥ 0.2.0 — the version that added `MERGE_BY_KEY`) |
| merge policy | the server-owned policy matches the Postgres path exactly: `MERGE_BY_KEY(4)`, `arrayMatchKeys: id`, `lwwKeys: updatedAt,syncedAt`, and **no** `fwwKeys` (FWW is a node-level veto, so no key may reject a write for being *newer*) |
| REST layer | PostgREST serves the table; it **404s on `/rest/v1/...`** (proving `SUPABASE_REST_PREFIX` is load-bearing, not decorative); an **invalid JWT is rejected with 401** (proving the suite is not passing against a wide-open database) |
| create + round trip | create through `rust-mash`, read back through `rust-mash`, then read the row **directly out of PostgREST** and compare; `updated_at` is a server-side trigger value `rust-mash` never sent |
| deep merge | nested key added, nested sibling preserved, untouched branch preserved verbatim, version bumped — and the merged jsonb **actually persisted**, verified by a direct PostgREST read |
| keyed arrays | reconciliation by `id`: matched element updated, omitted fields kept, unmentioned element untouched, new identity appended last, order preserved |
| LWW | stale element (older `updatedAt`) rejected and the rejection is what PostgREST stores; an element carrying a *later* `createdAt` is **accepted** when its `updatedAt` is newer (`createdAt` is not a guarded key) and the element stays writable afterwards; document-level LWW rejects a stale whole payload |
| idempotency | three identical syncs converge to identical data, no duplicated keyed elements, converged state persisted |
| jsonb / REST fidelity | a **nanosecond integer** survives merge + jsonb + REST exactly (compared against the raw response text, so JS number handling cannot mask a loss), plus double precision, unicode and escaping |
| errors / SSR | 404 on unknown document (GET and sync), 400 on a non-object body, the Maud/HTMX dashboard and `/docs` render off the REST layer |

The design rule throughout: **every claim about merged state is re-verified by
reading the row back through PostgREST directly, bypassing `rust-mash`.** A
merge that only ever existed in server memory, or a write that silently
no-op'd, fails those checks.

## Isolation from the other suites

- Uses its **own table**, `supabase_sync_docs`. The Postgres-path suites run
  concurrently against `syncer_test_docs`, which this suite never reads,
  writes, drops or truncates.
- Every document id is prefixed with a per-run token (`sb-<pid>-<time>`), and
  cleanup deletes only that prefix. Concurrent and repeated runs are safe.
- `supabase-init` is a one-shot psql container. It is idempotent and only ever
  does DDL/GRANTs — it never restarts or resets postgres.

## Auth: faithful, not bypassed

A real Supabase anon key is an HS256 JWT with `role: anon` signed by the
project's JWT secret, sent in both `apikey` and `Authorization: Bearer`. The
local stand-in uses exactly that arrangement: `PGRST_JWT_SECRET` in the
override file and a matching deterministic anon JWT as `SUPABASE_KEY`.
PostgREST logs in as a privilege-less `authenticator` role and `SET ROLE`s to
`anon` per request. If the secret and the key drift apart, every request 401s
— the honest failure mode. Auth is verified, not disabled.

## Real-Supabase compatibility

`rust-mash` defaults `SUPABASE_REST_PREFIX` to `/rest/v1`, so **a real Supabase
project needs no configuration** — set `SUPABASE_URL` and `SUPABASE_KEY` and it
works as before. Only this local stand-in overrides the prefix to `""`, because
bare PostgREST serves tables at the root. `SUPABASE_TABLE` similarly defaults
to `syncer_test_docs`.

## NOT covered — what PostgREST is not

PostgREST is Supabase's REST layer, but Supabase is more than PostgREST. These
are genuinely **untested** here, and passing this suite says nothing about
them:

- **Row Level Security policies.** The `anon` role here has plain table
  GRANTs and no RLS enabled. A real project's `anon` role is constrained by
  RLS, so a query that passes locally could return zero rows or 403 in
  production. This is the biggest gap.
- **GoTrue auth.** No sign-up/sign-in, no user JWTs with a `sub` claim, no
  refresh-token rotation, no key expiry or rotation handling. The suite uses one
  static long-lived anon token.
- **Realtime.** No websocket subscriptions, no logical-replication change feed —
  so nothing about how concurrent syncs propagate to subscribers is covered.
- **PostgREST version drift.** Pinned to `postgrest/postgrest:v12.2.3`;
  Supabase runs its own build and may differ in defaults or error bodies.
- **Cloud behaviors:** the API gateway (Kong), rate limits, connection-pooler
  semantics, TLS, project-level `apikey` validation ahead of PostgREST,
  Storage, Edge Functions, and network latency/partition behavior.
- **Supabase client libraries.** `rust-mash` hand-builds its HTTP requests; no
  `supabase-js`/`postgrest-rs` code path is exercised.
