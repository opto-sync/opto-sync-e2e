# Protocol operations

The Node/PostgreSQL implementation is a reference sync service, not just a
semantic demo. It fails closed on invalid operational configuration and exposes
bounded traffic controls, structured audit events, and Prometheus metrics.

## Configuration

Every numeric setting is parsed during startup. A missing setting uses the
default; an invalid, fractional, or out-of-range value aborts startup.

| Environment variable | Default | Valid range | Effect |
|---|---:|---:|---|
| `SYNCER_PROTOCOL_MAX_PUSH_BYTES` | 1,048,576 | 1 KiB–32 MiB | Maximum exact HTTP body bytes for `/v1/sync/push`, including JSON whitespace. |
| `SYNCER_PROTOCOL_MAX_MUTATION_BYTES` | 262,144 | 256 B–16 MiB | Maximum canonical JSON bytes for one mutation. |
| `SYNCER_PROTOCOL_MAX_PUSH_MUTATIONS` | 100 | 1–100 | Maximum mutations in one atomic push/queue batch. |
| `SYNCER_PROTOCOL_MAX_SNAPSHOT_RECORDS` | 100,000 | 1–10,000,000 | Maximum live records in one all-at-once reset snapshot. |
| `SYNCER_PROTOCOL_MAX_SNAPSHOT_BYTES` | 134,217,728 | 1 KiB–1 GiB | Maximum aggregate PostgreSQL JSON text bytes in one snapshot. |
| `SYNCER_PROTOCOL_RATE_LIMIT_REQUESTS` | 600 | 0–1,000,000 | Requests per principal, route, and fixed window. `0` delegates limiting to an external implementation. |
| `SYNCER_PROTOCOL_RATE_LIMIT_WINDOW_MS` | 60,000 | 1,000–3,600,000 | Fixed-window duration. |
| `SYNCER_METRICS_TOKEN` | none | 32–4,096 characters | Separate bearer credential for `GET /metrics`. Required outside explicit e2e mode; an unconfigured production endpoint answers 404. |

The legacy/conformance routes retain Express's 32 MiB parser limit. Protocol
pushes are measured from the raw received buffer and enforce the tighter
protocol limit, so whitespace padding and chunked requests cannot bypass it.

Quota failures are explicit and do not touch the mutation ledger:

- `PUSH_TOO_LARGE`
- `MUTATION_TOO_LARGE`
- `PUSH_MUTATION_LIMIT`
- `SNAPSHOT_QUOTA_EXCEEDED`

The snapshot endpoint checks count and aggregate JSON bytes inside the same
repeatable-read transaction as its checkpoint. It never returns a silently
partial reset. Raise the configured limit for a bounded deployment or implement
a transactionally pinned streaming snapshot before exceeding it.

## Rate limiting

Authenticated tenant, administrator, and test identities have independent
per-route buckets. Invalid bearer attempts use a remote-address bucket, so
credential spraying is also bounded. A refusal returns HTTP 429,
`RATE_LIMITED`, a JSON `retryAfterSeconds`, and the standard `Retry-After`
header.

The bundled limiter is deliberately process-local. With multiple server
replicas, enforce the same policy at a trusted ingress or replace it with a
shared Redis/database limiter. Set `SYNCER_PROTOCOL_RATE_LIMIT_REQUESTS=0` only
when that external control exists. Do not enable Express `trust proxy` without
restricting which proxy can supply forwarding headers.

## Metrics

`GET /metrics` emits Prometheus text. Labels are a fixed vocabulary: route,
method, status class, mutation outcome, quota, and compaction outcome. Tenant,
subject, client, record, token, and error-message values never become labels.

Important series include:

- `opto_sync_protocol_requests_total`
- `opto_sync_protocol_request_duration_seconds`
- `opto_sync_protocol_mutations_total`
- `opto_sync_protocol_push_batches_total`
- `opto_sync_protocol_push_bytes_total`
- `opto_sync_protocol_push_rejections_total`
- `opto_sync_protocol_quota_rejections_total`
- `opto_sync_protocol_rate_limited_total`
- `opto_sync_protocol_snapshots_total`
- `opto_sync_protocol_compactions_total`
- `opto_sync_protocol_rate_limiter_entries`

Alert at minimum on sustained 5xx responses, rollback/failure counters, rising
429 or quota rejection rates, snapshot quota exhaustion, and request-duration
percentiles approaching the caller timeout.

## Structured audit events

Security and state-transition events are written to stdout as one JSON object
per line with schema `opto_sync.audit.v1`. Every protocol response also carries
an `X-Request-ID`. Events cover authentication denial/rate limiting, client
binding denial, push commit/rollback/quota refusal, snapshot refusal/failure,
metrics authentication denial, and compaction commit/rollback.

Bearer tokens, mutation payloads, raw tenant/subject/client IDs, and record IDs
are never logged. Principal and client correlation values are truncated SHA-256
digests. Route these lines to an append-only log sink and apply retention and
access controls appropriate to security audit data.

JWT/JWKS configuration, signed tenant/client claims, rotation behavior, and
adversarial verification are documented in
[AUTHENTICATION.md](AUTHENTICATION.md).

Versioned migration, backup scope, restore validation, and deployment runbooks
are documented in
[MIGRATIONS_AND_RECOVERY.md](MIGRATIONS_AND_RECOVERY.md).

## Verification and capacity probe

```sh
# Low-limit production instance: protected metrics, all quota classes,
# authenticated and unauthenticated rate limiting, snapshot refusal.
docker compose --profile operations up --build \
  --exit-code-from operations-protocol

# 96 concurrent writers against one record, then 96 ambiguous retries.
docker compose --profile load up --build --exit-code-from protocol-load
```

The load probe accepts `LOAD_CLIENTS`, `LOAD_P95_MS`, and `LOAD_MAX_MS`. It
first proves every write committed, every retry deduplicated, every ordered
change exists, and the snapshot contains every contribution; only then does it
enforce latency bounds. On one local ARM Docker run, 96 writers measured
281 ms initial-push p95 and 112 ms duplicate-retry p95. These figures establish
a regression baseline for that environment, not a production capacity claim.

The singleton PostgreSQL state lock makes commit order easy to reason about but
also bounds write throughput. Repeat the probe on deployment-equivalent
hardware and replace the allocator with a WAL/LSN or partitioned design if
measured requirements exceed it.
