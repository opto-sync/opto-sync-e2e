\set ON_ERROR_STOP on

DO $$
DECLARE
  state_seq BIGINT;
  change_seq BIGINT;
BEGIN
  SELECT last_seq INTO state_seq
    FROM syncer_protocol_state WHERE singleton = TRUE;
  SELECT MAX(seq) INTO change_seq FROM syncer_protocol_changes;

  IF state_seq <> 3 OR change_seq <> 3 THEN
    RAISE EXCEPTION 'checkpoint/change stream mismatch after restore: % / %',
      state_seq, change_seq;
  END IF;
  IF (SELECT COUNT(*) FROM syncer_protocol_schema_migrations) <> 3 THEN
    RAISE EXCEPTION 'migration history was not restored';
  END IF;
  IF EXISTS (
    SELECT 1 FROM syncer_protocol_schema_migrations
     WHERE version NOT IN (1, 2, 3) OR checksum !~ '^[a-f0-9]{64}$'
  ) THEN
    RAISE EXCEPTION 'migration version/checksum is invalid';
  END IF;
  IF (SELECT COUNT(*) FROM syncer_protocol_clients) <> 2
     OR (SELECT COUNT(*) FROM syncer_protocol_mutations) <> 3
     OR (SELECT COUNT(*) FROM syncer_protocol_changes) <> 3
     OR (SELECT COUNT(*) FROM syncer_protocol_docs) <> 2
     OR (SELECT COUNT(*) FROM syncer_protocol_records) <> 2 THEN
    RAISE EXCEPTION 'protocol cardinality changed across backup/restore';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM syncer_protocol_clients AS client
     WHERE client.last_mutation_id <> (
       SELECT MAX(mutation.mutation_id)
         FROM syncer_protocol_mutations AS mutation
        WHERE mutation.tenant_id = client.tenant_id
          AND mutation.client_id = client.client_id
     )
  ) THEN
    RAISE EXCEPTION 'client watermark no longer matches its durable ledger';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM syncer_protocol_docs
     WHERE tenant_id = 'recovery-a'
       AND id = 'recovery-tombstone'
       AND deleted_at IS NOT NULL
       AND version = 2
  ) THEN
    RAISE EXCEPTION 'tombstone/revision did not survive restore';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM syncer_protocol_docs
     WHERE tenant_id = 'recovery-b'
       AND id = 'recovery-live'
       AND deleted_at IS NULL
       AND data = '{"title":"survives restore","nested":{"exact":true}}'::JSONB
  ) THEN
    RAISE EXCEPTION 'live nested JSONB did not survive restore';
  END IF;
  IF (
    SELECT COUNT(*)
      FROM pg_trigger AS trigger
      JOIN pg_proc AS function ON function.oid = trigger.tgfoid
     WHERE trigger.tgrelid = 'syncer_protocol_docs'::REGCLASS
       AND function.proname IN (
         'syncer_protocol_prepare_doc_update',
         'syncer_protocol_lock_state',
         'syncer_protocol_capture_change'
       )
       AND NOT trigger.tgisinternal
  ) <> 3 THEN
    RAISE EXCEPTION 'capture/update triggers were not restored';
  END IF;
END
$$;

-- Restored trigger behavior matters as much as restored rows.
INSERT INTO syncer_protocol_docs(tenant_id, id, data)
VALUES ('recovery-trigger', 'after-restore', '{"step":1}'::JSONB);
UPDATE syncer_protocol_docs
   SET data = '{"step":2}'::JSONB
 WHERE tenant_id = 'recovery-trigger' AND id = 'after-restore';

DO $$
DECLARE
  delete_was_rejected BOOLEAN := FALSE;
BEGIN
  BEGIN
    DELETE FROM syncer_protocol_docs
     WHERE tenant_id = 'recovery-trigger' AND id = 'after-restore';
  EXCEPTION
    WHEN OTHERS THEN
      IF POSITION('physical deletes are forbidden' IN SQLERRM) > 0 THEN
        delete_was_rejected := TRUE;
      ELSE
        RAISE;
      END IF;
  END;
  IF NOT delete_was_rejected THEN
    RAISE EXCEPTION 'restored physical-delete guard did not run';
  END IF;
  IF (SELECT last_seq FROM syncer_protocol_state WHERE singleton = TRUE) <> 5
     OR (SELECT MAX(seq) FROM syncer_protocol_changes) <> 5 THEN
    RAISE EXCEPTION 'restored trigger did not allocate ordered checkpoints';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM syncer_protocol_changes
     WHERE tenant_id = 'recovery-trigger'
       AND record_id = 'after-restore'
       AND revision = 2
       AND record = '{"step":2}'::JSONB
  ) THEN
    RAISE EXCEPTION 'restored update was not captured';
  END IF;
END
$$;

-- The restored generic capture function supports arbitrary column names,
-- whole-row objects, nullable tombstones, resurrection, and physical delete.
CREATE TABLE recovery_application_tasks (
  workspace TEXT NOT NULL,
  task_key TEXT NOT NULL,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  removed_at TIMESTAMPTZ,
  PRIMARY KEY (workspace, task_key)
);
SELECT syncer_protocol_register_capture(
    'recovery_application_tasks'::REGCLASS,
    'application_tasks', 'workspace', 'task_key', '*', 'removed_at'
);

INSERT INTO recovery_application_tasks(workspace, task_key, payload)
VALUES ('recovery-generic', 'g1', '{"nested":{"step":1}}'::JSONB);
UPDATE recovery_application_tasks
   SET payload = '{"nested":{"step":2}}'::JSONB
 WHERE workspace = 'recovery-generic' AND task_key = 'g1';
UPDATE recovery_application_tasks
   SET removed_at = NOW()
 WHERE workspace = 'recovery-generic' AND task_key = 'g1';
UPDATE recovery_application_tasks
   SET removed_at = NULL, payload = '{"nested":{"step":4}}'::JSONB
 WHERE workspace = 'recovery-generic' AND task_key = 'g1';
DELETE FROM recovery_application_tasks
 WHERE workspace = 'recovery-generic' AND task_key = 'g1';
INSERT INTO recovery_application_tasks(workspace, task_key, payload)
VALUES ('recovery-generic', 'g2', '{"nested":{"live":true}}'::JSONB);

DO $$
BEGIN
  IF (SELECT last_seq FROM syncer_protocol_state WHERE singleton = TRUE) <> 11
     OR (SELECT MAX(seq) FROM syncer_protocol_changes) <> 11 THEN
    RAISE EXCEPTION 'generic capture did not allocate ordered checkpoints';
  END IF;
  IF (
    SELECT COUNT(*) FROM syncer_protocol_changes
     WHERE tenant_id = 'recovery-generic'
       AND table_name = 'application_tasks'
       AND record_id = 'g1'
  ) <> 5 THEN
    RAISE EXCEPTION 'generic capture lost an application-table transition';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM syncer_protocol_changes
     WHERE tenant_id = 'recovery-generic'
       AND table_name = 'application_tasks'
       AND record_id = 'g1'
       AND operation = 'delete'
       AND revision = 5
       AND record IS NULL
  ) THEN
    RAISE EXCEPTION 'generic physical delete was not captured';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM syncer_protocol_records
     WHERE tenant_id = 'recovery-generic'
       AND table_name = 'application_tasks'
       AND record_id = 'g1'
       AND revision = 5
       AND deleted_at IS NOT NULL
       AND record IS NULL
  ) THEN
    RAISE EXCEPTION 'generic mirror did not retain the tombstone revision';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM syncer_protocol_records
     WHERE tenant_id = 'recovery-generic'
       AND table_name = 'application_tasks'
       AND record_id = 'g2'
       AND revision = 1
       AND deleted_at IS NULL
       AND record #> '{payload,nested}' = '{"live":true}'::JSONB
  ) THEN
    RAISE EXCEPTION 'generic whole-row JSONB capture is incorrect';
  END IF;
END
$$;

-- Invalid capture input must fail the source write and roll back checkpoint
-- allocation. This guards against a change-log hole paired with an
-- unrepresentable authoritative row.
CREATE TABLE recovery_invalid_capture (
  tenant_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  PRIMARY KEY (tenant_id, record_id)
);
SELECT syncer_protocol_register_capture(
    'recovery_invalid_capture'::REGCLASS,
    'invalid_capture', 'tenant_id', 'record_id', 'payload'
);

DO $$
DECLARE
  invalid_record_was_rejected BOOLEAN := FALSE;
BEGIN
  BEGIN
    INSERT INTO recovery_invalid_capture(tenant_id, record_id, payload)
    VALUES ('recovery-generic', 'invalid-array', '[]'::JSONB);
  EXCEPTION
    WHEN OTHERS THEN
      IF POSITION('captured protocol record must be a JSON object' IN SQLERRM) > 0 THEN
        invalid_record_was_rejected := TRUE;
      ELSE
        RAISE;
      END IF;
  END;

  IF NOT invalid_record_was_rejected THEN
    RAISE EXCEPTION 'generic capture accepted a non-object protocol record';
  END IF;
  IF EXISTS (SELECT 1 FROM recovery_invalid_capture)
     OR EXISTS (
       SELECT 1 FROM syncer_protocol_records
        WHERE tenant_id = 'recovery-generic'
          AND table_name = 'invalid_capture'
     )
     OR EXISTS (
       SELECT 1 FROM syncer_protocol_changes
        WHERE tenant_id = 'recovery-generic'
          AND table_name = 'invalid_capture'
     ) THEN
    RAISE EXCEPTION 'rejected generic capture left a partial durable effect';
  END IF;
  IF (SELECT last_seq FROM syncer_protocol_state WHERE singleton = TRUE) <> 11
     OR (SELECT MAX(seq) FROM syncer_protocol_changes) <> 11 THEN
    RAISE EXCEPTION 'rejected generic capture advanced the checkpoint';
  END IF;
END
$$;

\echo 'Restored protocol invariants and trigger behavior: all assertions passed'
