"""Read-only GitHub Actions monitor for the opto-sync canary inventory."""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable

from canary_delivery_common import INCIDENT, fail
from canary_delivery_linear import DryRunLinear, LinearGraphQL, apply_event

GITHUB_ENDPOINT = "https://api.github.com"


class GitHubAPI:
    def __init__(
        self,
        token: str | None = None,
        endpoint: str = GITHUB_ENDPOINT,
        get_json: Callable[[str], dict[str, Any]] | None = None,
    ) -> None:
        self.token = token or ""
        self.endpoint = endpoint.rstrip("/")
        self._get_json_override = get_json

    def get_json(self, path: str) -> dict[str, Any]:
        if self._get_json_override is not None:
            return self._get_json_override(path)
        request = urllib.request.Request(
            f"{self.endpoint}{path}",
            headers={
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "opto-sync-canary-delivery/1",
                **(
                    {"Authorization": f"Bearer {self.token}"}
                    if self.token
                    else {}
                ),
            },
        )
        for attempt in range(4):
            try:
                with urllib.request.urlopen(request, timeout=25) as response:
                    value = json.loads(response.read())
                if not isinstance(value, dict):
                    fail("GitHub returned a non-object JSON response")
                return value
            except urllib.error.HTTPError as exc:
                if (exc.code == 429 or exc.code >= 500) and attempt < 3:
                    time.sleep(2**attempt)
                    continue
                fail(f"GitHub API request failed with status {exc.code}: {path}")
            except (urllib.error.URLError, TimeoutError) as exc:
                if attempt < 3:
                    time.sleep(2**attempt)
                    continue
                fail(
                    "GitHub API request failed after retries: "
                    f"{type(exc).__name__}"
                )
            except json.JSONDecodeError:
                fail("GitHub returned invalid JSON")
        fail("GitHub API request failed")

    def latest_scheduled_run(
        self, entry: dict[str, Any]
    ) -> dict[str, Any] | None:
        repository = urllib.parse.quote(entry["repository"], safe="/")
        workflow = urllib.parse.quote(entry["workflowFile"], safe="")
        payload = self.get_json(
            f"/repos/{repository}/actions/workflows/{workflow}/runs"
            "?event=schedule&branch=main&per_page=2"
        )
        runs = payload.get("workflow_runs") or []
        if not isinstance(runs, list):
            fail("GitHub workflow runs response is malformed")
        return runs[0] if runs else None

    def failure_location(
        self, entry: dict[str, Any], run: dict[str, Any]
    ) -> tuple[str, str]:
        run_id = run.get("id")
        if not isinstance(run_id, int):
            return ("<workflow>", "<unknown-step>")
        repository = urllib.parse.quote(entry["repository"], safe="/")
        payload = self.get_json(
            f"/repos/{repository}/actions/runs/{run_id}/jobs"
            "?filter=latest&per_page=100"
        )
        jobs = payload.get("jobs") or []
        if not isinstance(jobs, list):
            return ("<workflow>", "<unknown-step>")
        failing = next(
            (
                job
                for job in jobs
                if str(job.get("conclusion") or "").lower()
                in {"failure", "timed_out", "cancelled", "action_required"}
            ),
            None,
        )
        if not isinstance(failing, dict):
            return ("<workflow>", "<unknown-step>")
        steps = failing.get("steps") or []
        failed_step = next(
            (
                step
                for step in steps
                if str(step.get("conclusion") or "").lower()
                in {"failure", "timed_out", "cancelled", "action_required"}
            ),
            None,
        )
        return (
            str(failing.get("name") or "<workflow>"),
            str((failed_step or {}).get("name") or "<unknown-step>"),
        )

    def artifact_urls(
        self, entry: dict[str, Any], run: dict[str, Any]
    ) -> list[str]:
        run_id = run.get("id")
        run_url = str(run.get("html_url") or "")
        if not isinstance(run_id, int) or not run_url:
            return []
        repository = urllib.parse.quote(entry["repository"], safe="/")
        payload = self.get_json(
            f"/repos/{repository}/actions/runs/{run_id}/artifacts?per_page=100"
        )
        if int(payload.get("total_count") or 0) < 1:
            return []
        return [f"{run_url}#artifacts"]


def run_timestamp(run: dict[str, Any]) -> str:
    for key in ("updated_at", "run_started_at", "created_at"):
        value = run.get(key)
        if isinstance(value, str) and value:
            return value
    fail("GitHub workflow run has no timestamp")


def collect_event(
    github: GitHubAPI,
    entry: dict[str, Any],
    now: str,
) -> dict[str, Any] | None:
    run = github.latest_scheduled_run(entry)
    last_scheduled = (
        run_timestamp(run) if run is not None else entry["monitorSince"]
    )
    missed = INCIDENT.detect_missed(
        {
            "repository": entry["repository"],
            "workflow": entry["workflowName"],
            "now": now,
            "lastScheduledRunAt": last_scheduled,
            "intervalMinutes": entry["intervalMinutes"],
            "graceMinutes": entry["graceMinutes"],
        }
    )
    if missed["missed"]:
        return missed["event"]
    if run is None or str(run.get("status") or "").lower() != "completed":
        return None
    conclusion = str(run.get("conclusion") or "").lower()
    if conclusion not in {
        "success",
        "failure",
        "timed_out",
        "cancelled",
        "action_required",
    }:
        return None

    job = "<workflow>"
    step = "<workflow-complete>"
    error = ""
    artifacts: list[str] = []
    if conclusion != "success":
        job, step = github.failure_location(entry, run)
        error = entry["failureSummary"]
        artifacts = github.artifact_urls(entry, run)
    run_id = run.get("id")
    if not isinstance(run_id, int):
        fail("GitHub workflow run id must be an integer")
    return {
        "repository": entry["repository"],
        "workflow": entry["workflowName"],
        "event": "schedule",
        "conclusion": conclusion,
        "runId": run_id,
        "runUrl": run.get("html_url"),
        "headSha": run.get("head_sha"),
        "startedAt": run.get("run_started_at") or run.get("created_at"),
        "completedAt": run.get("updated_at"),
        "job": job,
        "step": step,
        "error": error,
        "artifactUrls": artifacts,
    }


def monitor(
    config: dict[str, Any],
    github: GitHubAPI,
    linear: LinearGraphQL | DryRunLinear,
    now: str,
    dry_run: bool,
) -> dict[str, Any]:
    results: list[dict[str, Any]] = []
    for entry in config["workflows"]:
        event = collect_event(github, entry, now)
        if event is None:
            results.append(
                {
                    "repository": entry["repository"],
                    "workflow": entry["workflowName"],
                    "action": "no_completed_or_overdue_scheduled_run",
                }
            )
            continue
        applied = apply_event(linear, event, config, dry_run=dry_run)
        results.append(
            {
                "repository": entry["repository"],
                "workflow": entry["workflowName"],
                "runId": event.get("runId"),
                "event": event["event"],
                "conclusion": event["conclusion"],
                "actions": applied,
            }
        )
    return {
        "schemaVersion": 1,
        "checkedAt": now,
        "dryRun": dry_run,
        "results": results,
    }
