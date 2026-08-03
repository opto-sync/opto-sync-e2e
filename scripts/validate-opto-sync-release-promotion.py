#!/usr/bin/env python3
"""Read-only, fail-closed Opto-Sync release promotion state machine."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

SHA40 = re.compile(r"^[0-9a-f]{40}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")


class ContractError(ValueError):
    pass


def fail(message: str) -> None:
    raise ContractError(message)


def exact(value: dict[str, Any], keys: set[str], context: str) -> None:
    if set(value) != keys:
        fail(f"{context}: keys differ: actual={sorted(value)}, expected={sorted(keys)}")


def text(value: Any, context: str) -> str:
    if not isinstance(value, str) or not value:
        fail(f"{context}: expected non-empty string")
    return value


def integer(value: Any, context: str, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        fail(f"{context}: expected integer >= {minimum}")
    return value


def boolean(value: Any, context: str) -> bool:
    if not isinstance(value, bool):
        fail(f"{context}: expected boolean")
    return value


def sha(value: Any, context: str) -> str:
    value = text(value, context)
    if not SHA40.fullmatch(value):
        fail(f"{context}: expected 40 lowercase hex")
    return value


def sha256(value: Any, context: str) -> str:
    value = text(value, context)
    if not SHA256.fullmatch(value) or value == "0" * 64:
        fail(f"{context}: expected non-zero SHA-256")
    return value


def digest(value: Any, context: str) -> str:
    value = text(value, context)
    if not DIGEST.fullmatch(value) or value == "sha256:" + "0" * 64:
        fail(f"{context}: expected non-zero sha256 digest")
    return value


def canonical(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


canonical_bytes = canonical


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"{path}: invalid JSON: {exc}")
    if not isinstance(value, dict):
        fail(f"{path}: root must be object")
    return value


def validate_contract(value: dict[str, Any]) -> dict[str, Any]:
    contract = copy.deepcopy(value)
    exact(contract, {"schemaVersion", "ownerIssue", "parentIssue", "releaseSetId", "reportSchemaVersion", "registrySource", "stages", "wrapperFleet", "states"}, "contract")
    if contract["schemaVersion"] != 1 or contract["reportSchemaVersion"] != 1:
        fail("contract: schema versions must be 1")
    if contract["ownerIssue"] != "DEN-1591":
        fail("contract.ownerIssue: expected DEN-1591")
    text(contract["parentIssue"], "contract.parentIssue")
    text(contract["releaseSetId"], "contract.releaseSetId")
    if contract["registrySource"] != "https://registry.zpkg.tech":
        fail("contract.registrySource: expected production registry")

    expected = [
        ("core_publication", "corePublication", "publication"),
        ("clients_publication", "clientsPublication", "publication"),
        ("e2e_publication", "e2ePublication", "publication"),
        ("wrapper_certification", "wrapperCertification", "certification"),
    ]
    stages = contract["stages"]
    if not isinstance(stages, list) or len(stages) != 4:
        fail("contract.stages: expected four stages")
    for index, (stage, expected_stage) in enumerate(zip(stages, expected)):
        if not isinstance(stage, dict):
            fail(f"contract.stages[{index}]: expected object")
        keys = {"name", "reportKey", "kind", "verifiedField"}
        if index < 3:
            keys |= {"manifestPackage", "packages"}
        exact(stage, keys, f"contract.stages[{index}]")
        if (stage["name"], stage["reportKey"], stage["kind"]) != expected_stage:
            fail(f"contract.stages[{index}]: unexpected stage order or kind")
        required_flag = "publicationVerified" if index < 3 else "certificationVerified"
        if stage["verifiedField"] != required_flag:
            fail(f"contract.stages[{index}].verifiedField: expected {required_flag}")
        if index < 3:
            text(stage["manifestPackage"], f"contract.stages[{index}].manifestPackage")
            packages = stage["packages"]
            if not isinstance(packages, list) or not packages:
                fail(f"contract.stages[{index}].packages: expected non-empty list")
            seen: set[tuple[str, str]] = set()
            for package in packages:
                if not isinstance(package, dict):
                    fail("contract package: expected object")
                exact(package, {"org", "name", "artifactFilename"}, "contract package")
                identity = (text(package["org"], "package.org"), text(package["name"], "package.name"))
                if identity in seen:
                    fail(f"contract package: duplicate {identity}")
                seen.add(identity)
                text(package["artifactFilename"], "package.artifactFilename")

    fleet = contract["wrapperFleet"]
    if not isinstance(fleet, dict):
        fail("contract.wrapperFleet: expected object")
    exact(fleet, {"wrappers", "e2e"}, "contract.wrapperFleet")
    if integer(fleet["wrappers"], "wrapperFleet.wrappers", 1) != 17 or integer(fleet["e2e"], "wrapperFleet.e2e", 1) != 15:
        fail("contract.wrapperFleet: expected 17 wrappers and 15 E2E repositories")

    state_names = ["await_core_publication_verification", "core_publication_verified", "clients_publication_verified", "e2e_publication_verified", "wrapper_certification_verified"]
    states = contract["states"]
    if not isinstance(states, list) or len(states) != 5:
        fail("contract.states: expected five states")
    for index, state in enumerate(states):
        if not isinstance(state, dict):
            fail(f"contract.states[{index}]: expected object")
        exact(state, {"verifiedStageCount", "state", "allowedActions"}, f"contract.states[{index}]")
        if state["verifiedStageCount"] != index or state["state"] != state_names[index]:
            fail(f"contract.states[{index}]: unexpected state")
        actions = state["allowedActions"]
        if not isinstance(actions, list) or not actions or len(actions) != len(set(actions)) or not all(isinstance(action, str) and action for action in actions):
            fail(f"contract.states[{index}].allowedActions: invalid")
    return contract


def validate_release_set(value: dict[str, Any], contract: dict[str, Any]) -> dict[str, Any]:
    if value.get("schemaVersion") != 1:
        fail("releaseSet.schemaVersion: expected 1")
    release = value.get("releaseSet")
    packages = value.get("packages")
    certification = value.get("certification")
    if not isinstance(release, dict) or release.get("id") != contract["releaseSetId"]:
        fail("releaseSet.releaseSet.id: does not match promotion contract")
    if not isinstance(packages, dict) or set(packages) != {"syncer", "clients", "e2e"}:
        fail("releaseSet.packages: expected syncer, clients, and e2e")
    if not isinstance(certification, dict) or not isinstance(certification.get("artifactFiles"), list):
        fail("releaseSet.certification.artifactFiles: expected array")
    artifacts = certification["artifactFiles"]
    if len(artifacts) != 5:
        fail("releaseSet.certification.artifactFiles: expected five artifacts")
    by_file: dict[str, dict[str, Any]] = {}
    for index, artifact in enumerate(artifacts):
        if not isinstance(artifact, dict):
            fail(f"artifactFiles[{index}]: expected object")
        filename = text(artifact.get("filename"), f"artifactFiles[{index}].filename")
        if filename in by_file:
            fail(f"artifactFiles: duplicate filename {filename}")
        sha256(artifact.get("sha256"), f"artifactFiles[{index}].sha256")
        integer(artifact.get("size"), f"artifactFiles[{index}].size", 1)
        by_file[filename] = artifact

    expected: dict[str, list[dict[str, Any]]] = {}
    for stage in contract["stages"][:3]:
        manifest = packages.get(stage["manifestPackage"])
        if not isinstance(manifest, dict):
            fail(f"releaseSet.packages.{stage['manifestPackage']}: expected object")
        stage["expectedIdentity"] = {
            "repository": text(manifest.get("repository"), "manifest.repository"),
            "tag": text(manifest.get("tag"), "manifest.tag"),
            "version": text(manifest.get("version"), "manifest.version"),
            "sourceCommit": sha(manifest.get("sha"), "manifest.sha"),
        }
        values: list[dict[str, Any]] = []
        for package in stage["packages"]:
            artifact = by_file.get(package["artifactFilename"])
            if artifact is None:
                fail(f"releaseSet: missing artifact {package['artifactFilename']}")
            values.append({
                "org": package["org"], "name": package["name"],
                "version": stage["expectedIdentity"]["version"],
                "sha256": artifact["sha256"], "size": artifact["size"],
                "format": "tar.gz", "vcsTag": stage["expectedIdentity"]["tag"],
                "vcsCommit": stage["expectedIdentity"]["sourceCommit"],
                "source": contract["registrySource"],
            })
        expected[stage["name"]] = sorted(values, key=lambda item: (item["org"], item["name"]))
    return {"expectedPackages": expected, "releaseSetDigest": "sha256:" + hashlib.sha256(canonical(value)).hexdigest()}


def validate_package_plane(value: dict[str, Any]) -> dict[str, str]:
    if value.get("schemaVersion") != 1:
        fail("packagePlane.schemaVersion: expected 1")
    cli, interfaces, variables = value.get("zedCli"), value.get("zedInterfaces"), value.get("requiredWorkflowVariables")
    if not isinstance(cli, dict) or not isinstance(interfaces, dict) or not isinstance(variables, dict):
        fail("packagePlane: missing final pin objects")
    cli_sha, interface_sha = sha(cli.get("sha"), "packagePlane.zedCli.sha"), sha(interfaces.get("sha"), "packagePlane.zedInterfaces.sha")
    if cli.get("interfaceDependencySha") != interface_sha:
        fail("packagePlane: zed-cli interface dependency does not match")
    expected = {"ZED_CLI_SHA": cli_sha, "ZED_INTERFACES_SHA": interface_sha}
    if variables != expected:
        fail("packagePlane.requiredWorkflowVariables: exact final pins required")
    forbidden = value.get("forbiddenPins")
    if not isinstance(forbidden, list) or cli_sha in forbidden or interface_sha in forbidden:
        fail("packagePlane.forbiddenPins: final pins must remain allowed")
    return {"zedCliSha": cli_sha, "zedInterfacesSha": interface_sha}


def validate_packages(value: Any, expected: list[dict[str, Any]], context: str) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        fail(f"{context}: expected array")
    keys = {"org", "name", "version", "sha256", "size", "format", "vcsTag", "vcsCommit", "source"}
    normalized: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for index, package in enumerate(value):
        if not isinstance(package, dict):
            fail(f"{context}[{index}]: expected object")
        exact(package, keys, f"{context}[{index}]")
        identity = (text(package["org"], "package.org"), text(package["name"], "package.name"))
        if identity in seen:
            fail(f"{context}: duplicate package {identity[0]}/{identity[1]}")
        seen.add(identity)
        sha256(package["sha256"], "package.sha256")
        sha(package["vcsCommit"], "package.vcsCommit")
        integer(package["size"], "package.size", 1)
        normalized.append(copy.deepcopy(package))
    normalized.sort(key=lambda item: (item["org"], item["name"]))
    if normalized != expected:
        fail(f"{context}: package identities or immutable fields differ")
    return normalized


def validate_publication(report: dict[str, Any], stage: dict[str, Any], expected: list[dict[str, Any]], contract: dict[str, Any]) -> tuple[bool, list[str]]:
    context = stage["reportKey"]
    exact(report, {"schemaVersion", "releaseSetId", "repository", "tag", "version", "sourceCommit", "publicationVerified", "failedCount", "artifactDigest", "packages"}, context)
    if report["schemaVersion"] != 1 or report["releaseSetId"] != contract["releaseSetId"]:
        fail(f"{context}: schema or release set mismatch")
    for key, expected_value in stage["expectedIdentity"].items():
        if report[key] != expected_value:
            fail(f"{context}.{key}: immutable identity mismatch")
    sha(report["sourceCommit"], f"{context}.sourceCommit")
    digest(report["artifactDigest"], f"{context}.artifactDigest")
    verified = boolean(report["publicationVerified"], f"{context}.publicationVerified")
    failed = integer(report["failedCount"], f"{context}.failedCount")
    validate_packages(report["packages"], expected, f"{context}.packages")
    reasons = ([] if verified else [f"{context}: publicationVerified is false"]) + ([] if failed == 0 else [f"{context}: failedCount is {failed}"])
    return verified and failed == 0, reasons


def all_packages(by_stage: dict[str, list[dict[str, Any]]]) -> list[dict[str, Any]]:
    values = [copy.deepcopy(item) for name in ("core_publication", "clients_publication", "e2e_publication") for item in by_stage[name]]
    return sorted(values, key=lambda item: (item["org"], item["name"]))


all_expected_packages = all_packages


def validate_certification(report: dict[str, Any], expected: dict[str, list[dict[str, Any]]], plane: dict[str, str], contract: dict[str, Any]) -> tuple[bool, list[str]]:
    context = "wrapperCertification"
    exact(report, {"schemaVersion", "releaseSetId", "certificationVerified", "failedCount", "packagePlane", "wrappers", "e2e", "packages"}, context)
    if report["schemaVersion"] != 1 or report["releaseSetId"] != contract["releaseSetId"]:
        fail(f"{context}: schema or release set mismatch")
    if report["packagePlane"] != plane:
        fail(f"{context}.packagePlane: stale or mismatched final pins")
    verified = boolean(report["certificationVerified"], f"{context}.certificationVerified")
    failed = integer(report["failedCount"], f"{context}.failedCount")
    reasons: list[str] = []
    complete_counts = True
    for key in ("wrappers", "e2e"):
        count = report[key]
        if not isinstance(count, dict):
            fail(f"{context}.{key}: expected object")
        exact(count, {"expected", "verified"}, f"{context}.{key}")
        expected_count = contract["wrapperFleet"][key]
        if count["expected"] != expected_count:
            fail(f"{context}.{key}.expected: expected {expected_count}")
        actual = integer(count["verified"], f"{context}.{key}.verified")
        if actual != expected_count:
            complete_counts = False
            label = "E2E" if key == "e2e" else key
            reasons.append(f"{context}: verified {label} {actual} != {expected_count}")
    validate_packages(report["packages"], all_packages(expected), f"{context}.packages")
    if not verified:
        reasons.append(f"{context}: certificationVerified is false")
    if failed:
        reasons.append(f"{context}: failedCount is {failed}")
    return verified and failed == 0 and complete_counts, reasons


def evaluate(contract_value: dict[str, Any], release_value: dict[str, Any], plane_value: dict[str, Any], reports_value: dict[str, Any]) -> dict[str, Any]:
    contract = validate_contract(contract_value)
    release = validate_release_set(release_value, contract)
    plane = validate_package_plane(plane_value)
    exact(reports_value, {"schemaVersion", "releaseSetId", "reports"}, "reports")
    if reports_value["schemaVersion"] != 1 or reports_value["releaseSetId"] != contract["releaseSetId"]:
        fail("reports: schema or release set mismatch")
    reports = reports_value["reports"]
    if not isinstance(reports, dict):
        fail("reports.reports: expected object")
    known = {stage["reportKey"] for stage in contract["stages"]}
    if set(reports) - known:
        fail(f"reports.reports: unknown report keys {sorted(set(reports) - known)}")

    outcomes, blocked = [], []
    verified_count, prerequisite_failed = 0, False
    for stage in contract["stages"]:
        key = stage["reportKey"]
        report = reports.get(key)
        if report is None:
            prerequisite_failed = True
            outcomes.append({"stage": stage["name"], "report": key, "outcome": "absent"})
            continue
        if not isinstance(report, dict):
            fail(f"reports.{key}: expected object")
        if prerequisite_failed:
            fail(f"reports.{key}: downstream evidence supplied before every prerequisite stage verified")
        if stage["kind"] == "publication":
            verified, reasons = validate_publication(report, stage, release["expectedPackages"][stage["name"]], contract)
        else:
            verified, reasons = validate_certification(report, release["expectedPackages"], plane, contract)
        outcomes.append({"stage": stage["name"], "report": key, "outcome": "verified" if verified else "not_verified"})
        if verified:
            verified_count += 1
        else:
            prerequisite_failed = True
            blocked.extend(reasons)

    state = contract["states"][verified_count]
    snapshot = {
        "schemaVersion": 1,
        "ownerIssue": contract["ownerIssue"],
        "releaseSetId": contract["releaseSetId"],
        "releaseSetDigest": release["releaseSetDigest"],
        "packagePlane": plane,
        "state": state["state"],
        "verifiedStages": [item["stage"] for item in outcomes if item["outcome"] == "verified"],
        "nextStage": contract["stages"][verified_count]["name"] if verified_count < 4 else None,
        "allowedActions": copy.deepcopy(state["allowedActions"]),
        "blockedReasons": sorted(blocked),
        "reportOutcomes": outcomes,
        "readOnly": True,
    }
    snapshot["snapshotDigest"] = "sha256:" + hashlib.sha256(canonical(snapshot)).hexdigest()
    return snapshot


def empty_reports(contract: dict[str, Any]) -> dict[str, Any]:
    return {"schemaVersion": contract["reportSchemaVersion"], "releaseSetId": contract["releaseSetId"], "reports": {}}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--contract", type=Path, required=True)
    parser.add_argument("--release-set", type=Path, required=True)
    parser.add_argument("--package-plane", type=Path, required=True)
    parser.add_argument("--reports", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv or sys.argv[1:])
    try:
        contract = read_json(args.contract)
        snapshot = evaluate(contract, read_json(args.release_set), read_json(args.package_plane), read_json(args.reports) if args.reports else empty_reports(contract))
        output = json.dumps(snapshot, sort_keys=True, indent=2) + "\n"
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(output, encoding="utf-8")
        else:
            sys.stdout.write(output)
        return 0
    except ContractError as exc:
        sys.stderr.write(f"promotion contract failed: {exc}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
