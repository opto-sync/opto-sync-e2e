#!/usr/bin/env python3
"""Static guardrails for the cross-repository GitHub Actions workflows."""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOCKER = ROOT / ".github/workflows/e2e-docker.yml"
CLIENTS = ROOT / ".github/workflows/e2e-clients.yml"
SHA = r"[0-9a-f]{40}"


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(1)


def main() -> int:
    docker = DOCKER.read_text(encoding="utf-8")
    clients = CLIENTS.read_text(encoding="utf-8")

    for path, text in ((DOCKER, docker), (CLIENTS, clients)):
        if not re.search(rf"(?m)^\s*SYNCER_C_REF:\s*{SHA}\s*$", text):
            fail(f"{path}: SYNCER_C_REF must be an immutable 40-hex commit")
        if not re.search(rf"(?m)^\s*CLIENTS_REF:\s*{SHA}\s*$", text):
            fail(f"{path}: CLIENTS_REF must be an immutable 40-hex commit")
        if text.count("persist-credentials: false") < 3:
            fail(f"{path}: every repository checkout must opt out of persisted credentials")
        if re.search(r"(?m)^\s*cat\s+\.env\s*$", text):
            fail(f"{path}: never print .env contents into Actions logs")

    if "npm install" in clients:
        fail(f"{CLIENTS}: use committed npm locks through npm ci")
    if "cargo generate-lockfile" in clients:
        fail(f"{CLIENTS}: the tracked Rust lockfile must not be regenerated in CI")
    if "cargo fetch --locked" not in clients:
        fail(f"{CLIENTS}: prefetch the tracked Rust dependency graph with --locked")

    expected_overrides = (
        "github.event.inputs.syncer_ref || env.SYNCER_C_REF",
        "github.event.inputs.clients_ref || env.CLIENTS_REF",
    )
    for expression in expected_overrides:
        if expression not in docker or expression not in clients:
            fail(f"both workflows must retain the explicit compatibility override: {expression}")

    print("cross-repository E2E CI contract passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
