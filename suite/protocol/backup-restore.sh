#!/bin/sh
set -eu

export PGPASSWORD="${PGPASSWORD:-syncer_test}"
source_database="${SOURCE_DATABASE:-syncer_test}"
restore_database="${RESTORE_DATABASE:-syncer_restore_test}"
backup_file="/tmp/opto-sync-protocol.dump"
lock_marker="/tmp/opto-sync-state-lock-held"

cleanup() {
  dropdb --if-exists --force -h postgres -U syncer "$restore_database" \
    >/dev/null 2>&1 || true
  rm -f "$backup_file"
  rm -f "$lock_marker"
}
trap cleanup EXIT

pg_dump --format=custom --no-owner --no-privileges \
  -h postgres -U syncer -d "$source_database" -f "$backup_file"

backup_bytes="$(wc -c < "$backup_file" | tr -d ' ')"
if [ "$backup_bytes" -lt 4096 ]; then
  echo "backup is unexpectedly small: $backup_bytes bytes" >&2
  exit 1
fi

dropdb --if-exists --force -h postgres -U syncer "$restore_database"
createdb -h postgres -U syncer "$restore_database"
pg_restore --exit-on-error --no-owner --no-privileges \
  -h postgres -U syncer -d "$restore_database" "$backup_file"
psql -v ON_ERROR_STOP=1 -h postgres -U syncer -d "$restore_database" \
  -f /suite/protocol/recovery-assert.sql

# Reproduce the dangerous lock interleaving deterministically. The holder owns
# protocol state first. A correctly registered direct SQL statement blocks in
# its BEFORE STATEMENT trigger before it can lock the source row, allowing the
# holder to update that row and commit. Without the pre-lock trigger, the
# contender takes the row first and its AFTER trigger deadlocks against state.
psql -v ON_ERROR_STOP=1 -h postgres -U syncer -d "$restore_database" \
  -c "INSERT INTO recovery_application_tasks(workspace, task_key, payload)
      VALUES ('recovery-lock-order', 'shared', '{\"lockOrder\":\"seed\"}'::JSONB)"
rm -f "$lock_marker"
psql -v ON_ERROR_STOP=1 -h postgres -U syncer -d "$restore_database" \
  -f /suite/protocol/lock-order-holder.sql &
holder_pid=$!
attempt=0
while [ ! -f "$lock_marker" ]; do
  attempt=$((attempt + 1))
  if [ "$attempt" -gt 250 ]; then
    echo "state-lock holder did not become ready" >&2
    kill "$holder_pid" >/dev/null 2>&1 || true
    wait "$holder_pid" || true
    exit 1
  fi
  sleep 0.02
done
psql -v ON_ERROR_STOP=1 -h postgres -U syncer -d "$restore_database" \
  -c "SET statement_timeout = '5s';
      UPDATE recovery_application_tasks
         SET payload = '{\"lockOrder\":\"contender\"}'::JSONB
       WHERE workspace = 'recovery-lock-order' AND task_key = 'shared'"
wait "$holder_pid"
psql -v ON_ERROR_STOP=1 -h postgres -U syncer -d "$restore_database" \
  -f /suite/protocol/lock-order-assert.sql

echo "Backup/restore drill passed ($backup_bytes-byte custom-format dump)"
