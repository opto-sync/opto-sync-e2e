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

Volatile SHAs, UUIDs, timestamps, process/run numbers, and memory addresses do not fragment one material failure into duplicate incidents. Changing missed-run deadlines and lateness values collapse to one stable `availability:missed-schedule` category.

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

The credential-free engine does not embed a Linear API token or write to Linear from untrusted workflow code. The protected adapter in `scripts/linear-canary-delivery.py`:

1. runs live only from the protected `linear-canary-incidents` GitHub Environment;
2. stores the credential outside Git and fork pull requests;
3. searches by the exact incident signature before creating anything;
4. applies reducer actions idempotently;
5. retains structured run and artifact links without copying arbitrary logs;
6. persists a versioned state marker in the Linear description; and
7. fails closed on duplicate signatures or damaged state markers.

`operations/canary-workflows.v1.json` inventories the four covered schedules. See [`CANARY_LINEAR_DELIVERY.md`](CANARY_LINEAR_DELIVERY.md) for enablement, dry-run, controlled recovery drill, manual fallback, and credential rotation.

Fork pull requests and arbitrary branch code never receive the delivery credential. The hourly job is additionally disabled until the explicit repository variable `LINEAR_CANARY_DELIVERY_ENABLED=true` is set.

## Covered regressions

The normalization categories explicitly prioritize:

- ASan, LSan, UBSan, use-after-free, and buffer-overflow reports;
- credential/token leakage indicators;
- protocol or schema mismatches;
- migration and core-parity failures; and
- frozen-install or lockfile mismatches.

The state-engine suite proves deduplication, material-signature separation, scheduled-only recovery, stable missed-run detection, and non-scheduled evidence behavior. The adapter suite adds exact Linear signature queries, duplicate/damaged-state fail-closed behavior, GitHub job/step extraction, all four workflow schedules, and a controlled create/update/manual-evidence/recovery drill.
