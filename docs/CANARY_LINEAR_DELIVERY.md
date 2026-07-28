# Protected Linear delivery for scheduled opto-sync canaries

`canary-incident.py` is the credential-free normalization and state engine.
`linear-canary-delivery.py` is the trusted edge that observes GitHub's scheduled
workflow results and applies those deterministic actions to the
`github.com/opto-sync` Linear project.

The separation is deliberate:

- pull requests can test classification, deduplication, recovery, missed-run
  detection, GitHub response parsing, and mutation planning with no credentials;
- only a protected default-branch workflow may receive the Linear credential;
- the adapter never copies arbitrary job logs into Linear;
- GitHub run and retained-artifact links are preserved instead.

## Monitored workflows

`operations/canary-workflows.v1.json` is the reviewed inventory.

| Repository | Workflow | Schedule | Material failure category |
|---|---|---:|---|
| `opto-sync/syncer.c` | `Fuzz and leak canary` | nightly | sanitizer/security |
| `opto-sync/opto-sync-clients` | `Upstream engine main canary` | nightly | compatibility/core parity |
| `opto-sync/opto-sync-e2e` | `E2E (docker)` | weekly | protocol/storage compatibility |
| `opto-sync/opto-sync-e2e` | `E2E (client-in-the-loop)` | weekly | cross-client compatibility |

Each entry declares its expected interval, grace window, first monitoring time,
and a reviewed fallback failure summary. The monitor fetches the failed job and
step from GitHub's structured Actions API. It intentionally does not download
and republish arbitrary logs, because environment values and third-party output
may contain secrets or personal data.

A completed run is keyed by its GitHub run ID, so hourly monitor passes do not
increment the same failure repeatedly. A missed schedule has no run ID; repeated
checks use one stable `availability:missed-schedule` signature and update the
same issue as its lateness grows.

## Linear issue state

The adapter searches the project by the exact line:

```text
Incident signature: `<24-hex-signature>`
```

One machine-readable marker is appended to the issue description:

```text
<!-- opto-sync-canary-state:v1
{"signature":"...","state":"open",...}
-->
```

That state records occurrences, last delivered run, recovery evidence, and
priority. It contains no credential or log body. If more than one issue carries
one signature, or a matching issue has a missing/corrupt marker, delivery fails
closed instead of guessing and creating more duplicates.

Actions map as follows:

- `create`: create one assigned issue in `In Progress`;
- `update`: update the same issue and add occurrence evidence;
- `reopen`: return a recovered issue to `In Progress`;
- `record_manual_success_evidence`: comment and retain the open state;
- `recover`: only a later scheduled success moves the issue to `Done`.

A materially different normalized job, step, or error category receives a
different signature and therefore a separate incident.

## Protected GitHub configuration

Create a GitHub Environment named:

```text
linear-canary-incidents
```

Protect it so untrusted branches and fork pull requests cannot deploy through it.
Add one environment secret:

```text
LINEAR_API_KEY
```

The token must have access to the Denman team and `github.com/opto-sync`
project. A personal Linear API key is sent as the raw `Authorization` header; an
OAuth access token uses `Bearer`. The current workflow expects the personal-key
form. Rotate or disable the credential in the environment—never in source,
workflow inputs, logs, artifacts, or Linear issue text.

Optional organization/repository secret:

```text
OPTO_SYNC_CANARY_GITHUB_TOKEN
```

The default `GITHUB_TOKEN` is sufficient while all monitored repositories and
their Actions metadata are public. Use a least-privilege organization token only
if repository visibility changes. It needs read-only Actions/metadata access.

After the environment has been reviewed, set the repository variable:

```text
LINEAR_CANARY_DELIVERY_ENABLED=true
```

Without that exact opt-in, hourly scheduled workflow invocations perform no
contract or delivery job. Pull requests still run the credential-free tests.

## Commands

Validate the inventory:

```sh
python3 scripts/linear-canary-delivery.py validate-config
```

Inspect current GitHub scheduled-run state without a Linear credential:

```sh
python3 scripts/linear-canary-delivery.py dry-run
```

Deliver current scheduled outcomes:

```sh
LINEAR_API_KEY=... python3 scripts/linear-canary-delivery.py deliver
```

Apply one reviewed raw event from stdin:

```sh
LINEAR_API_KEY=... \
  python3 scripts/linear-canary-delivery.py apply < event.json
```

Never paste a credential into shell history on a shared machine. The examples
show the required interface, not the recommended secret-injection mechanism.

## Controlled recovery drill

Manually dispatch `Canary Linear delivery` with
`mode=controlled-drill`. The job runs inside the protected environment and
submits four synthetic outcomes through the same live adapter:

1. scheduled failure;
2. identical scheduled failure with a different run ID;
3. manual green evidence;
4. scheduled green recovery.

The expected sequence is:

```text
create (or reopen on a later drill)
update
record_manual_success_evidence
recover
```

The result must be one Linear incident with two added failure occurrences,
manual evidence that did not close it, and a final `Done` state after scheduled
recovery. The drill is synthetic delivery evidence; it does not replace proof
that the real nightly and weekly cron jobs are running.

## Manual fallback

When automated delivery is disabled:

1. run `dry-run` from a trusted checkout;
2. identify the affected repository, workflow, run URL, job, step, and normalized
   signature;
3. search Linear for the exact incident signature;
4. create or update one issue using the rendered body;
5. preserve the state marker and occurrence count;
6. do not mark recovery from a manually triggered green run;
7. re-enable automation only after the credential and environment protections
   have been reviewed.

If a state marker is damaged, repair that one issue deliberately. Do not delete
it or let the automation create a replacement.

## Credential rotation and disable procedure

1. Set `LINEAR_CANARY_DELIVERY_ENABLED=false`.
2. Verify the scheduled workflow has no live-delivery job.
3. Replace or revoke `LINEAR_API_KEY` in the protected environment.
4. Manually dispatch `dry-run`; it must work without a Linear credential.
5. Manually dispatch `controlled-drill` after the replacement is approved.
6. Re-enable the repository variable only after the drill recovers correctly.

The adapter checks GraphQL `errors` even when Linear returns HTTP 200, retries
bounded 429/5xx responses, and never includes request headers or request bodies
in transport errors.
