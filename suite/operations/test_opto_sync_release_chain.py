from __future__ import annotations

import copy
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/check-opto-sync-release-chain.py"
CONTRACT_PATH = ROOT / "operations/opto-sync-release-chain.v1.json"
SPEC = importlib.util.spec_from_file_location("opto_sync_release_chain", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)
RAW_CONTRACT = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
CONTRACT = MODULE.validate_contract(copy.deepcopy(RAW_CONTRACT))
STAGES = MODULE.stage_map(CONTRACT)


def core_report(verified: bool = True) -> dict:
    stage = STAGES["core"]
    required = stage["requiredEvidence"]
    if verified:
        locks = []
        for index, package in enumerate(MODULE.expected_lock_projection(stage)):
            value = dict(package)
            value["file"] = f"{stage['packages'][index]['name']}.zpkg.lock"
            value["source"] = "https://registry.zpkg.tech"
            locks.append(value)
        return {
            "schemaVersion": 1,
            "ownerIssue": stage["outcomeIssue"],
            "repository": stage["repository"],
            "activation": {
                "pullRequest": 20,
                "mergeSha": "39aa65805dde93f29945e29cf66b830e0b55868a",
                "activationFile": "release/zed-publication-activation.v1.json",
            },
            "release": {
                "tag": stage["tag"],
                "version": stage["version"],
                "targetSha": stage["sourceSha"],
                "targetTreeSha": stage["treeSha"],
            },
            "publicationVerified": True,
            "state": required["state"],
            "checks": [
                {"name": "immutable_tag", "passed": True, "detail": {}},
                {"name": "trusted_workflow_run", "passed": True, "detail": {}},
                {"name": "bounded_lock_artifact", "passed": True, "detail": {}},
                {"name": "three_frozen_locks", "passed": True, "detail": locks},
            ],
            "errors": [],
            "summary": {
                "checks": required["checks"],
                "passed": required["checks"],
                "failed": 0,
                "locks": required["locks"],
            },
        }
    return {
        "schemaVersion": 1,
        "ownerIssue": stage["outcomeIssue"],
        "repository": stage["repository"],
        "activation": {
            "pullRequest": 20,
            "mergeSha": "39aa65805dde93f29945e29cf66b830e0b55868a",
            "activationFile": "release/zed-publication-activation.v1.json",
        },
        "release": {
            "tag": stage["tag"],
            "version": stage["version"],
            "targetSha": stage["sourceSha"],
            "targetTreeSha": stage["treeSha"],
        },
        "publicationVerified": False,
        "state": "not_verified",
        "checks": [
            {"name": "immutable_tag", "passed": False, "detail": {"error": "missing"}},
            {"name": "trusted_workflow_run", "passed": False, "detail": {"error": "missing"}},
            {"name": "bounded_lock_artifact", "passed": False, "detail": {"error": "missing"}},
            {"name": "three_frozen_locks", "passed": False, "detail": {"error": "missing"}},
        ],
        "errors": ["not verified"],
        "summary": {"checks": 4, "passed": 0, "failed": 4, "locks": 0},
    }


def generic_report(stage_id: str, verified: bool = True) -> dict:
    stage = STAGES[stage_id]
    required = stage["requiredEvidence"]
    return {
        "schemaVersion": 1,
        "stage": stage_id,
        "ownerIssue": stage["outcomeIssue"],
        "repository": stage["repository"],
        "publicationVerified": verified,
        "state": required["state"] if verified else "not_verified",
        "release": {
            "tag": stage["tag"],
            "version": stage["version"],
            "targetSha": stage["sourceSha"],
            "targetTreeSha": stage["treeSha"],
        },
        "dependencies": MODULE.expected_dependencies(stage_id, STAGES),
        "packages": MODULE.expected_lock_projection(stage) if verified else [],
        "errors": [] if verified else ["not verified"],
        "summary": (
            {
                "checks": required["checks"],
                "passed": required["checks"],
                "failed": 0,
                "locks": required["locks"],
            }
            if verified
            else {"checks": required["checks"], "passed": 0, "failed": required["checks"], "locks": 0}
        ),
    }


def wrappers_report(verified: bool = True) -> dict:
    stage = STAGES["wrappers"]
    return {
        "schemaVersion": 1,
        "stage": "wrappers",
        "ownerIssue": stage["outcomeIssue"],
        "certificationVerified": verified,
        "state": stage["requiredEvidence"]["state"] if verified else "not_verified",
        "packagePlane": dict(CONTRACT["packagePlane"]),
        "releaseSet": {
            "core": {
                "tag": STAGES["core"]["tag"],
                "sourceSha": STAGES["core"]["sourceSha"],
            },
            "clients": {
                "tag": STAGES["clients"]["tag"],
                "sourceSha": STAGES["clients"]["sourceSha"],
            },
            "e2e": {
                "tag": STAGES["e2e"]["tag"],
                "sourceSha": STAGES["e2e"]["sourceSha"],
            },
        },
        "summary": (
            {
                "wrappers": 17,
                "e2eRepositories": 17,
                "realLocks": 17,
                "liveCertifications": 17,
                "failed": 0,
            }
            if verified
            else {
                "wrappers": 17,
                "e2eRepositories": 17,
                "realLocks": 0,
                "liveCertifications": 0,
                "failed": 17,
            }
        ),
        "errors": [] if verified else ["not verified"],
    }


def derive(**reports):
    values = {stage: reports.get(stage) for stage in MODULE.EXPECTED_STAGE_IDS}
    return MODULE.derive_state(CONTRACT, values)


class OptoSyncReleaseChainTests(unittest.TestCase):
    def test_no_reports_awaits_core_and_derives_one_action(self):
        result = derive()
        self.assertEqual(result["currentState"], "await_core_publication_verification")
        self.assertEqual(result["verifiedStages"], [])
        self.assertEqual(result["pendingStage"], "core")
        self.assertEqual(result["allowedActions"], ["run_core_publication_outcome_audit"])
        self.assertTrue(result["readOnly"])

    def test_unverified_core_report_blocks_without_becoming_invalid(self):
        result = derive(core=core_report(False))
        self.assertEqual(result["currentState"], "await_core_publication_verification")
        self.assertFalse(result["reports"]["core"]["verified"])
        self.assertTrue(result["reports"]["core"]["provided"])

    def test_each_verified_stage_advances_exactly_one_state(self):
        core = core_report()
        clients = generic_report("clients")
        e2e = generic_report("e2e")
        wrappers = wrappers_report()
        cases = (
            ({"core": core}, "core_verified", ["core"], "clients", ["activate_clients_publication"]),
            (
                {"core": core, "clients": clients},
                "clients_verified",
                ["core", "clients"],
                "e2e",
                ["activate_e2e_publication"],
            ),
            (
                {"core": core, "clients": clients, "e2e": e2e},
                "e2e_verified",
                ["core", "clients", "e2e"],
                "wrappers",
                ["generate_wrapper_real_locks", "run_wrapper_live_certification"],
            ),
            (
                {"core": core, "clients": clients, "e2e": e2e, "wrappers": wrappers},
                "fleet_live_certified",
                ["core", "clients", "e2e", "wrappers"],
                None,
                ["request_semantic_product_merges"],
            ),
        )
        for reports, state, verified, pending, actions in cases:
            with self.subTest(state=state):
                result = derive(**reports)
                self.assertEqual(result["currentState"], state)
                self.assertEqual(result["verifiedStages"], verified)
                self.assertEqual(result["pendingStage"], pending)
                self.assertEqual(result["allowedActions"], actions)

    def test_false_downstream_report_keeps_previous_verified_state(self):
        result = derive(core=core_report(), clients=generic_report("clients", False))
        self.assertEqual(result["currentState"], "core_verified")
        self.assertEqual(result["verifiedStages"], ["core"])
        self.assertEqual(result["allowedActions"], ["activate_clients_publication"])

    def test_reports_cannot_skip_or_outrun_prerequisites(self):
        cases = (
            {"clients": generic_report("clients")},
            {"core": core_report(False), "clients": generic_report("clients")},
            {"core": core_report(), "e2e": generic_report("e2e")},
            {
                "core": core_report(),
                "clients": generic_report("clients", False),
                "e2e": generic_report("e2e"),
            },
            {
                "core": core_report(),
                "clients": generic_report("clients"),
                "wrappers": wrappers_report(),
            },
            {
                "core": core_report(),
                "clients": generic_report("clients"),
                "e2e": generic_report("e2e", False),
                "wrappers": wrappers_report(),
            },
        )
        for reports in cases:
            with self.subTest(reports=sorted(reports)):
                with self.assertRaises(MODULE.ChainError):
                    derive(**reports)

    def test_native_core_report_requires_exact_release_summary_and_locks(self):
        mutations = {
            "owner": lambda report: report.update(ownerIssue="DEN-309"),
            "repository": lambda report: report.update(repository="fork/syncer.c"),
            "state": lambda report: report.update(state="not_verified"),
            "tag": lambda report: report["release"].update(tag="v9.9.9"),
            "source": lambda report: report["release"].update(targetSha="f" * 40),
            "summary": lambda report: report["summary"].update(locks=2),
            "missing lock check": lambda report: report.update(checks=report["checks"][:-1]),
            "hash": lambda report: report["checks"][3]["detail"][0].update(sha256="1" * 64),
            "duplicate package": lambda report: report["checks"][3]["detail"].append(copy.deepcopy(report["checks"][3]["detail"][0])),
        }
        for label, mutate in mutations.items():
            with self.subTest(label=label):
                report = core_report()
                mutate(report)
                with self.assertRaises(MODULE.ChainError):
                    derive(core=report)

    def test_clients_and_e2e_reports_bind_dependencies_and_package_identity(self):
        cases = []
        wrong_core = generic_report("clients")
        wrong_core["dependencies"]["core"]["sourceSha"] = "f" * 40
        cases.append(wrong_core)
        wrong_hash = generic_report("clients")
        wrong_hash["packages"][0]["sha256"] = "1" * 64
        cases.append(wrong_hash)
        zero_hash = generic_report("clients")
        zero_hash["packages"][0]["sha256"] = "0" * 64
        cases.append(zero_hash)
        wrong_e2e_client = generic_report("e2e")
        wrong_e2e_client["dependencies"]["clients"]["tag"] = "v9.9.9"
        cases.append(wrong_e2e_client)
        wrong_e2e_source = generic_report("e2e")
        wrong_e2e_source["release"]["targetSha"] = "e" * 40
        cases.append(wrong_e2e_source)
        for report in cases:
            with self.subTest(stage=report["stage"]):
                reports = {"core": core_report()}
                if report["stage"] == "e2e":
                    reports["clients"] = generic_report("clients")
                reports[report["stage"]] = report
                with self.assertRaises(MODULE.ChainError):
                    derive(**reports)

    def test_unverified_publication_cannot_claim_locks(self):
        report = generic_report("clients", False)
        report["packages"] = MODULE.expected_lock_projection(STAGES["clients"])
        with self.assertRaisesRegex(MODULE.ChainError, "cannot claim package locks"):
            derive(core=core_report(), clients=report)

    def test_wrapper_report_requires_final_zed_pair_release_set_and_17_counts(self):
        base_reports = {
            "core": core_report(),
            "clients": generic_report("clients"),
            "e2e": generic_report("e2e"),
        }
        cases = []
        stale_cli = wrappers_report()
        stale_cli["packagePlane"]["zedCliSha"] = "c636fb8f6b08695c6b4fe94e2481f4d57270b2d7"
        cases.append(stale_cli)
        wrong_release = wrappers_report()
        wrong_release["releaseSet"]["clients"]["tag"] = "v9.9.9"
        cases.append(wrong_release)
        partial = wrappers_report()
        partial["summary"]["realLocks"] = 16
        cases.append(partial)
        failure = wrappers_report()
        failure["summary"]["failed"] = 1
        cases.append(failure)
        for report in cases:
            with self.subTest(report=report):
                with self.assertRaises(MODULE.ChainError):
                    derive(**base_reports, wrappers=report)

    def test_contract_rejects_duplicate_packages_pin_drift_and_state_inputs(self):
        duplicate = copy.deepcopy(RAW_CONTRACT)
        duplicate["stages"][0]["packages"][1]["name"] = duplicate["stages"][0]["packages"][0]["name"]
        with self.assertRaisesRegex(MODULE.ChainError, "duplicate names"):
            MODULE.validate_contract(duplicate)

        stale = copy.deepcopy(RAW_CONTRACT)
        stale["packagePlane"]["zedInterfacesSha"] = "415e871b1fb3dd97744c134351408a3224805dfb"
        with self.assertRaisesRegex(MODULE.ChainError, "final reviewed Zed pair"):
            MODULE.validate_contract(stale)

        actions = copy.deepcopy(RAW_CONTRACT)
        actions["allowedActionsByState"]["core_verified"] = ["merge_everything"]
        with self.assertRaisesRegex(MODULE.ChainError, "allowedActionsByState"):
            MODULE.validate_contract(actions)

        state = copy.deepcopy(RAW_CONTRACT)
        state["currentState"] = "fleet_live_certified"
        # Unknown contract keys are rejected by ensuring callers cannot smuggle
        # a derived state into the contract.
        with self.assertRaises(MODULE.ChainError):
            MODULE.validate_contract(state)

    def test_report_order_does_not_change_derived_output(self):
        reports_a = {
            "core": core_report(),
            "clients": generic_report("clients"),
            "e2e": generic_report("e2e"),
            "wrappers": None,
        }
        reports_b = {
            "wrappers": None,
            "e2e": copy.deepcopy(reports_a["e2e"]),
            "clients": copy.deepcopy(reports_a["clients"]),
            "core": copy.deepcopy(reports_a["core"]),
        }
        first = MODULE.derive_state(CONTRACT, reports_a)
        second = MODULE.derive_state(CONTRACT, reports_b)
        self.assertEqual(first, second)
        self.assertEqual(
            json.dumps(first, sort_keys=True, separators=(",", ":")),
            json.dumps(second, sort_keys=True, separators=(",", ":")),
        )

    def test_cli_renders_byte_identical_default_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            first = Path(tmp) / "first.json"
            second = Path(tmp) / "second.json"
            self.assertEqual(MODULE.main_for_test if hasattr(MODULE, "main_for_test") else None, None)
            import subprocess
            subprocess.run(
                [sys.executable, str(SCRIPT), "--output", str(first)],
                cwd=ROOT,
                check=True,
            )
            subprocess.run(
                [sys.executable, str(SCRIPT), "--output", str(second)],
                cwd=ROOT,
                check=True,
            )
            self.assertEqual(first.read_bytes(), second.read_bytes())
            value = json.loads(first.read_text())
            self.assertEqual(value["currentState"], "await_core_publication_verification")


if __name__ == "__main__":
    unittest.main()
