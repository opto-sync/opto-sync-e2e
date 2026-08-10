#!/usr/bin/env python3
"""Derive the only allowed Opto-Sync release-chain action from evidence.

The validator is deliberately read-only. It accepts optional stage reports,
validates them against operations/opto-sync-release-chain.v1.json, rejects
out-of-order evidence, and derives state and allowed actions. Callers cannot
supply or override the derived state.

The core stage understands the bounded DEN-1584 publication report directly.
Clients and E2E publication reports use the generic stage report contract
validated below. Wrapper certification is a separate fleet report bound to the
final Zed package-plane pair and all 17 wrapper/E2E identities.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONTRACT = ROOT / "operations/opto-sync-release-chain.v1.json"
SHA = re.compile(r"^[0-9a-f]{40}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
ISSUE = re.compile(r"^DEN-[1-9][0-9]*$")
REPOSITORY = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
EXPECTED_STAGE_IDS = ["core", "clients", "e2e", "wrappers"]
EXPECTED_PREREQUISITES = {
    "core": None,
    "clients": "core",
    "e2e": "clients",
    "wrappers": "e2e",
}
EXPECTED_STATES = [
    "await_core_publication_verification",
    "core_verified",
    "clients_verified",
    "e2e_verified",
    "fleet_live_certified",
]
EXPECTED_ACTIONS = {
    "await_core_publication_verification": [
        "run_core_publication_outcome_audit"
    ],
    "core_verified": ["activate_clients_publication"],
    "clients_verified": ["activate_e2e_publication"],
    "e2e_verified": [
        "generate_wrapper_real_locks",
        "run_wrapper_live_certification",
    ],
    "fleet_live_certified": ["request_semantic_product_merges"],
}
EXPECTED_RULES = {
    "activationMergeIsNotEvidence": True,
    "reportsCannotSkipPrerequisites": True,
    "falseVerificationBlocks": True,
    "packageIdentitiesMustMatch": True,
    "packagePlanePinsMustMatch": True,
    "allowedActionsAreDerived": True,
    "validatorIsReadOnly": True,
}
FINAL_ZED_CLI = "a850dbcc799aeaccf1093741ab58439a049c14c9"
FINAL_ZED_INTERFACES = "c2e049006453c26ca8ca291783f681fce75cb01f"


class ChainError(ValueError):
    pass


def fail(message: str) -> "NoReturn":
    raise ChainError(message)


def load_object(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"cannot load {label}: {exc}")
    if not isinstance(value, dict):
        fail(f"{label} must contain a JSON object")
    return value


def require_text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        fail(f"{label} must be a non-empty string")
    return value.strip()


def require_issue(value: Any, label: str) -> str:
    issue = require_text(value, label)
    if not ISSUE.fullmatch(issue):
        fail(f"{label} must be a DEN issue")
    return issue


def require_repository(value: Any, label: str) -> str:
    repository = require_text(value, label)
    if not REPOSITORY.fullmatch(repository):
        fail(f"{label} must use owner/name")
    return repository


def require_sha(value: Any, label: str) -> str:
    text = require_text(value, label)
    if not SHA.fullmatch(text):
        fail(f"{label} must be a lowercase 40-character SHA")
    return text


def require_sha256(value: Any, label: str) -> str:
    text = require_text(value, label)
    if not SHA256.fullmatch(text) or text == "0" * 64:
        fail(f"{label} must be a nonzero lowercase SHA-256")
    return text


def require_positive_int(value: Any, label: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        fail(f"{label} must be a positive integer")
    return value


def require_nonnegative_int(value: Any, label: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        fail(f"{label} must be a nonnegative integer")
    return value


def validate_package(package: Any, label: str) -> dict[str, Any]:
    if not isinstance(package, dict):
        fail(f"{label} must be an object")
    name = require_text(package.get("name"), f"{label}.name")
    sha256 = require_sha256(package.get("sha256"), f"{label}.sha256")
    size = require_positive_int(package.get("size"), f"{label}.size")
    artifact_format = require_text(package.get("format"), f"{label}.format")
    if artifact_format not in {"tar.gz", "zip"}:
        fail(f"{label}.format is unsupported")
    return {
        "name": name,
        "sha256": sha256,
        "size": size,
        "format": artifact_format,
    }


def validate_contract(value: dict[str, Any]) -> dict[str, Any]:
    if value.get("schemaVersion") != 1:
        fail("contract schemaVersion must be 1")
    owner_issue = require_issue(value.get("ownerIssue"), "ownerIssue")
    architecture_issue = require_issue(
        value.get("architectureIssue"), "architectureIssue"
    )
    package_plane = value.get("packagePlane")
    if not isinstance(package_plane, dict):
        fail("packagePlane must be an object")
    zed_cli = require_sha(package_plane.get("zedCliSha"), "packagePlane.zedCliSha")
    zed_interfaces = require_sha(
        package_plane.get("zedInterfacesSha"),
        "packagePlane.zedInterfacesSha",
    )
    if zed_cli != FINAL_ZED_CLI or zed_interfaces != FINAL_ZED_INTERFACES:
        fail("packagePlane does not select the final reviewed Zed pair")

    stages = value.get("stages")
    if not isinstance(stages, list) or len(stages) != 4:
        fail("stages must contain exactly four entries")
    normalized_stages: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for index, stage in enumerate(stages):
        label = f"stages[{index}]"
        if not isinstance(stage, dict):
            fail(f"{label} must be an object")
        stage_id = require_text(stage.get("id"), f"{label}.id")
        if stage_id in seen_ids:
            fail(f"duplicate stage id: {stage_id}")
        seen_ids.add(stage_id)
        if stage_id != EXPECTED_STAGE_IDS[index]:
            fail(f"{label}.id must be {EXPECTED_STAGE_IDS[index]}")
        if stage.get("prerequisite") != EXPECTED_PREREQUISITES[stage_id]:
            fail(f"{label}.prerequisite differs")
        outcome_issue = require_issue(
            stage.get("outcomeIssue"), f"{label}.outcomeIssue"
        )
        evidence = stage.get("requiredEvidence")
        if not isinstance(evidence, dict):
            fail(f"{label}.requiredEvidence must be an object")
        normalized: dict[str, Any] = {
            "id": stage_id,
            "prerequisite": stage.get("prerequisite"),
            "outcomeIssue": outcome_issue,
            "requiredEvidence": dict(evidence),
        }
        if stage_id != "wrappers":
            repository = require_repository(
                stage.get("repository"), f"{label}.repository"
            )
            source_sha = require_sha(stage.get("sourceSha"), f"{label}.sourceSha")
            tree_sha = require_sha(stage.get("treeSha"), f"{label}.treeSha")
            version = require_text(stage.get("version"), f"{label}.version")
            tag = require_text(stage.get("tag"), f"{label}.tag")
            if tag != f"v{version}":
                fail(f"{label}.tag must equal v{{version}}")
            packages = stage.get("packages")
            if not isinstance(packages, list) or not packages:
                fail(f"{label}.packages must be non-empty")
            normalized_packages = [
                validate_package(package, f"{label}.packages[{package_index}]")
                for package_index, package in enumerate(packages)
            ]
            names = [package["name"] for package in normalized_packages]
            if len(names) != len(set(names)):
                fail(f"{label}.packages contains duplicate names")
            required_checks = require_positive_int(
                evidence.get("checks"), f"{label}.requiredEvidence.checks"
            )
            required_locks = require_positive_int(
                evidence.get("locks"), f"{label}.requiredEvidence.locks"
            )
            if evidence.get("state") != "published_verified":
                fail(f"{label}.requiredEvidence.state differs")
            if required_locks != len(normalized_packages):
                fail(f"{label}.requiredEvidence.locks differs from package count")
            normalized.update(
                {
                    "repository": repository,
                    "sourceSha": source_sha,
                    "treeSha": tree_sha,
                    "version": version,
                    "tag": tag,
                    "packages": normalized_packages,
                    "requiredEvidence": {
                        "checks": required_checks,
                        "locks": required_locks,
                        "state": "published_verified",
                    },
                }
            )
            if stage_id == "clients":
                normalized["embeddedCoreSha"] = require_sha(
                    stage.get("embeddedCoreSha"),
                    f"{label}.embeddedCoreSha",
                )
            if stage_id == "e2e":
                normalized["pinnedCoreSha"] = require_sha(
                    stage.get("pinnedCoreSha"),
                    f"{label}.pinnedCoreSha",
                )
                normalized["pinnedClientsSha"] = require_sha(
                    stage.get("pinnedClientsSha"),
                    f"{label}.pinnedClientsSha",
                )
        else:
            expected_wrapper_evidence = {
                "state": "live_certified",
                "wrappers": 17,
                "e2eRepositories": 17,
                "realLocks": 17,
                "liveCertifications": 17,
                "failed": 0,
            }
            if evidence != expected_wrapper_evidence:
                fail("wrappers.requiredEvidence differs")
            normalized["requiredEvidence"] = expected_wrapper_evidence
        normalized_stages.append(normalized)

    by_id = {stage["id"]: stage for stage in normalized_stages}
    if by_id["clients"]["embeddedCoreSha"] != by_id["core"]["sourceSha"]:
        fail("clients embedded core differs from core source")
    if by_id["e2e"]["pinnedCoreSha"] != by_id["core"]["sourceSha"]:
        fail("E2E core pin differs from core source")
    if by_id["e2e"]["pinnedClientsSha"] != by_id["clients"]["sourceSha"]:
        fail("E2E clients pin differs from clients source")

    if value.get("derivedStateOrder") != EXPECTED_STATES:
        fail("derivedStateOrder differs")
    if value.get("allowedActionsByState") != EXPECTED_ACTIONS:
        fail("allowedActionsByState differs")
    if value.get("rules") != EXPECTED_RULES:
        fail("rules differ from the fail-closed contract")

    return {
        "schemaVersion": 1,
        "ownerIssue": owner_issue,
        "architectureIssue": architecture_issue,
        "packagePlane": {
            "zedCliSha": zed_cli,
            "zedInterfacesSha": zed_interfaces,
        },
        "stages": normalized_stages,
        "derivedStateOrder": list(EXPECTED_STATES),
        "allowedActionsByState": dict(EXPECTED_ACTIONS),
        "rules": dict(EXPECTED_RULES),
    }


def stage_map(contract: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {stage["id"]: stage for stage in contract["stages"]}


def expected_lock_projection(stage: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        {
            "package": f"opto-sync/{package['name']}",
            "version": stage["version"],
            "sha256": package["sha256"],
            "size": package["size"],
            "format": package["format"],
            "vcsTag": stage["tag"],
            "vcsCommit": stage["sourceSha"],
        }
        for package in stage["packages"]
    ]


def validate_lock_projection(
    actual: Any,
    stage: dict[str, Any],
    label: str,
) -> None:
    if not isinstance(actual, list):
        fail(f"{label} must be an array")
    expected = expected_lock_projection(stage)
    if actual != expected:
        fail(f"{label} differs from the expected package locks")


def validate_native_core_report(
    report: dict[str, Any],
    stage: dict[str, Any],
) -> bool:
    if report.get("schemaVersion") != 1:
        fail("core report schemaVersion must be 1")
    if report.get("ownerIssue") != stage["outcomeIssue"]:
        fail("core report ownerIssue differs")
    if report.get("repository") != stage["repository"]:
        fail("core report repository differs")
    verified = report.get("publicationVerified")
    if not isinstance(verified, bool):
        fail("core report publicationVerified must be boolean")
    expected_state = stage["requiredEvidence"]["state"] if verified else "not_verified"
    if report.get("state") != expected_state:
        fail("core report state differs from publicationVerified")
    release = report.get("release")
    if not isinstance(release, dict):
        fail("core report release must be an object")
    expected_release = {
        "tag": stage["tag"],
        "version": stage["version"],
        "targetSha": stage["sourceSha"],
        "targetTreeSha": stage["treeSha"],
    }
    if release != expected_release:
        fail("core report release identity differs")
    summary = report.get("summary")
    if not isinstance(summary, dict):
        fail("core report summary must be an object")
    for field in ("checks", "passed", "failed", "locks"):
        require_nonnegative_int(summary.get(field), f"core report summary.{field}")
    if verified:
        required = stage["requiredEvidence"]
        if summary != {
            "checks": required["checks"],
            "passed": required["checks"],
            "failed": 0,
            "locks": required["locks"],
        }:
            fail("verified core report summary differs")
        checks = report.get("checks")
        if not isinstance(checks, list):
            fail("verified core report checks must be an array")
        matching = [
            check
            for check in checks
            if isinstance(check, dict)
            and check.get("name") == "three_frozen_locks"
            and check.get("passed") is True
        ]
        if len(matching) != 1:
            fail("verified core report lacks one passed three_frozen_locks check")
        validate_lock_projection(
            matching[0].get("detail"),
            stage,
            "core report three_frozen_locks.detail",
        )
    else:
        if summary.get("failed", 0) < 1:
            fail("unverified core report must contain at least one failed check")
    return verified


def expected_dependencies(
    stage_id: str,
    stages: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    core = stages["core"]
    clients = stages["clients"]
    core_dependency = {
        "repository": core["repository"],
        "sourceSha": core["sourceSha"],
        "tag": core["tag"],
        "packages": expected_lock_projection(core),
    }
    if stage_id == "clients":
        return {"core": core_dependency}
    if stage_id == "e2e":
        return {
            "core": core_dependency,
            "clients": {
                "repository": clients["repository"],
                "sourceSha": clients["sourceSha"],
                "tag": clients["tag"],
                "packages": expected_lock_projection(clients),
            },
        }
    fail(f"unsupported dependency stage: {stage_id}")


def validate_generic_publication_report(
    report: dict[str, Any],
    stage: dict[str, Any],
    stages: dict[str, dict[str, Any]],
) -> bool:
    stage_id = stage["id"]
    label = f"{stage_id} report"
    if report.get("schemaVersion") != 1:
        fail(f"{label} schemaVersion must be 1")
    if report.get("stage") != stage_id:
        fail(f"{label} stage differs")
    if report.get("ownerIssue") != stage["outcomeIssue"]:
        fail(f"{label} ownerIssue differs")
    if report.get("repository") != stage["repository"]:
        fail(f"{label} repository differs")
    verified = report.get("publicationVerified")
    if not isinstance(verified, bool):
        fail(f"{label} publicationVerified must be boolean")
    expected_state = stage["requiredEvidence"]["state"] if verified else "not_verified"
    if report.get("state") != expected_state:
        fail(f"{label} state differs from publicationVerified")
    release = report.get("release")
    if release != {
        "tag": stage["tag"],
        "version": stage["version"],
        "targetSha": stage["sourceSha"],
        "targetTreeSha": stage["treeSha"],
    }:
        fail(f"{label} release identity differs")
    if report.get("dependencies") != expected_dependencies(stage_id, stages):
        fail(f"{label} dependency evidence differs")
    summary = report.get("summary")
    if not isinstance(summary, dict):
        fail(f"{label} summary must be an object")
    for field in ("checks", "passed", "failed", "locks"):
        require_nonnegative_int(summary.get(field), f"{label} summary.{field}")
    if verified:
        required = stage["requiredEvidence"]
        if summary != {
            "checks": required["checks"],
            "passed": required["checks"],
            "failed": 0,
            "locks": required["locks"],
        }:
            fail(f"verified {label} summary differs")
        validate_lock_projection(
            report.get("packages"),
            stage,
            f"{label} packages",
        )
    else:
        if summary.get("failed", 0) < 1:
            fail(f"unverified {label} must contain at least one failed check")
        if report.get("packages") not in (None, []):
            fail(f"unverified {label} cannot claim package locks")
    return verified


def validate_wrappers_report(
    report: dict[str, Any],
    stage: dict[str, Any],
    contract: dict[str, Any],
) -> bool:
    if report.get("schemaVersion") != 1:
        fail("wrappers report schemaVersion must be 1")
    if report.get("stage") != "wrappers":
        fail("wrappers report stage differs")
    if report.get("ownerIssue") != stage["outcomeIssue"]:
        fail("wrappers report ownerIssue differs")
    verified = report.get("certificationVerified")
    if not isinstance(verified, bool):
        fail("wrappers report certificationVerified must be boolean")
    expected_state = stage["requiredEvidence"]["state"] if verified else "not_verified"
    if report.get("state") != expected_state:
        fail("wrappers report state differs from certificationVerified")
    if report.get("packagePlane") != contract["packagePlane"]:
        fail("wrappers report package-plane pins differ")
    stages = stage_map(contract)
    if report.get("releaseSet") != {
        "core": {
            "tag": stages["core"]["tag"],
            "sourceSha": stages["core"]["sourceSha"],
        },
        "clients": {
            "tag": stages["clients"]["tag"],
            "sourceSha": stages["clients"]["sourceSha"],
        },
        "e2e": {
            "tag": stages["e2e"]["tag"],
            "sourceSha": stages["e2e"]["sourceSha"],
        },
    }:
        fail("wrappers report releaseSet differs")
    summary = report.get("summary")
    if not isinstance(summary, dict):
        fail("wrappers report summary must be an object")
    expected_summary = {
        key: value
        for key, value in stage["requiredEvidence"].items()
        if key != "state"
    }
    if verified:
        if summary != expected_summary:
            fail("verified wrappers report summary differs")
    else:
        for key in ("wrappers", "e2eRepositories", "realLocks", "liveCertifications", "failed"):
            require_nonnegative_int(summary.get(key), f"wrappers report summary.{key}")
        if summary.get("failed", 0) < 1:
            fail("unverified wrappers report must contain at least one failure")
    return verified


def derive_state(
    contract: dict[str, Any],
    reports: dict[str, dict[str, Any] | None],
) -> dict[str, Any]:
    stages = stage_map(contract)
    verified: dict[str, bool] = {}
    normalized_reports: dict[str, dict[str, Any]] = {}

    for stage_id in EXPECTED_STAGE_IDS:
        report = reports.get(stage_id)
        prerequisite = EXPECTED_PREREQUISITES[stage_id]
        if report is not None and prerequisite is not None:
            prerequisite_report = reports.get(prerequisite)
            if prerequisite_report is None:
                fail(
                    f"{stage_id} report was supplied before {prerequisite} evidence"
                )
            if verified.get(prerequisite) is not True:
                fail(
                    f"{stage_id} report was supplied before {prerequisite} was verified"
                )
        if report is None:
            verified[stage_id] = False
            normalized_reports[stage_id] = {
                "provided": False,
                "verified": False,
            }
            continue
        if stage_id == "core":
            result = validate_native_core_report(report, stages[stage_id])
        elif stage_id in {"clients", "e2e"}:
            result = validate_generic_publication_report(
                report,
                stages[stage_id],
                stages,
            )
        else:
            result = validate_wrappers_report(
                report,
                stages[stage_id],
                contract,
            )
        verified[stage_id] = result
        normalized_reports[stage_id] = {
            "provided": True,
            "verified": result,
            "ownerIssue": report.get("ownerIssue"),
            "state": report.get("state"),
        }

    if verified["wrappers"]:
        state = "fleet_live_certified"
        pending_stage = None
    elif verified["e2e"]:
        state = "e2e_verified"
        pending_stage = "wrappers"
    elif verified["clients"]:
        state = "clients_verified"
        pending_stage = "e2e"
    elif verified["core"]:
        state = "core_verified"
        pending_stage = "clients"
    else:
        state = "await_core_publication_verification"
        pending_stage = "core"

    verified_stages = [
        stage_id for stage_id in EXPECTED_STAGE_IDS if verified[stage_id]
    ]
    return {
        "schemaVersion": 1,
        "ownerIssue": contract["ownerIssue"],
        "architectureIssue": contract["architectureIssue"],
        "readOnly": True,
        "currentState": state,
        "verifiedStages": verified_stages,
        "pendingStage": pending_stage,
        "allowedActions": list(contract["allowedActionsByState"][state]),
        "packagePlane": dict(contract["packagePlane"]),
        "reports": normalized_reports,
    }


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--contract", type=Path, default=DEFAULT_CONTRACT)
    parser.add_argument("--core-report", type=Path)
    parser.add_argument("--clients-report", type=Path)
    parser.add_argument("--e2e-report", type=Path)
    parser.add_argument("--wrappers-report", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        contract = validate_contract(load_object(args.contract, "release-chain contract"))
        report_paths = {
            "core": args.core_report,
            "clients": args.clients_report,
            "e2e": args.e2e_report,
            "wrappers": args.wrappers_report,
        }
        reports = {
            stage_id: (
                load_object(path, f"{stage_id} report") if path is not None else None
            )
            for stage_id, path in report_paths.items()
        }
        result = derive_state(contract, reports)
        write_json(args.output, result)
        print(json.dumps({
            "currentState": result["currentState"],
            "allowedActions": result["allowedActions"],
        }, sort_keys=True))
        return 0
    except ChainError as exc:
        result = {
            "schemaVersion": 1,
            "ownerIssue": "DEN-309",
            "readOnly": True,
            "currentState": "contract_invalid",
            "verifiedStages": [],
            "pendingStage": None,
            "allowedActions": [],
            "errors": [str(exc)],
        }
        write_json(args.output, result)
        print(f"opto-sync-release-chain: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
