#!/usr/bin/env python3
"""Validate the final Zed CLI/interface pins across the Opto-Sync rollout.

The static contract defines one reviewed package-plane pair. The live audit is
read-only: it fetches the adoption workflow from each reviewed branch and
requires exact YAML environment assignments for both SHAs. It does not claim
that a package was published or that a manual frozen-install job passed.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Protocol

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONTRACT = ROOT / "operations/zed-package-plane-contract.v1.json"
DEFAULT_FLEET = ROOT / "operations/downstream-wrapper-fleet.v1.json"
SHA = re.compile(r"^[0-9a-f]{40}$")
ENV_ASSIGNMENT = re.compile(
    r"(?m)^\s*(ZED_CLI_SHA|ZED_INTERFACES_SHA)\s*:\s*['\"]?([0-9a-f]{40})['\"]?\s*$"
)
API_DEFAULT = "https://api.github.com"


class PinAuditError(ValueError):
    pass


class GitHubApiError(RuntimeError):
    def __init__(self, status: int, resource: str):
        super().__init__(f"GitHub API returned HTTP {status} for {resource}")
        self.status = status
        self.resource = resource


class Client(Protocol):
    def read_text(self, repository: str, path: str, ref: str) -> str: ...


def fail(message: str) -> "NoReturn":
    raise PinAuditError(message)


def load_object(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"cannot load {label}: {exc}")
    if not isinstance(value, dict):
        fail(f"{label} must contain a JSON object")
    return value


def require_sha(value: Any, label: str) -> str:
    if not isinstance(value, str) or not SHA.fullmatch(value):
        fail(f"{label} must be a lowercase 40-character commit SHA")
    return value


def validate_contract(contract: dict[str, Any], fleet: dict[str, Any]) -> list[dict[str, Any]]:
    if contract.get("schemaVersion") != 1:
        fail("contract.schemaVersion must be 1")
    if contract.get("ownerIssue") != "DEN-1576":
        fail("contract.ownerIssue must be DEN-1576")
    if contract.get("parentIssue") != "DEN-313":
        fail("contract.parentIssue must be DEN-313")
    cli = contract.get("zedCli")
    interfaces = contract.get("zedInterfaces")
    required = contract.get("requiredWorkflowVariables")
    if not isinstance(cli, dict) or not isinstance(interfaces, dict) or not isinstance(required, dict):
        fail("contract CLI, interfaces, and workflow-variable sections are required")
    if cli.get("repository") != "zed-pkg/zed-cli":
        fail("contract.zedCli.repository differs")
    if interfaces.get("repository") != "zed-pkg/zed-interfaces":
        fail("contract.zedInterfaces.repository differs")
    cli_sha = require_sha(cli.get("sha"), "contract.zedCli.sha")
    interface_sha = require_sha(interfaces.get("sha"), "contract.zedInterfaces.sha")
    strict_sha = require_sha(
        interfaces.get("strictParserSha"),
        "contract.zedInterfaces.strictParserSha",
    )
    if cli.get("interfaceDependencySha") != interface_sha:
        fail("CLI dependency SHA differs from final interface SHA")
    if required != {
        "ZED_CLI_SHA": cli_sha,
        "ZED_INTERFACES_SHA": interface_sha,
    }:
        fail("required workflow variables differ from the reviewed pair")
    forbidden = contract.get("forbiddenPins")
    if not isinstance(forbidden, list) or not forbidden:
        fail("contract.forbiddenPins must be non-empty")
    if len(forbidden) != len(set(forbidden)):
        fail("contract.forbiddenPins contains duplicates")
    for index, value in enumerate(forbidden):
        require_sha(value, f"contract.forbiddenPins[{index}]")
    if cli_sha in forbidden or interface_sha in forbidden:
        fail("the final package-plane pair cannot be forbidden")
    if strict_sha not in forbidden:
        fail("strict-only interface SHA must be forbidden after compatibility merge")
    properties = contract.get("requiredProperties")
    if not isinstance(properties, list) or len(properties) < 5:
        fail("contract.requiredProperties is incomplete")
    if set(contract.get("releaseGates", [])) != {"DEN-309", "DEN-363"}:
        fail("contract.releaseGates must contain DEN-309 and DEN-363")

    wrappers = fleet.get("wrappers")
    if not isinstance(wrappers, list) or len(wrappers) != 17:
        fail("fleet must contain exactly 17 wrappers")
    targets: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for index, wrapper in enumerate(wrappers):
        if not isinstance(wrapper, dict):
            fail(f"fleet.wrappers[{index}] must be an object")
        repository = wrapper.get("repository")
        branch = wrapper.get("branch")
        wave = wrapper.get("wave")
        e2e = wrapper.get("e2e")
        if not isinstance(repository, str) or not isinstance(branch, str):
            fail(f"fleet.wrappers[{index}] has invalid wrapper identity")
        target = {
            "kind": "wrapper",
            "repository": repository,
            "branch": branch,
            "path": ".github/workflows/opto-sync-wrapper.yml",
            "wave": wave,
        }
        key = (repository, target["path"])
        if key in seen:
            fail(f"duplicate target: {repository}:{target['path']}")
        seen.add(key)
        targets.append(target)
        if not isinstance(e2e, dict):
            fail(f"fleet.wrappers[{index}].e2e must be an object")
        if e2e.get("status") == "existing":
            e2e_repository = e2e.get("repository")
            e2e_branch = e2e.get("branch")
            if not isinstance(e2e_repository, str) or not isinstance(e2e_branch, str):
                fail(f"fleet.wrappers[{index}] has invalid E2E identity")
            path = (
                ".github/workflows/opto-sync-adoption.yml"
                if wave == "A"
                else ".github/workflows/opto-sync-wrapper-e2e.yml"
            )
            target = {
                "kind": "e2e",
                "repository": e2e_repository,
                "branch": e2e_branch,
                "path": path,
                "wave": wave,
            }
            key = (e2e_repository, path)
            if key in seen:
                fail(f"duplicate target: {e2e_repository}:{path}")
            seen.add(key)
            targets.append(target)
        elif e2e.get("status") != "provisioning_required":
            fail(f"fleet.wrappers[{index}] has unsupported E2E status")
    if len(targets) != 32:
        fail(f"expected 32 existing workflow targets, found {len(targets)}")
    return sorted(targets, key=lambda item: (item["kind"], item["repository"].lower()))


def validate_workflow_text(
    text: str,
    contract: dict[str, Any],
    target: dict[str, Any],
) -> list[str]:
    errors: list[str] = []
    assignments: dict[str, list[str]] = {}
    for name, value in ENV_ASSIGNMENT.findall(text):
        assignments.setdefault(name, []).append(value)
    for name, expected in contract["requiredWorkflowVariables"].items():
        actual = assignments.get(name, [])
        if actual != [expected]:
            errors.append(
                f"{name} assignments are {actual!r}, expected exactly [{expected!r}]"
            )
    for forbidden in contract["forbiddenPins"]:
        if forbidden in text:
            errors.append(f"forbidden package-plane SHA remains: {forbidden}")
    if "zed install --frozen --install-mode copy" not in text and (
        'install --frozen --install-mode copy' not in text
    ):
        errors.append("workflow lacks frozen copy-mode installation")
    if "cargo build --locked --release" not in text:
        errors.append("workflow does not build the pinned Zed CLI with Cargo --locked")
    return errors


class GitHubClient:
    def __init__(self, token: str, *, api_url: str = API_DEFAULT, timeout: int = 20):
        if not token:
            raise PinAuditError("SYNC_FLEET_TOKEN is required for the live pin audit")
        self._token = token
        self._api_url = api_url.rstrip("/")
        self._timeout = timeout

    def read_text(self, repository: str, path: str, ref: str) -> str:
        owner, name = repository.split("/", 1)
        resource = "/repos/{}/{}/contents/{}?ref={}".format(
            urllib.parse.quote(owner, safe=""),
            urllib.parse.quote(name, safe=""),
            "/".join(urllib.parse.quote(part, safe="") for part in path.split("/")),
            urllib.parse.quote(ref, safe=""),
        )
        request = urllib.request.Request(
            self._api_url + resource,
            headers={
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {self._token}",
                "User-Agent": "opto-sync-final-zed-pin-audit/1",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=self._timeout) as response:
                value = json.load(response)
        except urllib.error.HTTPError as exc:
            raise GitHubApiError(exc.code, resource) from None
        except urllib.error.URLError as exc:
            raise RuntimeError(
                f"GitHub API transport failed for {resource}: {type(exc.reason).__name__}"
            ) from None
        if not isinstance(value, dict) or value.get("encoding") != "base64":
            fail(f"GitHub content response is invalid for {repository}:{path}@{ref}")
        try:
            return base64.b64decode(value["content"], validate=True).decode("utf-8")
        except (KeyError, ValueError, UnicodeDecodeError) as exc:
            fail(f"cannot decode GitHub content for {repository}:{path}@{ref}: {type(exc).__name__}")


def audit(
    contract: dict[str, Any],
    targets: list[dict[str, Any]],
    client: Client,
) -> dict[str, Any]:
    entries: list[dict[str, Any]] = []
    for target in targets:
        errors: list[str] = []
        status: int | None = None
        try:
            text = client.read_text(
                target["repository"],
                target["path"],
                target["branch"],
            )
            errors.extend(validate_workflow_text(text, contract, target))
        except GitHubApiError as exc:
            status = exc.status
            errors.append(str(exc))
        except (RuntimeError, PinAuditError) as exc:
            errors.append(str(exc))
        entries.append(
            {
                **target,
                "httpStatus": status,
                "passed": not errors,
                "errors": errors,
            }
        )
    failed = [entry for entry in entries if not entry["passed"]]
    return {
        "schemaVersion": 1,
        "ownerIssue": contract["ownerIssue"],
        "readOnly": True,
        "packagePlane": contract["requiredWorkflowVariables"],
        "summary": {
            "targets": len(entries),
            "passed": len(entries) - len(failed),
            "failed": len(failed),
        },
        "entries": entries,
    }


def write_report(path: Path, report: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("plan", "audit"))
    parser.add_argument("--contract", type=Path, default=DEFAULT_CONTRACT)
    parser.add_argument("--fleet", type=Path, default=DEFAULT_FLEET)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--api-url", default=API_DEFAULT)
    args = parser.parse_args()
    try:
        contract = load_object(args.contract, "package-plane contract")
        fleet = load_object(args.fleet, "wrapper fleet")
        targets = validate_contract(contract, fleet)
        if args.command == "plan":
            report = {
                "schemaVersion": 1,
                "ownerIssue": contract["ownerIssue"],
                "readOnly": True,
                "packagePlane": contract["requiredWorkflowVariables"],
                "summary": {
                    "targets": len(targets),
                    "wrappers": sum(item["kind"] == "wrapper" for item in targets),
                    "e2e": sum(item["kind"] == "e2e" for item in targets),
                    "provisioningRequired": 2,
                },
                "targets": targets,
            }
            write_report(args.output, report)
            print(json.dumps(report["summary"], sort_keys=True))
            return 0
        token = os.environ.get("SYNC_FLEET_TOKEN", "")
        if not token:
            fail("SYNC_FLEET_TOKEN is required for the live pin audit")
        report = audit(
            contract,
            targets,
            GitHubClient(token, api_url=args.api_url),
        )
        write_report(args.output, report)
        print(json.dumps(report["summary"], sort_keys=True))
        return 0 if report["summary"]["failed"] == 0 else 1
    except PinAuditError as exc:
        report = {
            "schemaVersion": 1,
            "ownerIssue": "DEN-1576",
            "readOnly": True,
            "summary": {"targets": 0, "passed": 0, "failed": 1},
            "errors": [str(exc)],
            "entries": [],
        }
        write_report(args.output, report)
        print(f"final-zed-pin-audit: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
