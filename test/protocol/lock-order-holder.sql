\set ON_ERROR_STOP on

BEGIN;
SET LOCAL statement_timeout = '5s';
SELECT last_seq
  FROM syncer_protocol_state
 WHERE singleton = TRUE
 FOR UPDATE;
\! touch /tmp/opto-sync-state-lock-held
SELECT pg_sleep(0.5);
UPDATE recovery_application_tasks
   SET payload = '{"lockOrder":"holder"}'::JSONB
 WHERE workspace = 'recovery-lock-order'
   AND task_key = 'shared';
COMMIT;
