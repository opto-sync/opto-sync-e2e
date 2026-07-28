# Canary incident routing contract

Scheduled tests only protect opto-sync when failures become owned, deduplicated incidents and recovery is based on later scheduled evidence rather than an optimistic manual rerun.

`scripts/canary-incident.py` provides the credential-free state and rendering layer shared by the nightly core fuzz/leak canary, the client compatibility canary, and weekly E2E certification.

## Commands

The script reads one JSON object from standard input and writes deterministic JSON to standard output.

### `classify`

Normalizes a GitHub Actions outcome into:

- a stable 24-character incident signature;
- failure, missed-run, or recovery-evidence kind;
- High or Urgent priority for compatibility and sanitizer/security failures;
- redacted first actionable error text; and
- a Linear-ready title, Markdown body, labels, and project name.

Volatile SHAs, UUIDs, timestamps, process/run numbers, and memory addresses do not fragment one material failure into duplicate incidents.

### `reduce`

Consumes an existing incident state plus one event and emits an action:

- `create` for a new scheduled failure signature;
- `update` for a repeated identical scheduled failure;
- `reopen` when a recovered signature fails again;
- `recover` only after a later **scheduled** success;
- `record_manual_success_evidence` for a manually triggered green rerun; or
- evidence-only actions for pull-request and push failures.

This intentionally prevents a manual rerun from auto-closing a nightly/weekly incident.

### `detect-missed`

Compares the current time to the last scheduled run, expected interval, and grace window. When overdue, it emits a synthetic `missed` event that goes through the same deduplication reducer.

## Delivery boundary

This PR does not embed a Linear API token or write to Linear from untrusted workflow code. A delivery adapter must:

1. run only from trusted scheduled/workflow-run contexts;
2. hold credentials in protected GitHub Environment or organization secrets;
3. search by the exact incident signature before creating anything;
4. apply the reducer action idempotently;
5. retain run and artifact links but redact environment values; and
6. persist incident state in Linear fields/comments or another reviewed durable store.

Fork pull requests and arbitrary branch code must never receive the delivery credential.

## Covered regressions

The normalization categories explicitly prioritize:

- ASan, LSan, UBSan, use-after-free, and buffer-overflow reports;
- credential/token leakage indicators;
- protocol or schema mismatches;
- migration and core-parity failures; and
- frozen-install or lockfile mismatches.

The unit suite proves deduplication, material-signature separation, scheduled-only recovery, missed-run detection, and non-scheduled evidence behavior. The next DEN-366 slice is the protected Linear delivery adapter and an end-to-end controlled failure/recovery drill.
