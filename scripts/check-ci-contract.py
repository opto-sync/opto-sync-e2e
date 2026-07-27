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
SHA = r"[0-9a-f]{40}"


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(1)


def read_toml(path: Path) -> dict:
    with path.open("rb") as handle:
        return tomllib.load(handle)


def workflow_ref(text: str, name: str, path: Path) -> str:
    match = re.search(rf"(?m)^\s*{name}:\s*({SHA})\s*$", text)
    if not match:
        fail(f"{path}: {name} must be an immutable 40-hex commit")
    return match.group(1)


def main() -> int:
    docker = DOCKER.read_text(encoding="utf-8")
    clients = CLIENTS.read_text(encoding="utf-8")

    refs: dict[Path, tuple[str, str]] = {}
    for path, text in ((DOCKER, docker), (CLIENTS, clients)):
        refs[path] = (
            workflow_ref(text, "SYNCER_C_REF", path),
            workflow_ref(text, "CLIENTS_REF", path),
        )
        checkout_count = len(re.findall(r"uses:\s*actions/checkout@", text))
        credential_opt_outs = len(re.findall(r"persist-credentials:\s*false", text))
        if credential_opt_outs < checkout_count:
            fail(
                f"{path}: every checkout must opt out of persisted credentials "
                f"({credential_opt_outs}/{checkout_count})"
            )
        if re.search(r"(?m)^\s*cat\s+\.env\s*$", text):
            fail(f"{path}: never print .env contents into Actions logs")
        if "docker compose config --quiet" not in text:
            fail(f"{path}: validate Compose configuration before test startup")

    if refs[DOCKER] != refs[CLIENTS]:
        fail(
            "Docker and live-client workflows must certify the same engine/client "
            f"pair: docker={refs[DOCKER]!r} clients={refs[CLIENTS]!r}"
        )

    if re.search(r"\bnpm install\b", clients):
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
            fail(f"both workflows must retain the compatibility override: {expression}")

    nested_requirements = (
        "submodules: recursive",
        "python3 opto-sync-clients/scripts/check-dependency-boundary.py",
        'git -C opto-sync-clients/syncer.c rev-parse HEAD',
        'test "$server_sha" = "$client_sha"',
        "working-directory: opto-sync-clients/syncer.c/core",
        "working-directory: opto-sync-clients/syncer.c/bindings/typescript",
        "cd opto-sync-clients/syncer.c/bindings/beam",
        "opto-sync-clients/syncer.c/core/build/libsyncer.so",
    )
    for requirement in nested_requirements:
        if requirement not in clients:
            fail(f"{CLIENTS}: missing nested-client engine contract: {requirement}")

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

    engine, client = refs[DOCKER]
    print(
        "cross-repository E2E CI and Zed package contract passed: "
        f"engine={engine} clients={client}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
