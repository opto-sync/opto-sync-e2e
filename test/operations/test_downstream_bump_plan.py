from __future__ import annotations

import copy
import importlib.util
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/plan-downstream-bumps.py"
SPEC = importlib.util.spec_from_file_location("downstream_bump_plan", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

RELEASE = json.loads((ROOT / "release/opto-sync-release-set.candidate.json").read_text(encoding="utf-8"))
MANIFEST = json.loads((ROOT / "operations/downstream-consumers.v1.json").read_text(encoding="utf-8"))


class DownstreamBumpPlanTests(unittest.TestCase):
    def published_release(self):
        value = copy.deepcopy(RELEASE)
        value["releaseSet"]["status"] = "published"
        for name, checksum in zip(("syncer", "clients", "e2e"), ("1" * 64, "2" * 64, "3" * 64), strict=True):
            value["certification"]["artifactChecksums"][name] = checksum
        package_by_repo = {package["repository"]: package for package in value["packages"].values()}
        for run in value["certification"]["requiredRuns"]:
            run["conclusion"] = "success"
            run["headSha"] = package_by_repo[run["repository"]]["sha"]
        value["rollback"].update(
            {
                "owner": "opto-sync release manager",
                "procedure": "Revert downstream bump PRs as paired gitlink units.",
            }
        )
        return value

    def test_candidate_is_complete_but_not_dispatchable(self):
        plan = MODULE.build_plan(RELEASE, MANIFEST)
        self.assertFalse(plan["dispatchAllowed"])
        self.assertEqual(len(plan["consumers"]), 2)
        self.assertTrue(any("status" in blocker for blocker in plan["blockers"]))
        self.assertTrue(any("placeholder" in blocker for blocker in plan["blockers"]))
        for consumer in plan["consumers"]:
            self.assertEqual([item["kind"] for item in consumer["updates"]], ["gitlink", "gitlink"])
            self.assertEqual(
                {item["sha"] for item in consumer["updates"]},
                {RELEASE["packages"]["syncer"]["sha"], RELEASE["packages"]["clients"]["sha"]},
            )
            self.assertFalse(consumer["pullRequest"]["autoMerge"])
            self.assertEqual(consumer["baseBranch"], "main")

    def test_published_evidence_allows_dispatch(self):
        plan = MODULE.build_plan(self.published_release(), MANIFEST)
        self.assertTrue(plan["dispatchAllowed"])
        self.assertEqual(plan["blockers"], [])

    def test_one_sided_and_duplicate_consumers_fail(self):
        one_sided = copy.deepcopy(MANIFEST)
        one_sided["consumers"][0]["clientsGitlink"] = one_sided["consumers"][0]["coreGitlink"]
        with self.assertRaises(SystemExit):
            MODULE.build_plan(RELEASE, one_sided)
        duplicate = copy.deepcopy(MANIFEST)
        duplicate["consumers"].append(copy.deepcopy(duplicate["consumers"][0]))
        with self.assertRaises(SystemExit):
            MODULE.build_plan(RELEASE, duplicate)

    def test_mismatched_embedded_core_fails_closed(self):
        value = copy.deepcopy(RELEASE)
        value["packages"]["clients"]["embeddedSyncerSha"] = "f" * 40
        with self.assertRaises(SystemExit):
            MODULE.build_plan(value, MANIFEST)

    def test_output_is_deterministic_and_reviewable(self):
        first = MODULE.build_plan(RELEASE, MANIFEST)
        second = MODULE.build_plan(copy.deepcopy(RELEASE), copy.deepcopy(MANIFEST))
        self.assertEqual(
            json.dumps(first, sort_keys=True, separators=(",", ":")),
            json.dumps(second, sort_keys=True, separators=(",", ":")),
        )
        for consumer in first["consumers"]:
            self.assertTrue(consumer["branch"].startswith("agent/opto-sync-release-"))
            self.assertTrue(consumer["linearProject"].startswith("github.com/"))
            self.assertIn("Auto-merge is intentionally disabled", consumer["pullRequest"]["body"])
            self.assertTrue(consumer["requiredChecks"])


if __name__ == "__main__":
    unittest.main()
