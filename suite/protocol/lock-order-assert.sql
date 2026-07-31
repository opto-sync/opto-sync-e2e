\set ON_ERROR_STOP on

DO $$
BEGIN
  IF (SELECT last_seq FROM syncer_protocol_state WHERE singleton = TRUE) <> 14
     OR (SELECT MAX(seq) FROM syncer_protocol_changes) <> 14 THEN
    RAISE EXCEPTION 'lock-order probe did not allocate three ordered changes';
  END IF;
  IF (
    SELECT COUNT(*)
      FROM syncer_protocol_changes
     WHERE tenant_id = 'recovery-lock-order'
       AND table_name = 'application_tasks'
       AND record_id = 'shared'
  ) <> 3 THEN
    RAISE EXCEPTION 'lock-order probe lost a captured transition';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM syncer_protocol_records
     WHERE tenant_id = 'recovery-lock-order'
       AND table_name = 'application_tasks'
       AND record_id = 'shared'
       AND revision = 3
       AND record #>> '{payload,lockOrder}' = 'contender'
  ) THEN
    RAISE EXCEPTION 'lock-order probe did not serialize holder before contender';
  END IF;
  IF (
    SELECT COUNT(*)
      FROM pg_trigger AS trigger
      JOIN pg_proc AS function ON function.oid = trigger.tgfoid
     WHERE trigger.tgrelid = 'recovery_application_tasks'::REGCLASS
       AND function.proname IN (
         'syncer_protocol_lock_state',
         'syncer_protocol_capture_change'
       )
       AND NOT trigger.tgisinternal
  ) <> 2 THEN
    RAISE EXCEPTION 'registered capture is missing its lock/capture trigger pair';
  END IF;
END
$$;

\echo 'Concurrent state/source-row lock ordering: all assertions passed'
