from __future__ import annotations

import copy
import importlib.util
import io
import json
import sys
import unittest
import zipfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/audit-syncer-publication-outcome.py"
EXPECTATION_PATH = ROOT / "operations/syncer-publication-expectation.v1.json"
SPEC = importlib.util.spec_from_file_location("syncer_publication_outcome", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)
RAW_EXPECTATION = json.loads(EXPECTATION_PATH.read_text(encoding="utf-8"))
EXPECTATION = MODULE.validate_expectation(copy.deepcopy(RAW_EXPECTATION))


def lock_text(package: dict[str, Any], *, source: str | None = None) -> str:
    return "\n".join(
        [
            "version = 1",
            "",
            "[[package]]",
            f'org = "{package["org"]}"',
            f'name = "{package["name"]}"',
            f'version = "{package["version"]}"',
            f'sha256 = "{package["sha256"]}"',
            f'size = {package["size"]}',
            f'format = "{package["format"]}"',
            f'vcs_tag = "{package["vcsTag"]}"',
            f'vcs_commit = "{package["vcsCommit"]}"',
            f'source = "{source or EXPECTATION["registrySource"]}"',
            "",
        ]
    )


def lock_archive(
    expectation: dict[str, Any] = EXPECTATION,
    *,
    overrides: dict[str, str] | None = None,
    extra: dict[str, str] | None = None,
) -> bytes:
    output = io.BytesIO()
    overrides = overrides or {}
    extra = extra or {}
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for package in expectation["packages"]:
            filename = package["lockFile"]
            archive.writestr(filename, overrides.get(filename, lock_text(package)))
        for filename, content in extra.items():
            archive.writestr(filename, content)
    return output.getvalue()


def trusted_run(expectation: dict[str, Any] = EXPECTATION) -> dict[str, Any]:
    return {
        "id": 987654,
        "name": expectation["trustedWorkflow"]["name"],
        "path": expectation["trustedWorkflow"]["path"],
        "event": expectation["trustedWorkflow"]["event"],
        "status": "completed",
        "conclusion": "success",
        "actor": {"login": expectation["trustedWorkflow"]["actor"]},
        "head_repository": {"full_name": expectation["repository"]},
        "head_sha": expectation["activationMergeSha"],
        "pull_requests": [{"number": expectation["activationPullRequest"]}],
        "run_attempt": 1,
        "created_at": "2026-08-03T12:00:00Z",
        "html_url": "https://example.invalid/actions/runs/987654",
    }


def publication_artifact(expectation: dict[str, Any] = EXPECTATION) -> dict[str, Any]:
    return {
        "id": 123456,
        "name": expectation["expectedArtifact"]["name"],
        "expired": False,
        "size_in_bytes": 4096,
        "digest": "sha256:" + "a" * 64,
        "created_at": "2026-08-03T12:10:00Z",
        "expires_at": "2026-11-01T12:10:00Z",
        "archive_download_url": "https://example.invalid/artifacts/123456/zip",
    }


class FixtureClient:
    def __init__(
        self,
        expectation: dict[str, Any] = EXPECTATION,
        *,
        tag_ref: Any | None = None,
        tag_objects: dict[str, Any] | None = None,
        runs: list[Any] | None = None,
        artifacts: list[Any] | None = None,
        archive: bytes | None = None,
    ):
        repository_resource = MODULE.repo_resource(expectation["repository"])
        quoted_tag = __import__("urllib.parse").parse.quote(expectation["tag"], safe="")
        self.tag_resource = f"{repository_resource}/git/ref/tags/{quoted_tag}"
        self.tag_ref = tag_ref or {
            "ref": f"refs/tags/{expectation['tag']}",
            "object": {"type": "commit", "sha": expectation["targetSha"]},
        }
        self.tag_objects = tag_objects or {}
        self.runs = runs if runs is not None else [trusted_run(expectation)]
        self.artifacts = (
            artifacts if artifacts is not None else [publication_artifact(expectation)]
        )
        self.archive = archive if archive is not None else lock_archive(expectation)
        self.requests: list[tuple[str, str]] = []

    def get_json(self, resource: str) -> Any:
        self.requests.append(("json", resource))
        if resource == self.tag_resource:
            if isinstance(self.tag_ref, Exception):
                raise self.tag_ref
            return copy.deepcopy(self.tag_ref)
        if "/git/tags/" in resource:
            sha = resource.rsplit("/", 1)[-1]
            value = self.tag_objects[sha]
            if isinstance(value, Exception):
                raise value
            return copy.deepcopy(value)
        if "/actions/runs/" in resource and resource.endswith("/artifacts?per_page=100"):
            return {
                "total_count": len(self.artifacts),
                "artifacts": copy.deepcopy(self.artifacts),
            }
        raise AssertionError(f"unexpected JSON resource: {resource}")

    def get_paginated(self, resource: str) -> list[Any]:
        self.requests.append(("paginated", resource))
        self.assert_safe_resource(resource)
        return copy.deepcopy(self.runs)

    def get_bytes(self, resource: str) -> bytes:
        self.requests.append(("bytes", resource))
        if not resource.endswith("/zip"):
            raise AssertionError(f"unexpected bytes resource: {resource}")
        return self.archive

    @staticmethod
    def assert_safe_resource(resource: str) -> None:
        assert resource.startswith("/")
        assert "authorization" not in resource.lower()
        assert "bearer" not in resource.lower()
        assert "token" not in resource.lower()


class SyncerPublicationOutcomeTests(unittest.TestCase):
    def test_expectation_is_valid_and_deterministic(self):
        first = MODULE.validate_expectation(copy.deepcopy(RAW_EXPECTATION))
        second = MODULE.validate_expectation(copy.deepcopy(RAW_EXPECTATION))
        self.assertEqual(first, second)
        self.assertEqual(first["ownerIssue"], "DEN-1584")
        self.assertEqual(
            [package["name"] for package in first["packages"]],
            ["syncer", "syncer-c", "syncer-wasm"],
        )
        self.assertEqual(
            set(first["expectedArtifact"]["lockFiles"]),
            {"syncer.zpkg.lock", "syncer-c.zpkg.lock", "syncer-wasm.zpkg.lock"},
        )

    def test_complete_tag_run_artifact_and_locks_verify_publication(self):
        client = FixtureClient()
        report = MODULE.audit_publication(EXPECTATION, client)
        self.assertTrue(report["publicationVerified"])
        self.assertEqual(report["state"], "published_verified")
        self.assertEqual(
            report["summary"],
            {"checks": 4, "passed": 4, "failed": 0, "locks": 3},
        )
        self.assertEqual([check["name"] for check in report["checks"]], [
            "immutable_tag",
            "trusted_workflow_run",
            "bounded_lock_artifact",
            "three_frozen_locks",
        ])
        serialized = json.dumps(report).lower()
        self.assertNotIn("authorization", serialized)
        self.assertNotIn("bearer", serialized)

    def test_annotated_tag_is_dereferenced_to_the_approved_commit(self):
        tag_object_sha = "b" * 40
        client = FixtureClient(
            tag_ref={
                "ref": "refs/tags/v0.2.1",
                "object": {"type": "tag", "sha": tag_object_sha},
            },
            tag_objects={
                tag_object_sha: {
                    "object": {"type": "commit", "sha": EXPECTATION["targetSha"]}
                }
            },
        )
        result = MODULE.resolve_tag(client, EXPECTATION)
        self.assertEqual(result["resolvedCommit"], EXPECTATION["targetSha"])
        self.assertEqual(
            result["chain"],
            [
                {"type": "tag", "sha": tag_object_sha},
                {"type": "commit", "sha": EXPECTATION["targetSha"]},
            ],
        )

    def test_missing_or_conflicting_tag_fails_closed(self):
        missing = FixtureClient(
            tag_ref=MODULE.GitHubApiError(404, "/repos/opto-sync/syncer.c/git/ref/tags/v0.2.1")
        )
        report = MODULE.audit_publication(EXPECTATION, missing)
        self.assertFalse(report["publicationVerified"])
        self.assertEqual(report["state"], "not_verified")
        tag_check = report["checks"][0]
        self.assertFalse(tag_check["passed"])
        self.assertEqual(tag_check["detail"]["error"].split(" for ")[0], "GitHub API returned HTTP 404")

        conflicting = FixtureClient(
            tag_ref={
                "ref": "refs/tags/v0.2.1",
                "object": {"type": "commit", "sha": "c" * 40},
            }
        )
        report = MODULE.audit_publication(EXPECTATION, conflicting)
        self.assertFalse(report["publicationVerified"])
        self.assertTrue(any("tag resolves to" in error for error in report["errors"]))

    def test_run_must_match_workflow_path_event_actor_repository_and_activation(self):
        base = trusted_run()
        mutations = {
            "name": lambda run: run.update(name="Other workflow"),
            "path": lambda run: run.update(path=".github/workflows/untrusted.yml"),
            "event": lambda run: run.update(event="workflow_dispatch"),
            "conclusion": lambda run: run.update(conclusion="failure"),
            "actor": lambda run: run["actor"].update(login="attacker"),
            "repository": lambda run: run["head_repository"].update(full_name="fork/syncer.c"),
            "activation": lambda run: run.update(head_sha="d" * 40, pull_requests=[]),
        }
        for label, mutate in mutations.items():
            with self.subTest(label=label):
                run = copy.deepcopy(base)
                mutate(run)
                with self.assertRaisesRegex(MODULE.AuditError, "no successful trusted"):
                    MODULE.select_trusted_run([run], EXPECTATION)

    def test_run_association_accepts_pr_number_or_exact_merge_sha(self):
        by_pr = trusted_run()
        by_pr["head_sha"] = "e" * 40
        self.assertEqual(MODULE.select_trusted_run([by_pr], EXPECTATION)["id"], 987654)

        by_sha = trusted_run()
        by_sha["pull_requests"] = []
        self.assertEqual(MODULE.select_trusted_run([by_sha], EXPECTATION)["id"], 987654)

    def test_latest_successful_associated_run_is_selected(self):
        old = trusted_run()
        old.update(id=1, created_at="2026-08-03T10:00:00Z", run_attempt=1)
        new = trusted_run()
        new.update(id=2, created_at="2026-08-03T11:00:00Z", run_attempt=2)
        selected = MODULE.select_trusted_run([old, new], EXPECTATION)
        self.assertEqual(selected["id"], 2)
        self.assertEqual(selected["runAttempt"], 2)

    def test_artifact_must_be_unique_nonexpired_nonempty_and_digested(self):
        cases = []
        expired = publication_artifact()
        expired["expired"] = True
        cases.append(("expired", [expired]))
        empty = publication_artifact()
        empty["size_in_bytes"] = 0
        cases.append(("size", [empty]))
        no_digest = publication_artifact()
        no_digest["digest"] = None
        cases.append(("digest", [no_digest]))
        wrong_digest = publication_artifact()
        wrong_digest["digest"] = "sha256:bad"
        cases.append(("digest", [wrong_digest]))
        duplicate = publication_artifact()
        cases.append(("exactly one", [duplicate, copy.deepcopy(duplicate)]))
        cases.append(("exactly one", []))
        for expected_error, artifacts in cases:
            with self.subTest(expected_error=expected_error):
                with self.assertRaisesRegex(MODULE.AuditError, expected_error):
                    MODULE.select_artifact(artifacts, EXPECTATION)

    def test_lock_archive_rejects_missing_extra_duplicate_and_unsafe_files(self):
        missing_data = io.BytesIO()
        with zipfile.ZipFile(missing_data, "w") as archive:
            for package in EXPECTATION["packages"][:2]:
                archive.writestr(package["lockFile"], lock_text(package))
        with self.assertRaisesRegex(MODULE.AuditError, "lock files differ"):
            MODULE.validate_lock_archive(missing_data.getvalue(), EXPECTATION)

        with self.assertRaisesRegex(MODULE.AuditError, "lock files differ"):
            MODULE.validate_lock_archive(
                lock_archive(extra={"unexpected.txt": "no"}),
                EXPECTATION,
            )

        duplicate_data = io.BytesIO()
        with zipfile.ZipFile(duplicate_data, "w") as archive:
            for package in EXPECTATION["packages"]:
                archive.writestr(package["lockFile"], lock_text(package))
            archive.writestr("nested/syncer.zpkg.lock", lock_text(EXPECTATION["packages"][0]))
        with self.assertRaisesRegex(MODULE.AuditError, "duplicate artifact basename"):
            MODULE.validate_lock_archive(duplicate_data.getvalue(), EXPECTATION)

        unsafe_data = io.BytesIO()
        with zipfile.ZipFile(unsafe_data, "w") as archive:
            archive.writestr("../syncer.zpkg.lock", "version = 1\n")
        with self.assertRaisesRegex(MODULE.AuditError, "unsafe artifact entry"):
            MODULE.validate_lock_archive(unsafe_data.getvalue(), EXPECTATION)

    def test_each_lock_field_and_registry_source_are_exact(self):
        package = EXPECTATION["packages"][0]
        base = lock_text(package)
        replacements = {
            "org": base.replace('org = "opto-sync"', 'org = "other"', 1),
            "name": base.replace('name = "syncer"', 'name = "other"', 1),
            "version": base.replace('version = "0.2.1"', 'version = "9.9.9"', 1),
            "sha256": base.replace(package["sha256"], "1" * 64, 1),
            "zero hash": base.replace(package["sha256"], "0" * 64, 1),
            "size": base.replace(f'size = {package["size"]}', 'size = 1', 1),
            "format": base.replace('format = "tar.gz"', 'format = "zip"', 1),
            "tag": base.replace('vcs_tag = "v0.2.1"', 'vcs_tag = "v9.9.9"', 1),
            "commit": base.replace(package["vcsCommit"], "f" * 40, 1),
            "source": base.replace(EXPECTATION["registrySource"], "https://other.invalid", 1),
        }
        for label, invalid_lock in replacements.items():
            with self.subTest(label=label):
                with self.assertRaises(MODULE.AuditError):
                    MODULE.validate_lock_archive(
                        lock_archive(overrides={package["lockFile"]: invalid_lock}),
                        EXPECTATION,
                    )

    def test_archive_must_be_zip_and_lock_must_be_valid_toml(self):
        with self.assertRaisesRegex(MODULE.AuditError, "not a ZIP"):
            MODULE.validate_lock_archive(b"not-a-zip", EXPECTATION)
        package = EXPECTATION["packages"][1]
        with self.assertRaisesRegex(MODULE.AuditError, "invalid UTF-8/TOML"):
            MODULE.validate_lock_archive(
                lock_archive(overrides={package["lockFile"]: "[[package]\n"}),
                EXPECTATION,
            )

    def test_expectation_rejects_insecure_or_ambiguous_contracts(self):
        cases = []
        wrong_rules = copy.deepcopy(RAW_EXPECTATION)
        wrong_rules["releaseStateRules"]["allLocksMustMatch"] = False
        cases.append(wrong_rules)
        insecure_registry = copy.deepcopy(RAW_EXPECTATION)
        insecure_registry["registrySource"] = "http://registry.invalid"
        cases.append(insecure_registry)
        zero_hash = copy.deepcopy(RAW_EXPECTATION)
        zero_hash["packages"][0]["sha256"] = "0" * 64
        cases.append(zero_hash)
        wrong_order = copy.deepcopy(RAW_EXPECTATION)
        wrong_order["packages"][0], wrong_order["packages"][1] = (
            wrong_order["packages"][1],
            wrong_order["packages"][0],
        )
        cases.append(wrong_order)
        duplicate_lock = copy.deepcopy(RAW_EXPECTATION)
        duplicate_lock["packages"][1]["lockFile"] = duplicate_lock["packages"][0]["lockFile"]
        cases.append(duplicate_lock)
        bad_workflow = copy.deepcopy(RAW_EXPECTATION)
        bad_workflow["trustedWorkflow"]["event"] = "workflow_dispatch"
        cases.append(bad_workflow)
        for value in cases:
            with self.subTest(value=value):
                with self.assertRaises(MODULE.AuditError):
                    MODULE.validate_expectation(value)

    def test_missing_token_report_is_bounded_and_contains_no_auth_data(self):
        report = MODULE.missing_token_report(EXPECTATION)
        self.assertFalse(report["publicationVerified"])
        self.assertEqual(report["state"], "not_verified")
        serialized = json.dumps(report).lower()
        self.assertIn("sync_fleet_token is required", serialized)
        self.assertNotIn("authorization", serialized)
        self.assertNotIn("bearer", serialized)
        self.assertNotIn("response body", serialized)

    def test_github_api_error_never_contains_response_content(self):
        error = MODULE.GitHubApiError(403, "/repos/opto-sync/syncer.c/git/ref/tags/v0.2.1")
        text = str(error)
        self.assertEqual(
            text,
            "GitHub API returned HTTP 403 for /repos/opto-sync/syncer.c/git/ref/tags/v0.2.1",
        )
        self.assertNotIn("token", text.lower())
        self.assertNotIn("authorization", text.lower())


if __name__ == "__main__":
    unittest.main()
