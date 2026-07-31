#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RELEASE = ROOT / "release/opto-sync-release-set.candidate.json"
COMPAT = ROOT / "compatibility/contract.v1.json"
ZERO_SHA256 = "0" * 64


def fail(message: str) -> None:
    print(f"release-contract: {message}", file=sys.stderr)
    raise SystemExit(1)


def load(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"cannot load {path.relative_to(ROOT)}: {exc}")


def main() -> int:
    release = load(RELEASE)
    compat = load(COMPAT)

    packages = release["packages"]
    syncer_sha = packages["syncer"]["sha"]
    clients_sha = packages["clients"]["sha"]
    if packages["clients"]["embeddedSyncerSha"] != syncer_sha:
        fail("clients embedded core differs from release syncer SHA")
    if packages["e2e"]["pinnedSyncerSha"] != syncer_sha:
        fail("E2E syncer pin differs from release syncer SHA")
    if packages["e2e"]["pinnedClientsSha"] != clients_sha:
        fail("E2E clients pin differs from release clients SHA")

    versions = {
        packages["syncer"]["version"],
        packages["clients"]["version"],
        packages["e2e"]["version"],
    }
    if len(versions) != 3:
        fail("package versions must remain independently explicit")

    status = release["releaseSet"]["status"]
    checksums = release["certification"]["artifactChecksums"]
    placeholders = [name for name, value in checksums.items() if value == ZERO_SHA256]
    rollback = release["rollback"]
    incomplete_rollback = any(value.startswith("REQUIRED_") for value in (rollback["owner"], rollback["procedure"]))
    if status in {"approved", "published"} and (placeholders or incomplete_rollback):
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
        f"status={status}, placeholder_checksums={len(placeholders)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
