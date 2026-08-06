#!/usr/bin/env python3
"""Read-only audit of the approved syncer publication outcome.

The activation merge is not publication evidence. This audit accepts the
release only when the immutable tag, trusted protected workflow run, bounded
non-expired lock artifact, and all three generated `.zpkg.lock` files agree
with operations/syncer-publication-expectation.v1.json.

Authentication is read only from SYNC_FLEET_TOKEN. The token is never accepted
as a command-line argument, written to a report, or included in an exception.
The client performs GET requests only and discards HTTP response bodies on
failure.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import sys
import tomllib
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Protocol

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_EXPECTATION = ROOT / "operations/syncer-publication-expectation.v1.json"
API_DEFAULT = "https://api.github.com"
DEFAULT_MAX_ARTIFACT_BYTES = 16 * 1024 * 1024
SHA = re.compile(r"^[0-9a-f]{40}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
ARTIFACT_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
REPOSITORY = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
ISSUE = re.compile(r"^DEN-[1-9][0-9]*$")
EXPECTED_PACKAGE_NAMES = ["syncer", "syncer-c", "syncer-wasm"]
EXPECTED_RULES = {
    "activationMergeIsNotPublication": True,
    "tagMustResolveTargetSha": True,
    "trustedRunMustSucceed": True,
    "artifactMustExistAndNotBeExpired": True,
    "artifactDigestMustBePresent": True,
    "allLocksMustMatch": True,
    "conflictingIdentityFailsClosed": True,
}


class AuditError(ValueError):
    pass


class GitHubApiError(RuntimeError):
    def __init__(self, status: int, resource: str):
        super().__init__(f"GitHub API returned HTTP {status} for {resource}")
        self.status = status
        self.resource = resource


class Client(Protocol):
    def get_json(self, resource: str) -> Any: ...

    def get_paginated(self, resource: str) -> list[Any]: ...

    def get_bytes(self, resource: str) -> bytes: ...


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Expose GitHub's artifact redirect without forwarding credentials."""

    def redirect_request(self, request, file_pointer, code, message, headers, url):
        return None


def fail(message: str) -> "NoReturn":
    raise AuditError(message)


def load_object(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"cannot load {label}: {exc}")
    if not isinstance(value, dict):
        fail(f"{label} must contain a JSON object")
    return value


def require_text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        fail(f"{label} must be a non-empty string")
    return value.strip()


def require_positive_int(value: Any, label: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        fail(f"{label} must be a positive integer")
    return value


def require_sha(value: Any, label: str) -> str:
    text = require_text(value, label)
    if not SHA.fullmatch(text):
        fail(f"{label} must be a lowercase 40-character SHA")
    return text


def require_sha256(value: Any, label: str) -> str:
    text = require_text(value, label)
    if not SHA256.fullmatch(text) or text == "0" * 64:
        fail(f"{label} must be a nonzero lowercase SHA-256")
    return text


def normalize_registry_source(value: str) -> str:
    return value.rstrip("/")


def artifact_redirect_request(location: str) -> urllib.request.Request:
    """Build a credential-free request for an HTTPS artifact storage URL."""
    parsed = urllib.parse.urlparse(location)
    if (
        parsed.scheme != "https"
        or not parsed.netloc
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
    ):
        fail("artifact redirect must be an absolute HTTPS URL without userinfo")
    return urllib.request.Request(
        location,
        headers={
            "Accept": "application/octet-stream",
            "User-Agent": "opto-sync-publication-outcome-audit/1",
        },
    )


def bounded_read(response: Any, *, max_bytes: int) -> bytes:
    """Read a nonempty response while enforcing both declared and actual size."""
    if max_bytes <= 0:
        fail("artifact download limit must be positive")
    content_length = response.headers.get("Content-Length")
    if content_length is not None:
        try:
            declared_size = int(content_length)
        except (TypeError, ValueError):
            fail("artifact Content-Length is invalid")
        if declared_size <= 0 or declared_size > max_bytes:
            fail("artifact Content-Length is outside the allowed bounds")
    data = response.read(max_bytes + 1)
    if not data:
        fail("artifact download is empty")
    if len(data) > max_bytes:
        fail("artifact download exceeds the allowed size")
    return data


def validate_expectation(value: dict[str, Any]) -> dict[str, Any]:
    if value.get("schemaVersion") != 1:
        fail("schemaVersion must be 1")
    owner_issue = require_text(value.get("ownerIssue"), "ownerIssue")
    if not ISSUE.fullmatch(owner_issue) or owner_issue != "DEN-1584":
        fail("ownerIssue must be DEN-1584")
    repository = require_text(value.get("repository"), "repository")
    if not REPOSITORY.fullmatch(repository):
        fail("repository must use owner/name")
    activation_pr = require_positive_int(
        value.get("activationPullRequest"), "activationPullRequest"
    )
    activation_merge = require_sha(
        value.get("activationMergeSha"), "activationMergeSha"
    )
    activation_file = require_text(value.get("activationFile"), "activationFile")
    if PurePosixPath(activation_file).is_absolute() or ".." in PurePosixPath(
        activation_file
    ).parts:
        fail("activationFile must be repository-relative")
    tag = require_text(value.get("tag"), "tag")
    version = require_text(value.get("version"), "version")
    if tag != f"v{version}":
        fail("tag must equal v{version}")
    target_sha = require_sha(value.get("targetSha"), "targetSha")
    target_tree = require_sha(value.get("targetTreeSha"), "targetTreeSha")
    if activation_merge == target_sha:
        fail("activation merge and approved source must be distinct")

    workflow = value.get("trustedWorkflow")
    if not isinstance(workflow, dict):
        fail("trustedWorkflow must be an object")
    workflow_name = require_text(workflow.get("name"), "trustedWorkflow.name")
    workflow_path = require_text(workflow.get("path"), "trustedWorkflow.path")
    if not workflow_path.startswith(".github/workflows/") or not workflow_path.endswith(
        (".yml", ".yaml")
    ):
        fail("trustedWorkflow.path must be a workflow file")
    workflow_event = require_text(workflow.get("event"), "trustedWorkflow.event")
    if workflow_event != "pull_request_target":
        fail("trustedWorkflow.event must be pull_request_target")
    workflow_actor = require_text(workflow.get("actor"), "trustedWorkflow.actor")

    artifact = value.get("expectedArtifact")
    if not isinstance(artifact, dict):
        fail("expectedArtifact must be an object")
    artifact_name = require_text(artifact.get("name"), "expectedArtifact.name")
    lock_files = artifact.get("lockFiles")
    if not isinstance(lock_files, list) or len(lock_files) != 3:
        fail("expectedArtifact.lockFiles must contain exactly three files")
    if not all(isinstance(item, str) and item for item in lock_files):
        fail("expectedArtifact.lockFiles must contain strings")
    if len(lock_files) != len(set(lock_files)):
        fail("expectedArtifact.lockFiles contains duplicates")
    for lock_file in lock_files:
        pure = PurePosixPath(lock_file)
        if pure.is_absolute() or ".." in pure.parts or pure.name != lock_file:
            fail(f"unsafe expected lock filename: {lock_file}")
        if not lock_file.endswith(".zpkg.lock"):
            fail(f"expected lock file must end in .zpkg.lock: {lock_file}")

    registry = require_text(value.get("registrySource"), "registrySource")
    parsed_registry = urllib.parse.urlparse(registry)
    if parsed_registry.scheme != "https" or not parsed_registry.netloc:
        fail("registrySource must be an HTTPS URL")

    packages = value.get("packages")
    if not isinstance(packages, list) or len(packages) != 3:
        fail("packages must contain exactly three entries")
    actual_names: list[str] = []
    package_by_lock: dict[str, dict[str, Any]] = {}
    for index, package in enumerate(packages):
        label = f"packages[{index}]"
        if not isinstance(package, dict):
            fail(f"{label} must be an object")
        org = require_text(package.get("org"), f"{label}.org")
        name = require_text(package.get("name"), f"{label}.name")
        actual_names.append(name)
        package_version = require_text(package.get("version"), f"{label}.version")
        if package_version != version:
            fail(f"{label}.version differs from release version")
        require_sha256(package.get("sha256"), f"{label}.sha256")
        require_positive_int(package.get("size"), f"{label}.size")
        artifact_format = require_text(package.get("format"), f"{label}.format")
        if artifact_format not in {"tar.gz", "zip"}:
            fail(f"{label}.format is unsupported")
        if package.get("vcsTag") != tag:
            fail(f"{label}.vcsTag differs from release tag")
        if package.get("vcsCommit") != target_sha:
            fail(f"{label}.vcsCommit differs from targetSha")
        lock_file = require_text(package.get("lockFile"), f"{label}.lockFile")
        if lock_file not in lock_files:
            fail(f"{label}.lockFile is not in expectedArtifact.lockFiles")
        if lock_file in package_by_lock:
            fail(f"duplicate package lockFile: {lock_file}")
        package_by_lock[lock_file] = package
        if org != "opto-sync":
            fail(f"{label}.org must be opto-sync")
    if actual_names != EXPECTED_PACKAGE_NAMES:
        fail("package identity/order must be syncer, syncer-c, syncer-wasm")
    if set(package_by_lock) != set(lock_files):
        fail("package lockFile mapping is incomplete")

    rules = value.get("releaseStateRules")
    if rules != EXPECTED_RULES:
        fail("releaseStateRules differ from the fail-closed contract")

    return {
        "schemaVersion": 1,
        "ownerIssue": owner_issue,
        "repository": repository,
        "activationPullRequest": activation_pr,
        "activationMergeSha": activation_merge,
        "activationFile": activation_file,
        "tag": tag,
        "version": version,
        "targetSha": target_sha,
        "targetTreeSha": target_tree,
        "trustedWorkflow": {
            "name": workflow_name,
            "path": workflow_path,
            "event": workflow_event,
            "actor": workflow_actor,
        },
        "expectedArtifact": {
            "name": artifact_name,
            "lockFiles": list(lock_files),
        },
        "registrySource": normalize_registry_source(registry),
        "packages": packages,
        "releaseStateRules": rules,
    }


class GitHubClient:
    def __init__(
        self,
        token: str,
        *,
        api_url: str = API_DEFAULT,
        timeout_seconds: int = 20,
        max_pages: int = 10,
        max_artifact_bytes: int = DEFAULT_MAX_ARTIFACT_BYTES,
    ):
        if not token:
            raise AuditError("SYNC_FLEET_TOKEN is required for the live audit")
        self._token = token
        self._api_url = api_url.rstrip("/")
        self._timeout_seconds = timeout_seconds
        self._max_pages = max_pages
        self._max_artifact_bytes = max_artifact_bytes

    def _api_request(self, resource: str) -> urllib.request.Request:
        if not resource.startswith("/"):
            raise AuditError(f"unsafe GitHub resource path: {resource}")
        return urllib.request.Request(
            self._api_url + resource,
            headers={
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {self._token}",
                "User-Agent": "opto-sync-publication-outcome-audit/1",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )

    def _request(self, resource: str) -> urllib.response.addinfourl:
        request = self._api_request(resource)
        try:
            return urllib.request.urlopen(request, timeout=self._timeout_seconds)
        except urllib.error.HTTPError as exc:
            # Response bodies may contain private metadata and are not required
            # for a bounded audit error.
            raise GitHubApiError(exc.code, resource) from None
        except urllib.error.URLError as exc:
            reason = type(exc.reason).__name__
            raise RuntimeError(
                f"GitHub API transport failed for {resource}: {reason}"
            ) from None

    def get_json(self, resource: str) -> Any:
        with self._request(resource) as response:
            return json.load(response)

    def get_bytes(self, resource: str) -> bytes:
        request = self._api_request(resource)
        opener = urllib.request.build_opener(NoRedirectHandler())
        try:
            opener.open(request, timeout=self._timeout_seconds)
        except urllib.error.HTTPError as exc:
            if exc.code not in {301, 302, 303, 307, 308}:
                raise GitHubApiError(exc.code, resource) from None
            location = exc.headers.get("Location")
        except urllib.error.URLError as exc:
            reason = type(exc.reason).__name__
            raise RuntimeError(
                f"GitHub API transport failed for {resource}: {reason}"
            ) from None
        else:
            raise AuditError("artifact API did not return a storage redirect")

        signed_request = artifact_redirect_request(location or "")
        try:
            with urllib.request.urlopen(
                signed_request, timeout=self._timeout_seconds
            ) as response:
                return bounded_read(response, max_bytes=self._max_artifact_bytes)
        except urllib.error.HTTPError as exc:
            raise RuntimeError(
                f"artifact storage returned HTTP {exc.code} for the signed download"
            ) from None
        except urllib.error.URLError as exc:
            reason = type(exc.reason).__name__
            raise RuntimeError(
                f"artifact storage transport failed for the signed download: {reason}"
            ) from None

    def get_paginated(self, resource: str) -> list[Any]:
        separator = "&" if "?" in resource else "?"
        result: list[Any] = []
        for page in range(1, self._max_pages + 1):
            value = self.get_json(f"{resource}{separator}per_page=100&page={page}")
            if not isinstance(value, list):
                raise AuditError(
                    f"paginated GitHub resource did not return an array: {resource}"
                )
            result.extend(value)
            if len(value) < 100:
                return result
        raise AuditError(
            f"paginated GitHub resource exceeded {self._max_pages} pages: {resource}"
        )


def repo_resource(repository: str) -> str:
    owner, name = repository.split("/", 1)
    return "/repos/{}/{}".format(
        urllib.parse.quote(owner, safe=""),
        urllib.parse.quote(name, safe=""),
    )


def resolve_tag(client: Client, expectation: dict[str, Any]) -> dict[str, Any]:
    repository = expectation["repository"]
    tag = urllib.parse.quote(expectation["tag"], safe="")
    resource = f"{repo_resource(repository)}/git/ref/tags/{tag}"
    ref = client.get_json(resource)
    if not isinstance(ref, dict):
        fail("tag reference response is not an object")
    obj = ref.get("object")
    if not isinstance(obj, dict):
        fail("tag reference lacks object")
    object_type = obj.get("type")
    object_sha = obj.get("sha")
    require_sha(object_sha, "tag object SHA")
    chain: list[dict[str, str]] = []
    for _ in range(5):
        chain.append({"type": str(object_type), "sha": str(object_sha)})
        if object_type == "commit":
            if object_sha != expectation["targetSha"]:
                fail(
                    f"tag resolves to {object_sha}, expected {expectation['targetSha']}"
                )
            return {
                "ref": ref.get("ref"),
                "resolvedCommit": object_sha,
                "chain": chain,
            }
        if object_type != "tag":
            fail(f"unsupported tag object type: {object_type!r}")
        tag_object = client.get_json(
            f"{repo_resource(repository)}/git/tags/{urllib.parse.quote(str(object_sha), safe='')}"
        )
        if not isinstance(tag_object, dict) or not isinstance(
            tag_object.get("object"), dict
        ):
            fail("annotated tag response lacks object")
        object_type = tag_object["object"].get("type")
        object_sha = tag_object["object"].get("sha")
        require_sha(object_sha, "annotated tag object SHA")
    fail("tag dereference exceeded five objects")


def run_associated_with_activation(run: dict[str, Any], expectation: dict[str, Any]) -> bool:
    pulls = run.get("pull_requests")
    if isinstance(pulls, list) and any(
        isinstance(item, dict)
        and item.get("number") == expectation["activationPullRequest"]
        for item in pulls
    ):
        return True
    return run.get("head_sha") == expectation["activationMergeSha"]


def select_trusted_run(
    runs: list[Any], expectation: dict[str, Any]
) -> dict[str, Any]:
    workflow = expectation["trustedWorkflow"]
    candidates: list[dict[str, Any]] = []
    for run in runs:
        if not isinstance(run, dict):
            continue
        if run.get("name") != workflow["name"]:
            continue
        if run.get("path") != workflow["path"]:
            continue
        if run.get("event") != workflow["event"]:
            continue
        if run.get("status") != "completed" or run.get("conclusion") != "success":
            continue
        actor = run.get("actor")
        if not isinstance(actor, dict) or actor.get("login") != workflow["actor"]:
            continue
        head_repository = run.get("head_repository")
        if (
            not isinstance(head_repository, dict)
            or head_repository.get("full_name") != expectation["repository"]
        ):
            continue
        if not run_associated_with_activation(run, expectation):
            continue
        require_positive_int(run.get("id"), "trusted run id")
        candidates.append(run)
    if not candidates:
        fail("no successful trusted workflow run is associated with the activation")
    candidates.sort(
        key=lambda run: (
            str(run.get("created_at") or ""),
            int(run.get("run_attempt") or 0),
            int(run.get("id") or 0),
        ),
        reverse=True,
    )
    selected = candidates[0]
    return {
        "id": selected["id"],
        "name": selected.get("name"),
        "path": selected.get("path"),
        "event": selected.get("event"),
        "status": selected.get("status"),
        "conclusion": selected.get("conclusion"),
        "actor": selected.get("actor", {}).get("login"),
        "headSha": selected.get("head_sha"),
        "runAttempt": selected.get("run_attempt"),
        "createdAt": selected.get("created_at"),
        "htmlUrl": selected.get("html_url"),
    }


def select_artifact(
    artifacts: list[Any], expectation: dict[str, Any]
) -> dict[str, Any]:
    expected_name = expectation["expectedArtifact"]["name"]
    matches = [
        artifact
        for artifact in artifacts
        if isinstance(artifact, dict) and artifact.get("name") == expected_name
    ]
    if len(matches) != 1:
        fail(f"expected exactly one artifact named {expected_name}, found {len(matches)}")
    artifact = matches[0]
    artifact_id = require_positive_int(artifact.get("id"), "artifact id")
    if artifact.get("expired") is not False:
        fail("publication lock artifact is expired or lacks explicit expired=false")
    size = require_positive_int(artifact.get("size_in_bytes"), "artifact size")
    digest = require_text(artifact.get("digest"), "artifact digest")
    if not ARTIFACT_DIGEST.fullmatch(digest):
        fail("artifact digest must use sha256:<64 lowercase hex>")
    return {
        "id": artifact_id,
        "name": expected_name,
        "expired": False,
        "sizeInBytes": size,
        "digest": digest,
        "createdAt": artifact.get("created_at"),
        "expiresAt": artifact.get("expires_at"),
        "archiveDownloadUrl": artifact.get("archive_download_url"),
    }


def validate_locked_package(
    lock_file: str,
    lock: dict[str, Any],
    expected: dict[str, Any],
    registry_source: str,
) -> dict[str, Any]:
    if lock.get("version") != 1:
        fail(f"{lock_file}: lock version must be 1")
    packages = lock.get("package", [])
    if not isinstance(packages, list) or len(packages) != 1:
        fail(f"{lock_file}: lock must contain exactly one package")
    package = packages[0]
    if not isinstance(package, dict):
        fail(f"{lock_file}: package entry must be an object")
    comparisons = {
        "org": expected["org"],
        "name": expected["name"],
        "version": expected["version"],
        "sha256": expected["sha256"],
        "size": expected["size"],
        "format": expected["format"],
        "vcs_tag": expected["vcsTag"],
        "vcs_commit": expected["vcsCommit"],
    }
    for field, expected_value in comparisons.items():
        if package.get(field) != expected_value:
            fail(
                f"{lock_file}: {field} is {package.get(field)!r}, expected {expected_value!r}"
            )
    require_sha256(package.get("sha256"), f"{lock_file}: sha256")
    if not SHA.fullmatch(str(package.get("vcs_commit"))):
        fail(f"{lock_file}: vcs_commit is not a canonical commit SHA")
    source = require_text(package.get("source"), f"{lock_file}: source")
    if normalize_registry_source(source) != registry_source:
        fail(
            f"{lock_file}: source is {source!r}, expected {registry_source!r}"
        )
    return {
        "file": lock_file,
        "package": f"{package['org']}/{package['name']}",
        "version": package["version"],
        "sha256": package["sha256"],
        "size": package["size"],
        "format": package["format"],
        "vcsTag": package["vcs_tag"],
        "vcsCommit": package["vcs_commit"],
        "source": normalize_registry_source(source),
    }


def validate_lock_archive(data: bytes, expectation: dict[str, Any]) -> list[dict[str, Any]]:
    if not data.startswith(b"PK"):
        fail("publication artifact is not a ZIP archive")
    expected_files = expectation["expectedArtifact"]["lockFiles"]
    package_by_lock = {
        package["lockFile"]: package for package in expectation["packages"]
    }
    results: list[dict[str, Any]] = []
    try:
        with zipfile.ZipFile(io.BytesIO(data), "r") as archive:
            raw_names = archive.namelist()
            normalized_names: list[str] = []
            entry_by_name: dict[str, zipfile.ZipInfo] = {}
            for raw_name in raw_names:
                pure = PurePosixPath(raw_name)
                if pure.is_absolute() or ".." in pure.parts:
                    fail(f"unsafe artifact entry: {raw_name}")
                if raw_name.endswith("/"):
                    continue
                name = pure.name
                if name in entry_by_name:
                    fail(f"duplicate artifact basename: {name}")
                normalized_names.append(name)
                entry_by_name[name] = archive.getinfo(raw_name)
            if set(normalized_names) != set(expected_files):
                fail(
                    "artifact lock files differ: "
                    f"actual={sorted(normalized_names)}, expected={sorted(expected_files)}"
                )
            for lock_file in expected_files:
                info = entry_by_name[lock_file]
                if info.file_size <= 0:
                    fail(f"{lock_file}: artifact entry is empty")
                raw = archive.read(info)
                try:
                    lock = tomllib.loads(raw.decode("utf-8"))
                except (UnicodeDecodeError, tomllib.TOMLDecodeError) as exc:
                    fail(f"{lock_file}: invalid UTF-8/TOML: {exc}")
                if not isinstance(lock, dict):
                    fail(f"{lock_file}: TOML root is not an object")
                results.append(
                    validate_locked_package(
                        lock_file,
                        lock,
                        package_by_lock[lock_file],
                        expectation["registrySource"],
                    )
                )
    except zipfile.BadZipFile as exc:
        fail(f"publication artifact ZIP is invalid: {exc}")
    return results


@dataclass
class Check:
    name: str
    passed: bool
    detail: Any

    def as_dict(self) -> dict[str, Any]:
        return {"name": self.name, "passed": self.passed, "detail": self.detail}


def audit_publication(
    expectation: dict[str, Any], client: Client
) -> dict[str, Any]:
    checks: list[Check] = []
    errors: list[str] = []
    tag_result: dict[str, Any] | None = None
    run_result: dict[str, Any] | None = None
    artifact_result: dict[str, Any] | None = None
    lock_results: list[dict[str, Any]] = []

    try:
        tag_result = resolve_tag(client, expectation)
        checks.append(Check("immutable_tag", True, tag_result))
    except (AuditError, GitHubApiError, RuntimeError) as exc:
        errors.append(str(exc))
        checks.append(Check("immutable_tag", False, {"error": str(exc)}))

    try:
        repository = expectation["repository"]
        runs_resource = (
            f"{repo_resource(repository)}/actions/runs"
            f"?event={urllib.parse.quote(expectation['trustedWorkflow']['event'], safe='')}"
            "&status=completed"
        )
        runs = client.get_paginated(runs_resource)
        run_result = select_trusted_run(runs, expectation)
        checks.append(Check("trusted_workflow_run", True, run_result))
    except (AuditError, GitHubApiError, RuntimeError) as exc:
        errors.append(str(exc))
        checks.append(Check("trusted_workflow_run", False, {"error": str(exc)}))

    if run_result is not None:
        try:
            artifacts_value = client.get_json(
                f"{repo_resource(expectation['repository'])}/actions/runs/{run_result['id']}/artifacts?per_page=100"
            )
            if not isinstance(artifacts_value, dict) or not isinstance(
                artifacts_value.get("artifacts"), list
            ):
                fail("workflow artifacts response lacks artifacts array")
            artifact_result = select_artifact(
                artifacts_value["artifacts"], expectation
            )
            checks.append(Check("bounded_lock_artifact", True, artifact_result))
        except (AuditError, GitHubApiError, RuntimeError) as exc:
            errors.append(str(exc))
            checks.append(Check("bounded_lock_artifact", False, {"error": str(exc)}))
    else:
        checks.append(
            Check(
                "bounded_lock_artifact",
                False,
                {"error": "trusted workflow run is unavailable"},
            )
        )

    if artifact_result is not None:
        try:
            data = client.get_bytes(
                f"{repo_resource(expectation['repository'])}/actions/artifacts/{artifact_result['id']}/zip"
            )
            lock_results = validate_lock_archive(data, expectation)
            checks.append(Check("three_frozen_locks", True, lock_results))
        except (AuditError, GitHubApiError, RuntimeError) as exc:
            errors.append(str(exc))
            checks.append(Check("three_frozen_locks", False, {"error": str(exc)}))
    else:
        checks.append(
            Check(
                "three_frozen_locks",
                False,
                {"error": "publication lock artifact is unavailable"},
            )
        )

    verified = all(check.passed for check in checks)
    return {
        "schemaVersion": 1,
        "ownerIssue": expectation["ownerIssue"],
        "repository": expectation["repository"],
        "activation": {
            "pullRequest": expectation["activationPullRequest"],
            "mergeSha": expectation["activationMergeSha"],
            "activationFile": expectation["activationFile"],
        },
        "release": {
            "tag": expectation["tag"],
            "version": expectation["version"],
            "targetSha": expectation["targetSha"],
            "targetTreeSha": expectation["targetTreeSha"],
        },
        "publicationVerified": verified,
        "state": "published_verified" if verified else "not_verified",
        "checks": [check.as_dict() for check in checks],
        "errors": errors,
        "summary": {
            "checks": len(checks),
            "passed": sum(check.passed for check in checks),
            "failed": sum(not check.passed for check in checks),
            "locks": len(lock_results),
        },
    }


def missing_token_report(expectation: dict[str, Any]) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "ownerIssue": expectation["ownerIssue"],
        "repository": expectation["repository"],
        "publicationVerified": False,
        "state": "not_verified",
        "checks": [],
        "errors": ["SYNC_FLEET_TOKEN is required for the live publication audit"],
        "summary": {"checks": 0, "passed": 0, "failed": 1, "locks": 0},
    }


def write_report(path: Path, report: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("validate-expectation", "audit"))
    parser.add_argument("--expectation", type=Path, default=DEFAULT_EXPECTATION)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--api-url", default=API_DEFAULT)
    args = parser.parse_args()
    try:
        expectation = validate_expectation(
            load_object(args.expectation, "publication expectation")
        )
        if args.command == "validate-expectation":
            report = {
                "schemaVersion": 1,
                "ownerIssue": expectation["ownerIssue"],
                "repository": expectation["repository"],
                "readOnly": True,
                "publicationVerified": False,
                "state": "expectation_valid",
                "expected": expectation,
            }
            write_report(args.output, report)
            print(json.dumps({"state": report["state"]}, sort_keys=True))
            return 0

        token = os.environ.get("SYNC_FLEET_TOKEN", "")
        if not token:
            report = missing_token_report(expectation)
            write_report(args.output, report)
            print(report["errors"][0], file=sys.stderr)
            return 2
        report = audit_publication(
            expectation,
            GitHubClient(token, api_url=args.api_url),
        )
        write_report(args.output, report)
        print(json.dumps(report["summary"], sort_keys=True))
        return 0 if report["publicationVerified"] else 1
    except AuditError as exc:
        report = {
            "schemaVersion": 1,
            "ownerIssue": "DEN-1584",
            "publicationVerified": False,
            "state": "contract_invalid",
            "checks": [],
            "errors": [str(exc)],
            "summary": {"checks": 0, "passed": 0, "failed": 1, "locks": 0},
        }
        write_report(args.output, report)
        print(f"syncer-publication-outcome-audit: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
