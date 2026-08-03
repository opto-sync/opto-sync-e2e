from __future__ import annotations

import hashlib
import importlib.util
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
STARTER_PATH = ROOT / "scripts/render-missing-e2e-starter.py"
CONTRACT_PATH = ROOT / "operations/zed-package-plane-contract.v1.json"
FLEET_PATH = ROOT / "operations/downstream-wrapper-fleet.v1.json"
SPEC = importlib.util.spec_from_file_location("final_zed_pin_starter", STARTER_PATH)
assert SPEC and SPEC.loader
STARTER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(STARTER)
CONTRACT = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
REPOSITORIES = (
    "akrion-sim/akrion-sim-e2e",
    "benefactor-cc/benefactor-e2e",
)


class FinalZedPinStarterTests(unittest.TestCase):
    def test_generated_workflows_use_only_the_final_reviewed_pair(self):
        required = CONTRACT["requiredWorkflowVariables"]
        for repository in REPOSITORIES:
            with self.subTest(repository=repository):
                files = STARTER.build_files(FLEET_PATH, repository)
                workflow = files[".github/workflows/opto-sync-adoption.yml"].decode()
                for name, expected in required.items():
                    self.assertEqual(workflow.count(f"{name}: {expected}"), 1)
                for forbidden in CONTRACT["forbiddenPins"]:
                    self.assertNotIn(forbidden, workflow)

    def test_bootstrap_receipt_hashes_the_final_pinned_workflow(self):
        for repository in REPOSITORIES:
            with self.subTest(repository=repository):
                files = STARTER.build_files(FLEET_PATH, repository)
                receipt = json.loads(files["bootstrap-receipt.json"])
                record = next(
                    item
                    for item in receipt["files"]
                    if item["path"] == ".github/workflows/opto-sync-adoption.yml"
                )
                workflow = files[record["path"]]
                self.assertEqual(record["size"], len(workflow))
                self.assertEqual(
                    record["sha256"],
                    hashlib.sha256(workflow).hexdigest(),
                )

    def test_contract_rejects_a_mismatched_cli_interface_pair(self):
        original = CONTRACT_PATH.read_text(encoding="utf-8")
        # Exercise the loader directly with a temporary alternate contract by
        # patching only the in-memory path reference, not the checked-in file.
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "contract.json"
            value = json.loads(original)
            value["zedCli"]["interfaceDependencySha"] = "1" * 40
            path.write_text(json.dumps(value), encoding="utf-8")
            old = STARTER.PACKAGE_PLANE_CONTRACT_PATH
            STARTER.PACKAGE_PLANE_CONTRACT_PATH = path
            try:
                with self.assertRaisesRegex(STARTER.BootstrapError, "disagree"):
                    STARTER.load_package_plane_pins()
            finally:
                STARTER.PACKAGE_PLANE_CONTRACT_PATH = old


if __name__ == "__main__":
    unittest.main()
