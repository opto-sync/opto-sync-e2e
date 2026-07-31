"""Linear GraphQL transport and idempotent canary issue mutations."""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from typing import Any, Callable

from canary_delivery_common import (
    INCIDENT,
    LinearIssue,
    append_state_marker,
    fail,
    parse_state_marker,
    priority_value,
    rendered_description,
    strip_state_marker,
)

LINEAR_ENDPOINT = "https://api.linear.app/graphql"
Transport = Callable[[str, dict[str, Any]], dict[str, Any]]


class LinearGraphQL:
    def __init__(
        self,
        api_key: str,
        endpoint: str = LINEAR_ENDPOINT,
        transport: Transport | None = None,
    ) -> None:
        if not api_key:
            fail("LINEAR_API_KEY is required for live delivery")
        self.api_key = api_key
        self.endpoint = endpoint
        self.transport = transport

    def graphql(self, query: str, variables: dict[str, Any]) -> dict[str, Any]:
        payload = (
            self.transport(query, variables)
            if self.transport is not None
            else self._http_graphql(query, variables)
        )
        errors = payload.get("errors")
        if errors:
            messages = "; ".join(
                str(item.get("message") or "unknown GraphQL error")
                for item in errors
                if isinstance(item, dict)
            )
            fail(f"Linear GraphQL error: {messages or 'unknown error'}")
        data = payload.get("data")
        if not isinstance(data, dict):
            fail("Linear GraphQL response has no data object")
        return data

    def _http_graphql(
        self, query: str, variables: dict[str, Any]
    ) -> dict[str, Any]:
        request = urllib.request.Request(
            self.endpoint,
            data=json.dumps(
                {"query": query, "variables": variables},
                separators=(",", ":"),
            ).encode("utf-8"),
            method="POST",
            headers={
                "Authorization": self.api_key,
                "Content-Type": "application/json",
                "User-Agent": "opto-sync-canary-delivery/1",
            },
        )
        for attempt in range(4):
            try:
                with urllib.request.urlopen(request, timeout=25) as response:
                    value = json.loads(response.read())
                if not isinstance(value, dict):
                    fail("Linear returned a non-object JSON response")
                return value
            except urllib.error.HTTPError as exc:
                if (exc.code == 429 or exc.code >= 500) and attempt < 3:
                    retry_after = exc.headers.get("Retry-After")
                    delay = (
                        int(retry_after)
                        if retry_after and retry_after.isdigit()
                        else 2**attempt
                    )
                    time.sleep(min(delay, 15))
                    continue
                # Request headers and bodies may contain credentials and incident
                # content, so transport failures report status only.
                fail(f"Linear HTTP request failed with status {exc.code}")
            except (urllib.error.URLError, TimeoutError) as exc:
                if attempt < 3:
                    time.sleep(2**attempt)
                    continue
                fail(f"Linear request failed after retries: {type(exc).__name__}")
            except json.JSONDecodeError:
                fail("Linear returned invalid JSON")
        fail("Linear request failed")

    def find_by_signature(
        self, project_id: str, signature: str
    ) -> list[LinearIssue]:
        data = self.graphql(
            """
            query FindCanarySignature($projectId: String!, $needle: String!) {
              issues(
                first: 20
                filter: {
                  project: { id: { eq: $projectId } }
                  description: { contains: $needle }
                }
              ) {
                nodes {
                  id identifier title description priority url
                  state { id name type }
                }
              }
            }
            """,
            {
                "projectId": project_id,
                "needle": f"Incident signature: `{signature}`",
            },
        )
        nodes = ((data.get("issues") or {}).get("nodes") or [])
        return [LinearIssue.from_node(node) for node in nodes]

    def find_workflow_issues(
        self, project_id: str, repository: str, workflow: str
    ) -> list[LinearIssue]:
        data = self.graphql(
            """
            query FindCanaryWorkflow($projectId: String!, $repository: String!) {
              issues(
                first: 50
                filter: {
                  project: { id: { eq: $projectId } }
                  description: { contains: $repository }
                }
              ) {
                nodes {
                  id identifier title description priority url
                  state { id name type }
                }
              }
            }
            """,
            {
                "projectId": project_id,
                "repository": f"Repository: `{repository}`",
            },
        )
        nodes = ((data.get("issues") or {}).get("nodes") or [])
        exact_workflow = f"Workflow: `{workflow}`"
        return [
            LinearIssue.from_node(node)
            for node in nodes
            if exact_workflow in str(node.get("description") or "")
        ]

    def create_issue(self, input_value: dict[str, Any]) -> LinearIssue:
        data = self.graphql(
            """
            mutation CreateCanaryIssue($input: IssueCreateInput!) {
              issueCreate(input: $input) {
                success
                issue {
                  id identifier title description priority url
                  state { id name type }
                }
              }
            }
            """,
            {"input": input_value},
        )
        result = data.get("issueCreate") or {}
        if result.get("success") is not True or not isinstance(
            result.get("issue"), dict
        ):
            fail("Linear issueCreate did not succeed")
        return LinearIssue.from_node(result["issue"])

    def update_issue(
        self, issue_id: str, input_value: dict[str, Any]
    ) -> LinearIssue:
        data = self.graphql(
            """
            mutation UpdateCanaryIssue(
              $id: String!
              $input: IssueUpdateInput!
            ) {
              issueUpdate(id: $id, input: $input) {
                success
                issue {
                  id identifier title description priority url
                  state { id name type }
                }
              }
            }
            """,
            {"id": issue_id, "input": input_value},
        )
        result = data.get("issueUpdate") or {}
        if result.get("success") is not True or not isinstance(
            result.get("issue"), dict
        ):
            fail("Linear issueUpdate did not succeed")
        return LinearIssue.from_node(result["issue"])

    def create_comment(self, issue_id: str, body: str) -> None:
        data = self.graphql(
            """
            mutation CommentOnCanaryIssue($input: CommentCreateInput!) {
              commentCreate(input: $input) {
                success
                comment { id }
              }
            }
            """,
            {"input": {"issueId": issue_id, "body": body}},
        )
        if (data.get("commentCreate") or {}).get("success") is not True:
            fail("Linear commentCreate did not succeed")


class DryRunLinear(LinearGraphQL):
    def __init__(self) -> None:
        self.api_key = "<dry-run>"
        self.endpoint = "<dry-run>"
        self.transport = None

    def find_by_signature(
        self, project_id: str, signature: str
    ) -> list[LinearIssue]:
        return []

    def find_workflow_issues(
        self, project_id: str, repository: str, workflow: str
    ) -> list[LinearIssue]:
        return []

    def create_issue(self, input_value: dict[str, Any]) -> LinearIssue:
        raise AssertionError("dry run may not create issues")

    def update_issue(
        self, issue_id: str, input_value: dict[str, Any]
    ) -> LinearIssue:
        raise AssertionError("dry run may not update issues")

    def create_comment(self, issue_id: str, body: str) -> None:
        raise AssertionError("dry run may not create comments")


def issue_state(issue: LinearIssue | None) -> dict[str, Any] | None:
    return parse_state_marker(issue.description) if issue else None


def action_comment(
    action: str, event: dict[str, Any], state: dict[str, Any]
) -> str:
    occurrence = state.get("occurrences")
    suffix = (
        f"\n\nRecorded occurrences: **{occurrence}**." if occurrence else ""
    )
    return (
        f"Canary delivery action: **{action}**.\n\n"
        f"{event['linear']['body']}{suffix}"
    )


def apply_event(
    linear: LinearGraphQL,
    raw_event: dict[str, Any],
    config: dict[str, Any],
    dry_run: bool = False,
) -> list[dict[str, Any]]:
    linear_config = config["linear"]
    classified = INCIDENT.classify(raw_event)
    results: list[dict[str, Any]] = []

    if classified["kind"] == "success":
        issues = linear.find_workflow_issues(
            linear_config["projectId"],
            classified["repository"],
            classified["workflow"],
        )
        for issue in issues:
            current = issue_state(issue)
            if current is None or current.get("state") != "open":
                continue
            if current.get("recoveryRunId") == classified["runId"]:
                continue
            reduced = INCIDENT.reduce_state(
                {"incident": current, "event": raw_event}
            )
            action = reduced["action"]
            next_state = reduced["incident"]
            if not isinstance(next_state, dict):
                continue
            results.append(
                {
                    "action": action,
                    "issue": issue.identifier,
                    "signature": current["signature"],
                }
            )
            if dry_run:
                continue
            if action == "recover":
                description = append_state_marker(
                    strip_state_marker(issue.description)
                    + "\n\n## Scheduled recovery\n\n"
                    + classified["linear"]["body"],
                    next_state,
                )
                linear.update_issue(
                    issue.id,
                    {
                        "description": description,
                        "stateId": linear_config["recoveredStateId"],
                    },
                )
                linear.create_comment(
                    issue.id, action_comment(action, classified, next_state)
                )
            elif action == "record_manual_success_evidence":
                linear.update_issue(
                    issue.id,
                    {
                        "description": append_state_marker(
                            strip_state_marker(issue.description), next_state
                        )
                    },
                )
                linear.create_comment(
                    issue.id, action_comment(action, classified, next_state)
                )
        return results

    matches = linear.find_by_signature(
        linear_config["projectId"], classified["signature"]
    )
    if len(matches) > 1:
        fail(
            "multiple Linear issues contain the same incident signature; "
            "refusing to guess which record is authoritative"
        )
    issue = matches[0] if matches else None
    current = issue_state(issue)
    if issue is not None and current is None:
        fail(
            "matching Linear issue is missing a valid opto-sync canary state "
            "marker; repair it manually before delivery resumes"
        )
    if (
        current is not None
        and classified["runId"] is not None
        and current.get("lastRunId") == classified["runId"]
    ):
        return [
            {
                "action": "no_op_already_delivered",
                "issue": issue.identifier,
                "signature": classified["signature"],
            }
        ]

    reduced = INCIDENT.reduce_state(
        {"incident": current, "event": raw_event}
    )
    action = reduced["action"]
    next_state = reduced["incident"]
    if not isinstance(next_state, dict):
        return []
    results.append(
        {
            "action": action,
            "issue": issue.identifier if issue else None,
            "signature": classified["signature"],
        }
    )
    if dry_run:
        return results

    description = rendered_description(classified, next_state, config)
    if action == "create":
        created = linear.create_issue(
            {
                "teamId": linear_config["teamId"],
                "projectId": linear_config["projectId"],
                "assigneeId": linear_config["assigneeId"],
                "stateId": linear_config["openStateId"],
                "priority": priority_value(classified["priority"]),
                "title": classified["linear"]["title"],
                "description": description,
            }
        )
        results[-1]["issue"] = created.identifier
    elif issue is not None and action in {"update", "reopen"}:
        linear.update_issue(
            issue.id,
            {
                "description": description,
                "stateId": linear_config["openStateId"],
                "priority": priority_value(classified["priority"]),
            },
        )
        linear.create_comment(
            issue.id, action_comment(action, classified, next_state)
        )
    return results


def controlled_drill(
    linear: LinearGraphQL,
    config: dict[str, Any],
    *,
    run_id: int,
    run_url: str,
    head_sha: str,
    occurred_at: str,
) -> dict[str, Any]:
    """Exercise create/update/manual-evidence/recovery through the live adapter."""

    if run_id < 1:
        fail("controlled drill run id must be positive")
    repository = "opto-sync/opto-sync-e2e"
    workflow = "Canary delivery controlled drill"
    base = run_id * 10

    def drill_event(
        sequence: int,
        *,
        conclusion: str,
        trigger: str,
        error: str = "",
    ) -> dict[str, Any]:
        return {
            "repository": repository,
            "workflow": workflow,
            "event": trigger,
            "conclusion": conclusion,
            "runId": base + sequence,
            "runUrl": f"{run_url}#canary-delivery-drill-{sequence}",
            "headSha": head_sha,
            "startedAt": occurred_at,
            "completedAt": occurred_at,
            "job": "controlled-drill",
            "step": "synthetic canary outcome",
            "error": error,
            "artifactUrls": [],
        }

    events = [
        drill_event(
            1,
            conclusion="failure",
            trigger="schedule",
            error="protocol compatibility controlled delivery drill failed",
        ),
        drill_event(
            2,
            conclusion="failure",
            trigger="schedule",
            error="protocol compatibility controlled delivery drill failed",
        ),
        drill_event(3, conclusion="success", trigger="workflow_dispatch"),
        drill_event(4, conclusion="success", trigger="schedule"),
    ]
    actions = [
        apply_event(linear, event, config, dry_run=False) for event in events
    ]
    flattened = [item["action"] for group in actions for item in group]
    if not flattened or flattened[0] not in {"create", "reopen", "update"}:
        fail(f"controlled drill did not open/update an incident: {flattened}")
    if len(flattened) != 4 or flattened[1:] != [
        "update",
        "record_manual_success_evidence",
        "recover",
    ]:
        fail(f"controlled drill violated the recovery contract: {flattened}")
    return {
        "schemaVersion": 1,
        "repository": repository,
        "workflow": workflow,
        "actions": actions,
        "verified": {
            "singleSignatureRepeatedFailure": True,
            "manualSuccessDidNotRecover": True,
            "scheduledSuccessRecovered": True,
        },
    }
