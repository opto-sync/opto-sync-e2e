#!/usr/bin/env python3
"""Deterministic canary incident normalization and recovery state reducer."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timedelta, timezone
from typing import Any

SHA_RE = re.compile(r"\b[0-9a-f]{40,64}\b", re.IGNORECASE)
UUID_RE = re.compile(
    r"\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b",
    re.IGNORECASE,
)
TIMESTAMP_RE = re.compile(
    r"\b\d{4}-\d{2}-\d{2}[T ][0-9:.+-]+Z?\b", re.IGNORECASE
)
ADDRESS_RE = re.compile(r"\b0x[0-9a-f]+\b", re.IGNORECASE)
RUN_NUMBER_RE = re.compile(
    r"\b(?:run|job|attempt|pid|process)\s*[#:=]?\s*\d+\b", re.IGNORECASE
)
SPACE_RE = re.compile(r"\s+")

SECURITY_TERMS = (
    "addresssanitizer",
    "leaksanitizer",
    "undefinedbehaviorsanitizer",
    "heap-use-after-free",
    "stack-buffer-overflow",
    "security",
    "credential",
    "token leak",
)
COMPATIBILITY_TERMS = (
    "compatibility",
    "protocol mismatch",
    "schema mismatch",
    "migration",
    "frozen install",
    "lockfile mismatch",
    "core parity",
)
MISSED_SCHEDULE_MARKER = "scheduled workflow did not run by"


def fail(message: str) -> None:
    print(f"canary-incident: {message}", file=sys.stderr)
    raise SystemExit(1)


def parse_time(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (TypeError, ValueError) as exc:
        fail(f"invalid ISO-8601 timestamp {value!r}: {exc}")
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def load_stdin() -> dict[str, Any]:
    try:
        value = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        fail(f"invalid JSON input: {exc}")
    if not isinstance(value, dict):
        fail("input must be a JSON object")
    return value


def dump(value: dict[str, Any]) -> None:
    json.dump(value, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")


def normalize_error(value: str) -> str:
    text = value.strip().lower()
    text = SHA_RE.sub("<sha>", text)
    text = UUID_RE.sub("<uuid>", text)
    text = TIMESTAMP_RE.sub("<timestamp>", text)
    text = ADDRESS_RE.sub("<address>", text)
    text = RUN_NUMBER_RE.sub("<run>", text)
    text = SPACE_RE.sub(" ", text)
    return text[:320]


def require_text(event: dict[str, Any], key: str) -> str:
    value = event.get(key)
    if not isinstance(value, str) or not value.strip():
        fail(f"event.{key} must be a non-empty string")
    return value.strip()


def error_category(normalized_error: str) -> str:
    # The deadline and minutes-late count necessarily change every time the
    # monitor checks one missed schedule. Collapse that volatile detail into one
    # stable material category so an outage updates one Linear incident rather
    # than opening another issue every hour.
    if MISSED_SCHEDULE_MARKER in normalized_error:
        return "availability:missed-schedule"
    for term in SECURITY_TERMS:
        if term in normalized_error:
            return f"security:{term}"
    for term in COMPATIBILITY_TERMS:
        if term in normalized_error:
            return f"compatibility:{term}"
    return normalized_error or "<no-error>"


def priority_for(normalized_error: str, kind: str) -> str:
    category = error_category(normalized_error)
    if category.startswith("security:"):
        return "urgent"
    if category.startswith("compatibility:"):
        return "high"
    if kind in {"missed", "failure"}:
        return "high"
    return "medium"


def signature_for(event: dict[str, Any], normalized_error: str) -> str:
    parts = [
        require_text(event, "repository"),
        require_text(event, "workflow"),
        str(event.get("job") or "<workflow>"),
        str(event.get("step") or "<unknown-step>"),
        error_category(normalized_error),
    ]
    material = "\n".join(part.strip().lower() for part in parts)
    return hashlib.sha256(material.encode("utf-8")).hexdigest()[:24]


def classify(event: dict[str, Any]) -> dict[str, Any]:
    event_name = require_text(event, "event")
    allowed_events = {"schedule", "workflow_dispatch", "pull_request", "push", "missed"}
    if event_name not in allowed_events:
        fail(f"unsupported event type: {event_name}")

    conclusion = str(event.get("conclusion") or "").lower()
    if event_name == "missed":
        kind = "missed"
    elif conclusion == "success":
        kind = "success"
    elif conclusion in {"failure", "timed_out", "cancelled", "action_required"}:
        kind = "failure"
    else:
        fail(f"unsupported or incomplete conclusion: {conclusion!r}")

    error = normalize_error(str(event.get("error") or ""))
    signature = signature_for(event, error if kind != "success" else "scheduled success")
    repository = require_text(event, "repository")
    workflow = require_text(event, "workflow")
    run_id = event.get("runId")
    if run_id is not None and (not isinstance(run_id, int) or run_id < 1):
        fail("event.runId must be a positive integer when provided")

    priority = priority_for(error, kind)
    title_prefix = {
        "failure": "Canary failure",
        "missed": "Canary missed",
        "success": "Canary recovery evidence",
    }[kind]
    title = f"[opto-sync] {title_prefix}: {repository} / {workflow}"
    body_lines = [
        f"Incident signature: `{signature}`",
        f"Repository: `{repository}`",
        f"Workflow: `{workflow}`",
        f"Trigger: `{event_name}`",
        f"Conclusion: `{conclusion or kind}`",
    ]
    for key, label in (
        ("job", "Job"),
        ("step", "Step"),
        ("headSha", "Source SHA"),
        ("runUrl", "Run"),
    ):
        value = event.get(key)
        if value:
            body_lines.append(
                f"{label}: {value}" if key == "runUrl" else f"{label}: `{value}`"
            )
    if error:
        body_lines.extend(
            ["", "Normalized first actionable error:", f"```text\n{error}\n```"]
        )
    artifacts = event.get("artifactUrls") or []
    if artifacts:
        body_lines.append("")
        body_lines.append("Artifacts:")
        body_lines.extend(f"- {url}" for url in artifacts)

    return {
        "schemaVersion": 1,
        "kind": kind,
        "signature": signature,
        "repository": repository,
        "workflow": workflow,
        "event": event_name,
        "runId": run_id,
        "runUrl": event.get("runUrl"),
        "headSha": event.get("headSha"),
        "occurredAt": event.get("completedAt") or event.get("startedAt"),
        "priority": priority,
        "normalizedError": error,
        "linear": {
            "title": title,
            "body": "\n".join(body_lines),
            "labels": ["Canary", kind.capitalize()],
            "project": "github.com/opto-sync",
        },
    }


def reduce_state(payload: dict[str, Any]) -> dict[str, Any]:
    event_raw = payload.get("event")
    if not isinstance(event_raw, dict):
        fail("reduce input requires an event object")
    incident = payload.get("incident")
    if incident is not None and not isinstance(incident, dict):
        fail("incident must be null or an object")
    event = classify(event_raw)
    scheduled = event["event"] in {"schedule", "missed"}

    if event["kind"] == "success":
        if incident is None:
            action = "ignore_success_without_open_incident"
            next_incident = None
        elif event["event"] != "schedule":
            action = "record_manual_success_evidence"
            next_incident = dict(incident)
            next_incident["lastEvidenceRunId"] = event["runId"]
        elif incident.get("state") != "open":
            action = "ignore_success_for_non_open_incident"
            next_incident = dict(incident)
        else:
            action = "recover"
            next_incident = dict(incident)
            next_incident.update(
                {
                    "state": "recovered",
                    "recoveredAt": event["occurredAt"],
                    "recoveryRunId": event["runId"],
                    "recoveryRunUrl": event["runUrl"],
                }
            )
        return {"action": action, "event": event, "incident": next_incident}

    if not scheduled:
        return {
            "action": "record_non_scheduled_failure_evidence",
            "event": event,
            "incident": incident,
        }

    if incident is None or incident.get("signature") != event["signature"]:
        action = "create"
        next_incident = {
            "signature": event["signature"],
            "state": "open",
            "occurrences": 1,
            "firstSeenAt": event["occurredAt"],
            "lastSeenAt": event["occurredAt"],
            "lastRunId": event["runId"],
            "lastRunUrl": event["runUrl"],
            "priority": event["priority"],
        }
    elif incident.get("state") == "open":
        action = "update"
        next_incident = dict(incident)
        next_incident.update(
            {
                "occurrences": int(incident.get("occurrences", 0)) + 1,
                "lastSeenAt": event["occurredAt"],
                "lastRunId": event["runId"],
                "lastRunUrl": event["runUrl"],
                "priority": event["priority"],
            }
        )
    else:
        action = "reopen"
        next_incident = dict(incident)
        next_incident.update(
            {
                "state": "open",
                "occurrences": int(incident.get("occurrences", 0)) + 1,
                "lastSeenAt": event["occurredAt"],
                "lastRunId": event["runId"],
                "lastRunUrl": event["runUrl"],
                "priority": event["priority"],
                "recoveredAt": None,
                "recoveryRunId": None,
                "recoveryRunUrl": None,
            }
        )

    return {"action": action, "event": event, "incident": next_incident}


def detect_missed(payload: dict[str, Any]) -> dict[str, Any]:
    now = parse_time(require_text(payload, "now"))
    last = parse_time(require_text(payload, "lastScheduledRunAt"))
    interval = payload.get("intervalMinutes")
    grace = payload.get("graceMinutes", 0)
    if not isinstance(interval, int) or interval < 1:
        fail("intervalMinutes must be a positive integer")
    if not isinstance(grace, int) or grace < 0:
        fail("graceMinutes must be a non-negative integer")
    deadline = last + timedelta(minutes=interval + grace)
    missed = now > deadline
    result: dict[str, Any] = {
        "missed": missed,
        "deadline": deadline.isoformat().replace("+00:00", "Z"),
        "minutesLate": max(0, int((now - deadline).total_seconds() // 60)),
    }
    if missed:
        result["event"] = {
            "repository": require_text(payload, "repository"),
            "workflow": require_text(payload, "workflow"),
            "event": "missed",
            "conclusion": "missed",
            "startedAt": last.isoformat().replace("+00:00", "Z"),
            "completedAt": now.isoformat().replace("+00:00", "Z"),
            "job": "<workflow>",
            "step": "scheduled-run-presence",
            "error": (
                f"scheduled workflow did not run by {result['deadline']}; "
                f"{result['minutesLate']} minutes late"
            ),
        }
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("classify", "reduce", "detect-missed"))
    args = parser.parse_args()
    payload = load_stdin()
    if args.command == "classify":
        dump(classify(payload))
    elif args.command == "reduce":
        dump(reduce_state(payload))
    else:
        dump(detect_missed(payload))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
