#!/usr/bin/env python3
"""Validate the opto-sync E2E Zed source package or an extracted artifact."""

from __future__ import annotations

import sys
import tomllib
from pathlib import Path

SOURCE_ROOT = Path(__file__).resolve().parents[1]
ROOT = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else SOURCE_ROOT


def read_toml(path: Path) -> dict:
    with path.open("rb") as handle:
        return tomllib.load(handle)


def require(relative: str) -> None:
    path = ROOT / relative
    if not path.is_file():
        raise AssertionError(f"missing required package file: {relative}")


def main() -> int:
    manifest = read_toml(ROOT / ".zpkg.toml")
    package = manifest["package"]
    assert package["org"] == "opto-sync"
    assert package["name"] == "opto-sync-e2e"
    assert package["version"] == "0.1.0"
    assert package["repository"]["url"] == "https://github.com/opto-sync/opto-sync-e2e"
    assert manifest["dependencies"] == {
        "opto-sync/syncer": "^0.2.1",
        "opto-sync/opto-sync-clients": "^0.4.0",
    }
    assert ".env" in manifest["publish"]["exclude"]
    assert "**/*.log" in manifest["publish"]["exclude"]

    lock_path = ROOT / ".zpkg.lock"
    if lock_path.exists():
        lock = read_toml(lock_path)
        assert lock.get("version") == 1
    elif ROOT == SOURCE_ROOT:
        raise AssertionError("source repository must commit .zpkg.lock")

    for relative in (
        "LICENSE",
        "README.md",
        "docker-compose.yml",
        "docker-compose.supabase.yml",
        ".env.example",
        "suite/run_e2e.sh",
        "suite/clients/run_all.sh",
        "suite/protocol/run.mjs",
        "suite/cross-server/run.mjs",
    ):
        require(relative)

    # `.env` may exist in a working checkout for Compose, but it is a runtime
    # input and must never be distributed in the package artifact.
    if ROOT != SOURCE_ROOT and (ROOT / ".env").exists():
        raise AssertionError("published artifact must not contain .env")

    kind = "source repository" if lock_path.exists() else "installed artifact"
    print(f"opto-sync E2E Zed contract passed for {kind}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
