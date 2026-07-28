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

## Real Chromium IndexedDB migration test

`test/compatibility/indexeddb-migration.mjs` consumes the checksum-pinned logical v1 export and expected v2 snapshot in a genuine persistent Chromium profile. The workflow:

1. translates the synthetic fixture into the TypeScript client's real v1 `localMutations` IndexedDB store at native version `10`, matching Dexie's representation of schema version `1`;
2. starts a logical-v1 → logical-v2 upgrade at native version `20`, creates migration metadata, and deterministically aborts the native `versionchange` transaction;
3. closes the entire persistent browser context;
4. reopens the same on-disk profile and origin, proving the database remains native version `10`/logical version `1`, the `meta` store did not leak, and the queued mutation is byte-for-byte intact;
5. retries native version `20`/logical version `2` successfully;
6. opens the database through the current bundled `OptoSyncDatabase`, which upgrades native version `20` to `30` for Dexie implementation version `3` and adds the mutation-identity index without recreating `meta`;
7. proves the durable `hlc.nodeId` remains `fixturedevice`, an HLC/wire-valid identifier without the reserved `-` delimiter, so the recovered queued row belongs to the same protocol client;
8. builds a real protocol push request, applies a duplicate acknowledgement, advances checkpoint `1`, and verifies the queue transitions to acknowledged without duplicate effects; and
9. compares the deterministic logical export to `current/indexeddb-v2-expected.json`.

Dexie multiplies declared schema versions by ten when opening the native IndexedDB database. Raw versions `1` and `2` are therefore not equivalent to Dexie versions `1` and `2`; using them would make the later Dexie open replay earlier schema declarations and recreate the `meta` store, changing the durable client identity. The fixture records logical storage version `2`, Dexie implementation version `3`, and native IndexedDB version `30` separately so those three contracts cannot be conflated.

The Chromium profile contains deterministic synthetic data only and is deleted in `finally`. CI never uploads the browser profile. On failure it may retain only the logical diagnostic JSON, which contains no credentials, personal data, cookies, or production records.

## Stable-release gate

The default validator accepts the bootstrap fixture and reports that N-1 and N-2 are intentionally missing. `--require-history` fails until both immutable historical slots are present. CI explicitly verifies that this stricter gate remains closed.

When real releases exist:

1. retain their package and release-set provenance;
2. add immutable `n-1` and `n-2` entries with checksums;
3. add real SQLite and IndexedDB snapshots plus wire/checkpoint/mutation logs;
4. run every allowed client/server combination; and
5. change the fixture-set status only after the strict gate passes.

Fixtures must never contain credentials, kubeconfigs, tokens, personal data, or production records.
