#!/usr/bin/env python3
"""Validate and render deterministic evidence for one coordinated Opto-Sync release set."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tarfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PLAN = ROOT / "release/opto-sync-release-evidence-plan.v1.json"
SHA = re.compile(r"^[0-9a-f]{40}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
SEMVER = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+$")
RELEASE_ID = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
EXPECTED_SOURCES = {"syncer", "clients", "e2e"}
FORBIDDEN_ARCHIVE_PARTS = {
    ".git",
    ".github",
    ".zed",
    ".dart_tool",
    "node_modules",
    "target",
    "build",
    "_build",
    "deps",
}


def fail(message: str) -> "NoReturn":
    print(f"release-evidence: {message}", file=sys.stderr)
    raise SystemExit(1)


def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"cannot load {path}: {exc}")
    if not isinstance(value, dict):
        fail(f"{path} must contain a JSON object")
    return value


def require_text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        fail(f"{label} must be a non-empty string")
    return value.strip()


def require_sha(value: Any, label: str) -> str:
    text = require_text(value, label)
    if not SHA.fullmatch(text):
        fail(f"{label} must be a 40-character lowercase commit SHA")
    return text


def validate_repository(value: Any, label: str) -> str:
    repository = require_text(value, label)
    if repository.count("/") != 1 or repository.startswith("/") or repository.endswith("/"):
        fail(f"{label} must use owner/name")
    return repository


def validate_plan(plan: dict[str, Any], plan_path: Path) -> None:
    if plan.get("schemaVersion") != 1:
        fail("schemaVersion must be 1")
    release_id = require_text(plan.get("releaseSetId"), "releaseSetId")
    if not RELEASE_ID.fullmatch(release_id):
        fail("releaseSetId must be lowercase and branch-safe")
    if plan.get("evidenceState") not in {"pending", "produced"}:
        fail("evidenceState must be pending or produced")

    sources = plan.get("sources")
    if not isinstance(sources, dict) or set(sources) != EXPECTED_SOURCES:
        fail("sources must contain exactly syncer, clients, and e2e")

    expected_archives: set[str] = set()
    for source_name in sorted(EXPECTED_SOURCES):
        source = sources[source_name]
        if not isinstance(source, dict):
            fail(f"sources.{source_name} must be an object")
        validate_repository(source.get("repository"), f"sources.{source_name}.repository")
        require_sha(source.get("sha"), f"sources.{source_name}.sha")
        version = require_text(source.get("version"), f"sources.{source_name}.version")
        if not SEMVER.fullmatch(version):
            fail(f"sources.{source_name}.version must be semantic version x.y.z")
        if source.get("plannedTag") != f"v{version}":
            fail(f"sources.{source_name}.plannedTag must equal v{version}")
        archives = source.get("archives")
        if not isinstance(archives, list) or not archives or not all(isinstance(item, str) and item for item in archives):
            fail(f"sources.{source_name}.archives must be a non-empty string array")
        if len(archives) != len(set(archives)):
            fail(f"sources.{source_name}.archives contains duplicates")
        canonical = require_text(source.get("canonicalArchive"), f"sources.{source_name}.canonicalArchive")
        if canonical not in archives:
            fail(f"sources.{source_name}.canonicalArchive is not listed in archives")
        for archive in archives:
            if Path(archive).name != archive or not archive.endswith(".tar.gz"):
                fail(f"unsafe archive name: {archive}")
            if archive in expected_archives:
                fail(f"duplicate archive across sources: {archive}")
            expected_archives.add(archive)

    syncer_sha = sources["syncer"]["sha"]
    clients_sha = sources["clients"]["sha"]
    if sources["clients"].get("embeddedSyncerSha") != syncer_sha:
        fail("clients embeddedSyncerSha differs from syncer SHA")
    if sources["e2e"].get("pinnedSyncerSha") != syncer_sha:
        fail("e2e pinnedSyncerSha differs from syncer SHA")
    if sources["e2e"].get("pinnedClientsSha") != clients_sha:
        fail("e2e pinnedClientsSha differs from clients SHA")
    required_paths = sources["e2e"].get("requiredPackagePaths")
    if not isinstance(required_paths, list) or not required_paths:
        fail("e2e requiredPackagePaths must be non-empty")
    for path in required_paths:
        if not isinstance(path, str) or not path.startswith("pkg/") or ".." in Path(path).parts:
            fail(f"unsafe e2e required package path: {path!r}")

    tooling = plan.get("tooling")
    if not isinstance(tooling, dict):
        fail("tooling must be an object")
    validate_repository(tooling.get("zedCliRepository"), "tooling.zedCliRepository")
    require_sha(tooling.get("zedCliSha"), "tooling.zedCliSha")
    validate_repository(tooling.get("zedInterfacesRepository"), "tooling.zedInterfacesRepository")
    require_sha(tooling.get("zedInterfacesSha"), "tooling.zedInterfacesSha")

    requirements = plan.get("evidenceRequirements")
    if not isinstance(requirements, dict):
        fail("evidenceRequirements must be an object")
    for key in (
        "packTwiceAndCompare",
        "verifyRecursiveCoreParity",
        "runSourcePackageChecks",
        "runPublishDryRuns",
        "recordSha256AndSize",
    ):
        if requirements.get(key) is not True:
            fail(f"evidenceRequirements.{key} must remain true")
    if requirements.get("publishArtifacts") is not False:
        fail("evidence generation must not publish registry artifacts")

    rollback = plan.get("rollback")
    if not isinstance(rollback, dict):
        fail("rollback must be an object")
    require_text(rollback.get("owner"), "rollback.owner")
    procedure = require_text(rollback.get("procedureDocument"), "rollback.procedureDocument")
    procedure_path = ROOT / procedure
    if not procedure_path.is_file():
        fail(f"rollback procedure does not exist: {procedure}")
    require_text(rollback.get("partialReleasePolicy"), "rollback.partialReleasePolicy")

    print(
        f"release evidence plan valid: {release_id}, "
        f"sources={len(sources)}, archives={len(expected_archives)}, plan={plan_path}"
    )


def git(directory: Path, *args: str) -> str:
    try:
        completed = subprocess.run(
            ["git", "-C", str(directory), *args],
            check=True,
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        fail(f"git {' '.join(args)} failed in {directory}: {exc}")
    return completed.stdout.strip()


def read_manifest_version(source_dir: Path) -> str:
    import tomllib

    try:
        manifest = tomllib.loads((source_dir / ".zpkg.toml").read_text(encoding="utf-8"))
        return str(manifest["package"]["version"])
    except (OSError, KeyError, tomllib.TOMLDecodeError) as exc:
        fail(f"cannot read package version in {source_dir}: {exc}")


def verify_sources(plan: dict[str, Any], source_dirs: dict[str, Path]) -> dict[str, dict[str, str]]:
    sources = plan["sources"]
    identities: dict[str, dict[str, str]] = {}
    for source_name, source_dir in source_dirs.items():
        actual = git(source_dir, "rev-parse", "HEAD")
        expected = sources[source_name]["sha"]
        if actual != expected:
            fail(f"{source_name} checkout is {actual}, expected {expected}")
        version = read_manifest_version(source_dir)
        if version != sources[source_name]["version"]:
            fail(f"{source_name} manifest version {version} differs from plan {sources[source_name]['version']}")
        identities[source_name] = {
            "repository": sources[source_name]["repository"],
            "sha": actual,
            "treeSha": git(source_dir, "rev-parse", "HEAD^{tree}"),
            "version": version,
        }

    expected_core = sources["syncer"]["sha"]
    gitlink = git(source_dirs["clients"], "rev-parse", "HEAD:syncer.c")
    nested = git(source_dirs["clients"] / "syncer.c", "rev-parse", "HEAD")
    if gitlink != expected_core or nested != expected_core:
        fail(f"client core parity failed: planned={expected_core}, gitlink={gitlink}, nested={nested}")

    expected_clients = sources["clients"]["sha"]
    for workflow_name in ("e2e-docker.yml", "e2e-clients.yml"):
        workflow_path = source_dirs["e2e"] / ".github" / "workflows" / workflow_name
        try:
            workflow_text = workflow_path.read_text(encoding="utf-8")
        except OSError as exc:
            fail(f"cannot read {workflow_path}: {exc}")
        if expected_core not in workflow_text or expected_clients not in workflow_text:
            fail(f"{workflow_name} does not pin the planned core/client pair")

    identities["clients"]["embeddedSyncerSha"] = nested
    identities["e2e"]["pinnedSyncerSha"] = expected_core
    identities["e2e"]["pinnedClientsSha"] = expected_clients
    return identities


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def inspect_archive(source_name: str, archive: Path, required_paths: set[str]) -> list[str]:
    try:
        with tarfile.open(archive, "r:gz") as handle:
            names = sorted(member.name.rstrip("/") for member in handle.getmembers() if member.name)
    except (OSError, tarfile.TarError) as exc:
        fail(f"cannot inspect {archive}: {exc}")

    name_set = set(names)
    for required in required_paths:
        if required not in name_set:
            fail(f"{archive.name} is missing required path {required}")
    for name in names:
        parts = set(Path(name).parts)
        forbidden = sorted(parts & FORBIDDEN_ARCHIVE_PARTS)
        if forbidden:
            fail(f"{archive.name} contains forbidden generated/VCS path {name} ({', '.join(forbidden)})")
        if name.endswith(".log"):
            fail(f"{archive.name} contains log output: {name}")
    return names


def archive_requirements(plan: dict[str, Any], source_name: str, archive_name: str) -> set[str]:
    if source_name == "syncer":
        if archive_name == plan["sources"]["syncer"]["canonicalArchive"]:
            return {"pkg/.zpkg.toml", "pkg/LICENSE", "pkg/core/include/syncer.h", "pkg/core/src/syncer.c"}
        if "-syncer-c-" in archive_name:
            return {"pkg/LICENSE", "pkg/include/syncer.h", "pkg/src/syncer.c"}
        if "-syncer-wasm-" in archive_name:
            return {"pkg/LICENSE", "pkg/package.json"}
    if source_name == "clients":
        return {
            "pkg/.zpkg.toml",
            "pkg/.gitmodules",
            "pkg/LICENSE",
            "pkg/clients/ts/package.json",
            "pkg/clients/dart/pubspec.yaml",
            "pkg/clients/rust/Cargo.toml",
            "pkg/clients/gleam/gleam.toml",
            "pkg/syncer.c/core/include/syncer.h",
        }
    if source_name == "e2e":
        return {
            "pkg/.zpkg.toml",
            "pkg/LICENSE",
            "pkg/docker-compose.yml",
            *plan["sources"]["e2e"]["requiredPackagePaths"],
        }
    fail(f"cannot determine archive requirements for {source_name}/{archive_name}")


def generate_evidence(
    plan: dict[str, Any],
    source_dirs: dict[str, Path],
    archive_root: Path,
    output: Path,
) -> None:
    validate_plan(plan, DEFAULT_PLAN)
    identities = verify_sources(plan, source_dirs)

    expected_files = {
        archive
        for source in plan["sources"].values()
        for archive in source["archives"]
    }
    actual_files = {path.name for path in archive_root.glob("*.tar.gz") if path.is_file()}
    missing = sorted(expected_files - actual_files)
    unexpected = sorted(actual_files - expected_files)
    if missing or unexpected:
        fail(f"archive set differs from plan: missing={missing}, unexpected={unexpected}")

    artifacts: list[dict[str, Any]] = []
    canonical: dict[str, str] = {}
    for source_name in sorted(EXPECTED_SOURCES):
        source = plan["sources"][source_name]
        for archive_name in source["archives"]:
            archive = archive_root / archive_name
            required = archive_requirements(plan, source_name, archive_name)
            members = inspect_archive(source_name, archive, required)
            checksum = sha256(archive)
            if not SHA256.fullmatch(checksum):
                fail(f"invalid SHA-256 produced for {archive_name}")
            record = {
                "source": source_name,
                "filename": archive_name,
                "canonical": archive_name == source["canonicalArchive"],
                "sha256": checksum,
                "size": archive.stat().st_size,
                "fileCount": len(members),
            }
            artifacts.append(record)
            if record["canonical"]:
                canonical[source_name] = checksum

    if set(canonical) != EXPECTED_SOURCES:
        fail("one canonical checksum is required for each source package")

    run_id = os.environ.get("GITHUB_RUN_ID")
    run_attempt = os.environ.get("GITHUB_RUN_ATTEMPT")
    evidence = {
        "schemaVersion": 1,
        "releaseSetId": plan["releaseSetId"],
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "sources": identities,
        "tooling": plan["tooling"],
        "artifacts": artifacts,
        "canonicalChecksums": canonical,
        "workflowEvidence": {
            "repository": os.environ.get("GITHUB_REPOSITORY"),
            "workflow": os.environ.get("GITHUB_WORKFLOW"),
            "runId": int(run_id) if run_id and run_id.isdigit() else None,
            "runAttempt": int(run_attempt) if run_attempt and run_attempt.isdigit() else None,
            "headSha": os.environ.get("GITHUB_SHA"),
            "ref": os.environ.get("GITHUB_REF"),
        },
        "publicationPerformed": False,
        "rollback": plan["rollback"],
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(
        "release evidence generated: "
        + ", ".join(f"{name}={checksum}" for name, checksum in sorted(canonical.items()))
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("validate-plan", "generate"))
    parser.add_argument("--plan", type=Path, default=DEFAULT_PLAN)
    parser.add_argument("--syncer-dir", type=Path)
    parser.add_argument("--clients-dir", type=Path)
    parser.add_argument("--e2e-dir", type=Path)
    parser.add_argument("--archive-root", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    plan = load_json(args.plan)
    validate_plan(plan, args.plan)
    if args.command == "validate-plan":
        return 0

    required = {
        "--syncer-dir": args.syncer_dir,
        "--clients-dir": args.clients_dir,
        "--e2e-dir": args.e2e_dir,
        "--archive-root": args.archive_root,
        "--output": args.output,
    }
    missing = [flag for flag, value in required.items() if value is None]
    if missing:
        fail("generate requires " + ", ".join(missing))
    generate_evidence(
        plan,
        {
            "syncer": args.syncer_dir,
            "clients": args.clients_dir,
            "e2e": args.e2e_dir,
        },
        args.archive_root,
        args.output,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
