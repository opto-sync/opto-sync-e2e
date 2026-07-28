ALTER TABLE opto_sync_mutations
  ADD COLUMN hlc TEXT NOT NULL DEFAULT '0:0:fixture-device';

ALTER TABLE opto_sync_mutations
  ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;

CREATE TABLE opto_sync_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO opto_sync_meta (key, value)
VALUES
  ('storage_version', '2'),
  ('migration_state', 'complete');

PRAGMA user_version = 2;
