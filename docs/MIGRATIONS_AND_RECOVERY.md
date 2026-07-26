# Schema migrations and recovery

The reference PostgreSQL protocol owns durable state whose consistency spans
application records, the canonical protocol mirror, client watermarks,
immutable mutation results, ordered changes, tombstones, trigger functions,
and the singleton checkpoint. Backing up only the application tables is not
sufficient.

## Versioned migrations

`ensureProtocolSchema()` runs a numbered migration set with these invariants:

- all pending migrations and their history rows commit in one transaction;
- a PostgreSQL advisory transaction lock serializes concurrent replicas;
- SHA-256 covers the exact SQL text;
- an already-applied version with a different name or checksum aborts startup;
- a database containing an unknown newer version aborts an older binary; and
- legacy unscoped tables upgrade without discarding their ledger.

Applied versions live in `syncer_protocol_schema_migrations`. `/health`
advertises `protocolSchemaVersion`.

Never edit an applied migration. Add the next monotonically increasing version.
Editing old SQL intentionally makes deployed databases fail their checksum
gate, because silently changing historical meaning is unsafe.

Run migrations as a deployment job before rolling application replicas:

```sh
cd servers/node
npm ci
npm run build
DATABASE_URL=postgres://... npm run migrate
```

Application startup runs the same idempotent gate, so a missed migration job
still fails safely. A production container already contains `dist/migrate.js`,
so its deployment job only runs `npm run migrate`. The `recovery` Docker
profile starts that compiled migration job and two replicas concurrently
against one unmigrated history and requires all three to converge at version 3,
exercising the advisory lock.

Before adding a migration:

1. define forward-only SQL and its rollback/repair playbook;
2. test an upgrade from every supported prior version with production-shaped
   data volume;
3. decide whether DDL requires a maintenance window or lock timeout;
4. take and verify a recoverable backup;
5. deploy the migration job once;
6. verify the migration row/checksum and service health; and
7. only then roll application replicas.

The current reference migration is transactional. PostgreSQL operations that
cannot run in a transaction, such as `CREATE INDEX CONCURRENTLY`, require a
separately designed multi-phase migration and must not be inserted into this
transactional list.

## Backup scope

Prefer a full physical/PITR backup for production recovery. A logical backup
must include, at minimum:

- `syncer_protocol_schema_migrations`
- `syncer_protocol_state`
- `syncer_protocol_docs`
- `syncer_protocol_records`
- `syncer_protocol_clients`
- `syncer_protocol_mutations`
- `syncer_protocol_changes`
- `syncer_protocol_capture_change()` and every application-table trigger that
  invokes it
- the source application tables represented in the protocol mirror
- application membership/ACL tables used to issue authorization claims

Back up the database at one consistent snapshot. Do not export these tables
independently: a client watermark newer than its mutation ledger, or a
checkpoint newer than the change stream, can permanently lose or duplicate
work.

Example logical backup:

```sh
pg_dump --format=custom --no-owner --no-privileges \
  --dbname="$DATABASE_URL" --file=opto-sync.dump
```

Encrypt backups, restrict access, record checksums, keep them outside the
primary failure domain, and test the actual restore mechanism used by the
deployment. Supabase-managed backups and PITR remain the preferred hosted
recovery layer; a logical export is still useful for portable drills.

## Automated restore drill

```sh
docker compose --profile recovery up --build \
  --exit-code-from protocol-backup-restore
```

The drill:

1. races the compiled migration job and two servers through the migration
   gate;
2. creates two tenant streams, three durable ledger rows, live nested JSONB,
   and a tombstone through the real HTTP protocol;
3. takes a custom-format `pg_dump` while the source server remains online;
4. restores into a fresh database;
5. checks migration history, state/change checkpoint equality, client
   watermark/ledger equality, tenant cardinality, revisions, tombstones, and
   exact nested JSONB; and
6. performs insert/update/delete attempts to prove restored document capture,
   versioning, checkpoint allocation, and the physical-delete guard still run;
7. attaches the generic capture trigger to an arbitrary table with nonstandard
   tenant/id/delete column names and proves whole-row JSONB capture, tombstone,
   resurrection, physical delete, and retained mirror revisions; and
8. rejects a non-object record atomically, proving neither the source row nor
   a checkpoint/log/mirror fragment survives.

The drill deletes only its temporary restore database after success. It does
not claim an RPO or RTO: measure those on production-sized data and record
deployment-specific objectives and alert thresholds.

## Post-restore startup

Before serving traffic:

```sql
SELECT version, name, checksum, applied_at
FROM syncer_protocol_schema_migrations
ORDER BY version;

SELECT last_seq, min_available_seq
FROM syncer_protocol_state
WHERE singleton = TRUE;

SELECT max(seq) FROM syncer_protocol_changes;
```

Then start one canary replica, verify `/health`, pull and snapshot a test
tenant, retry a previously acknowledged mutation to confirm `duplicate`, and
only then restore full traffic.
