# Historical compatibility fixtures

The compatibility contract is not considered a production support promise until CI can replay immutable current, N-1, and N-2 artifacts. This directory establishes the fixture format and a current-release bootstrap without pretending that unreleased historical versions already exist.

## Fixture set

`compatibility/fixtures/fixture-set.v1.json` records:

- the coordinated release-set identity;
- protocol, schema, mutation-log, checkpoint, IndexedDB, and SQLite versions;
- deterministic artifact paths and SHA-256 checksums;
- required historical slots; and
- a strict synthetic-data-only policy.

The initial current fixture uses one mutation identity across SQLite, IndexedDB export, wire payload, and mutation-log lifecycle so drift between layers fails CI.

## Real SQLite migration test

`scripts/check-historical-fixtures.py` creates real SQLite databases from the checked SQL seed. It then proves:

1. the queued mutation exists before migration;
2. a complete transactional v1 to v2 migration preserves it;
3. an interruption after transactional DDL rolls back cleanly;
4. retrying the migration succeeds; and
5. storage version, columns, metadata, mutation state, checkpoint, HLC, and retry counters match the expected v2 shape.

No binary database is committed. CI generates the database in a temporary directory from checksum-pinned SQL, which makes the fixture reviewable and reproducible.

## IndexedDB bootstrap

The current IndexedDB artifact is a deterministic logical export of object-store definitions, indexes, records, and a pending mutation. It is validated for cross-fixture identity now. A later DEN-365 slice must load this export into a real browser database, interrupt an upgrade transaction, reopen the database, and prove recovery before N-1/N-2 support is accepted.

## Stable-release gate

The default validator accepts the bootstrap fixture and reports that N-1 and N-2 are intentionally missing. `--require-history` fails until both immutable historical slots are present. CI explicitly verifies that this stricter gate remains closed.

When real releases exist:

1. retain their package and release-set provenance;
2. add immutable `n-1` and `n-2` entries with checksums;
3. add real SQLite and IndexedDB snapshots plus wire/checkpoint/mutation logs;
4. run every allowed client/server combination; and
5. change the fixture-set status only after the strict gate passes.

Fixtures must never contain credentials, kubeconfigs, tokens, personal data, or production records.
