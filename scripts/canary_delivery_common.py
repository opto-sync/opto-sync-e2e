"""Shared validation and durable-state helpers for opto-sync canary delivery."""

from __future__ import annotations

import importlib.util
import json
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
INCIDENT_SCRIPT = ROOT / "scripts/canary-incident.py"
STATE_MARKER_RE = re.compile(
    r"\n*<!-- opto-sync-canary-state:v1\n(?P<json>\{.*?\})\n-->\s*$",
    re.DOTALL,
)
PRIORITY_VALUES = {"urgent": 1, "high": 2, "medium": 3, "low": 4}


def fail(message: str) -> None:
    print(f"linear-canary-delivery: {message}", file=sys.stderr)
    raise SystemExit(1)


def load_incident_module() -> Any:
    spec = importlib.util.spec_from_file_location("canary_incident", INCIDENT_SCRIPT)
    if spec is None or spec.loader is None:
        fail(f"cannot load incident engine at {INCIDENT_SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


INCIDENT = load_incident_module()


def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"cannot load {path}: {exc}")
    if not isinstance(value, dict):
        fail(f"{path} must contain a JSON object")
    return value


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def require_string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        fail(f"{label} must be a non-empty string")
    return value.strip()


def validate_config(config: dict[str, Any]) -> None:
    if config.get("schemaVersion") != 1:
        fail("config.schemaVersion must be 1")
    linear = config.get("linear")
    if not isinstance(linear, dict):
        fail("config.linear must be an object")
    for key in (
        "teamId",
        "projectId",
        "assigneeId",
        "openStateId",
        "recoveredStateId",
    ):
        require_string(linear.get(key), f"config.linear.{key}")
    pair = config.get("certifiedPair")
    if not isinstance(pair, dict):
        fail("config.certifiedPair must be an object")
    for key in ("syncerSha", "clientsSha"):
        value = require_string(pair.get(key), f"config.certifiedPair.{key}")
        if not re.fullmatch(r"[0-9a-f]{40}", value):
            fail(f"config.certifiedPair.{key} must be a 40-hex commit")
    workflows = config.get("workflows")
    if not isinstance(workflows, list) or not workflows:
        fail("config.workflows must be a non-empty array")
    identities: set[tuple[str, str]] = set()
    for index, entry in enumerate(workflows):
        if not isinstance(entry, dict):
            fail(f"config.workflows[{index}] must be an object")
        repository = require_string(
            entry.get("repository"), f"config.workflows[{index}].repository"
        )
        workflow_file = require_string(
            entry.get("workflowFile"), f"config.workflows[{index}].workflowFile"
        )
        workflow_name = require_string(
            entry.get("workflowName"), f"config.workflows[{index}].workflowName"
        )
        require_string(
            entry.get("failureSummary"), f"config.workflows[{index}].failureSummary"
        )
        monitor_since = require_string(
            entry.get("monitorSince"), f"config.workflows[{index}].monitorSince"
        )
        INCIDENT.parse_time(monitor_since)
        for key in ("intervalMinutes", "graceMinutes"):
            value = entry.get(key)
            minimum = 0 if key == "graceMinutes" else 1
            if not isinstance(value, int) or value < minimum:
                fail(f"config.workflows[{index}].{key} is invalid")
        identity = (repository, workflow_file)
        if identity in identities:
            fail(f"duplicate monitored workflow: {repository}/{workflow_file}")
        identities.add(identity)
        if "/" not in repository or workflow_file.startswith("/"):
            fail(f"invalid monitored workflow identity: {repository}/{workflow_file}")
        if workflow_name != workflow_name.strip():
            fail("workflowName may not have surrounding whitespace")


def strip_state_marker(description: str | None) -> str:
    return STATE_MARKER_RE.sub("", description or "").rstrip()


def append_state_marker(description: str, state: dict[str, Any]) -> str:
    base = strip_state_marker(description)
    marker = json.dumps(state, sort_keys=True, separators=(",", ":"))
    return f"{base}\n\n<!-- opto-sync-canary-state:v1\n{marker}\n-->\n"


def parse_state_marker(description: str | None) -> dict[str, Any] | None:
    match = STATE_MARKER_RE.search(description or "")
    if match is None:
        return None
    try:
        value = json.loads(match.group("json"))
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) and value.get("signature") else None


def priority_value(name: str) -> int:
    return PRIORITY_VALUES.get(name, 3)


def release_evidence(config: dict[str, Any]) -> str:
    pair = config["certifiedPair"]
    return (
        "\n\nCertified source pair:\n"
        f"- `syncer.c`: `{pair['syncerSha']}`\n"
        f"- `opto-sync-clients`: `{pair['clientsSha']}`"
    )


def rendered_description(
    event: dict[str, Any], state: dict[str, Any], config: dict[str, Any]
) -> str:
    return append_state_marker(
        event["linear"]["body"] + release_evidence(config),
        state,
    )


@dataclass
class LinearIssue:
    id: str
    identifier: str
    title: str
    description: str
    priority: int
    state_type: str
    url: str

    @classmethod
    def from_node(cls, node: dict[str, Any]) -> "LinearIssue":
        state = node.get("state") or {}
        return cls(
            id=require_string(node.get("id"), "Linear issue id"),
            identifier=str(node.get("identifier") or ""),
            title=str(node.get("title") or ""),
            description=str(node.get("description") or ""),
            priority=int(node.get("priority") or 0),
            state_type=str(state.get("type") or ""),
            url=str(node.get("url") or ""),
        )
