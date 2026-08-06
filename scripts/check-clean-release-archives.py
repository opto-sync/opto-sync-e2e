#!/usr/bin/env python3
"""Reject release archives contaminated by generated build/test output.

The coordinated release evidence must be produced from untouched source
checkouts.  This guard is intentionally independent from the Zed packer so a
future packer regression cannot silently turn local binaries into source
artifacts.
"""

from __future__ import annotations

import argparse
import json
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PLAN = ROOT / "release/opto-sync-release-evidence-plan.v1.json"

GENERATED_TEST_BINARIES = {
    "pkg/core/test/test_syncer",
    "pkg/core/test/prop_test",
    "pkg/core/test/test_syncer_asan",
    "pkg/core/test/prop_test_asan",
}

GENERATED_SUFFIXES = (
    ".o",
    ".obj",
    ".so",
    ".dylib",
    ".dll",
    ".exe",
    ".pdb",
    ".profraw",
    ".profdata",
)


def fail(message: str) -> "NoReturn":
    raise SystemExit(f"clean-release-archives: {message}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive-root", type=Path, required=True)
    args = parser.parse_args()

    plan = json.loads(PLAN.read_text(encoding="utf-8"))
    requirements = plan["evidenceRequirements"]
    if requirements.get("packFromUntouchedCheckouts") is not True:
        fail("packFromUntouchedCheckouts must remain true")
    if requirements.get("rejectGeneratedTestBinaries") is not True:
        fail("rejectGeneratedTestBinaries must remain true")

    expected = {
        archive
        for source in plan["sources"].values()
        for archive in source["archives"]
    }
    actual = {
        path.name
        for path in args.archive_root.glob("*.tar.gz")
        if path.is_file()
    }
    if actual != expected:
        fail(f"archive set differs from plan: actual={sorted(actual)}, expected={sorted(expected)}")

    inspected = 0
    for archive_name in sorted(expected):
        archive = args.archive_root / archive_name
        try:
            with tarfile.open(archive, "r:gz") as handle:
                members = [member for member in handle.getmembers() if member.name]
        except (OSError, tarfile.TarError) as exc:
            fail(f"cannot inspect {archive_name}: {exc}")

        for member in members:
            normalized = member.name.rstrip("/")
            if normalized in GENERATED_TEST_BINARIES:
                fail(f"{archive_name} contains generated test binary {normalized}")
            if normalized.endswith(GENERATED_SUFFIXES):
                fail(f"{archive_name} contains generated native output {normalized}")
            if normalized.endswith(".log"):
                fail(f"{archive_name} contains generated log {normalized}")
            if member.isfile() and member.mode & 0o111:
                basename = Path(normalized).name
                if normalized.startswith("pkg/core/test/") and "." not in basename:
                    fail(f"{archive_name} contains executable test output {normalized}")
        inspected += 1
        print(f"clean source archive: {archive_name} ({len(members)} entries)")

    print(f"clean release archive guard passed: {inspected} archives")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
