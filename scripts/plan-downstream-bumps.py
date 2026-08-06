#!/usr/bin/env python3
"""Validate one immutable release set and render non-mutating downstream bump plans."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
SHA = re.compile(r"^[0-9a-f]{40}$")
CHECKSUM = re.compile(r"^[0-9a-f]{64}$")
ARTIFACT_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
SAFE_PATH = re.compile(r"^[A-Za-z0-9._/-]+$")
PLACEHOLDER = {"", "REQUIRED_BEFORE_APPROVAL"}


def fail(message: str) -> None:
    print(f"downstream-bump-plan: {message}", file=sys.stderr)
    raise SystemExit(1)


def load(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"cannot load {path}: {exc}")
    if not isinstance(value, dict):
        fail(f"{path} must contain a JSON object")
    return value


def text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        fail(f"{label} must be a non-empty string")
    return value.strip()


def repository(value: Any, label: str) -> str:
    result = text(value, label)
    if result.count("/") != 1 or result.startswith("/") or result.endswith("/"):
        fail(f"{label} must use owner/name")
    return result


def relative_path(value: Any, label: str) -> str:
    result = text(value, label)
    if result.startswith("/") or ".." in Path(result).parts or "//" in result or not SAFE_PATH.fullmatch(result):
        fail(f"{label} must be a safe repository-relative path")
    return result


def validate_manifest(value: dict[str, Any]) -> None:
    if value.get("schemaVersion") != 1:
        fail("manifest.schemaVersion must be 1")
    prefix = text(value.get("branchPrefix"), "manifest.branchPrefix")
    if not prefix.startswith("agent/") or prefix.endswith("/"):
        fail("manifest.branchPrefix must be an agent/* prefix")
    relative_path(value.get("releaseContract"), "manifest.releaseContract")
    consumers = value.get("consumers")
    if not isinstance(consumers, list) or not consumers:
        fail("manifest.consumers must be a non-empty array")
    seen_repositories: set[str] = set()
    for index, consumer in enumerate(consumers):
        if not isinstance(consumer, dict):
            fail(f"manifest.consumers[{index}] must be an object")
        repo = repository(consumer.get("repository"), f"consumers[{index}].repository")
        if repo in seen_repositories:
            fail(f"duplicate downstream repository: {repo}")
        seen_repositories.add(repo)
        if consumer.get("defaultBranch") != "main":
            fail(f"{repo}: defaultBranch must be main")
        core = relative_path(consumer.get("coreGitlink"), f"{repo}.coreGitlink")
        clients = relative_path(consumer.get("clientsGitlink"), f"{repo}.clientsGitlink")
        if core == clients:
            fail(f"{repo}: core and clients gitlinks must be distinct")
        files = consumer.get("expectedShaFiles")
        if not isinstance(files, list) or not files or len(files) != len(set(files)):
            fail(f"{repo}: expectedShaFiles must be unique and non-empty")
        for path in files:
            relative_path(path, f"{repo}.expectedShaFiles")
        checks = consumer.get("requiredChecks")
        if not isinstance(checks, list) or not checks or not all(isinstance(item, str) and item.strip() for item in checks):
            fail(f"{repo}: requiredChecks must be non-empty strings")
        text(consumer.get("linearProject"), f"{repo}.linearProject")
        if consumer.get("autoMerge") is not False:
            fail(f"{repo}: autoMerge must remain false")


def package(value: dict[str, Any], name: str) -> dict[str, Any]:
    packages = value.get("packages")
    if not isinstance(packages, dict) or not isinstance(packages.get(name), dict):
        fail(f"release set is missing packages.{name}")
    return packages[name]


def validate_coordinated_run(run: dict[str, Any], package_entry: dict[str, Any], name: str) -> list[str]:
    blockers: list[str] = []
    if run.get("conclusion") != "success":
        blockers.append(f"required certification run for {name} is not successful")

    tested_sha = run.get("testedSha", run.get("headSha"))
    if tested_sha != package_entry["sha"]:
        blockers.append(f"required certification run for {name} did not test the package SHA")

    # A source-owned workflow may attest its own head directly. A coordinated
    # evidence controller may have a distinct workflow head, but then it must
    # explicitly identify the tested source SHA and immutable evidence artifact.
    if "testedSha" in run:
        for field in ("headSha", "workflowSha", "testedSha"):
            if not isinstance(run.get(field), str) or not SHA.fullmatch(run[field]):
                blockers.append(f"required certification run for {name} has invalid {field}")
        try:
            repository(run.get("workflowRepository"), f"requiredRuns.{name}.workflowRepository")
        except SystemExit:
            raise
        if not isinstance(run.get("runId"), int) or run["runId"] <= 0:
            blockers.append(f"required certification run for {name} has invalid runId")
        if not isinstance(run.get("runAttempt"), int) or run["runAttempt"] <= 0:
            blockers.append(f"required certification run for {name} has invalid runAttempt")
        if not isinstance(run.get("evidenceArtifactId"), int) or run["evidenceArtifactId"] <= 0:
            blockers.append(f"required certification run for {name} has no immutable artifact id")
        if not isinstance(run.get("evidenceArtifact"), str) or not run["evidenceArtifact"].strip():
            blockers.append(f"required certification run for {name} has no evidence artifact name")
        digest = run.get("evidenceArtifactDigest")
        if not isinstance(digest, str) or not ARTIFACT_DIGEST.fullmatch(digest):
            blockers.append(f"required certification run for {name} has no valid evidence artifact digest")
    else:
        head_sha = run.get("headSha")
        if not isinstance(head_sha, str) or not SHA.fullmatch(head_sha):
            blockers.append(f"required certification run for {name} has invalid headSha")

    return blockers


def release_blockers(value: dict[str, Any]) -> list[str]:
    if value.get("schemaVersion") != 1:
        fail("release.schemaVersion must be 1")
    metadata = value.get("releaseSet")
    if not isinstance(metadata, dict):
        fail("release.releaseSet must be an object")
    release_id = text(metadata.get("id"), "release.releaseSet.id")
    if not re.fullmatch(r"[a-z0-9][a-z0-9._-]*", release_id):
        fail("release.releaseSet.id must be lowercase and branch-safe")
    status = text(metadata.get("status"), "release.releaseSet.status")
    if status not in {"candidate", "approved", "published", "deprecated"}:
        fail(f"unsupported release status: {status}")

    syncer = package(value, "syncer")
    clients = package(value, "clients")
    e2e = package(value, "e2e")
    for name, entry in (("syncer", syncer), ("clients", clients), ("e2e", e2e)):
        repository(entry.get("repository"), f"packages.{name}.repository")
        if not SHA.fullmatch(text(entry.get("sha"), f"packages.{name}.sha")):
            fail(f"packages.{name}.sha must be a 40-hex commit")
        for field in ("tag", "version", "zedPackage"):
            text(entry.get(field), f"packages.{name}.{field}")
        tree_sha = entry.get("treeSha")
        if tree_sha is not None and (not isinstance(tree_sha, str) or not SHA.fullmatch(tree_sha)):
            fail(f"packages.{name}.treeSha must be a 40-hex tree")
        archive = entry.get("canonicalArchive")
        if archive is not None:
            relative_path(archive, f"packages.{name}.canonicalArchive")
    if clients.get("embeddedSyncerSha") != syncer["sha"]:
        fail("clients.embeddedSyncerSha differs from syncer.sha")
    if e2e.get("pinnedSyncerSha") != syncer["sha"] or e2e.get("pinnedClientsSha") != clients["sha"]:
        fail("E2E pins differ from the release core/client pair")

    blockers: list[str] = []
    if status != "published":
        blockers.append(f"release status is {status!r}, not 'published'")
    certification = value.get("certification")
    if not isinstance(certification, dict):
        fail("release.certification must be an object")
    checksums = certification.get("artifactChecksums")
    if not isinstance(checksums, dict):
        fail("release.certification.artifactChecksums must be an object")
    for name in ("syncer", "clients", "e2e"):
        checksum = checksums.get(name)
        if not isinstance(checksum, str) or not CHECKSUM.fullmatch(checksum):
            fail(f"artifact checksum {name} must be 64 lowercase hex")
        if set(checksum) == {"0"}:
            blockers.append(f"artifact checksum {name} is still a placeholder")

    artifacts = certification.get("artifactFiles")
    if artifacts is not None:
        if not isinstance(artifacts, list) or not artifacts:
            fail("release.certification.artifactFiles must be a non-empty array")
        canonical: dict[str, dict[str, Any]] = {}
        seen_files: set[str] = set()
        for index, artifact in enumerate(artifacts):
            if not isinstance(artifact, dict):
                fail(f"artifactFiles[{index}] must be an object")
            source = text(artifact.get("source"), f"artifactFiles[{index}].source")
            if source not in {"syncer", "clients", "e2e"}:
                fail(f"artifactFiles[{index}].source is unsupported")
            filename = relative_path(artifact.get("filename"), f"artifactFiles[{index}].filename")
            if filename in seen_files:
                fail(f"duplicate artifact filename: {filename}")
            seen_files.add(filename)
            checksum = artifact.get("sha256")
            if not isinstance(checksum, str) or not CHECKSUM.fullmatch(checksum):
                fail(f"artifactFiles[{index}].sha256 must be 64 lowercase hex")
            for field in ("size", "fileCount"):
                if not isinstance(artifact.get(field), int) or artifact[field] <= 0:
                    fail(f"artifactFiles[{index}].{field} must be a positive integer")
            if artifact.get("canonical") is True:
                if source in canonical:
                    fail(f"multiple canonical artifacts for {source}")
                canonical[source] = artifact
        if set(canonical) != {"syncer", "clients", "e2e"}:
            blockers.append("canonical artifact evidence is incomplete")
        else:
            for source, entry in (("syncer", syncer), ("clients", clients), ("e2e", e2e)):
                if canonical[source]["sha256"] != checksums[source]:
                    blockers.append(f"canonical artifact checksum for {source} differs from release checksum")
                expected_archive = entry.get("canonicalArchive")
                if expected_archive and canonical[source]["filename"] != expected_archive:
                    blockers.append(f"canonical artifact filename for {source} differs from package contract")

    runs = certification.get("requiredRuns")
    if not isinstance(runs, list) or len(runs) < 3:
        fail("certification.requiredRuns must contain at least three runs")
    by_repo = {run.get("repository"): run for run in runs if isinstance(run, dict)}
    for name, entry in (("syncer", syncer), ("clients", clients), ("e2e", e2e)):
        run = by_repo.get(entry["repository"])
        if not isinstance(run, dict):
            blockers.append(f"no required certification run for {name}")
        else:
            blockers.extend(validate_coordinated_run(run, entry, name))

    tooling = certification.get("tooling")
    if tooling is not None:
        if not isinstance(tooling, dict):
            fail("release.certification.tooling must be an object")
        repository(tooling.get("zedCliRepository"), "certification.tooling.zedCliRepository")
        repository(tooling.get("zedInterfacesRepository"), "certification.tooling.zedInterfacesRepository")
        for field in ("zedCliSha", "zedInterfacesSha"):
            if not isinstance(tooling.get(field), str) or not SHA.fullmatch(tooling[field]):
                fail(f"certification.tooling.{field} must be a 40-hex commit")
    if certification.get("publicationPerformed") not in {None, False}:
        blockers.append("candidate evidence unexpectedly reports that publication was performed")

    rollback = value.get("rollback")
    if not isinstance(rollback, dict):
        fail("release.rollback must be an object")
    for field in ("owner", "procedure", "partialReleasePolicy"):
        item = rollback.get(field)
        if not isinstance(item, str) or item.strip() in PLACEHOLDER:
            blockers.append(f"rollback.{field} is not approved")
    procedure = rollback.get("procedure")
    if isinstance(procedure, str) and procedure.strip() not in PLACEHOLDER:
        path = ROOT / procedure
        if not path.is_file():
            blockers.append(f"rollback.procedure does not exist: {procedure}")
    return blockers


def build_plan(release: dict[str, Any], manifest: dict[str, Any]) -> dict[str, Any]:
    validate_manifest(manifest)
    blockers = release_blockers(release)
    metadata = release["releaseSet"]
    syncer = package(release, "syncer")
    clients = package(release, "clients")
    e2e = package(release, "e2e")
    suffix = re.sub(r"[^a-z0-9._-]+", "-", metadata["id"].lower()).strip("-.")[:80]
    consumers: list[dict[str, Any]] = []
    for consumer in sorted(manifest["consumers"], key=lambda item: item["repository"]):
        checks = list(consumer["requiredChecks"])
        checks_markdown = "\n".join(f"- `{check}`" for check in checks)
        body = (
            "## Certified opto-sync release set\n\n"
            f"Release set: `{metadata['id']}`\n\n"
            f"- `syncer.c`: `{syncer['tag']}` / `{syncer['sha']}`\n"
            f"- `opto-sync-clients`: `{clients['tag']}` / `{clients['sha']}`\n"
            f"- E2E evidence: `{e2e['tag']}` / `{e2e['sha']}`\n\n"
            "Both gitlinks and every expected-SHA assertion are updated together. "
            "Do not merge if recursive core parity or consumer-specific checks fail.\n\n"
            f"## Required checks\n\n{checks_markdown}\n\n"
            "## Rollback\n\nRevert this pull request as one unit; never roll back only one gitlink.\n\n"
            "Auto-merge is intentionally disabled."
        )
        consumers.append(
            {
                "repository": consumer["repository"],
                "baseBranch": "main",
                "branch": manifest["branchPrefix"] + suffix,
                "updates": [
                    {"kind": "gitlink", "path": consumer["coreGitlink"], "sha": syncer["sha"]},
                    {"kind": "gitlink", "path": consumer["clientsGitlink"], "sha": clients["sha"]},
                ],
                "expectedShaReplacements": [
                    {"path": path, "syncerSha": syncer["sha"], "clientsSha": clients["sha"]}
                    for path in consumer["expectedShaFiles"]
                ],
                "requiredChecks": checks,
                "linearProject": consumer["linearProject"],
                "pullRequest": {
                    "title": f"Bump opto-sync to {metadata['id']}",
                    "body": body,
                    "draft": False,
                    "autoMerge": False,
                },
            }
        )
    return {
        "schemaVersion": 1,
        "releaseSetId": metadata["id"],
        "releaseStatus": metadata["status"],
        "dispatchAllowed": not blockers,
        "blockers": blockers,
        "consumers": consumers,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("validate", "plan"))
    parser.add_argument("--release", type=Path, default=ROOT / "release/opto-sync-release-set.candidate.json")
    parser.add_argument("--manifest", type=Path, default=ROOT / "operations/downstream-consumers.v1.json")
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    release = load(args.release)
    manifest = load(args.manifest)
    plan = build_plan(release, manifest)
    if args.command == "validate":
        print(f"downstream bump contracts ok: {len(plan['consumers'])} consumers, dispatchAllowed={str(plan['dispatchAllowed']).lower()}")
        return 0
    rendered = json.dumps(plan, indent=2, sort_keys=True) + "\n"
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(rendered, encoding="utf-8")
    else:
        sys.stdout.write(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
