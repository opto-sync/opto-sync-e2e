#!/usr/bin/env python3
"""Canonical starter-tree renderer for reviewed missing E2E repositories.

The underlying template library intentionally includes negative-test source
that mentions forbidden values such as ``latest``.  This facade applies the
security policy structurally: it rejects mutable values when assigned to a
branch/ref field, but does not reject test code whose purpose is to assert that
those values fail.  It is the supported tree-rendering entrypoint used by CI
and by the deterministic archive renderer.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import re
import sys
from pathlib import Path, PurePosixPath
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
LIBRARY_PATH = ROOT / "scripts/render-missing-e2e-repository.py"
SPEC = importlib.util.spec_from_file_location("missing_e2e_template_library", LIBRARY_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"cannot load template library: {LIBRARY_PATH}")
LIBRARY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LIBRARY)

BootstrapError = LIBRARY.BootstrapError
DEFAULT_MANIFEST = LIBRARY.DEFAULT_MANIFEST
load_manifest = LIBRARY.load_manifest
select_wrapper = LIBRARY.select_wrapper
profile_for = LIBRARY.profile_for
write_tree = LIBRARY.write_tree
canonical_json = LIBRARY.canonical_json
sha256_bytes = LIBRARY.sha256_bytes
sha256_file = LIBRARY.sha256_file

JSON_MUTABLE_REF = re.compile(
    r'"(?:wrapperRef|branch|ref|defaultBranch)"\s*:\s*"(?:main|latest|refs/heads/main)"',
    re.IGNORECASE,
)
YAML_MUTABLE_REF = re.compile(
    r"(?mi)^\s*(?:ref|branch|default|default_branch)\s*:\s*[\"']?(?:main|latest|refs/heads/main)[\"']?\s*$"
)
TOML_MUTABLE_REF = re.compile(
    r"(?mi)^\s*(?:ref|branch|default_branch)\s*=\s*[\"'](?:main|latest|refs/heads/main)[\"']\s*$"
)


def validate_generated_files(files: dict[str, bytes]) -> None:
    required = {
        ".gitignore",
        "LICENSE",
        "README.md",
        "agents.md",
        "opto-sync-adoption.json",
        "bootstrap-receipt.json",
        "tests/opto-sync/adoption_contract.py",
        "tests/opto-sync/product.e2e.test.mjs",
        ".github/workflows/opto-sync-adoption.yml",
    }
    if set(files) != required:
        raise BootstrapError(f"generated file set differs: {sorted(files)}")

    for path, content in files.items():
        pure = PurePosixPath(path)
        if pure.is_absolute() or ".." in pure.parts or path.startswith("/"):
            raise BootstrapError(f"unsafe generated path: {path}")
        try:
            text = content.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise BootstrapError(f"generated file is not UTF-8: {path}: {exc}") from exc
        lowered = text.lower()
        for marker in LIBRARY.FORBIDDEN_SECRET_MARKERS:
            if marker in lowered:
                raise BootstrapError(
                    f"generated file {path} contains forbidden secret marker {marker!r}"
                )
        if "refs/heads/main" in lowered:
            raise BootstrapError(f"generated file {path} contains a mutable ref")
        if JSON_MUTABLE_REF.search(text) or YAML_MUTABLE_REF.search(text) or TOML_MUTABLE_REF.search(text):
            raise BootstrapError(f"generated file {path} contains a mutable ref")

    profile = json.loads(files["opto-sync-adoption.json"])
    if profile["e2eRepository"] not in {
        "akrion-sim/akrion-sim-e2e",
        "benefactor-cc/benefactor-e2e",
    }:
        raise BootstrapError("generator emitted an unapproved repository")
    if profile["wrapperRef"] in {"main", "latest", "refs/heads/main"}:
        raise BootstrapError("generated profile contains a mutable wrapper ref")


def build_files(manifest_path: Path, repository: str) -> dict[str, bytes]:
    original_validator = LIBRARY.validate_generated_files
    LIBRARY.validate_generated_files = validate_generated_files
    try:
        files = LIBRARY.build_files(manifest_path, repository)
    finally:
        LIBRARY.validate_generated_files = original_validator
    validate_generated_files(files)
    return files


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    try:
        files = build_files(args.manifest, args.repository)
        write_tree(files, args.out)
    except (BootstrapError, OSError) as exc:
        print(f"missing-e2e-starter: {exc}", file=sys.stderr)
        return 1
    print(
        f"rendered canonical starter tree for {args.repository}: "
        f"files={len(files)}, output={args.out}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
