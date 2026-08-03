from __future__ import annotations

import copy
import importlib.util
import json
import unittest
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/audit-downstream-wrapper-prs.py"
MANIFEST_PATH = ROOT / "operations/downstream-wrapper-fleet.v1.json"
SPEC = importlib.util.spec_from_file_location("downstream_wrapper_pr_audit", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
MANIFEST = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
PROVISIONED = {
    "akrion-sim/akrion-sim-e2e",
    "benefactor-cc/benefactor-e2e",
}


def pull(repository: str, number: int, branch: str) -> dict[str, Any]:
    return {
        "number": number,
        "state": "open",
        "draft": True,
        "merged": False,
        "merged_at": None,
        "base": {"ref": "main"},
        "head": {
            "ref": branch,
            "repo": {"full_name": repository},
        },
    }


def changed_files(paths: set[str], *, padding: int = 0) -> list[dict[str, str]]:
    values = [{"filename": path} for path in sorted(paths)]
    values.extend({"filename": f"extra/file-{index:03d}.txt"} for index in range(padding))
    return values


class FixtureClient:
    def __init__(self, manifest: dict[str, Any]):
        self.json_resources: dict[str, Any] = {}
        self.paginated_resources: dict[str, list[Any]] = {}
        for wrapper in manifest["wrappers"]:
            repository = wrapper["repository"]
            number = wrapper["pullRequest"]
            self.json_resources[MODULE.pull_resource(repository, number)] = pull(
                repository,
                number,
                wrapper["branch"],
            )
            self.paginated_resources[
                MODULE.pull_files_resource(repository, number)
            ] = changed_files(MODULE.WRAPPER_REQUIRED_FILES)

            e2e = wrapper["e2e"]
            e2e_repository = e2e["repository"]
            e2e_number = e2e["pullRequest"]
            self.json_resources[
                MODULE.pull_resource(e2e_repository, e2e_number)
            ] = pull(e2e_repository, e2e_number, e2e["branch"])
            self.paginated_resources[
                MODULE.pull_files_resource(e2e_repository, e2e_number)
            ] = changed_files(MODULE.e2e_required_files(wrapper))

    def get_json(self, resource: str) -> Any:
        value = self.json_resources[resource]
        if isinstance(value, Exception):
            raise value
        return copy.deepcopy(value)

    def get_paginated(self, resource: str) -> list[Any]:
        return copy.deepcopy(self.paginated_resources[resource])


class PagedClient(MODULE.GitHubClient):
    def __init__(self, pages: dict[str, Any]):
        # Deliberately bypass network/auth initialization while exercising the
        # production pagination implementation.
        self._token = "redacted-test-token"
        self._api_url = "https://example.invalid"
        self._timeout_seconds = 1
        self._max_pages = 5
        self.pages = pages
        self.requests: list[str] = []

    def _request_json(self, resource: str) -> Any:
        self.requests.append(resource)
        return copy.deepcopy(self.pages[resource])


class DownstreamWrapperPrAuditTests(unittest.TestCase):
    def test_complete_live_metadata_fixture_passes(self):
        client = FixtureClient(MANIFEST)
        report = MODULE.audit_fleet(MANIFEST, client)
        self.assertEqual(
            report["summary"],
            {
                "entries": 34,
                "passed": 34,
                "failed": 0,
                "counts": {
                    "e2e": 17,
                    "wrapper": 17,
                },
            },
        )
        self.assertEqual(report["reconciliationIssue"], "DEN-1534")
        self.assertTrue(report["readOnly"])
        self.assertTrue(all(entry["passed"] for entry in report["entries"]))

    def test_wrong_branch_non_draft_and_missing_lock_fail_together(self):
        client = FixtureClient(MANIFEST)
        wrapper = MANIFEST["wrappers"][0]
        repository = wrapper["repository"]
        number = wrapper["pullRequest"]
        pull_path = MODULE.pull_resource(repository, number)
        file_path = MODULE.pull_files_resource(repository, number)
        client.json_resources[pull_path]["head"]["ref"] = "agent/wrong-branch"
        client.json_resources[pull_path]["draft"] = False
        client.paginated_resources[file_path] = [
            item
            for item in client.paginated_resources[file_path]
            if item["filename"] != ".zpkg.lock"
        ]
        report = MODULE.audit_fleet(MANIFEST, client)
        entry = next(
            item
            for item in report["entries"]
            if item["kind"] == "wrapper" and item["repository"] == repository
        )
        self.assertFalse(entry["passed"])
        joined = "\n".join(entry["errors"])
        self.assertIn("must remain draft", joined)
        self.assertIn("head branch", joined)
        self.assertIn(".zpkg.lock", joined)

    def test_missing_pull_is_bounded_and_does_not_expose_response_body(self):
        client = FixtureClient(MANIFEST)
        wrapper = MANIFEST["wrappers"][3]
        path = MODULE.pull_resource(wrapper["repository"], wrapper["pullRequest"])
        client.json_resources[path] = MODULE.GitHubApiError(404, path)
        report = MODULE.audit_fleet(MANIFEST, client)
        entry = next(
            item
            for item in report["entries"]
            if item["kind"] == "wrapper"
            and item["repository"] == wrapper["repository"]
        )
        self.assertEqual(entry["actual"]["httpStatus"], 404)
        self.assertEqual(entry["errors"], [f"GitHub API returned HTTP 404 for {path}"])
        self.assertNotIn("token", json.dumps(entry).lower())

    def test_provisioned_e2e_branch_and_product_chaos_files_are_audited(self):
        client = FixtureClient(MANIFEST)
        for repository in PROVISIONED:
            wrapper = next(
                item
                for item in MANIFEST["wrappers"]
                if item["e2e"]["repository"] == repository
            )
            e2e = wrapper["e2e"]
            required = MODULE.e2e_required_files(wrapper)
            self.assertEqual(required, MODULE.PROVISIONED_E2E_REQUIRED_FILES[repository])
            self.assertIn(".github/workflows/opto-sync-product-e2e.yml", required)
            self.assertIn(".github/workflows/opto-sync-chaos-e2e.yml", required)

            path = MODULE.pull_files_resource(repository, e2e["pullRequest"])
            client.paginated_resources[path] = [
                item
                for item in client.paginated_resources[path]
                if item["filename"] != ".github/workflows/opto-sync-chaos-e2e.yml"
            ]
            report = MODULE.audit_fleet(MANIFEST, client)
            entry = next(
                item
                for item in report["entries"]
                if item["kind"] == "e2e" and item["repository"] == repository
            )
            self.assertFalse(entry["passed"])
            self.assertIn(
                ".github/workflows/opto-sync-chaos-e2e.yml",
                entry["missingFiles"],
            )
            # Restore before checking the second reviewed repository.
            client.paginated_resources[path] = changed_files(required)

    def test_paginated_file_fetch_collects_every_page(self):
        base = "/repos/example/project/pulls/7/files"
        first = [{"filename": f"file-{index:03d}"} for index in range(100)]
        second = [{"filename": "file-100"}]
        client = PagedClient(
            {
                f"{base}?per_page=100&page=1": first,
                f"{base}?per_page=100&page=2": second,
            }
        )
        result = client.get_paginated(base)
        self.assertEqual(len(result), 101)
        self.assertEqual(
            client.requests,
            [
                f"{base}?per_page=100&page=1",
                f"{base}?per_page=100&page=2",
            ],
        )

    def test_duplicate_file_from_paginated_results_fails(self):
        result = MODULE.validate_pull_request(
            kind="wrapper",
            repository="example/project",
            number=7,
            expected_branch="agent/den-1473-example",
            required_files=MODULE.WRAPPER_REQUIRED_FILES,
            pull=pull("example/project", 7, "agent/den-1473-example"),
            files=changed_files(MODULE.WRAPPER_REQUIRED_FILES)
            + [{"filename": ".zpkg.lock"}],
        )
        self.assertFalse(result["passed"])
        self.assertTrue(
            any("duplicate changed files" in error for error in result["errors"])
        )

    def test_e2e_file_contracts_are_distinct_and_exact(self):
        self.assertNotEqual(
            MODULE.E2E_REQUIRED_FILES["A"],
            MODULE.E2E_REQUIRED_FILES["B"],
        )
        self.assertIn("opto-sync-adoption.json", MODULE.E2E_REQUIRED_FILES["A"])
        self.assertIn(
            "tests/opto-sync-wrapper/profile.json",
            MODULE.E2E_REQUIRED_FILES["B"],
        )
        for repository, files in MODULE.PROVISIONED_E2E_REQUIRED_FILES.items():
            self.assertIn(repository, PROVISIONED)
            self.assertEqual(len(files), 4)
            self.assertNotIn(".github/workflows/opto-sync-wrapper-e2e.yml", files)

    def test_plan_reports_17_existing_and_two_deterministic_baselines(self):
        self.assertEqual(
            sum(wrapper["e2e"]["status"] == "existing" for wrapper in MANIFEST["wrappers"]),
            17,
        )
        self.assertEqual(
            sum(
                wrapper["e2e"].get("provisionedByIssue") == "DEN-1469"
                for wrapper in MANIFEST["wrappers"]
            ),
            2,
        )

    def test_missing_token_report_contains_no_secret_fields(self):
        report = MODULE.missing_token_report()
        self.assertEqual(report["summary"]["failed"], 1)
        serialized = json.dumps(report).lower()
        self.assertIn("sync_fleet_token is required", serialized)
        self.assertNotIn("authorization", serialized)
        self.assertNotIn("bearer", serialized)


if __name__ == "__main__":
    unittest.main()
