from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

import canary_delivery_common as common
import canary_delivery_github as github_delivery
import canary_delivery_linear as linear_delivery

CONFIG = json.loads((ROOT / "operations/canary-workflows.v1.json").read_text())


class FakeLinear:
    def __init__(self) -> None:
        self.issues: list[common.LinearIssue] = []
        self.comments: list[tuple[str, str]] = []
        self.next_id = 1

    def find_by_signature(self, project_id: str, signature: str):
        needle = f"Incident signature: `{signature}`"
        return [issue for issue in self.issues if needle in issue.description]

    def find_workflow_issues(
        self, project_id: str, repository: str, workflow: str
    ):
        return [
            issue
            for issue in self.issues
            if f"Repository: `{repository}`" in issue.description
            and f"Workflow: `{workflow}`" in issue.description
        ]

    def create_issue(self, value):
        issue = common.LinearIssue(
            id=str(self.next_id),
            identifier=f"DEN-C{self.next_id}",
            title=value["title"],
            description=value["description"],
            priority=value["priority"],
            state_type="started",
            url=f"https://linear.example/DEN-C{self.next_id}",
        )
        self.next_id += 1
        self.issues.append(issue)
        return issue

    def update_issue(self, issue_id: str, value):
        issue = next(issue for issue in self.issues if issue.id == issue_id)
        if "description" in value:
            issue.description = value["description"]
        if "priority" in value:
            issue.priority = value["priority"]
        if value.get("stateId") == CONFIG["linear"]["recoveredStateId"]:
            issue.state_type = "completed"
        elif value.get("stateId") == CONFIG["linear"]["openStateId"]:
            issue.state_type = "started"
        return issue

    def create_comment(self, issue_id: str, body: str):
        self.comments.append((issue_id, body))


def event(
    *,
    run_id: int | None = 1,
    conclusion: str = "failure",
    trigger: str = "schedule",
    error: str = "AddressSanitizer: heap-use-after-free",
    workflow: str = "Fuzz and leak canary",
    repository: str = "opto-sync/syncer.c",
):
    value = {
        "repository": repository,
        "workflow": workflow,
        "event": trigger,
        "conclusion": conclusion,
        "runUrl": f"https://github.com/{repository}/actions/runs/{run_id}",
        "headSha": "a" * 40,
        "startedAt": "2026-07-28T05:23:00Z",
        "completedAt": "2026-07-28T05:25:00Z",
        "job": "fuzz",
        "step": "Run all fuzzers",
        "error": "" if conclusion == "success" else error,
        "artifactUrls": [],
    }
    if run_id is not None:
        value["runId"] = run_id
    return value


class DeliveryTests(unittest.TestCase):
    def test_config_covers_exactly_four_schedules(self):
        common.validate_config(CONFIG)
        identities = {
            (entry["repository"], entry["workflowFile"])
            for entry in CONFIG["workflows"]
        }
        self.assertEqual(len(identities), 4)

    def test_marker_round_trip(self):
        state = {"signature": "abc", "state": "open", "occurrences": 1}
        rendered = common.append_state_marker("human body", state)
        self.assertEqual(common.parse_state_marker(rendered), state)
        self.assertEqual(common.strip_state_marker(rendered), "human body")

    def test_graphql_errors_are_checked_even_with_data(self):
        client = linear_delivery.LinearGraphQL(
            "test-key",
            transport=lambda _query, _variables: {
                "data": {"issues": {"nodes": []}},
                "errors": [{"message": "validation failed"}],
            },
        )
        with self.assertRaises(SystemExit):
            client.find_by_signature("project", "abc")

    def test_signature_query_is_exact_and_project_scoped(self):
        observed = {}

        def transport(query, variables):
            observed["query"] = query
            observed["variables"] = variables
            return {"data": {"issues": {"nodes": []}}}

        client = linear_delivery.LinearGraphQL("test-key", transport=transport)
        self.assertEqual(client.find_by_signature("project-id", "deadbeef"), [])
        self.assertEqual(observed["variables"]["projectId"], "project-id")
        self.assertEqual(
            observed["variables"]["needle"],
            "Incident signature: `deadbeef`",
        )
        self.assertIn("project:", observed["query"])
        self.assertIn("description:", observed["query"])

    def test_controlled_failure_repeat_and_recovery(self):
        linear = FakeLinear()
        first = linear_delivery.apply_event(
            linear, event(run_id=10), CONFIG
        )
        self.assertEqual(first[0]["action"], "create")
        self.assertEqual(len(linear.issues), 1)
        self.assertEqual(linear.issues[0].priority, 1)

        duplicate = linear_delivery.apply_event(
            linear, event(run_id=10), CONFIG
        )
        self.assertEqual(
            duplicate[0]["action"], "no_op_already_delivered"
        )

        repeated = linear_delivery.apply_event(
            linear, event(run_id=11), CONFIG
        )
        self.assertEqual(repeated[0]["action"], "update")
        self.assertEqual(
            linear_delivery.issue_state(linear.issues[0])["occurrences"],
            2,
        )

        manual = linear_delivery.apply_event(
            linear,
            event(
                run_id=12,
                conclusion="success",
                trigger="workflow_dispatch",
            ),
            CONFIG,
        )
        self.assertEqual(
            manual[0]["action"], "record_manual_success_evidence"
        )
        self.assertEqual(linear.issues[0].state_type, "started")

        scheduled = linear_delivery.apply_event(
            linear,
            event(run_id=13, conclusion="success", trigger="schedule"),
            CONFIG,
        )
        self.assertEqual(scheduled[0]["action"], "recover")
        self.assertEqual(linear.issues[0].state_type, "completed")

    def test_different_signature_creates_separate_issue(self):
        linear = FakeLinear()
        linear_delivery.apply_event(linear, event(run_id=1), CONFIG)
        linear_delivery.apply_event(
            linear,
            event(run_id=2, error="protocol compatibility mismatch"),
            CONFIG,
        )
        self.assertEqual(len(linear.issues), 2)

    def test_recovered_signature_reopens(self):
        linear = FakeLinear()
        linear_delivery.apply_event(linear, event(run_id=1), CONFIG)
        linear_delivery.apply_event(
            linear,
            event(run_id=2, conclusion="success", trigger="schedule"),
            CONFIG,
        )
        reopened = linear_delivery.apply_event(
            linear, event(run_id=3), CONFIG
        )
        self.assertEqual(reopened[0]["action"], "reopen")
        self.assertEqual(linear.issues[0].state_type, "started")

    def test_damaged_marker_and_duplicate_signature_fail_closed(self):
        linear = FakeLinear()
        classified = common.INCIDENT.classify(event(run_id=1))
        damaged = common.LinearIssue(
            id="1",
            identifier="DEN-C1",
            title="damaged",
            description=classified["linear"]["body"],
            priority=2,
            state_type="started",
            url="https://linear.example/DEN-C1",
        )
        linear.issues.append(damaged)
        with self.assertRaises(SystemExit):
            linear_delivery.apply_event(linear, event(run_id=2), CONFIG)

        linear.issues.clear()
        linear_delivery.apply_event(linear, event(run_id=3), CONFIG)
        linear.issues.append(
            common.LinearIssue(
                id="duplicate",
                identifier="DEN-CX",
                title=linear.issues[0].title,
                description=linear.issues[0].description,
                priority=linear.issues[0].priority,
                state_type="started",
                url="https://linear.example/DEN-CX",
            )
        )
        with self.assertRaises(SystemExit):
            linear_delivery.apply_event(linear, event(run_id=4), CONFIG)

    def test_repeated_missed_checks_update_one_issue(self):
        linear = FakeLinear()
        first = {
            "repository": "opto-sync/opto-sync-e2e",
            "workflow": "E2E (docker)",
            "event": "missed",
            "conclusion": "missed",
            "startedAt": "2026-07-20T04:37:00Z",
            "completedAt": "2026-07-27T12:01:00Z",
            "job": "<workflow>",
            "step": "scheduled-run-presence",
            "error": (
                "scheduled workflow did not run by "
                "2026-07-27T10:37:00Z; 84 minutes late"
            ),
        }
        later = {
            **first,
            "completedAt": "2026-07-27T15:01:00Z",
            "error": (
                "scheduled workflow did not run by "
                "2026-07-27T10:37:00Z; 264 minutes late"
            ),
        }
        linear_delivery.apply_event(linear, first, CONFIG)
        updated = linear_delivery.apply_event(linear, later, CONFIG)
        self.assertEqual(updated[0]["action"], "update")
        self.assertEqual(len(linear.issues), 1)
        self.assertEqual(
            linear_delivery.issue_state(linear.issues[0])["occurrences"],
            2,
        )

    def test_controlled_drill_runs_full_contract(self):
        linear = FakeLinear()
        result = linear_delivery.controlled_drill(
            linear,
            CONFIG,
            run_id=77,
            run_url=(
                "https://github.com/opto-sync/opto-sync-e2e/"
                "actions/runs/77"
            ),
            head_sha="d" * 40,
            occurred_at="2026-07-28T12:00:00Z",
        )
        actions = [
            item["action"] for group in result["actions"] for item in group
        ]
        self.assertEqual(
            actions,
            [
                "create",
                "update",
                "record_manual_success_evidence",
                "recover",
            ],
        )
        self.assertEqual(len(linear.issues), 1)
        self.assertEqual(linear.issues[0].state_type, "completed")

    def test_failed_job_and_step_are_structured_not_log_copied(self):
        entry = CONFIG["workflows"][0]
        run = {
            "id": 55,
            "status": "completed",
            "conclusion": "failure",
            "html_url": (
                "https://github.com/opto-sync/syncer.c/actions/runs/55"
            ),
            "head_sha": "b" * 40,
            "created_at": "2026-07-28T05:23:00Z",
            "run_started_at": "2026-07-28T05:23:00Z",
            "updated_at": "2026-07-28T05:25:00Z",
        }

        def get_json(path: str):
            if "/runs?event=schedule" in path:
                return {"workflow_runs": [run]}
            if path.endswith("/jobs?filter=latest&per_page=100"):
                return {
                    "jobs": [
                        {
                            "name": "fuzz",
                            "conclusion": "failure",
                            "steps": [
                                {
                                    "name": (
                                        "Run all fuzzers plus dedicated "
                                        "leak passes"
                                    ),
                                    "conclusion": "failure",
                                }
                            ],
                        }
                    ]
                }
            if path.endswith("/artifacts?per_page=100"):
                return {"total_count": 1, "artifacts": [{"name": "crash"}]}
            raise AssertionError(path)

        github = github_delivery.GitHubAPI(get_json=get_json)
        collected = github_delivery.collect_event(
            github, entry, now="2026-07-28T06:00:00Z"
        )
        self.assertEqual(collected["runId"], 55)
        self.assertEqual(collected["job"], "fuzz")
        self.assertEqual(
            collected["step"],
            "Run all fuzzers plus dedicated leak passes",
        )
        self.assertEqual(collected["error"], entry["failureSummary"])
        self.assertEqual(
            collected["artifactUrls"],
            [
                "https://github.com/opto-sync/syncer.c/"
                "actions/runs/55#artifacts"
            ],
        )

    def test_overdue_schedule_emits_stable_missed_event(self):
        entry = CONFIG["workflows"][2]

        def get_json(_path: str):
            return {
                "workflow_runs": [
                    {
                        "id": 40,
                        "status": "completed",
                        "conclusion": "success",
                        "html_url": (
                            "https://github.com/opto-sync/opto-sync-e2e/"
                            "actions/runs/40"
                        ),
                        "head_sha": "c" * 40,
                        "created_at": "2026-07-20T04:37:00Z",
                        "run_started_at": "2026-07-20T04:37:00Z",
                        "updated_at": "2026-07-20T06:00:00Z",
                    }
                ]
            }

        github = github_delivery.GitHubAPI(get_json=get_json)
        first = github_delivery.collect_event(
            github, entry, now="2026-07-27T12:01:00Z"
        )
        later = github_delivery.collect_event(
            github, entry, now="2026-07-27T15:01:00Z"
        )
        self.assertEqual(first["event"], "missed")
        self.assertEqual(
            common.INCIDENT.classify(first)["signature"],
            common.INCIDENT.classify(later)["signature"],
        )


if __name__ == "__main__":
    unittest.main()
