# Experimental record-ID-scoped PostgreSQL reads (protocol-v1 companion)

This is a small first step toward Electric/Phoenix.Sync-like partial replication,
not general predicate or SQL-scope support. It uses the same PostgreSQL
commit-ordered checkpoint and captured record/change tables as the existing
protocol-v1 pull and snapshot endpoints.

## Endpoints

Both are authenticated, rate-limited POST routes under the existing
/v1/sync middleware. POST keeps requested record IDs out of URL/query logging.

POST /v1/sync/scopes/snapshot

    {
      "protocolVersion": 1,
      "scopeKey": "client-owned canonical scope/session key",
      "scope": {"version": 1, "table": "docs", "recordIds": ["doc-1"]}
    }

Response includes the same scopeKey, a server-owned scopeToken, a global
commit-ordered checkpoint string and an authoritative records array. The
snapshot and checkpoint are read under one PostgreSQL repeatable-read
transaction. Quotas use the existing snapshot record/byte configuration.

POST /v1/sync/scopes/pull

    {
      "protocolVersion": 1,
      "scopeKey": "client-owned canonical scope/session key",
      "scopeToken": "64-character token from snapshot",
      "scope": {"version": 1, "table": "docs", "recordIds": ["doc-1"]},
      "checkpoint": "123",
      "limit": 100
    }

Response includes fromCheckpoint, checkpoint, scopeKey, scopeToken, hasMore,
and the selected ordered change rows. If the selected rows do not fill a
page, the checkpoint may advance across unrelated global commits safely.
An expired checkpoint returns RESET_REQUIRED and the scoped snapshot route.

## Security/semantics

- Scope is an exact, immutable set of 1 to 128 unique record IDs.
- Only the reference docs logical table is supported. Arbitrary SQL/filter
  clauses and arbitrary registered application tables are rejected.
- The scope token binds server-verified tenant+subject to the exact canonical
  table and ordered ID set, and is validated on every pull. It is NOT a bearer
  credential or substitute for per-record authorization.
- Both routes run after the existing tenant auth/rate-limit middleware and
  apply tenant/table/ID predicates in parameterized PostgreSQL queries.
- The server echoes client scopeKey, but never trusts it to choose records,
  sessions, tenants or checkpoints. Clients must separately verify it.
- The current reference protocol authorizes documents at the TENANT level,
  which is not sufficient for scoped replication.
  Scoped routes now FAIL CLOSED with SCOPE_FORBIDDEN unless the host installs
  an explicit `SyncProtocolOptions.authorizeScopedRecord` callback.
  That callback must verify each ID against current access policy on EACH
  snapshot and pull; a false, missing or throwing callback denies the entire
  request. The callback is not a substitute for hardening database RLS.
  No production caller is wired to grant these permissions by default.
- Snapshots and pull pages use read-only repeatable-read transactions; the
  server's existing commit-ordered state is unchanged. No new mutation write
  path, merge engine, or local optimistic queue is introduced.
- Existing HTTP/WebSocket/TCP protocol v1 is unaffected. No claim of TanStack
  DB integration, predicate-membership transitions, or mobile parity is made.

## Verification

    cd servers/node
    npm ci
    npm run typecheck
    npm test

The scoped-reads tests use fake database connections to validate SQL-boundary
tenant/filter parameters, scope-token mismatch, and response shapes. REAL
Postgres concurrency, compaction/reset and tenant-switch e2e tests are required
before production readiness or promotion from draft.
