#!/usr/bin/env python3
"""Validate and render the complete downstream Opto-Sync wrapper fleet.

This is an inventory and planning contract.  It never calls GitHub, mutates a
consumer repository, treats a draft PR as merged, or claims that live frozen
installation has passed.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = ROOT / "operations/downstream-wrapper-fleet.v1.json"
EXPECTED_DEPENDENCY = {
    "package": "opto-sync/opto-sync-clients",
    "range": "^0.2.0",
}
EXPECTED_RELEASE_GATES = {"DEN-309", "DEN-363"}
EXPECTED_WAVE_COUNTS = {"A": 3, "B": 9, "C": 5}
EXPECTED_ISSUE_BY_WAVE = {"A": "DEN-1386", "B": "DEN-1387", "C": "DEN-1388"}
EXPECTED_BRANCH_SUFFIX_BY_WAVE = {
    "A": "opto-sync-zed-adapter",
    "B": "opto-sync-zed-adapter",
    "C": "opto-sync-zed-adapter",
}
EXPECTED_E2E_SUFFIX_BY_WAVE = {
    "A": "opto-sync-adoption-e2e",
    "B": "opto-sync-e2e",
    "C": "opto-sync-e2e",
}
EXPECTED_PROVISIONING_GAPS = {
    "akrion-sim/akrion-sim-e2e",
    "benefactor-cc/benefactor-e2e",
}
SUPPORTED_LANGUAGES = {"c", "rust", "typescript", "dart", "gleam", "sql"}
SUPPORTED_PERSISTENCE = {"indexeddb", "sqlite", "postgres", "supabase"}
REPOSITORY = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
ISSUE = re.compile(r"^DEN-[1-9][0-9]*$")
BRANCH = re.compile(r"^agent/den-[1-9][0-9]*-[a-z0-9][a-z0-9._/-]*$")
SCENARIO = re.compile(r"^[a-z0-9][a-z0-9-]*$")


class FleetContractError(ValueError):
    pass


def fail(message: str) -> "NoReturn":
    raise FleetContractError(message)


def load_manifest(path: Path = DEFAULT_MANIFEST) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"cannot load {path}: {exc}")
    if not isinstance(value, dict):
        fail("fleet manifest must contain a JSON object")
    return value


def require_text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        fail(f"{label} must be a non-empty string")
    return value.strip()


def require_issue(value: Any, label: str) -> str:
    issue = require_text(value, label)
    if not ISSUE.fullmatch(issue):
        fail(f"{label} must be a DEN issue identifier")
    return issue


def require_repository(value: Any, label: str) -> str:
    repository = require_text(value, label)
    if not REPOSITORY.fullmatch(repository):
        fail(f"{label} must use owner/name")
    return repository


def require_branch(value: Any, label: str) -> str:
    branch = require_text(value, label)
    if not BRANCH.fullmatch(branch):
        fail(f"{label} must be a scoped agent/den-* branch")
    lowered = branch.lower()
    if "refs/heads/main" in lowered or lowered.endswith("/main") or "latest" in lowered:
        fail(f"{label} contains a mutable ref")
    return branch


def require_positive_int(value: Any, label: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        fail(f"{label} must be a positive integer")
    return value


def require_unique_strings(value: Any, label: str, *, minimum: int = 1) -> list[str]:
    if not isinstance(value, list) or len(value) < minimum:
        fail(f"{label} must contain at least {minimum} strings")
    if not all(isinstance(item, str) and item.strip() for item in value):
        fail(f"{label} must contain non-empty strings")
    normalized = [item.strip() for item in value]
    if len(normalized) != len(set(normalized)):
        fail(f"{label} contains duplicates")
    return normalized


def validate_manifest(manifest: dict[str, Any]) -> dict[str, Any]:
    if manifest.get("schemaVersion") != 1:
        fail("schemaVersion must be 1")
    require_issue(manifest.get("ownerIssue"), "ownerIssue")
    if manifest.get("parentIssue") != "DEN-313":
        fail("parentIssue must be DEN-313")
    if manifest.get("dependency") != EXPECTED_DEPENDENCY:
        fail("dependency must be opto-sync/opto-sync-clients@^0.2.0")
    release_gates = require_unique_strings(manifest.get("releaseGates"), "releaseGates", minimum=2)
    if set(release_gates) != EXPECTED_RELEASE_GATES:
        fail("releaseGates must contain exactly DEN-309 and DEN-363")
    required_scenarios = require_unique_strings(
        manifest.get("requiredScenarios"), "requiredScenarios", minimum=10
    )
    if not all(SCENARIO.fullmatch(item) for item in required_scenarios):
        fail("requiredScenarios must use lowercase dash-separated identifiers")

    wrappers = manifest.get("wrappers")
    if not isinstance(wrappers, list) or len(wrappers) != 17:
        fail("wrappers must contain exactly 17 entries")

    wrapper_repositories: set[str] = set()
    wrapper_prs: set[tuple[str, int]] = set()
    e2e_repositories: set[str] = set()
    e2e_prs: set[tuple[str, int]] = set()
    provisioning_gaps: set[str] = set()
    wave_counts: Counter[str] = Counter()
    existing_e2e = 0

    for index, wrapper in enumerate(wrappers):
        label = f"wrappers[{index}]"
        if not isinstance(wrapper, dict):
            fail(f"{label} must be an object")
        wave = require_text(wrapper.get("wave"), f"{label}.wave")
        if wave not in EXPECTED_WAVE_COUNTS:
            fail(f"{label}.wave must be A, B, or C")
        wave_counts[wave] += 1
        issue = require_issue(wrapper.get("linearIssue"), f"{label}.linearIssue")
        if issue != EXPECTED_ISSUE_BY_WAVE[wave]:
            fail(f"{label}.linearIssue does not match wave {wave}")
        repository = require_repository(wrapper.get("repository"), f"{label}.repository")
        if repository in wrapper_repositories:
            fail(f"duplicate wrapper repository: {repository}")
        wrapper_repositories.add(repository)
        branch = require_branch(wrapper.get("branch"), f"{label}.branch")
        if not branch.startswith(f"agent/{issue.lower()}-"):
            fail(f"{repository}: branch does not identify {issue}")
        if not branch.endswith(EXPECTED_BRANCH_SUFFIX_BY_WAVE[wave]):
            fail(f"{repository}: unexpected wrapper branch suffix")
        pull_request = require_positive_int(wrapper.get("pullRequest"), f"{label}.pullRequest")
        if (repository, pull_request) in wrapper_prs:
            fail(f"duplicate wrapper pull request: {repository}#{pull_request}")
        wrapper_prs.add((repository, pull_request))

        languages = require_unique_strings(wrapper.get("languages"), f"{label}.languages")
        if not set(languages) <= SUPPORTED_LANGUAGES:
            fail(f"{repository}: unsupported language inventory")
        persistence = require_unique_strings(wrapper.get("persistence"), f"{label}.persistence")
        if not set(persistence) <= SUPPORTED_PERSISTENCE:
            fail(f"{repository}: unsupported persistence surface")
        if not {"postgres", "supabase"} <= set(persistence):
            fail(f"{repository}: backend authority must cover Postgres and Supabase")

        bootstrap_independent = wrapper.get("bootstrapIndependent")
        if not isinstance(bootstrap_independent, bool):
            fail(f"{label}.bootstrapIndependent must be boolean")
        if repository == "zed-pkg/zed-sync":
            if bootstrap_independent is not True:
                fail("zed-pkg/zed-sync must preserve Zed bootstrap independence")
        elif bootstrap_independent is not False:
            fail(f"{repository}: only zed-sync may declare package bootstrap independence")

        legacy_parity = wrapper.get("legacyParityRequired")
        if not isinstance(legacy_parity, bool):
            fail(f"{label}.legacyParityRequired must be boolean")
        if repository in {
            "sonus-auris/sonus-auris-sync",
            "voxletra/voxletra-sync",
        } and legacy_parity is not True:
            fail(f"{repository}: exact legacy parity must remain required")

        additional = require_unique_strings(
            wrapper.get("additionalScenarios"), f"{label}.additionalScenarios"
        )
        if not all(SCENARIO.fullmatch(item) for item in additional):
            fail(f"{repository}: additional scenarios must use stable identifiers")
        guards = require_unique_strings(wrapper.get("domainGuards"), f"{label}.domainGuards", minimum=2)
        if any(len(guard) < 30 for guard in guards):
            fail(f"{repository}: domain guards must describe real product boundaries")

        serialized = json.dumps(wrapper, sort_keys=True).lower()
        if any(token in serialized for token in ("refs/heads/main", '"latest"', 'branch = "main"')):
            fail(f"{repository}: mutable reference found")

        e2e = wrapper.get("e2e")
        if not isinstance(e2e, dict):
            fail(f"{label}.e2e must be an object")
        e2e_status = require_text(e2e.get("status"), f"{label}.e2e.status")
        e2e_repository = require_repository(e2e.get("repository"), f"{label}.e2e.repository")
        if e2e_repository in e2e_repositories:
            fail(f"duplicate E2E repository: {e2e_repository}")
        e2e_repositories.add(e2e_repository)

        if e2e_status == "existing":
            existing_e2e += 1
            e2e_branch = require_branch(e2e.get("branch"), f"{label}.e2e.branch")
            if not e2e_branch.startswith(f"agent/{issue.lower()}-"):
                fail(f"{e2e_repository}: E2E branch does not identify {issue}")
            if not e2e_branch.endswith(EXPECTED_E2E_SUFFIX_BY_WAVE[wave]):
                fail(f"{e2e_repository}: unexpected E2E branch suffix")
            e2e_pr = require_positive_int(e2e.get("pullRequest"), f"{label}.e2e.pullRequest")
            if (e2e_repository, e2e_pr) in e2e_prs:
                fail(f"duplicate E2E pull request: {e2e_repository}#{e2e_pr}")
            e2e_prs.add((e2e_repository, e2e_pr))
            if "blocker" in e2e:
                fail(f"{e2e_repository}: existing E2E entry cannot contain a provisioning blocker")
        elif e2e_status == "provisioning_required":
            provisioning_gaps.add(e2e_repository)
            if e2e.get("branch") is not None or e2e.get("pullRequest") is not None:
                fail(f"{e2e_repository}: uncreated repository cannot claim a branch or PR")
            blocker = require_text(e2e.get("blocker"), f"{label}.e2e.blocker")
            if len(blocker) < 60 or "repository-creation" not in blocker:
                fail(f"{e2e_repository}: provisioning blocker must explain the creation boundary")
        else:
            fail(f"{e2e_repository}: unsupported E2E status {e2e_status!r}")

    if dict(wave_counts) != EXPECTED_WAVE_COUNTS:
        fail(f"wave counts differ: {dict(wave_counts)}")
    if existing_e2e != 15:
        fail(f"expected 15 existing E2E repositories, found {existing_e2e}")
    if provisioning_gaps != EXPECTED_PROVISIONING_GAPS:
        fail(f"provisioning gaps differ: {sorted(provisioning_gaps)}")
    if len(e2e_repositories) != 17:
        fail("every wrapper must map to one unique E2E repository identity")

    return {
        "schemaVersion": 1,
        "ownerIssue": manifest["ownerIssue"],
        "parentIssue": manifest["parentIssue"],
        "dependency": manifest["dependency"],
        "releaseGates": sorted(release_gates),
        "requiredScenarios": sorted(required_scenarios),
        "summary": {
            "wrappers": len(wrappers),
            "existingE2e": existing_e2e,
            "provisioningRequired": len(provisioning_gaps),
            "waves": dict(sorted(wave_counts.items())),
        },
        "provisioningGaps": sorted(provisioning_gaps),
        "wrappers": sorted(
            (
                {
                    "wave": wrapper["wave"],
                    "repository": wrapper["repository"],
                    "pullRequest": wrapper["pullRequest"],
                    "branch": wrapper["branch"],
                    "linearIssue": wrapper["linearIssue"],
                    "e2eRepository": wrapper["e2e"]["repository"],
                    "e2eStatus": wrapper["e2e"]["status"],
                    "e2ePullRequest": wrapper["e2e"].get("pullRequest"),
                    "legacyParityRequired": wrapper["legacyParityRequired"],
                    "bootstrapIndependent": wrapper["bootstrapIndependent"],
                    "languages": sorted(wrapper["languages"]),
                    "persistence": sorted(wrapper["persistence"]),
                    "additionalScenarios": sorted(wrapper["additionalScenarios"]),
                }
                for wrapper in wrappers
            ),
            key=lambda item: (item["wave"], item["repository"].lower()),
        ),
    }


def render_markdown(summary: dict[str, Any]) -> str:
    lines = [
        "# Opto-Sync downstream wrapper fleet",
        "",
        f"Owner: `{summary['ownerIssue']}` · Parent: `{summary['parentIssue']}`",
        "",
        f"Dependency: `{summary['dependency']['package']}@{summary['dependency']['range']}`",
        "",
        "| Wave | Wrapper PR | E2E | Languages | Persistence | Special gate |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for wrapper in summary["wrappers"]:
        e2e = (
            f"`{wrapper['e2eRepository']}#{wrapper['e2ePullRequest']}`"
            if wrapper["e2eStatus"] == "existing"
            else f"`{wrapper['e2eRepository']}` — provisioning required"
        )
        special: list[str] = []
        if wrapper["bootstrapIndependent"]:
            special.append("bootstrap independence")
        if wrapper["legacyParityRequired"]:
            special.append("legacy parity")
        special.extend(wrapper["additionalScenarios"])
        lines.append(
            "| {wave} | `{repository}#{pr}` | {e2e} | {languages} | {persistence} | {special} |".format(
                wave=wrapper["wave"],
                repository=wrapper["repository"],
                pr=wrapper["pullRequest"],
                e2e=e2e,
                languages=", ".join(wrapper["languages"]),
                persistence=", ".join(wrapper["persistence"]),
                special=", ".join(special),
            )
        )
    lines.extend(
        [
            "",
            "## Summary",
            "",
            f"- Wrappers: **{summary['summary']['wrappers']}**",
            f"- Existing E2E repositories: **{summary['summary']['existingE2e']}**",
            f"- Repositories requiring provisioning: **{summary['summary']['provisioningRequired']}**",
            f"- Release gates: {', '.join(f'`{gate}`' for gate in summary['releaseGates'])}",
            "",
            "Inventory status is not live-install evidence. Each product PR still needs its committed frozen lock and product E2E run before merge.",
            "",
        ]
    )
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--format", choices=("json", "markdown"), default="json")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    try:
        summary = validate_manifest(load_manifest(args.manifest))
    except FleetContractError as exc:
        print(f"downstream-wrapper-fleet: {exc}", file=sys.stderr)
        return 1
    rendered = (
        json.dumps(summary, indent=2, sort_keys=True) + "\n"
        if args.format == "json"
        else render_markdown(summary)
    )
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
    else:
        sys.stdout.write(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
