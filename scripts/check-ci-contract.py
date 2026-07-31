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
CERTIFIED_SYNCER = "8d2b275a89062403666f4bdf196d246a07c84484"
CERTIFIED_CLIENTS = "38f0fcc6a471455a0a20aec5f7fa63d3f70d5f89"


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(1)


def read_toml(path: Path) -> dict:
    with path.open("rb") as handle:
        return tomllib.load(handle)


def pinned_ref(text: str, name: str) -> str:
    match = re.search(rf"(?m)^\s*{name}:\s*({SHA})\s*$", text)
    if not match:
        fail(f"{name} must be an immutable 40-hex commit")
    return match.group(1)


def main() -> int:
    docker = DOCKER.read_text(encoding="utf-8")
    clients = CLIENTS.read_text(encoding="utf-8")

    for path, text in ((DOCKER, docker), (CLIENTS, clients)):
        syncer_ref = pinned_ref(text, "SYNCER_C_REF")
        clients_ref = pinned_ref(text, "CLIENTS_REF")
        if syncer_ref != CERTIFIED_SYNCER:
            fail(f"{path}: SYNCER_C_REF is not the currently certified core")
        if clients_ref != CERTIFIED_CLIENTS:
            fail(f"{path}: CLIENTS_REF is not the currently certified client commit")

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
        if not re.search(
            r"repository:\s*opto-sync/opto-sync-clients[\s\S]{0,350}submodules:\s*recursive",
            text,
        ):
            fail(f"{path}: the pinned clients checkout must initialize syncer.c recursively")
        if "Verify sibling and nested core parity" not in text:
            fail(f"{path}: verify that the server core and client gitlink are identical")
        for command in (
            'git -C syncer.c rev-parse HEAD',
            'git -C opto-sync-clients rev-parse HEAD:syncer.c',
            'git -C opto-sync-clients/syncer.c rev-parse HEAD',
        ):
            if command not in text:
                fail(f"{path}: missing core-parity command: {command}")

    if re.search(r"\bnpm install\b", clients):
        fail(f"{CLIENTS}: use committed npm locks through npm ci")
    if "cargo generate-lockfile" in clients:
        fail(f"{CLIENTS}: the tracked Rust lockfile must not be regenerated in CI")
    if "cargo fetch --locked" not in clients:
        fail(f"{CLIENTS}: prefetch the tracked Rust dependency graph with --locked")

    for required in (
        "working-directory: opto-sync-clients/syncer.c/core",
        "working-directory: opto-sync-clients/syncer.c/bindings/typescript",
        "opto-sync-clients/syncer.c/core/build/libsyncer.so",
    ):
        if required not in clients:
            fail(f"{CLIENTS}: live clients must consume the recursively pinned core: {required}")

    expected_overrides = (
        "github.event.inputs.syncer_ref || env.SYNCER_C_REF",
        "github.event.inputs.clients_ref || env.CLIENTS_REF",
    )
    for expression in expected_overrides:
        if expression not in docker or expression not in clients:
            fail(f"both workflows must retain the compatibility override: {expression}")

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
        "cross-repository E2E CI and Zed package contract passed: "
        f"syncer={CERTIFIED_SYNCER}, clients={CERTIFIED_CLIENTS}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
