#!/usr/bin/env python3
"""Render deterministic starter repositories for reviewed E2E fleet gaps.

The generator is intentionally credential-free and non-mutating. It derives all
product identity and safety policy from downstream-wrapper-fleet.v1.json and
writes a local tree or canonical tar archive. It never creates a GitHub
repository, pushes a branch, dispatches a workflow, or substitutes inventory
metadata for live frozen-install evidence.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import shutil
import stat
import sys
import tarfile
from pathlib import Path, PurePosixPath
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = ROOT / "operations/downstream-wrapper-fleet.v1.json"
SAFE_REPOSITORY = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
SAFE_BRANCH = re.compile(r"^agent/den-[1-9][0-9]*-[a-z0-9][a-z0-9._/-]*$")
FORBIDDEN_SECRET_MARKERS = (
    "ghp_",
    "github_pat_",
    "bearer ",
    "authorization:",
    "password=",
    "private_key",
)
NATIVE_ADAPTERS = {
    "rust": {
        "package": "opto-sync-client",
        "path": "zed_modules/opto-sync/opto-sync-clients/clients/rust",
        "manifest": "Cargo.toml",
    },
    "typescript": {
        "package": "@opto-sync/client",
        "path": "zed_modules/opto-sync/opto-sync-clients/clients/ts",
        "manifest": "package.json",
    },
    "dart": {
        "package": "opto_sync_client",
        "path": "zed_modules/opto-sync/opto-sync-clients/clients/dart",
        "manifest": "pubspec.yaml",
    },
    "gleam": {
        "package": "opto_sync_client",
        "path": "zed_modules/opto-sync/opto-sync-clients/clients/gleam",
        "manifest": "gleam.toml",
    },
}

MIT_LICENSE = """MIT License

Copyright (c) 2026 Opto-Sync contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the \"Software\"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""


class BootstrapError(ValueError):
    pass


def fail(message: str) -> "NoReturn":
    raise BootstrapError(message)


def canonical_json(value: Any) -> str:
    return json.dumps(value, indent=2, sort_keys=True) + "\n"


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def load_manifest(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"cannot load fleet manifest {path}: {exc}")
    if not isinstance(value, dict) or value.get("schemaVersion") != 1:
        fail("fleet manifest must be a schemaVersion 1 object")
    if value.get("dependency") != {
        "package": "opto-sync/opto-sync-clients",
        "range": "^0.4.0",
    }:
        fail("fleet dependency contract changed unexpectedly")
    return value


def select_wrapper(manifest: dict[str, Any], repository: str) -> dict[str, Any]:
    if not SAFE_REPOSITORY.fullmatch(repository):
        fail("repository must use safe owner/name syntax")
    matches = [
        wrapper
        for wrapper in manifest.get("wrappers", [])
        if isinstance(wrapper, dict)
        and isinstance(wrapper.get("e2e"), dict)
        and wrapper["e2e"].get("repository") == repository
    ]
    if len(matches) != 1:
        fail(f"repository is not one reviewed fleet identity: {repository}")
    wrapper = matches[0]
    e2e = wrapper["e2e"]
    if e2e.get("status") != "provisioning_required":
        fail(f"repository already exists or is not approved for bootstrap: {repository}")
    if e2e.get("branch") is not None or e2e.get("pullRequest") is not None:
        fail("provisioning entry cannot already claim a branch or pull request")
    blocker = e2e.get("blocker")
    if not isinstance(blocker, str) or "repository-creation" not in blocker:
        fail("provisioning entry lacks the reviewed repository-creation blocker")
    branch = wrapper.get("branch")
    if not isinstance(branch, str) or not SAFE_BRANCH.fullmatch(branch):
        fail("wrapper branch is not a reviewed agent/den-* ref")
    if any(token in branch.lower() for token in ("latest", "refs/heads/main")):
        fail("wrapper branch is mutable")
    return wrapper


def profile_for(manifest: dict[str, Any], wrapper: dict[str, Any]) -> dict[str, Any]:
    languages = wrapper.get("languages")
    if not isinstance(languages, list) or not languages:
        fail("wrapper languages are missing")
    adapters: dict[str, Any] = {}
    for language in languages:
        if language in NATIVE_ADAPTERS:
            adapters[language] = {
                key: value
                for key, value in NATIVE_ADAPTERS[language].items()
                if key != "manifest"
            }
    if not adapters:
        fail("wrapper has no supported native adapters")
    required = manifest.get("requiredScenarios")
    additional = wrapper.get("additionalScenarios")
    if not isinstance(required, list) or not isinstance(additional, list):
        fail("wrapper scenario contract is incomplete")
    scenarios = sorted(set(required + additional))
    guards = wrapper.get("domainGuards")
    if not isinstance(guards, list) or len(guards) < 2:
        fail("wrapper domain guards are incomplete")
    return {
        "schemaVersion": 1,
        "generatedBy": "opto-sync/opto-sync-e2e:scripts/render-missing-e2e-repository.py",
        "wrapperRepository": wrapper["repository"],
        "wrapperRef": wrapper["branch"],
        "wrapperPullRequest": wrapper["pullRequest"],
        "e2eRepository": wrapper["e2e"]["repository"],
        "rolloutIssue": wrapper["linearIssue"],
        "parentIssue": manifest["parentIssue"],
        "bootstrapIssue": "DEN-1469",
        "releaseGates": sorted(manifest["releaseGates"]),
        "releaseState": "blocked-until-certified-package-published",
        "dependency": {
            "package": manifest["dependency"]["package"],
            "range": manifest["dependency"]["range"],
            "installRoot": "zed_modules/opto-sync/opto-sync-clients",
        },
        "nativeAdapters": adapters,
        "languages": sorted(languages),
        "persistence": sorted(wrapper["persistence"]),
        "requiredScenarios": scenarios,
        "legacyParityRequired": bool(wrapper["legacyParityRequired"]),
        "bootstrapIndependent": bool(wrapper["bootstrapIndependent"]),
        "domainGuards": guards,
    }


def contract_script() -> str:
    return r'''#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import pathlib
import re
import tomllib

TARGET_MANIFESTS = {
    "rust": "Cargo.toml",
    "typescript": "package.json",
    "dart": "pubspec.yaml",
    "gleam": "gleam.toml",
}
REQUIRED_BASE = {
    "frozen-install-provenance",
    "durable-restart",
    "optimistic-local-view-rebase",
    "remote-confirmed-no-premature-view",
    "stable-mutation-id-replay",
    "stale-base-conflict",
    "tombstone-no-resurrection",
    "indexeddb",
    "sqlite",
    "postgres-supabase-authority",
    "realtime-is-wake-hint",
    "background-handoff",
}


def load(path: pathlib.Path):
    value = json.loads(path.read_text())
    assert isinstance(value, dict)
    return value


def validate_profile(profile):
    assert profile["schemaVersion"] == 1
    assert profile["bootstrapIssue"] == "DEN-1469"
    assert profile["parentIssue"] == "DEN-313"
    assert set(profile["releaseGates"]) == {"DEN-309", "DEN-363"}
    assert profile["releaseState"] == "blocked-until-certified-package-published"
    assert profile["dependency"] == {
        "package": "opto-sync/opto-sync-clients",
        "range": "^0.4.0",
        "installRoot": "zed_modules/opto-sync/opto-sync-clients",
    }
    assert profile["wrapperRef"].startswith("agent/den-")
    assert "latest" not in profile["wrapperRef"].lower()
    assert REQUIRED_BASE <= set(profile["requiredScenarios"])
    assert len(profile["domainGuards"]) >= 2
    assert profile["nativeAdapters"]
    for language, adapter in profile["nativeAdapters"].items():
        assert language in TARGET_MANIFESTS
        assert adapter["path"].startswith(profile["dependency"]["installRoot"] + "/")
        assert ".." not in pathlib.PurePosixPath(adapter["path"]).parts


def validate_wrapper(profile, wrapper, live):
    manifest = tomllib.loads((wrapper / ".zpkg.toml").read_text())
    lock = tomllib.loads((wrapper / ".zpkg.lock").read_text())
    adapter = load(wrapper / "opto-sync-adapter.json")
    assert manifest["dependencies"]["opto-sync/opto-sync-clients"] == "^0.4.0"
    assert manifest["install"]["dir"] == "zed_modules"
    assert adapter["repository"] == profile["wrapperRepository"]
    assert adapter["e2eRepository"] == profile["e2eRepository"]
    packages = lock.get("package", [])
    if not live:
        if adapter["releaseState"] == "blocked-until-certified-package-published":
            assert lock.get("version") == 1 and packages == []
        return
    package = next(
        item
        for item in packages
        if item.get("org") == "opto-sync"
        and item.get("name") == "opto-sync-clients"
    )
    assert re.fullmatch(r"[0-9a-f]{64}", package["sha256"])
    assert package["sha256"] != "0" * 64
    assert package["size"] > 0
    assert package["format"] in {"tar.gz", "zip"}
    assert package["vcs_tag"]
    assert re.fullmatch(r"[0-9a-f]{40}", package["vcs_commit"])
    assert package["source"]
    for language, adapter in profile["nativeAdapters"].items():
        target = wrapper / adapter["path"] / TARGET_MANIFESTS[language]
        assert target.is_file(), f"missing installed {language} target: {target}"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", type=pathlib.Path, default=pathlib.Path("opto-sync-adoption.json"))
    parser.add_argument("--wrapper", type=pathlib.Path)
    parser.add_argument("--live", action="store_true")
    args = parser.parse_args()
    profile = load(args.profile)
    validate_profile(profile)
    if args.wrapper:
        validate_wrapper(profile, args.wrapper, args.live)
    print(f"validated generated E2E contract for {profile['e2eRepository']}")


if __name__ == "__main__":
    main()
'''


def product_test() -> str:
    return r'''import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const profilePath = process.env.OPTO_SYNC_PROFILE;
assert.ok(profilePath, "OPTO_SYNC_PROFILE is required");
const profile = JSON.parse(readFileSync(profilePath, "utf8"));
const require = createRequire(import.meta.url);
const sdk = require("../dist/index.js");
const {
  OptoSyncClient,
  createOptoSyncClient,
  initOptoSync,
  SYNC_STATUS,
  reconcileIncoming,
  engineVersion,
} = sdk;

async function deleteDatabase(name) {
  await new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  });
}

async function openClient(databaseName) {
  if (typeof initOptoSync === "function") await initOptoSync();
  if (typeof createOptoSyncClient === "function") {
    return createOptoSyncClient({ databaseName, stampUpdatedAt: false });
  }
  return new OptoSyncClient({ databaseName, stampUpdatedAt: false });
}

test("generated profile preserves product policy above the shared engine", () => {
  assert.equal(profile.dependency.package, "opto-sync/opto-sync-clients");
  assert.equal(profile.dependency.range, "^0.4.0");
  assert.ok(profile.domainGuards.length >= 2);
  assert.ok(profile.persistence.includes("postgres"));
  assert.ok(profile.persistence.includes("supabase"));
});

test("durable restart reuses the mutation identity and preserves the local view", async (t) => {
  const databaseName = `generated-e2e-${profile.e2eRepository.replaceAll("/", "-")}`;
  const collection = "generated_records";
  const id = "record-1";
  const local = { id, title: "offline edit", updatedAt: 5000 };
  await deleteDatabase(databaseName);
  t.after(() => deleteDatabase(databaseName));

  const client = await openClient(databaseName);
  const mutationId = await client.queueMutation(collection, id, local);
  const first = await client.protocolPushRequest();
  const replay = await client.protocolPushRequest();
  assert.deepEqual(
    first.mutations.map((mutation) => mutation.mutationId),
    replay.mutations.map((mutation) => mutation.mutationId),
  );
  client.db.close();

  const reopened = new OptoSyncClient({ databaseName, stampUpdatedAt: false });
  const pending = await reopened.pendingMutations();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].mutationId, mutationId);
  const visible = reopened.reconcileIncoming(
    collection,
    id,
    { id, title: "stale server", updatedAt: 10 },
    local,
  );
  assert.equal(visible.title, "offline edit");
  await reopened.markMutation(mutationId, SYNC_STATUS.SYNCED);
  assert.equal((await reopened.pendingMutations()).length, 0);
  reopened.db.close();
});

test("conflict and tombstone precedence remain deterministic", async () => {
  if (typeof initOptoSync === "function") await initOptoSync();
  const local = { id: "c1", value: "new local", updatedAt: 200 };
  const stale = { id: "c1", value: "old server", updatedAt: 100 };
  assert.deepEqual(reconcileIncoming(local, stale), local);
  const tombstone = reconcileIncoming(
    { id: "d1", value: "live", tombstone: false, updatedAt: 100 },
    { id: "d1", value: null, tombstone: true, deletedAt: 200, updatedAt: 200 },
  );
  assert.equal(tombstone.tombstone, true);
  assert.equal(tombstone.value, null);
  assert.match(String(engineVersion()), /^\d+\.\d+\.\d+/);
});
'''


def workflow(profile: dict[str, Any]) -> str:
    template = r'''name: opto-sync generated adoption certification

on:
  pull_request:
    paths:
      - "opto-sync-adoption.json"
      - "tests/opto-sync/**"
      - ".github/workflows/opto-sync-adoption.yml"
  workflow_dispatch:
    inputs:
      run_live:
        description: Run frozen-install and real-browser certification
        required: true
        default: false
        type: boolean
      wrapper_ref:
        description: Matching wrapper branch, tag, or commit
        required: true
        default: __WRAPPER_REF__
        type: string

permissions:
  contents: read

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

env:
  ZED_CLI_SHA: c636fb8f6b08695c6b4fe94e2481f4d57270b2d7
  ZED_INTERFACES_SHA: 415e871b1fb3dd97744c134351408a3224805dfb

jobs:
  contract:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
        with:
          persist-credentials: false
      - run: python3 -m py_compile tests/opto-sync/adoption_contract.py
      - run: python3 tests/opto-sync/adoption_contract.py
      - run: node --check tests/opto-sync/product.e2e.test.mjs

  live-frozen-install:
    if: ${{ github.event_name == 'workflow_dispatch' && inputs.run_live }}
    runs-on: ubuntu-latest
    timeout-minutes: 45
    env:
      SYNC_FLEET_TOKEN: ${{ secrets.SYNC_FLEET_TOKEN }}
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
        with:
          persist-credentials: false
      - name: Require private cross-repository read credentials
        shell: bash
        run: |
          set -euo pipefail
          test -n "$SYNC_FLEET_TOKEN" || {
            echo "SYNC_FLEET_TOKEN is required for the private wrapper checkout" >&2
            exit 1
          }
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
        with:
          repository: __WRAPPER_REPOSITORY__
          ref: ${{ inputs.wrapper_ref }}
          path: wrapper
          token: ${{ secrets.SYNC_FLEET_TOKEN }}
          submodules: recursive
          persist-credentials: false
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
        with:
          repository: zed-pkg/zed-cli
          ref: ${{ env.ZED_CLI_SHA }}
          path: .tools/zed-cli
          persist-credentials: false
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
        with:
          repository: zed-pkg/zed-interfaces
          ref: ${{ env.ZED_INTERFACES_SHA }}
          path: .tools/zed-interfaces
          persist-credentials: false
      - run: cargo build --locked --release --manifest-path .tools/zed-cli/Cargo.toml --bin zed
      - name: Install exactly the committed wrapper lock
        shell: bash
        run: |
          set -euo pipefail
          (cd wrapper && "$GITHUB_WORKSPACE/.tools/zed-cli/target/release/zed" install --frozen --install-mode copy)
          python3 tests/opto-sync/adoption_contract.py --wrapper wrapper --live
      - name: Run native and real-browser Opto-Sync conformance
        shell: bash
        run: |
          set -euo pipefail
          client="$GITHUB_WORKSPACE/wrapper/zed_modules/opto-sync/opto-sync-clients/clients/ts"
          cd "$client"
          npm ci
          npm run build
          npm run test:node
          npx playwright install --with-deps chromium
          OPTO_SYNC_REQUIRE_BROWSER=1 npm run test:browser
          cp "$GITHUB_WORKSPACE/tests/opto-sync/product.e2e.test.mjs" test/generated-downstream.e2e.test.mjs
          OPTO_SYNC_PROFILE="$GITHUB_WORKSPACE/opto-sync-adoption.json" node --test test/generated-downstream.e2e.test.mjs
'''
    return (
        template.replace("__WRAPPER_REF__", profile["wrapperRef"])
        .replace("__WRAPPER_REPOSITORY__", profile["wrapperRepository"])
    )


def readme(profile: dict[str, Any]) -> str:
    guards = "\n".join(f"- {guard}" for guard in profile["domainGuards"])
    scenarios = "\n".join(f"- `{scenario}`" for scenario in profile["requiredScenarios"])
    return f"""# {profile['e2eRepository']}

Product-level Opto-Sync adoption and convergence tests for `{profile['wrapperRepository']}`.

This repository is generated from the reviewed fleet inventory owned by
`{profile['bootstrapIssue']}`. The generated files are a starting point, not
proof that the GitHub repository has been provisioned or that a live frozen
install has passed.

## Release boundary

The live workflow remains skipped until `{profile['dependency']['package']}@{profile['dependency']['range']}`
is published under the coordinated `{', '.join(profile['releaseGates'])}` release gate and the wrapper contains a real immutable `.zpkg.lock`.

## Product-owned boundaries

{guards}

## Required scenarios

{scenarios}

## Local static validation

```sh
python3 tests/opto-sync/adoption_contract.py
node --check tests/opto-sync/product.e2e.test.mjs
```
"""


def agents(profile: dict[str, Any]) -> str:
    return f"""# Agent instructions

This repository owns E2E evidence for `{profile['wrapperRepository']}`.

- Preserve the Zed package-plane / Opto-Sync runtime-plane boundary.
- Never fabricate `.zpkg.lock` hashes, sizes, tags, commits, formats, or sources.
- Keep live jobs fail-closed when the package, private checkout credential, or protected release evidence is unavailable.
- Do not move product-domain policy into the shared reconciliation engine.
- Do not commit secrets, raw customer data, credentials, or production payloads.
- Resolve conflicts semantically and retain the product guards in `opto-sync-adoption.json`.
- Use draft pull requests until exact-head static and live evidence is attached.
"""


def build_files(manifest_path: Path, repository: str) -> dict[str, bytes]:
    manifest = load_manifest(manifest_path)
    wrapper = select_wrapper(manifest, repository)
    profile = profile_for(manifest, wrapper)
    files: dict[str, bytes] = {
        ".gitignore": b".dart_tool/\nnode_modules/\ntarget/\n.env\n.env.*\n!.env.example\n",
        "LICENSE": MIT_LICENSE.encode(),
        "README.md": readme(profile).encode(),
        "agents.md": agents(profile).encode(),
        "opto-sync-adoption.json": canonical_json(profile).encode(),
        "tests/opto-sync/adoption_contract.py": contract_script().encode(),
        "tests/opto-sync/product.e2e.test.mjs": product_test().encode(),
        ".github/workflows/opto-sync-adoption.yml": workflow(profile).encode(),
    }
    manifest_digest = sha256_file(manifest_path)
    inventory = [
        {
            "path": path,
            "sha256": sha256_bytes(content),
            "size": len(content),
        }
        for path, content in sorted(files.items())
    ]
    receipt = {
        "schemaVersion": 1,
        "repository": repository,
        "sourceManifest": str(manifest_path.relative_to(ROOT)),
        "sourceManifestSha256": manifest_digest,
        "generator": "scripts/render-missing-e2e-repository.py",
        "bootstrapIssue": "DEN-1469",
        "files": inventory,
    }
    files["bootstrap-receipt.json"] = canonical_json(receipt).encode()
    validate_generated_files(files)
    return files


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
        fail(f"generated file set differs: {sorted(files)}")
    for path, content in files.items():
        pure = PurePosixPath(path)
        if pure.is_absolute() or ".." in pure.parts or path.startswith("/"):
            fail(f"unsafe generated path: {path}")
        text = content.decode("utf-8")
        lowered = text.lower()
        for marker in FORBIDDEN_SECRET_MARKERS:
            if marker in lowered:
                fail(f"generated file {path} contains forbidden secret marker {marker!r}")
        if "refs/heads/main" in lowered or '"latest"' in lowered:
            fail(f"generated file {path} contains a mutable ref")
    profile = json.loads(files["opto-sync-adoption.json"])
    if profile["e2eRepository"] not in {
        "akrion-sim/akrion-sim-e2e",
        "benefactor-cc/benefactor-e2e",
    }:
        fail("generator emitted an unapproved repository")


def write_tree(files: dict[str, bytes], output: Path) -> None:
    if output.exists() and any(output.iterdir()):
        fail(f"output directory must be absent or empty: {output}")
    output.mkdir(parents=True, exist_ok=True)
    for relative, content in sorted(files.items()):
        path = output / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        if relative.endswith(".py"):
            path.chmod(0o755)


def write_archive(files: dict[str, bytes], archive: Path, repository: str) -> None:
    archive.parent.mkdir(parents=True, exist_ok=True)
    root_name = repository.split("/", 1)[1]
    with tarfile.open(archive, "w:gz", format=tarfile.PAX_FORMAT) as handle:
        for relative, content in sorted(files.items()):
            name = f"{root_name}/{relative}"
            info = tarfile.TarInfo(name=name)
            info.size = len(content)
            info.mtime = 0
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            info.mode = 0o755 if relative.endswith(".py") else 0o644
            handle.addfile(info, io.BytesIO(content))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--archive", type=Path)
    args = parser.parse_args()
    if args.out is None and args.archive is None:
        parser.error("at least one of --out or --archive is required")
    try:
        files = build_files(args.manifest, args.repository)
        if args.out:
            write_tree(files, args.out)
        if args.archive:
            write_archive(files, args.archive, args.repository)
    except BootstrapError as exc:
        print(f"missing-e2e-bootstrap: {exc}", file=sys.stderr)
        return 1
    print(
        f"rendered {args.repository}: files={len(files)}, "
        f"tree={args.out or '-'}, archive={args.archive or '-'}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
