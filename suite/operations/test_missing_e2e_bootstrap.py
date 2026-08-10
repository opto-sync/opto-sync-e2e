from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = ROOT / "operations/downstream-wrapper-fleet.v1.json"
GENERATOR_PATH = ROOT / "scripts/render-missing-e2e-starter.py"
ARCHIVE_PATH = ROOT / "scripts/render-missing-e2e-archive.py"


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


GENERATOR = load_module("provisioned_e2e_starter_tests", GENERATOR_PATH)
ARCHIVE = load_module("provisioned_e2e_archive_tests", ARCHIVE_PATH)
REPOSITORIES = (
    "akrion-sim/akrion-sim-e2e",
    "benefactor-cc/benefactor-e2e",
)


def tree_snapshot(root: Path) -> dict[str, tuple[str, int, int]]:
    result: dict[str, tuple[str, int, int]] = {}
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        relative = path.relative_to(root).as_posix()
        content = path.read_bytes()
        result[relative] = (
            hashlib.sha256(content).hexdigest(),
            len(content),
            stat.S_IMODE(path.stat().st_mode),
        )
    return result


class ProvisionedE2EBaselineTests(unittest.TestCase):
    def test_both_reviewed_repositories_render_byte_identical_baselines(self):
        for repository in REPOSITORIES:
            with self.subTest(repository=repository), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                first = root / "first"
                second = root / "second"
                files_a = GENERATOR.build_files(MANIFEST, repository)
                files_b = GENERATOR.build_files(MANIFEST, repository)
                self.assertEqual(files_a, files_b)
                GENERATOR.write_tree(files_a, first)
                GENERATOR.write_tree(files_b, second)
                self.assertEqual(tree_snapshot(first), tree_snapshot(second))
                snapshot = tree_snapshot(first)
                self.assertEqual(len(snapshot), 9)
                self.assertEqual(
                    snapshot["tests/opto-sync/adoption_contract.py"][2],
                    0o755,
                )
                self.assertEqual(snapshot["opto-sync-adoption.json"][2], 0o644)

    def test_canonical_archives_ignore_wall_clock_and_host_metadata(self):
        for repository in REPOSITORIES:
            with self.subTest(repository=repository), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                files = GENERATOR.build_files(MANIFEST, repository)
                first = root / "first.tar.gz"
                second = root / "second.tar.gz"
                ARCHIVE.write_archive(files, repository, first)
                time.sleep(1.1)
                ARCHIVE.write_archive(files, repository, second)
                first_bytes = first.read_bytes()
                second_bytes = second.read_bytes()
                self.assertEqual(first_bytes, second_bytes)
                self.assertEqual(first_bytes[0:2], b"\x1f\x8b")
                self.assertEqual(first_bytes[4:8], b"\x00\x00\x00\x00")
                self.assertEqual(first_bytes[3] & 0x08, 0, "gzip filename flag set")
                entries = ARCHIVE.inspect_archive(first_bytes, repository)
                self.assertEqual(len(entries), 9)
                self.assertEqual(
                    [entry["name"] for entry in entries],
                    sorted(entry["name"] for entry in entries),
                )
                for entry in entries:
                    self.assertEqual(entry["mtime"], 0)
                    self.assertEqual(entry["uid"], 0)
                    self.assertEqual(entry["gid"], 0)
                    self.assertEqual(entry["uname"], "")
                    self.assertEqual(entry["gname"], "")
                    expected_mode = 0o755 if entry["name"].endswith(".py") else 0o644
                    self.assertEqual(entry["mode"], expected_mode)

    def test_generated_receipt_covers_every_pre_receipt_file(self):
        for repository in REPOSITORIES:
            with self.subTest(repository=repository):
                files = GENERATOR.build_files(MANIFEST, repository)
                receipt = json.loads(files["bootstrap-receipt.json"])
                self.assertEqual(receipt["repository"], repository)
                self.assertEqual(receipt["bootstrapIssue"], "DEN-1469")
                recorded = {item["path"]: item for item in receipt["files"]}
                self.assertEqual(set(recorded), set(files) - {"bootstrap-receipt.json"})
                for path, item in recorded.items():
                    content = files[path]
                    self.assertEqual(item["size"], len(content))
                    self.assertEqual(
                        item["sha256"],
                        hashlib.sha256(content).hexdigest(),
                    )

    def test_generated_static_contracts_execute_in_isolation(self):
        node = shutil.which("node")
        for repository in REPOSITORIES:
            with self.subTest(repository=repository), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp) / "generated"
                GENERATOR.write_tree(
                    GENERATOR.build_files(MANIFEST, repository),
                    root,
                )
                subprocess.run(
                    [sys.executable, "tests/opto-sync/adoption_contract.py"],
                    cwd=root,
                    check=True,
                    capture_output=True,
                    text=True,
                )
                if node:
                    subprocess.run(
                        [node, "--check", "tests/opto-sync/product.e2e.test.mjs"],
                        cwd=root,
                        check=True,
                        capture_output=True,
                        text=True,
                    )
                workflow = (root / ".github/workflows/opto-sync-adoption.yml").read_text()
                profile = json.loads((root / "opto-sync-adoption.json").read_text())
                self.assertNotIn("__WRAPPER_", workflow)
                self.assertIn(profile["wrapperRepository"], workflow)
                self.assertIn(profile["wrapperRef"], workflow)
                self.assertIn("install --frozen --install-mode copy", workflow)
                self.assertIn("OPTO_SYNC_REQUIRE_BROWSER=1", workflow)
                self.assertIn("SYNC_FLEET_TOKEN", workflow)

    def test_unreviewed_repository_is_rejected(self):
        manifest = GENERATOR.load_manifest(MANIFEST)
        for repository in (
            "zed-pkg/zed-e2e",
            "opto-sync/not-reviewed-e2e",
            "../../escape",
        ):
            with self.subTest(repository=repository):
                with self.assertRaises(GENERATOR.BootstrapError):
                    GENERATOR.select_wrapper(manifest, repository)

    def test_existing_status_and_den_1469_provenance_are_required(self):
        manifest = GENERATOR.load_manifest(MANIFEST)
        for repository in REPOSITORIES:
            for field, value in (
                ("status", "provisioning_required"),
                ("branch", "agent/den-313-other"),
                ("pullRequest", 99),
                ("provisionedByIssue", "DEN-9999"),
                ("bootstrapSource", "manual-copy"),
                ("bootstrapMode", "hand-written"),
            ):
                with self.subTest(repository=repository, field=field):
                    modified = copy.deepcopy(manifest)
                    wrapper = next(
                        item
                        for item in modified["wrappers"]
                        if item["e2e"]["repository"] == repository
                    )
                    wrapper["e2e"][field] = value
                    with self.assertRaises(GENERATOR.BootstrapError):
                        GENERATOR.select_wrapper(modified, repository)

    def test_stale_blocker_is_rejected(self):
        manifest = GENERATOR.load_manifest(MANIFEST)
        wrapper = next(
            item
            for item in manifest["wrappers"]
            if item["e2e"]["repository"] == REPOSITORIES[0]
        )
        wrapper["e2e"]["blocker"] = "repository-creation no longer required"
        with self.assertRaisesRegex(GENERATOR.BootstrapError, "stale provisioning blocker"):
            GENERATOR.select_wrapper(manifest, REPOSITORIES[0])

    def test_mutable_configured_ref_is_rejected(self):
        files = GENERATOR.build_files(MANIFEST, REPOSITORIES[0])
        mutable = dict(files)
        mutable["README.md"] += b'\n{"ref":"latest"}\n'
        with self.assertRaisesRegex(GENERATOR.BootstrapError, "mutable ref"):
            GENERATOR.validate_generated_files(mutable)

    def test_archive_contains_no_directory_or_unsafe_entries(self):
        repository = REPOSITORIES[0]
        data = ARCHIVE.canonical_archive_bytes(
            GENERATOR.build_files(MANIFEST, repository),
            repository,
        )
        root_name = repository.split("/", 1)[1]
        with tarfile.open(fileobj=__import__("io").BytesIO(data), mode="r:gz") as handle:
            for member in handle.getmembers():
                self.assertTrue(member.isfile())
                self.assertTrue(member.name.startswith(root_name + "/"))
                self.assertNotIn("..", Path(member.name).parts)
                self.assertFalse(Path(member.name).is_absolute())


if __name__ == "__main__":
    unittest.main()
