#!/usr/bin/env python3
"""Canonical baseline renderer for the two deterministically provisioned E2E repos.

The underlying DEN-1469 template library originally rendered repositories while
they were provisioning gaps. Akrion and Benefactor now exist, but the generated
trees and canonical archives remain useful reproducibility evidence. This facade
accepts only those two reviewed existing entries with exact bootstrap provenance.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import re
import sys
from pathlib import Path, PurePosixPath

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
profile_for = LIBRARY.profile_for
write_tree = LIBRARY.write_tree
canonical_json = LIBRARY.canonical_json
sha256_bytes = LIBRARY.sha256_bytes
sha256_file = LIBRARY.sha256_file
PROVISIONED_BASELINES = {
    "akrion-sim/akrion-sim-e2e": {
        "branch": "agent/den-313-opto-sync-e2e",
        "pullRequest": 2,
        "provisionedByIssue": "DEN-1469",
        "bootstrapSource": "opto-sync/opto-sync-e2e#25",
        "bootstrapMode": "deterministic-starter",
    },
    "benefactor-cc/benefactor-e2e": {
        "branch": "agent/den-313-opto-sync-e2e",
        "pullRequest": 2,
        "provisionedByIssue": "DEN-1469",
        "bootstrapSource": "opto-sync/opto-sync-e2e#25",
        "bootstrapMode": "deterministic-starter",
    },
}

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


def select_wrapper(manifest: dict, repository: str) -> dict:
    if not LIBRARY.SAFE_REPOSITORY.fullmatch(repository):
        raise BootstrapError("repository must use safe owner/name syntax")
    if repository not in PROVISIONED_BASELINES:
        raise BootstrapError(f"repository is not one reviewed DEN-1469 baseline: {repository}")
    matches = [
        wrapper
        for wrapper in manifest.get("wrappers", [])
        if isinstance(wrapper, dict)
        and isinstance(wrapper.get("e2e"), dict)
        and wrapper["e2e"].get("repository") == repository
    ]
    if len(matches) != 1:
        raise BootstrapError(f"repository is not one reviewed fleet identity: {repository}")
    wrapper = matches[0]
    e2e = wrapper["e2e"]
    if e2e.get("status") != "existing":
        raise BootstrapError(f"reviewed baseline is no longer an existing repository: {repository}")
    for field, expected in PROVISIONED_BASELINES[repository].items():
        if e2e.get(field) != expected:
            raise BootstrapError(
                f"{repository}: {field} differs from the reviewed DEN-1469 baseline"
            )
    if "blocker" in e2e:
        raise BootstrapError(f"{repository}: stale provisioning blocker remains")
    branch = wrapper.get("branch")
    if not isinstance(branch, str) or not LIBRARY.SAFE_BRANCH.fullmatch(branch):
        raise BootstrapError("wrapper branch is not a reviewed agent/den-* ref")
    if any(token in branch.lower() for token in ("latest", "refs/heads/main")):
        raise BootstrapError("wrapper branch is mutable")
    return wrapper


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
    if profile["e2eRepository"] not in PROVISIONED_BASELINES:
        raise BootstrapError("generator emitted an unapproved repository")
    if profile["wrapperRef"] in {"main", "latest", "refs/heads/main"}:
        raise BootstrapError("generated profile contains a mutable wrapper ref")
    receipt = json.loads(files["bootstrap-receipt.json"])
    if receipt.get("bootstrapIssue") != "DEN-1469":
        raise BootstrapError("generated receipt lost DEN-1469 provenance")


def build_files(manifest_path: Path, repository: str) -> dict[str, bytes]:
    original_validator = LIBRARY.validate_generated_files
    original_selector = LIBRARY.select_wrapper
    LIBRARY.validate_generated_files = validate_generated_files
    LIBRARY.select_wrapper = select_wrapper
    try:
        files = LIBRARY.build_files(manifest_path, repository)
    finally:
        LIBRARY.validate_generated_files = original_validator
        LIBRARY.select_wrapper = original_selector
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
        print(f"provisioned-e2e-baseline: {exc}", file=sys.stderr)
        return 1
    print(
        f"rendered canonical provisioned baseline for {args.repository}: "
        f"files={len(files)}, output={args.out}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
