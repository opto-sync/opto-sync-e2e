PRAGMA foreign_keys = ON;
PRAGMA user_version = 1;

CREATE TABLE opto_sync_records (
  document_id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE opto_sync_mutations (
  mutation_id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'acknowledged', 'rejected')),
  checkpoint TEXT
);

INSERT INTO opto_sync_records (document_id, payload_json, updated_at)
VALUES (
  'fixture-doc-1',
  '{"title":"queued before migration","updatedAt":"1000"}',
  '1000'
);

INSERT INTO opto_sync_mutations (
  mutation_id,
  document_id,
  payload_json,
  state,
  checkpoint
)
VALUES (
  'fixture-mutation-1',
  'fixture-doc-1',
  '{"title":"queued before migration","updatedAt":"1000"}',
  'pending',
  NULL
);
