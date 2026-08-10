from __future__ import annotations

import copy
import importlib.util
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/check-downstream-wrapper-fleet.py"
MANIFEST_PATH = ROOT / "operations/downstream-wrapper-fleet.v1.json"
SPEC = importlib.util.spec_from_file_location("downstream_wrapper_fleet", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
MANIFEST = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
PROVISIONED = {
    "akrion-sim/akrion-sim-e2e",
    "benefactor-cc/benefactor-e2e",
}


class DownstreamWrapperFleetTests(unittest.TestCase):
    def test_complete_fleet_is_valid_and_deterministic(self):
        first = MODULE.validate_manifest(copy.deepcopy(MANIFEST))
        second = MODULE.validate_manifest(copy.deepcopy(MANIFEST))
        self.assertEqual(first, second)
        self.assertEqual(first["summary"]["wrappers"], 17)
        self.assertEqual(first["summary"]["existingE2e"], 17)
        self.assertEqual(first["summary"]["provisioningRequired"], 0)
        self.assertEqual(first["summary"]["provisionedBaselines"], 2)
        self.assertEqual(first["summary"]["waves"], {"A": 3, "B": 9, "C": 5})
        self.assertEqual(first["provisioningGaps"], [])
        self.assertEqual(set(first["provisionedBaselines"]), PROVISIONED)
        self.assertEqual(
            MODULE.render_markdown(first),
            MODULE.render_markdown(second),
        )

    def test_duplicate_wrapper_repository_fails(self):
        value = copy.deepcopy(MANIFEST)
        value["wrappers"][1]["repository"] = value["wrappers"][0]["repository"]
        with self.assertRaisesRegex(MODULE.FleetContractError, "duplicate wrapper repository"):
            MODULE.validate_manifest(value)

    def test_duplicate_e2e_repository_fails(self):
        value = copy.deepcopy(MANIFEST)
        value["wrappers"][1]["e2e"]["repository"] = value["wrappers"][0]["e2e"]["repository"]
        with self.assertRaisesRegex(MODULE.FleetContractError, "duplicate E2E repository"):
            MODULE.validate_manifest(value)

    def test_only_zed_sync_can_claim_bootstrap_independence(self):
        value = copy.deepcopy(MANIFEST)
        value["wrappers"][0]["bootstrapIndependent"] = False
        with self.assertRaisesRegex(MODULE.FleetContractError, "must preserve Zed bootstrap independence"):
            MODULE.validate_manifest(value)

        value = copy.deepcopy(MANIFEST)
        value["wrappers"][3]["bootstrapIndependent"] = True
        with self.assertRaisesRegex(MODULE.FleetContractError, "only zed-sync"):
            MODULE.validate_manifest(value)

    def test_exact_pin_pilots_cannot_drop_legacy_parity(self):
        for repository in (
            "sonus-auris/sonus-auris-sync",
            "voxletra/voxletra-sync",
        ):
            value = copy.deepcopy(MANIFEST)
            wrapper = next(item for item in value["wrappers"] if item["repository"] == repository)
            wrapper["legacyParityRequired"] = False
            with self.assertRaisesRegex(MODULE.FleetContractError, "exact legacy parity"):
                MODULE.validate_manifest(value)

    def test_every_e2e_repository_must_now_exist(self):
        for repository in PROVISIONED:
            value = copy.deepcopy(MANIFEST)
            wrapper = next(
                item for item in value["wrappers"] if item["e2e"]["repository"] == repository
            )
            wrapper["e2e"] = {
                "status": "provisioning_required",
                "repository": repository,
                "branch": None,
                "pullRequest": None,
                "blocker": "stale repository-creation blocker that should no longer be accepted",
            }
            with self.assertRaisesRegex(MODULE.FleetContractError, "must now exist"):
                MODULE.validate_manifest(value)

    def test_provisioned_branch_pr_and_bootstrap_provenance_are_exact(self):
        for repository in PROVISIONED:
            for field, value in (
                ("branch", "agent/den-313-other"),
                ("pullRequest", 99),
                ("provisionedByIssue", "DEN-9999"),
                ("bootstrapSource", "manual-copy"),
                ("bootstrapMode", "hand-written"),
            ):
                manifest = copy.deepcopy(MANIFEST)
                wrapper = next(
                    item
                    for item in manifest["wrappers"]
                    if item["e2e"]["repository"] == repository
                )
                wrapper["e2e"][field] = value
                with self.subTest(repository=repository, field=field):
                    with self.assertRaisesRegex(
                        MODULE.FleetContractError,
                        "reviewed DEN-1469 baseline",
                    ):
                        MODULE.validate_manifest(manifest)

    def test_non_provisioned_entries_cannot_claim_bootstrap_provenance(self):
        value = copy.deepcopy(MANIFEST)
        wrapper = next(
            item
            for item in value["wrappers"]
            if item["e2e"]["repository"] == "zed-pkg/zed-e2e"
        )
        wrapper["e2e"]["provisionedByIssue"] = "DEN-1469"
        with self.assertRaisesRegex(MODULE.FleetContractError, "unexpected provisioned-baseline"):
            MODULE.validate_manifest(value)

    def test_mutable_or_unscoped_branches_fail(self):
        value = copy.deepcopy(MANIFEST)
        value["wrappers"][0]["branch"] = "main"
        with self.assertRaisesRegex(MODULE.FleetContractError, "scoped agent"):
            MODULE.validate_manifest(value)

        value = copy.deepcopy(MANIFEST)
        value["wrappers"][3]["e2e"]["branch"] = "agent/den-1387-latest"
        with self.assertRaisesRegex(MODULE.FleetContractError, "mutable ref|unexpected E2E"):
            MODULE.validate_manifest(value)

    def test_wave_issue_and_reconciliation_drift_fail(self):
        value = copy.deepcopy(MANIFEST)
        value["wrappers"][0]["wave"] = "B"
        with self.assertRaisesRegex(MODULE.FleetContractError, "does not match wave"):
            MODULE.validate_manifest(value)

        value = copy.deepcopy(MANIFEST)
        value["wrappers"].pop()
        with self.assertRaisesRegex(MODULE.FleetContractError, "exactly 17"):
            MODULE.validate_manifest(value)

        value = copy.deepcopy(MANIFEST)
        value["reconciliationIssue"] = "DEN-1466"
        with self.assertRaisesRegex(MODULE.FleetContractError, "DEN-1534"):
            MODULE.validate_manifest(value)

    def test_product_guards_and_backend_authority_are_required(self):
        value = copy.deepcopy(MANIFEST)
        value["wrappers"][4]["domainGuards"] = ["too short", "also short"]
        with self.assertRaisesRegex(MODULE.FleetContractError, "real product boundaries"):
            MODULE.validate_manifest(value)

        value = copy.deepcopy(MANIFEST)
        value["wrappers"][4]["persistence"].remove("supabase")
        with self.assertRaisesRegex(MODULE.FleetContractError, "Postgres and Supabase"):
            MODULE.validate_manifest(value)


if __name__ == "__main__":
    unittest.main()
