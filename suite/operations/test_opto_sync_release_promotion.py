from __future__ import annotations

import copy
import importlib.util
import json
import sys
import unittest
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/validate-opto-sync-release-promotion.py"
CONTRACT_PATH = ROOT / "operations/opto-sync-release-promotion-contract.v1.json"
SPEC = importlib.util.spec_from_file_location("opto_sync_release_promotion", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)
CONTRACT = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))

SYNCER_SHA = "8d2b275a89062403666f4bdf196d246a07c84484"
CLIENTS_SHA = "38f0fcc6a471455a0a20aec5f7fa63d3f70d5f89"
E2E_SHA = "562e3f62645252ed79328b7ac30ce404ceb5fc92"
CLI_SHA = "a850dbcc799aeaccf1093741ab58439a049c14c9"
INTERFACES_SHA = "c2e049006453c26ca8ca291783f681fce75cb01f"
RELEASE_SET_ID = CONTRACT["releaseSetId"]

ARTIFACTS = [
    {
        "source": "syncer",
        "filename": "opto-sync-syncer-0.2.1.tar.gz",
        "canonical": True,
        "sha256": "444d57c04f80a910e418dec02ebaab1032f4e72fcaf43c1ed1c15d08d7aa163b",
        "size": 554540,
        "fileCount": 217,
    },
    {
        "source": "syncer",
        "filename": "opto-sync-syncer-c-0.2.1.tar.gz",
        "canonical": False,
        "sha256": "9a65dc901c89e95175b03263efa61cd6d990e42b05bb34a8ec847cab6dcb9b3d",
        "size": 138264,
        "fileCount": 9,
    },
    {
        "source": "syncer",
        "filename": "opto-sync-syncer-wasm-0.2.1.tar.gz",
        "canonical": False,
        "sha256": "ae458615cc05635d58cb400a4e187186b7685c73cd81e1fef42bbb9a64226f03",
        "size": 142226,
        "fileCount": 15,
    },
    {
        "source": "clients",
        "filename": "opto-sync-opto-sync-clients-0.2.0.tar.gz",
        "canonical": True,
        "sha256": "0719690cbadec372ec1dad95ca91b1cb6ec8ec9d2a8caf1e9551e3396fcaba14",
        "size": 858022,
        "fileCount": 378,
    },
    {
        "source": "e2e",
        "filename": "opto-sync-opto-sync-e2e-0.1.0.tar.gz",
        "canonical": True,
        "sha256": "f88f128a221ce7cbcc08c521393cf9ada7bf6315b009e704617dd1a636ee1180",
        "size": 308386,
        "fileCount": 143,
    },
]


def release_set() -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "releaseSet": {
            "id": RELEASE_SET_ID,
            "status": "candidate",
            "createdAt": "2026-08-03T04:04:51.993239Z",
        },
        "packages": {
            "syncer": {
                "repository": "opto-sync/syncer.c",
                "sha": SYNCER_SHA,
                "treeSha": "8935c7ce94657a68ad22829f3dcbd299fafddb93",
                "tag": "v0.2.1",
                "version": "0.2.1",
                "zedPackage": "opto-sync/syncer",
                "canonicalArchive": "opto-sync-syncer-0.2.1.tar.gz",
            },
            "clients": {
                "repository": "opto-sync/opto-sync-clients",
                "sha": CLIENTS_SHA,
                "treeSha": "c89cc0e08ab156bcdf9487a7c2f0515d6c88c865",
                "tag": "v0.2.0",
                "version": "0.2.0",
                "zedPackage": "opto-sync/opto-sync-clients",
                "canonicalArchive": "opto-sync-opto-sync-clients-0.2.0.tar.gz",
                "embeddedSyncerSha": SYNCER_SHA,
            },
            "e2e": {
                "repository": "opto-sync/opto-sync-e2e",
                "sha": E2E_SHA,
                "treeSha": "3ef8320a00b3b382ea8b5153e6615eff6f0efc5a",
                "tag": "v0.1.0",
                "version": "0.1.0",
                "zedPackage": "opto-sync/opto-sync-e2e",
                "canonicalArchive": "opto-sync-opto-sync-e2e-0.1.0.tar.gz",
                "pinnedSyncerSha": SYNCER_SHA,
                "pinnedClientsSha": CLIENTS_SHA,
            },
        },
        "certification": {
            "packagingMethod": "independent_untouched_checkouts_before_build",
            "requiredRuns": [],
            "artifactChecksums": {
                "syncer": ARTIFACTS[0]["sha256"],
                "clients": ARTIFACTS[3]["sha256"],
                "e2e": ARTIFACTS[4]["sha256"],
            },
            "artifactFiles": copy.deepcopy(ARTIFACTS),
            "tooling": {
                "zedCliRepository": "zed-pkg/zed-cli",
                "zedCliSha": "c636fb8f6b08695c6b4fe94e2481f4d57270b2d7",
                "zedInterfacesRepository": "zed-pkg/zed-interfaces",
                "zedInterfacesSha": "415e871b1fb3dd97744c134351408a3224805dfb",
            },
            "publicationPerformed": False,
        },
        "rollback": {
            "owner": "Opto-Sync maintainers",
            "procedure": "release/ROLLBACK.md",
            "partialReleasePolicy": "Never overwrite an immutable version.",
        },
    }


def package_plane() -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "ownerIssue": "DEN-1576",
        "parentIssue": "DEN-313",
        "zedCli": {
            "repository": "zed-pkg/zed-cli",
            "sha": CLI_SHA,
            "evidencePullRequest": 43,
            "interfaceDependencySha": INTERFACES_SHA,
        },
        "zedInterfaces": {
            "repository": "zed-pkg/zed-interfaces",
            "sha": INTERFACES_SHA,
            "strictParserSha": "cc5ed7339672543c734c5f1fd19f7e017a771854",
            "evidencePullRequests": [21, 23],
        },
        "requiredWorkflowVariables": {
            "ZED_CLI_SHA": CLI_SHA,
            "ZED_INTERFACES_SHA": INTERFACES_SHA,
        },
        "forbiddenPins": [
            "c636fb8f6b08695c6b4fe94e2481f4d57270b2d7",
            "dc0e0a0620b9462817950b552d3d334a184b1cb1",
            "415e871b1fb3dd97744c134351408a3224805dfb",
            "625ba7bdf4339df7d0880f791a0715ca894558fe",
            "cc5ed7339672543c734c5f1fd19f7e017a771854",
        ],
        "requiredProperties": ["strict committed locks"],
        "releaseGates": ["DEN-309", "DEN-363"],
    }


def expected_packages() -> dict[str, list[dict[str, Any]]]:
    contract = MODULE.validate_contract(copy.deepcopy(CONTRACT))
    return MODULE.validate_release_set(release_set(), contract)["expectedPackages"]


def publication_report(stage_name: str, *, verified: bool = True) -> dict[str, Any]:
    by_stage = expected_packages()
    stage = next(stage for stage in CONTRACT["stages"] if stage["name"] == stage_name)
    manifest = release_set()["packages"][stage["manifestPackage"]]
    return {
        "schemaVersion": 1,
        "releaseSetId": RELEASE_SET_ID,
        "repository": manifest["repository"],
        "tag": manifest["tag"],
        "version": manifest["version"],
        "sourceCommit": manifest["sha"],
        "publicationVerified": verified,
        "failedCount": 0 if verified else 1,
        "artifactDigest": "sha256:" + "a" * 64,
        "packages": copy.deepcopy(by_stage[stage_name]),
    }


def certification_report(*, verified: bool = True) -> dict[str, Any]:
    by_stage = expected_packages()
    return {
        "schemaVersion": 1,
        "releaseSetId": RELEASE_SET_ID,
        "certificationVerified": verified,
        "failedCount": 0 if verified else 1,
        "packagePlane": {
            "zedCliSha": CLI_SHA,
            "zedInterfacesSha": INTERFACES_SHA,
        },
        "wrappers": {"expected": 17, "verified": 17 if verified else 16},
        "e2e": {"expected": 15, "verified": 15},
        "packages": MODULE.all_expected_packages(by_stage),
    }


def reports_for_stage_count(count: int) -> dict[str, Any]:
    reports: dict[str, Any] = {}
    if count >= 1:
        reports["corePublication"] = publication_report("core_publication")
    if count >= 2:
        reports["clientsPublication"] = publication_report("clients_publication")
    if count >= 3:
        reports["e2ePublication"] = publication_report("e2e_publication")
    if count >= 4:
        reports["wrapperCertification"] = certification_report()
    return {"schemaVersion": 1, "releaseSetId": RELEASE_SET_ID, "reports": reports}


class OptoSyncReleasePromotionTests(unittest.TestCase):
    def evaluate(self, reports: dict[str, Any]) -> dict[str, Any]:
        return MODULE.evaluate(CONTRACT, release_set(), package_plane(), reports)

    def test_every_valid_stage_derives_only_the_next_allowed_actions(self):
        expected = [
            ("await_core_publication_verification", "core_publication", ["verify_core_publication"]),
            ("core_publication_verified", "clients_publication", ["publish_clients", "verify_clients_publication"]),
            ("clients_publication_verified", "e2e_publication", ["publish_e2e", "verify_e2e_publication"]),
            ("e2e_publication_verified", "wrapper_certification", ["generate_wrapper_locks", "verify_wrapper_certification"]),
            ("wrapper_certification_verified", None, ["merge_product_pull_requests"]),
        ]
        for count, (state, next_stage, actions) in enumerate(expected):
            with self.subTest(count=count):
                snapshot = self.evaluate(reports_for_stage_count(count))
                self.assertEqual(snapshot["state"], state)
                self.assertEqual(snapshot["nextStage"], next_stage)
                self.assertEqual(snapshot["allowedActions"], actions)
                self.assertEqual(len(snapshot["verifiedStages"]), count)
                self.assertTrue(snapshot["readOnly"])

    def test_snapshot_is_byte_deterministic_and_report_order_independent(self):
        first_reports = reports_for_stage_count(3)
        reversed_reports = copy.deepcopy(first_reports)
        reversed_reports["reports"] = dict(reversed(list(reversed_reports["reports"].items())))
        first = self.evaluate(first_reports)
        second = self.evaluate(reversed_reports)
        self.assertEqual(first, second)
        self.assertEqual(MODULE.canonical_bytes(first), MODULE.canonical_bytes(second))
        self.assertRegex(first["snapshotDigest"], r"^sha256:[0-9a-f]{64}$")

    def test_downstream_evidence_before_prerequisite_fails_closed(self):
        skipped_core = reports_for_stage_count(0)
        skipped_core["reports"]["clientsPublication"] = publication_report("clients_publication")
        with self.assertRaisesRegex(MODULE.ContractError, "before every prerequisite"):
            self.evaluate(skipped_core)

        skipped_clients = reports_for_stage_count(1)
        skipped_clients["reports"]["e2ePublication"] = publication_report("e2e_publication")
        with self.assertRaisesRegex(MODULE.ContractError, "before every prerequisite"):
            self.evaluate(skipped_clients)

        skipped_e2e = reports_for_stage_count(2)
        skipped_e2e["reports"]["wrapperCertification"] = certification_report()
        with self.assertRaisesRegex(MODULE.ContractError, "before every prerequisite"):
            self.evaluate(skipped_e2e)

    def test_false_verification_or_failed_count_blocks_promotion(self):
        reports = reports_for_stage_count(0)
        reports["reports"]["corePublication"] = publication_report("core_publication", verified=False)
        snapshot = self.evaluate(reports)
        self.assertEqual(snapshot["state"], "await_core_publication_verification")
        self.assertEqual(snapshot["verifiedStages"], [])
        self.assertIn("corePublication: publicationVerified is false", snapshot["blockedReasons"])
        self.assertIn("corePublication: failedCount is 1", snapshot["blockedReasons"])

    def test_immutable_identity_and_package_field_mismatches_fail_closed(self):
        mutations = {
            "repository": lambda report: report.update(repository="other/syncer.c"),
            "tag": lambda report: report.update(tag="v9.9.9"),
            "version": lambda report: report.update(version="9.9.9"),
            "source commit": lambda report: report.update(sourceCommit="f" * 40),
            "package hash": lambda report: report["packages"][0].update(sha256="1" * 64),
            "package size": lambda report: report["packages"][0].update(size=1),
            "registry": lambda report: report["packages"][0].update(source="https://other.invalid"),
        }
        for label, mutate in mutations.items():
            with self.subTest(label=label):
                reports = reports_for_stage_count(0)
                report = publication_report("core_publication")
                mutate(report)
                reports["reports"]["corePublication"] = report
                with self.assertRaises(MODULE.ContractError):
                    self.evaluate(reports)

    def test_duplicate_or_partial_package_sets_fail_closed(self):
        reports = reports_for_stage_count(0)
        report = publication_report("core_publication")
        report["packages"].append(copy.deepcopy(report["packages"][0]))
        reports["reports"]["corePublication"] = report
        with self.assertRaisesRegex(MODULE.ContractError, "duplicate package"):
            self.evaluate(reports)

        reports = reports_for_stage_count(0)
        report = publication_report("core_publication")
        report["packages"].pop()
        reports["reports"]["corePublication"] = report
        with self.assertRaisesRegex(MODULE.ContractError, "differ"):
            self.evaluate(reports)

    def test_stale_package_plane_fails_wrapper_certification(self):
        reports = reports_for_stage_count(4)
        reports["reports"]["wrapperCertification"]["packagePlane"]["zedCliSha"] = "f" * 40
        with self.assertRaisesRegex(MODULE.ContractError, "stale or mismatched"):
            self.evaluate(reports)

    def test_incomplete_wrapper_counts_remain_at_e2e_verified(self):
        reports = reports_for_stage_count(3)
        reports["reports"]["wrapperCertification"] = certification_report(verified=False)
        snapshot = self.evaluate(reports)
        self.assertEqual(snapshot["state"], "e2e_publication_verified")
        self.assertEqual(snapshot["nextStage"], "wrapper_certification")
        self.assertIn("wrapperCertification: verified wrappers 16 != 17", snapshot["blockedReasons"])

    def test_unknown_reports_and_input_derived_state_are_rejected(self):
        reports = reports_for_stage_count(0)
        reports["reports"]["futureStage"] = {}
        with self.assertRaisesRegex(MODULE.ContractError, "unknown report keys"):
            self.evaluate(reports)

        reports = reports_for_stage_count(0)
        reports["state"] = "caller_controlled"
        with self.assertRaisesRegex(MODULE.ContractError, "keys differ"):
            self.evaluate(reports)

    def test_release_set_and_package_plane_drift_fail_closed(self):
        release = release_set()
        release["releaseSet"]["id"] = "other"
        with self.assertRaisesRegex(MODULE.ContractError, "does not match"):
            MODULE.evaluate(CONTRACT, release, package_plane(), reports_for_stage_count(0))

        plane = package_plane()
        plane["zedCli"]["interfaceDependencySha"] = "f" * 40
        with self.assertRaisesRegex(MODULE.ContractError, "does not match"):
            MODULE.evaluate(CONTRACT, release_set(), plane, reports_for_stage_count(0))


if __name__ == "__main__":
    unittest.main()
