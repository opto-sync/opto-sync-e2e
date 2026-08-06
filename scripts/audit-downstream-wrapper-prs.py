#!/usr/bin/env python3
"""Read-only audit of the actual downstream wrapper and E2E pull requests.

The reviewed inventory in operations/downstream-wrapper-fleet.v1.json is the
source of expected repository, branch, pull-request, and provisioning state.
This script compares that contract with GitHub's REST metadata without making
any GitHub write. Authentication is read only from SYNC_FLEET_TOKEN; it is
never accepted as a command-line argument or included in reports/errors.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Protocol

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = ROOT / "operations/downstream-wrapper-fleet.v1.json"
FLEET_VALIDATOR_PATH = ROOT / "scripts/check-downstream-wrapper-fleet.py"
API_DEFAULT = "https://api.github.com"
WRAPPER_REQUIRED_FILES = {
    ".zpkg.toml",
    ".zpkg.lock",
    "opto-sync-adapter.json",
    ".github/workflows/opto-sync-wrapper.yml",
}
E2E_REQUIRED_FILES = {
    "A": {
        "opto-sync-adoption.json",
        "tests/opto-sync/adoption_contract.py",
        ".github/workflows/opto-sync-adoption.yml",
    },
    "B": {
        "tests/opto-sync-wrapper/profile.json",
        "tests/opto-sync-wrapper/product.e2e.test.mjs",
        ".github/workflows/opto-sync-wrapper-e2e.yml",
    },
    "C": {
        "tests/opto-sync-wrapper/profile.json",
        "tests/opto-sync-wrapper/product.e2e.test.mjs",
        ".github/workflows/opto-sync-wrapper-e2e.yml",
    },
}


class AuditContractError(ValueError):
    pass


class GitHubApiError(RuntimeError):
    def __init__(self, status: int, resource: str):
        super().__init__(f"GitHub API returned HTTP {status} for {resource}")
        self.status = status
        self.resource = resource


class Client(Protocol):
    def get_json(self, resource: str) -> Any: ...

    def get_paginated(self, resource: str) -> list[Any]: ...


def fail(message: str) -> "NoReturn":
    raise AuditContractError(message)


def load_fleet_validator():
    spec = importlib.util.spec_from_file_location(
        "downstream_wrapper_fleet_for_live_audit",
        FLEET_VALIDATOR_PATH,
    )
    if spec is None or spec.loader is None:
        fail(f"cannot load fleet validator: {FLEET_VALIDATOR_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_manifest(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"cannot load fleet manifest {path}: {exc}")
    if not isinstance(value, dict):
        fail("fleet manifest must contain a JSON object")
    validator = load_fleet_validator()
    try:
        validator.validate_manifest(value)
    except validator.FleetContractError as exc:
        fail(f"fleet manifest is invalid: {exc}")
    return value


def repository_resource(repository: str) -> str:
    owner, name = repository.split("/", 1)
    return "/repos/{}/{}".format(
        urllib.parse.quote(owner, safe=""),
        urllib.parse.quote(name, safe=""),
    )


def pull_resource(repository: str, number: int) -> str:
    return f"{repository_resource(repository)}/pulls/{number}"


def pull_files_resource(repository: str, number: int) -> str:
    return f"{pull_resource(repository, number)}/files"


class GitHubClient:
    def __init__(
        self,
        token: str,
        *,
        api_url: str = API_DEFAULT,
        timeout_seconds: int = 20,
        max_pages: int = 20,
    ):
        if not token:
            raise AuditContractError("SYNC_FLEET_TOKEN is required for the live audit")
        self._token = token
        self._api_url = api_url.rstrip("/")
        self._timeout_seconds = timeout_seconds
        self._max_pages = max_pages

    def _request_json(self, resource: str) -> Any:
        if not resource.startswith("/"):
            raise AuditContractError(f"unsafe GitHub resource path: {resource}")
        url = self._api_url + resource
        request = urllib.request.Request(
            url,
            headers={
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {self._token}",
                "User-Agent": "opto-sync-downstream-pr-audit/1",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=self._timeout_seconds) as response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            # Do not read or expose response bodies. They can contain private
            # repository metadata and are unnecessary for a bounded audit.
            raise GitHubApiError(exc.code, resource) from None
        except urllib.error.URLError as exc:
            reason = type(exc.reason).__name__
            raise RuntimeError(f"GitHub API transport failed for {resource}: {reason}") from None

    def get_json(self, resource: str) -> Any:
        return self._request_json(resource)

    def get_paginated(self, resource: str) -> list[Any]:
        separator = "&" if "?" in resource else "?"
        result: list[Any] = []
        for page in range(1, self._max_pages + 1):
            page_resource = f"{resource}{separator}per_page=100&page={page}"
            value = self._request_json(page_resource)
            if not isinstance(value, list):
                raise AuditContractError(
                    f"paginated GitHub resource did not return an array: {resource}"
                )
            result.extend(value)
            if len(value) < 100:
                return result
        raise AuditContractError(
            f"paginated GitHub resource exceeded {self._max_pages} pages: {resource}"
        )


def nested(value: Any, *keys: str) -> Any:
    current = value
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def validate_pull_request(
    *,
    kind: str,
    repository: str,
    number: int,
    expected_branch: str,
    required_files: set[str],
    pull: Any,
    files: Any,
) -> dict[str, Any]:
    errors: list[str] = []
    if not isinstance(pull, dict):
        errors.append("pull response is not an object")
        pull = {}
    if not isinstance(files, list):
        errors.append("pull files response is not an array")
        files = []

    actual_number = pull.get("number")
    if actual_number != number:
        errors.append(f"PR number is {actual_number!r}, expected {number}")
    if pull.get("state") != "open":
        errors.append(f"state is {pull.get('state')!r}, expected 'open'")
    if pull.get("draft") is not True:
        errors.append("PR must remain draft before live frozen-install release evidence")
    if pull.get("merged") is True or pull.get("merged_at") is not None:
        errors.append("PR is already merged")
    actual_base = nested(pull, "base", "ref")
    if actual_base != "main":
        errors.append(f"base branch is {actual_base!r}, expected 'main'")
    actual_head = nested(pull, "head", "ref")
    if actual_head != expected_branch:
        errors.append(
            f"head branch is {actual_head!r}, expected {expected_branch!r}"
        )
    actual_head_repository = nested(pull, "head", "repo", "full_name")
    if actual_head_repository != repository:
        errors.append(
            "head repository is "
            f"{actual_head_repository!r}, expected {repository!r}"
        )

    filenames: list[str] = []
    for index, item in enumerate(files):
        if not isinstance(item, dict) or not isinstance(item.get("filename"), str):
            errors.append(f"file entry {index} lacks a filename")
            continue
        filenames.append(item["filename"])
    duplicate_files = sorted(
        filename for filename in set(filenames) if filenames.count(filename) > 1
    )
    if duplicate_files:
        errors.append("duplicate changed files: " + ", ".join(duplicate_files))
    missing_files = sorted(required_files - set(filenames))
    if missing_files:
        errors.append("missing required files: " + ", ".join(missing_files))

    return {
        "kind": kind,
        "repository": repository,
        "pullRequest": number,
        "expected": {
            "state": "open",
            "draft": True,
            "base": "main",
            "head": expected_branch,
            "requiredFiles": sorted(required_files),
        },
        "actual": {
            "state": pull.get("state"),
            "draft": pull.get("draft"),
            "merged": pull.get("merged"),
            "base": actual_base,
            "head": actual_head,
            "headRepository": actual_head_repository,
            "changedFileCount": len(filenames),
        },
        "missingFiles": missing_files,
        "errors": errors,
        "passed": not errors,
    }


def api_error_entry(
    *,
    kind: str,
    repository: str,
    number: int | None,
    expected_branch: str | None,
    error: Exception,
) -> dict[str, Any]:
    status = error.status if isinstance(error, GitHubApiError) else None
    return {
        "kind": kind,
        "repository": repository,
        "pullRequest": number,
        "expected": {"head": expected_branch},
        "actual": {"httpStatus": status},
        "missingFiles": [],
        "errors": [str(error)],
        "passed": False,
    }


def audit_fleet(manifest: dict[str, Any], client: Client) -> dict[str, Any]:
    entries: list[dict[str, Any]] = []
    for wrapper in manifest["wrappers"]:
        repository = wrapper["repository"]
        number = wrapper["pullRequest"]
        branch = wrapper["branch"]
        try:
            pull = client.get_json(pull_resource(repository, number))
            files = client.get_paginated(pull_files_resource(repository, number))
            entries.append(
                validate_pull_request(
                    kind="wrapper",
                    repository=repository,
                    number=number,
                    expected_branch=branch,
                    required_files=WRAPPER_REQUIRED_FILES,
                    pull=pull,
                    files=files,
                )
            )
        except (GitHubApiError, RuntimeError, AuditContractError) as exc:
            entries.append(
                api_error_entry(
                    kind="wrapper",
                    repository=repository,
                    number=number,
                    expected_branch=branch,
                    error=exc,
                )
            )

        e2e = wrapper["e2e"]
        e2e_repository = e2e["repository"]
        if e2e["status"] == "existing":
            e2e_number = e2e["pullRequest"]
            e2e_branch = e2e["branch"]
            try:
                pull = client.get_json(pull_resource(e2e_repository, e2e_number))
                files = client.get_paginated(
                    pull_files_resource(e2e_repository, e2e_number)
                )
                entries.append(
                    validate_pull_request(
                        kind="e2e",
                        repository=e2e_repository,
                        number=e2e_number,
                        expected_branch=e2e_branch,
                        required_files=E2E_REQUIRED_FILES[wrapper["wave"]],
                        pull=pull,
                        files=files,
                    )
                )
            except (GitHubApiError, RuntimeError, AuditContractError) as exc:
                entries.append(
                    api_error_entry(
                        kind="e2e",
                        repository=e2e_repository,
                        number=e2e_number,
                        expected_branch=e2e_branch,
                        error=exc,
                    )
                )
        else:
            try:
                client.get_json(repository_resource(e2e_repository))
            except GitHubApiError as exc:
                if exc.status == 404:
                    entries.append(
                        {
                            "kind": "provisioning_gap",
                            "repository": e2e_repository,
                            "pullRequest": None,
                            "expected": {"repositoryExists": False},
                            "actual": {"repositoryExists": False, "httpStatus": 404},
                            "missingFiles": [],
                            "errors": [],
                            "passed": True,
                        }
                    )
                else:
                    entries.append(
                        api_error_entry(
                            kind="provisioning_gap",
                            repository=e2e_repository,
                            number=None,
                            expected_branch=None,
                            error=exc,
                        )
                    )
            except (RuntimeError, AuditContractError) as exc:
                entries.append(
                    api_error_entry(
                        kind="provisioning_gap",
                        repository=e2e_repository,
                        number=None,
                        expected_branch=None,
                        error=exc,
                    )
                )
            else:
                entries.append(
                    {
                        "kind": "provisioning_gap",
                        "repository": e2e_repository,
                        "pullRequest": None,
                        "expected": {"repositoryExists": False},
                        "actual": {"repositoryExists": True, "httpStatus": 200},
                        "missingFiles": [],
                        "errors": [
                            "repository exists while inventory still says provisioning_required"
                        ],
                        "passed": False,
                    }
                )

    failures = [entry for entry in entries if not entry["passed"]]
    counts: dict[str, int] = {}
    for entry in entries:
        counts[entry["kind"]] = counts.get(entry["kind"], 0) + 1
    return {
        "schemaVersion": 1,
        "ownerIssue": "DEN-1473",
        "parentIssue": manifest["ownerIssue"],
        "readOnly": True,
        "summary": {
            "entries": len(entries),
            "passed": len(entries) - len(failures),
            "failed": len(failures),
            "counts": dict(sorted(counts.items())),
        },
        "entries": entries,
    }


def write_report(path: Path, report: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def missing_token_report() -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "ownerIssue": "DEN-1473",
        "readOnly": True,
        "summary": {
            "entries": 0,
            "passed": 0,
            "failed": 1,
            "counts": {},
        },
        "entries": [],
        "errors": ["SYNC_FLEET_TOKEN is required for the live audit"],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("plan", "audit"))
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--api-url", default=API_DEFAULT)
    args = parser.parse_args()
    try:
        manifest = load_manifest(args.manifest)
        if args.command == "plan":
            report = {
                "schemaVersion": 1,
                "ownerIssue": "DEN-1473",
                "readOnly": True,
                "summary": {
                    "wrappers": len(manifest["wrappers"]),
                    "existingE2e": sum(
                        wrapper["e2e"]["status"] == "existing"
                        for wrapper in manifest["wrappers"]
                    ),
                    "provisioningRequired": sum(
                        wrapper["e2e"]["status"] == "provisioning_required"
                        for wrapper in manifest["wrappers"]
                    ),
                },
            }
            write_report(args.output, report)
            print(json.dumps(report["summary"], sort_keys=True))
            return 0

        token = os.environ.get("SYNC_FLEET_TOKEN", "")
        if not token:
            report = missing_token_report()
            write_report(args.output, report)
            print(report["errors"][0], file=sys.stderr)
            return 2
        client = GitHubClient(token, api_url=args.api_url)
        report = audit_fleet(manifest, client)
        write_report(args.output, report)
        print(json.dumps(report["summary"], sort_keys=True))
        return 0 if report["summary"]["failed"] == 0 else 1
    except AuditContractError as exc:
        report = {
            "schemaVersion": 1,
            "ownerIssue": "DEN-1473",
            "readOnly": True,
            "summary": {"entries": 0, "passed": 0, "failed": 1, "counts": {}},
            "entries": [],
            "errors": [str(exc)],
        }
        write_report(args.output, report)
        print(f"downstream-wrapper-pr-audit: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
