#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RELEASE = ROOT / "release/opto-sync-release-set.candidate.json"
COMPAT = ROOT / "compatibility/contract.v1.json"
ZERO_SHA256 = "0" * 64
SHA = re.compile(r"^[0-9a-f]{40}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
ARTIFACT_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
EXPECTED_PACKAGES = {"syncer", "clients", "e2e"}


def fail(message: str) -> None:
    print(f"release-contract: {message}", file=sys.stderr)
    raise SystemExit(1)


def load(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"cannot load {path.relative_to(ROOT)}: {exc}")
    if not isinstance(value, dict):
        fail(f"{path.relative_to(ROOT)} must contain a JSON object")
    return value


def require_text(value: object, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        fail(f"{label} must be a non-empty string")
    return value.strip()


def require_sha(value: object, label: str) -> str:
    text = require_text(value, label)
    if not SHA.fullmatch(text):
        fail(f"{label} must be a 40-character lowercase commit SHA")
    return text


def require_sha256(value: object, label: str) -> str:
    text = require_text(value, label)
    if not SHA256.fullmatch(text):
        fail(f"{label} must be a 64-character lowercase SHA-256")
    return text


def validate_repository(value: object, label: str) -> str:
    repository = require_text(value, label)
    if repository.count("/") != 1 or repository.startswith("/") or repository.endswith("/"):
        fail(f"{label} must use owner/name")
    return repository


def validate_release_evidence(release: dict) -> int:
    packages = release.get("packages")
    if not isinstance(packages, dict) or set(packages) != EXPECTED_PACKAGES:
        fail("packages must contain exactly syncer, clients, and e2e")

    for name, package in packages.items():
        if not isinstance(package, dict):
            fail(f"packages.{name} must be an object")
        validate_repository(package.get("repository"), f"packages.{name}.repository")
        require_sha(package.get("sha"), f"packages.{name}.sha")
        require_sha(package.get("treeSha"), f"packages.{name}.treeSha")
        version = require_text(package.get("version"), f"packages.{name}.version")
        if package.get("tag") != f"v{version}":
            fail(f"packages.{name}.tag must equal v{version}")
        require_text(package.get("zedPackage"), f"packages.{name}.zedPackage")
        archive = require_text(package.get("canonicalArchive"), f"packages.{name}.canonicalArchive")
        if Path(archive).name != archive or not archive.endswith(".tar.gz"):
            fail(f"packages.{name}.canonicalArchive must be a safe tar.gz filename")

    syncer_sha = packages["syncer"]["sha"]
    clients_sha = packages["clients"]["sha"]
    if packages["clients"].get("embeddedSyncerSha") != syncer_sha:
        fail("clients embedded core differs from release syncer SHA")
    if packages["e2e"].get("pinnedSyncerSha") != syncer_sha:
        fail("E2E syncer pin differs from release syncer SHA")
    if packages["e2e"].get("pinnedClientsSha") != clients_sha:
        fail("E2E clients pin differs from release clients SHA")

    versions = {packages[name]["version"] for name in EXPECTED_PACKAGES}
    if len(versions) != 3:
        fail("package versions must remain independently explicit")

    certification = release.get("certification")
    if not isinstance(certification, dict):
        fail("certification must be an object")
    runs = certification.get("requiredRuns")
    if not isinstance(runs, list) or len(runs) < 3:
        fail("certification.requiredRuns must contain at least three runs")
    by_repository: dict[str, dict] = {}
    for index, run in enumerate(runs):
        if not isinstance(run, dict):
            fail(f"certification.requiredRuns[{index}] must be an object")
        repository = validate_repository(run.get("repository"), f"requiredRuns[{index}].repository")
        if repository in by_repository:
            fail(f"duplicate required run for {repository}")
        by_repository[repository] = run
        validate_repository(run.get("workflowRepository"), f"requiredRuns[{index}].workflowRepository")
        require_text(run.get("workflow"), f"requiredRuns[{index}].workflow")
        if not isinstance(run.get("runId"), int) or run["runId"] <= 0:
            fail(f"requiredRuns[{index}].runId must be a positive integer")
        if not isinstance(run.get("runAttempt"), int) or run["runAttempt"] <= 0:
            fail(f"requiredRuns[{index}].runAttempt must be a positive integer")
        if run.get("conclusion") != "success":
            fail(f"required run for {repository} is not successful")
        require_sha(run.get("headSha"), f"requiredRuns[{index}].headSha")
        require_sha(run.get("workflowSha"), f"requiredRuns[{index}].workflowSha")
        require_sha(run.get("testedSha"), f"requiredRuns[{index}].testedSha")
        require_text(run.get("evidenceArtifact"), f"requiredRuns[{index}].evidenceArtifact")
        if not isinstance(run.get("evidenceArtifactId"), int) or run["evidenceArtifactId"] <= 0:
            fail(f"requiredRuns[{index}].evidenceArtifactId must be a positive integer")
        digest = require_text(run.get("evidenceArtifactDigest"), f"requiredRuns[{index}].evidenceArtifactDigest")
        if not ARTIFACT_DIGEST.fullmatch(digest):
            fail(f"requiredRuns[{index}].evidenceArtifactDigest must use sha256:<64 hex>")

    for name, package in packages.items():
        repository = package["repository"]
        run = by_repository.get(repository)
        if not run:
            fail(f"no required certification run for {name}")
        if run["testedSha"] != package["sha"]:
            fail(f"required run for {name} did not test the package SHA")

    checksums = certification.get("artifactChecksums")
    if not isinstance(checksums, dict) or set(checksums) != EXPECTED_PACKAGES:
        fail("certification.artifactChecksums must contain exactly syncer, clients, and e2e")
    placeholder_count = 0
    for name in EXPECTED_PACKAGES:
        checksum = require_sha256(checksums.get(name), f"artifactChecksums.{name}")
        if checksum == ZERO_SHA256:
            placeholder_count += 1

    artifact_files = certification.get("artifactFiles")
    if not isinstance(artifact_files, list) or not artifact_files:
        fail("certification.artifactFiles must be a non-empty array")
    filenames: set[str] = set()
    canonical_by_source: dict[str, dict] = {}
    for index, artifact in enumerate(artifact_files):
        if not isinstance(artifact, dict):
            fail(f"artifactFiles[{index}] must be an object")
        source = require_text(artifact.get("source"), f"artifactFiles[{index}].source")
        if source not in EXPECTED_PACKAGES:
            fail(f"artifactFiles[{index}].source is unsupported: {source}")
        filename = require_text(artifact.get("filename"), f"artifactFiles[{index}].filename")
        if Path(filename).name != filename or not filename.endswith(".tar.gz"):
            fail(f"artifactFiles[{index}].filename must be a safe tar.gz filename")
        if filename in filenames:
            fail(f"duplicate artifact filename: {filename}")
        filenames.add(filename)
        require_sha256(artifact.get("sha256"), f"artifactFiles[{index}].sha256")
        for field in ("size", "fileCount"):
            if not isinstance(artifact.get(field), int) or artifact[field] <= 0:
                fail(f"artifactFiles[{index}].{field} must be a positive integer")
        if not isinstance(artifact.get("canonical"), bool):
            fail(f"artifactFiles[{index}].canonical must be boolean")
        if artifact["canonical"]:
            if source in canonical_by_source:
                fail(f"multiple canonical artifacts for {source}")
            canonical_by_source[source] = artifact

    if set(canonical_by_source) != EXPECTED_PACKAGES:
        fail("exactly one canonical artifact is required for each package source")
    for name, package in packages.items():
        artifact = canonical_by_source[name]
        if artifact["filename"] != package["canonicalArchive"]:
            fail(f"canonical archive mismatch for {name}")
        if artifact["sha256"] != checksums[name]:
            fail(f"canonical checksum mismatch for {name}")

    tooling = certification.get("tooling")
    if not isinstance(tooling, dict):
        fail("certification.tooling must be an object")
    validate_repository(tooling.get("zedCliRepository"), "certification.tooling.zedCliRepository")
    require_sha(tooling.get("zedCliSha"), "certification.tooling.zedCliSha")
    validate_repository(tooling.get("zedInterfacesRepository"), "certification.tooling.zedInterfacesRepository")
    require_sha(tooling.get("zedInterfacesSha"), "certification.tooling.zedInterfacesSha")
    if certification.get("publicationPerformed") is not False:
        fail("candidate certification must explicitly state publicationPerformed=false")

    return placeholder_count


def main() -> int:
    release = load(RELEASE)
    compat = load(COMPAT)

    if release.get("schemaVersion") != 1:
        fail("release schemaVersion must be 1")
    metadata = release.get("releaseSet")
    if not isinstance(metadata, dict):
        fail("releaseSet must be an object")
    status = require_text(metadata.get("status"), "releaseSet.status")
    if status not in {"candidate", "approved", "published", "deprecated"}:
        fail(f"unsupported release status: {status}")
    require_text(metadata.get("id"), "releaseSet.id")
    require_text(metadata.get("createdAt"), "releaseSet.createdAt")

    placeholder_count = validate_release_evidence(release)

    rollback = release.get("rollback")
    if not isinstance(rollback, dict):
        fail("rollback must be an object")
    owner = require_text(rollback.get("owner"), "rollback.owner")
    procedure = require_text(rollback.get("procedure"), "rollback.procedure")
    require_text(rollback.get("partialReleasePolicy"), "rollback.partialReleasePolicy")
    incomplete_rollback = owner.startswith("REQUIRED_") or procedure.startswith("REQUIRED_")
    if not incomplete_rollback:
        procedure_path = ROOT / procedure
        if not procedure_path.is_file():
            fail(f"rollback procedure does not exist: {procedure}")

    if status in {"approved", "published"} and (placeholder_count or incomplete_rollback):
        fail("approved/published release sets cannot contain placeholder checksums or rollback ownership")

    protocol = compat["protocol"]
    if protocol["incompatibleAction"] != "fail_closed_before_mutation":
        fail("incompatible peers must fail before mutation")
    if compat["supportWindow"]["historicalFixturesRequiredBeforeStable"] is not True:
        fail("historical fixtures must be required before stable support claims")

    required = {"typescript", "dart", "rust", "gleam"}
    if set(compat["requiredClientBehavior"]) != required:
        fail("compatibility contract must cover exactly the four supported clients")

    print(
        "release and compatibility contracts passed: "
        f"status={status}, placeholder_checksums={placeholder_count}, "
        f"evidence_runs={len(release['certification']['requiredRuns'])}, "
        f"artifacts={len(release['certification']['artifactFiles'])}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
