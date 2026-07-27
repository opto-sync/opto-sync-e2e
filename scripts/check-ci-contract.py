#!/usr/bin/env python3
"""Static guardrails for cross-repository E2E workflows and the Zed package."""

from __future__ import annotations

import re
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOCKER = ROOT / ".github/workflows/e2e-docker.yml"
CLIENTS = ROOT / ".github/workflows/e2e-clients.yml"
MANIFEST = ROOT / ".zpkg.toml"
LOCKFILE = ROOT / ".zpkg.lock"
CERTIFIED_SYNCER = "7795ce2d1342e17d934d2faafff5c8ed4322609e"
CERTIFIED_CLIENTS = "54874e9f7df6009fccd9034fce39306daef2c043"


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(1)


def read_toml(path: Path) -> dict:
    with path.open("rb") as handle:
        return tomllib.load(handle)


def require(text: str, needle: str, label: str) -> None:
    if needle not in text:
        fail(f"{label}: required contract text is missing: {needle}")


def main() -> int:
    docker = DOCKER.read_text(encoding="utf-8")
    clients = CLIENTS.read_text(encoding="utf-8")

    expected_refs = (
        f"SYNCER_C_REF: {CERTIFIED_SYNCER}",
        f"CLIENTS_REF: {CERTIFIED_CLIENTS}",
    )
    for path, text in ((DOCKER, docker), (CLIENTS, clients)):
        for expected in expected_refs:
            require(text, expected, str(path))

        checkout_count = len(re.findall(r"uses:\s*actions/checkout@", text))
        credential_opt_outs = len(re.findall(r"persist-credentials:\s*false", text))
        if credential_opt_outs < checkout_count:
            fail(
                f"{path}: every checkout must opt out of persisted credentials "
                f"({credential_opt_outs}/{checkout_count})"
            )

        require(text, "repository: opto-sync/opto-sync-clients", str(path))
        require(text, "submodules: recursive", str(path))
        require(text, "Verify certified client and nested core pair", str(path))
        require(text, "git -C opto-sync-clients ls-tree HEAD syncer.c", str(path))
        require(text, "git -C opto-sync-clients/syncer.c rev-parse HEAD", str(path))
        require(text, "git -C syncer.c rev-parse HEAD", str(path))
        require(text, 'test "$actual_nested" = "$server_core"', str(path))
        require(text, "github.event.inputs.syncer_ref || env.SYNCER_C_REF", str(path))
        require(text, "github.event.inputs.clients_ref || env.CLIENTS_REF", str(path))
        require(text, "docker compose config --quiet", str(path))

        if re.search(r"(?m)^\s*cat\s+\.env\s*$", text):
            fail(f"{path}: never print .env contents into Actions logs")

    if re.search(r"\bnpm install\b", clients):
        fail(f"{CLIENTS}: use committed npm locks through npm ci")
    if "cargo generate-lockfile" in clients:
        fail(f"{CLIENTS}: the tracked Rust lockfile must not be regenerated in CI")
    require(clients, "cargo fetch --locked", str(CLIENTS))
    require(
        clients,
        "opto-sync-clients/syncer.c/bindings/typescript",
        str(CLIENTS),
    )
    if "working-directory: syncer.c/bindings/typescript" in clients:
        fail(f"{CLIENTS}: client native binding dependencies must come from its nested core")

    require(
        docker,
        "docker compose -f docker-compose.yml -f docker-compose.supabase.yml config --quiet",
        str(DOCKER),
    )

    manifest = read_toml(MANIFEST)
    package = manifest.get("package", {})
    if (package.get("org"), package.get("name"), package.get("version")) != (
        "opto-sync",
        "opto-sync-e2e",
        "0.1.0",
    ):
        fail("unexpected opto-sync-e2e Zed package identity")

    dependencies = manifest.get("dependencies", {})
    if dependencies.get("opto-sync/syncer") != "^0.2.1":
        fail("the E2E Zed package must depend on opto-sync/syncer ^0.2.1")
    if dependencies.get("opto-sync/opto-sync-clients") != "^0.2.0":
        fail("the E2E Zed package must depend on opto-sync/opto-sync-clients ^0.2.0")
    if read_toml(LOCKFILE).get("version") != 1:
        fail(".zpkg.lock must declare format version 1")

    print(
        "cross-repository E2E contract passed: exact client, nested core, "
        "server core, and Zed dependency graph are ratcheted"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
