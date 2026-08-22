#!/usr/bin/env python3
"""Build a truthful Opto-Sync consumer impact graph from Zed declarations.

Zed's v1 package-version endpoint exposes direct, unresolved declaration edges.
It does not expose a reverse-dependents endpoint and it must not be treated as a
resolved lock graph. This tool enumerates the registry's current package index,
fetches each graph under the caller's authorization, validates each declared graph, inverts those direct edges, and computes direct
and transitive consumers of one package coordinate.

The output deliberately separates:

* discovery (which indexed Zed packages expose an authorized graph declaring the dependency), from
* execution metadata (which GitHub repository and E2E repository test it), and
* adoption classification (exact pin, package release, adapted concept, or
  candidate).

No network access is required for snapshot mode, which is the deterministic CI
contract. Live mode uses only the Python standard library and supports a bearer
token supplied through an environment variable.
"""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import math
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict, deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

GRAPH_SCHEMA = "zpkg/dependency-graph/v1"
SNAPSHOT_SCHEMA = "opto-sync/zed-declared-inventory/v1"
OUTPUT_SCHEMA = "opto-sync/consumer-impact/v1"
CLASSIFICATION_VALUES = {"exact-pin", "package-release", "adapted-concept", "candidate"}
DEPENDENCY_KINDS = {"runtime", "build", "development", "peer", "tooling"}
COORDINATE_COMPONENT_RE = re.compile(r"^[A-Za-z0-9_.-]+$")
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
ETAG_RE = re.compile(r'^"[^"\x00-\x1f\x7f]+"$')
VERSION_POLICY_VALUES = {"latest-visible", "all-visible"}
FAILURE_VALUES = {"graph-only", "curated-only", "unclassified", "missing-graphs"}
DEFAULT_TIMEOUT_SECONDS = 30.0
MAX_TIMEOUT_SECONDS = 300.0
DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024
DEFAULT_MAX_PACKAGES = 50_000
DEFAULT_MAX_VERSIONS = 250_000
DEFAULT_MAX_EDGES = 100_000
MAX_COORDINATE_COMPONENT_LENGTH = 128
LIVE_INVENTORY_SCOPE = "registry-package-index-with-caller-authorized-graph-fetches"


class ContractError(ValueError):
    """Raised when registry or policy data violates the fail-closed contract."""


def reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    """Reject ambiguous JSON objects instead of silently keeping the last key."""

    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ContractError(f"duplicate JSON object key {key!r}")
        result[key] = value
    return result


def decode_json(payload: bytes | str, label: str) -> Any:
    try:
        return json.loads(payload, object_pairs_hook=reject_duplicate_keys)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ContractError(f"{label}: invalid JSON: {exc}") from exc


@dataclass(frozen=True, order=True)
class PackageCoordinate:
    org: str
    name: str

    @classmethod
    def from_parts(
        cls,
        org: Any,
        name: Any,
        label: str = "coordinate",
    ) -> "PackageCoordinate":
        normalized: list[str] = []
        for field, raw in (("org", org), ("name", name)):
            value = require_text(raw, f"{label}.{field}")
            if (
                value != raw
                or len(value) > MAX_COORDINATE_COMPONENT_LENGTH
                or value in {".", ".."}
                or not COORDINATE_COMPONENT_RE.fullmatch(value)
            ):
                raise ContractError(
                    f"{label}.{field} must be a normalized package component: {value!r}"
                )
            normalized.append(value)
        return cls(org=normalized[0], name=normalized[1])

    @classmethod
    def parse(cls, value: str, label: str = "coordinate") -> "PackageCoordinate":
        if not isinstance(value, str) or value.count("/") != 1:
            raise ContractError(f"{label} must use owner/name: {value!r}")
        org, name = value.split("/", 1)
        return cls.from_parts(org, name, label)

    @property
    def value(self) -> str:
        return f"{self.org}/{self.name}"


@dataclass(frozen=True, order=True)
class DeclaredEdge:
    source: PackageCoordinate
    source_version: str
    source_registry_id: str
    target: PackageCoordinate
    target_registry_id: str
    requirement: str
    kind: str
    optional: bool
    default_features: bool
    features: tuple[str, ...]
    target_predicate: str | None
    graph_digest: str

    def to_json(self) -> dict[str, Any]:
        value: dict[str, Any] = {
            "source": self.source.value,
            "sourceVersion": self.source_version,
            "sourceRegistryId": self.source_registry_id,
            "target": self.target.value,
            "targetRegistryId": self.target_registry_id,
            "requirement": self.requirement,
            "kind": self.kind,
            "optional": self.optional,
            "defaultFeatures": self.default_features,
            "features": list(self.features),
            "graphDigest": self.graph_digest,
        }
        if self.target_predicate is not None:
            value["targetPredicate"] = self.target_predicate
        return value


@dataclass(frozen=True)
class LoadedInventory:
    edges: tuple[DeclaredEdge, ...]
    packages_fetched: tuple[str, ...]
    package_list_total: int
    versions_attempted: int
    graphs_loaded: int
    missing_graphs: tuple[dict[str, Any], ...]
    inventory_scope: str
    registry_id: str | None
    version_policy: str


@dataclass(frozen=True)
class CuratedConsumer:
    repository: str
    e2e_repository: str
    wave: str
    linear_issue: str
    languages: tuple[str, ...]
    persistence: tuple[str, ...]
    legacy_parity_required: bool
    bootstrap_independent: bool


@dataclass(frozen=True)
class Classification:
    value: str
    evidence: tuple[str, ...]
    note: str | None


class RejectRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Reject redirects so bearer credentials never cross an origin boundary."""

    def redirect_request(self, request, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        return None


def normalize_registry_url(base_url: str) -> str:
    if not isinstance(base_url, str) or not base_url or base_url != base_url.strip():
        raise ContractError("registry URL must be a non-empty normalized string")
    if any(ord(character) < 0x20 or ord(character) == 0x7F for character in base_url):
        raise ContractError("registry URL must not contain control characters")
    try:
        parsed = urllib.parse.urlsplit(base_url)
        port = parsed.port
    except ValueError as exc:
        raise ContractError(f"registry URL has an invalid port: {exc}") from exc
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.hostname is None:
        raise ContractError("registry URL must be an absolute http(s) URL")
    if parsed.username is not None or parsed.password is not None:
        raise ContractError("registry URL must not contain userinfo")
    if parsed.query or parsed.fragment:
        raise ContractError("registry URL must not contain a query or fragment")
    hostname = parsed.hostname.rstrip(".").lower()
    if not hostname:
        raise ContractError("registry URL must contain a hostname")
    try:
        hostname.encode("ascii")
    except UnicodeEncodeError as exc:
        raise ContractError("registry URL hostname must use ASCII or punycode") from exc
    if parsed.scheme == "http":
        local = hostname == "localhost"
        if not local:
            try:
                local = ipaddress.ip_address(hostname).is_loopback
            except ValueError:
                local = False
        if not local:
            raise ContractError("registry URL must use HTTPS unless it targets an exact loopback host")
    host = f"[{hostname}]" if ":" in hostname else hostname
    if port is not None:
        host = f"{host}:{port}"
    path = parsed.path.rstrip("/")
    return urllib.parse.urlunsplit((parsed.scheme, host, path, "", ""))


def require_positive_limit(value: Any, label: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise ContractError(f"{label} must be a positive integer")
    return value


class RegistryClient:
    def __init__(
        self,
        base_url: str,
        *,
        bearer_token: str | None = None,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
        max_response_bytes: int = DEFAULT_MAX_RESPONSE_BYTES,
        opener: Any | None = None,
    ) -> None:
        if not math.isfinite(timeout_seconds) or timeout_seconds <= 0 or timeout_seconds > MAX_TIMEOUT_SECONDS:
            raise ContractError(
                f"timeout must be finite and within (0, {MAX_TIMEOUT_SECONDS:g}] seconds"
            )
        self.base_url = normalize_registry_url(base_url)
        self.bearer_token = bearer_token
        self.timeout_seconds = timeout_seconds
        self.max_response_bytes = require_positive_limit(
            max_response_bytes, "max response bytes"
        )
        self._opener = opener or urllib.request.build_opener(RejectRedirectHandler())

    def _get_json_response(
        self,
        path: str,
        *,
        allow_not_found: bool = False,
    ) -> tuple[Any, dict[str, str], int] | None:
        if not path.startswith("/"):
            raise ContractError(f"registry path must be absolute: {path!r}")
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            headers={
                "Accept": "application/vnd.zpkg.dependency-graph.v1+json, application/json",
                "User-Agent": "opto-sync-consumer-impact/1",
            },
            method="GET",
        )
        if self.bearer_token:
            request.add_header("Authorization", f"Bearer {self.bearer_token}")
        try:
            with self._opener.open(request, timeout=self.timeout_seconds) as response:
                final_url = response.geturl()
                if final_url != request.full_url:
                    raise ContractError(
                        f"{path}: registry redirects are forbidden ({request.full_url!r} -> {final_url!r})"
                    )
                content_type = response.headers.get_content_type()
                if content_type not in {
                    "application/json",
                    "application/vnd.zpkg.dependency-graph.v1+json",
                }:
                    raise ContractError(
                        f"{path}: expected JSON content type, received {content_type!r}"
                    )
                content_length_raw = response.headers.get("Content-Length")
                if content_length_raw is not None:
                    try:
                        content_length = int(content_length_raw, 10)
                    except ValueError as exc:
                        raise ContractError(f"{path}: invalid Content-Length") from exc
                    if content_length < 0 or content_length > self.max_response_bytes:
                        raise ContractError(
                            f"{path}: response Content-Length {content_length} exceeds the "
                            f"{self.max_response_bytes}-byte safety limit"
                        )
                payload = response.read(self.max_response_bytes + 1)
                if len(payload) > self.max_response_bytes:
                    raise ContractError(
                        f"{path}: response exceeds the {self.max_response_bytes}-byte safety limit"
                    )
                if content_length_raw is not None and content_length != len(payload):
                    raise ContractError(
                        f"{path}: Content-Length {content_length} does not match received body length {len(payload)}"
                    )
                headers = {key.lower(): value for key, value in response.headers.items()}
        except urllib.error.HTTPError as exc:
            if allow_not_found and exc.code == 404:
                return None
            if 300 <= exc.code < 400:
                raise ContractError(f"{path}: registry redirects are forbidden (HTTP {exc.code})") from exc
            raise ContractError(f"{path}: registry returned HTTP {exc.code}") from exc
        except urllib.error.URLError as exc:
            raise ContractError(f"{path}: registry request failed: {exc.reason}") from exc
        if not payload:
            raise ContractError(f"{path}: registry returned an empty body")
        return decode_json(payload, path), headers, len(payload)

    def get_json(self, path: str, *, allow_not_found: bool = False) -> Any | None:
        response = self._get_json_response(path, allow_not_found=allow_not_found)
        return None if response is None else response[0]

    def get_declared_graph(self, path: str, *, allow_not_found: bool = False) -> Any | None:
        response = self._get_json_response(path, allow_not_found=allow_not_found)
        if response is None:
            return None
        payload, headers, encoded_length = response
        validate_graph_transport(payload, headers, path, encoded_length=encoded_length)
        return payload


def validate_graph_transport(
    payload: Any,
    headers: Mapping[str, str],
    label: str,
    *,
    encoded_length: int | None = None,
) -> None:
    graph = require_mapping(payload, f"{label} graph response")
    body_digest = require_text(graph.get("graph_digest"), f"{label}.graph_digest")
    if not DIGEST_RE.fullmatch(body_digest):
        raise ContractError(f"{label}: invalid graph_digest")
    header_digest = headers.get("x-zpkg-graph-digest")
    if header_digest != body_digest:
        raise ContractError(
            f"{label}: x-zpkg-graph-digest {header_digest!r} does not match body {body_digest!r}"
        )
    etag = headers.get("etag")
    if not etag or etag.startswith("W/") or not ETAG_RE.fullmatch(etag):
        raise ContractError(f"{label}: declared graph must carry a strong quoted ETag")
    if headers.get("x-zpkg-graph-authoritative", "").lower() != "true":
        raise ContractError(f"{label}: canonical JSON graph must be authoritative")
    content_length_raw = headers.get("content-length")
    if content_length_raw is None:
        raise ContractError(f"{label}: declared graph must carry Content-Length")
    try:
        content_length = int(content_length_raw, 10)
    except ValueError as exc:
        raise ContractError(f"{label}: invalid Content-Length") from exc
    if content_length < 0 or (encoded_length is not None and content_length != encoded_length):
        raise ContractError(
            f"{label}: Content-Length {content_length} does not match encoded body length {encoded_length}"
        )
    vary = {item.strip().lower() for item in headers.get("vary", "").split(",") if item.strip()}
    if "accept" not in vary:
        raise ContractError(f"{label}: declared graph response must include Vary: Accept")
    cache_control = {
        item.strip().lower()
        for item in headers.get("cache-control", "").split(",")
        if item.strip()
    }
    if "authorization" in vary:
        if not {"private", "no-store"}.issubset(cache_control):
            raise ContractError(
                f"{label}: authorization-varying graph must use Cache-Control: private, no-store"
            )
    elif not {"public", "immutable", "max-age=31536000"}.issubset(cache_control):
        raise ContractError(
            f"{label}: public graph must use immutable one-year Cache-Control"
        )


def require_mapping(value: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ContractError(f"{label} must be a JSON object")
    return value


def require_list(value: Any, label: str) -> list[Any]:
    if not isinstance(value, list):
        raise ContractError(f"{label} must be a JSON array")
    return value


def require_text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ContractError(f"{label} must be a non-empty string")
    normalized = value.strip()
    if any(ord(character) < 0x20 or ord(character) == 0x7F for character in normalized):
        raise ContractError(f"{label} must not contain control characters")
    return normalized


def require_bool(value: Any, label: str) -> bool:
    if not isinstance(value, bool):
        raise ContractError(f"{label} must be boolean")
    return value


def require_nonnegative_int(value: Any, label: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ContractError(f"{label} must be a non-negative integer")
    return value


def require_unique_texts(value: Any, label: str) -> tuple[str, ...]:
    items = require_list(value, label)
    normalized = tuple(require_text(item, f"{label}[]") for item in items)
    if len(normalized) != len(set(normalized)):
        raise ContractError(f"{label} contains duplicate values")
    return tuple(sorted(normalized))


def read_json(
    path: Path,
    label: str,
    *,
    max_bytes: int = DEFAULT_MAX_RESPONSE_BYTES,
) -> Any:
    limit = require_positive_limit(max_bytes, f"{label} max bytes")
    try:
        size = path.stat().st_size
        if size > limit:
            raise ContractError(f"{label} {path} exceeds the {limit}-byte safety limit")
        payload = path.read_bytes()
    except OSError as exc:
        raise ContractError(f"cannot read {label} {path}: {exc}") from exc
    if len(payload) > limit:
        raise ContractError(f"{label} {path} exceeds the {limit}-byte safety limit")
    return decode_json(payload, f"invalid JSON in {label} {path}")


def canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def sha256_identity(value: Any) -> str:
    return f"sha256:{hashlib.sha256(canonical_json_bytes(value)).hexdigest()}"


def normalize_package_page(payload: Any, label: str) -> tuple[list[Mapping[str, Any]], int]:
    root = require_mapping(payload, label)
    # The current API route serializes PackageListResponse directly. Older
    # generated fixtures wrap that response under `page`; accept both shapes
    # but normalize them to one strict internal representation.
    if "page" in root:
        root = require_mapping(root["page"], f"{label}.page")
    items = require_list(root.get("items"), f"{label}.items")
    total = require_nonnegative_int(root.get("total"), f"{label}.total")
    normalized: list[Mapping[str, Any]] = []
    for index, item in enumerate(items):
        normalized.append(require_mapping(item, f"{label}.items[{index}]"))
    return normalized, total


def declared_graph_registry_id(
    payload: Any,
    *,
    expected: PackageCoordinate,
    version: str,
) -> str:
    graph = require_mapping(payload, f"declared graph {expected.value}@{version}")
    package = require_mapping(graph.get("package"), f"{expected.value}@{version}.package")
    return require_text(package.get("registry_id"), f"{expected.value}@{version}.package.registry_id")


def parse_declared_graph(
    payload: Any,
    *,
    expected: PackageCoordinate,
    version: str,
    expected_registry_id: str | None = None,
    max_edges: int = DEFAULT_MAX_EDGES,
) -> list[DeclaredEdge]:
    edge_limit = require_positive_limit(max_edges, "max graph edges")
    graph = require_mapping(payload, f"declared graph {expected.value}@{version}")
    if graph.get("schema") != GRAPH_SCHEMA:
        raise ContractError(
            f"{expected.value}@{version}: schema must be exactly {GRAPH_SCHEMA!r}"
        )
    if graph.get("view") != "declared":
        raise ContractError(f"{expected.value}@{version}: graph view must be 'declared'")
    digest = require_text(graph.get("graph_digest"), f"{expected.value}@{version}.graph_digest")
    if not DIGEST_RE.fullmatch(digest):
        raise ContractError(f"{expected.value}@{version}: invalid graph_digest")
    package = require_mapping(graph.get("package"), f"{expected.value}@{version}.package")
    package_coordinate = PackageCoordinate.from_parts(
        package.get("org"),
        package.get("name"),
        f"{expected.value}@{version}.package",
    )
    package_version = require_text(package.get("version"), "package.version")
    source_registry_id = require_text(package.get("registry_id"), "package.registry_id")
    if package_coordinate != expected:
        raise ContractError(
            f"{expected.value}@{version}: graph root is {package_coordinate.value}"
        )
    if package_version != version:
        raise ContractError(
            f"{expected.value}: requested version {version!r}, graph reports {package_version!r}"
        )
    if expected_registry_id is not None and source_registry_id != expected_registry_id:
        raise ContractError(
            f"{expected.value}@{version}: registry_id {source_registry_id!r} differs from "
            f"inventory registry {expected_registry_id!r}"
        )

    dependencies = require_list(graph.get("dependencies"), f"{expected.value}@{version}.dependencies")
    if len(dependencies) > edge_limit:
        raise ContractError(
            f"{expected.value}@{version}: dependency count {len(dependencies)} exceeds "
            f"the {edge_limit}-edge safety limit"
        )
    edges: list[DeclaredEdge] = []
    seen: set[DeclaredEdge] = set()
    for index, raw in enumerate(dependencies):
        label = f"{expected.value}@{version}.dependencies[{index}]"
        dep = require_mapping(raw, label)
        target = PackageCoordinate.from_parts(
            dep.get("org"),
            dep.get("name"),
            label,
        )
        target_registry_id = require_text(dep.get("registry_id"), f"{label}.registry_id")
        if target_registry_id != source_registry_id:
            raise ContractError(
                f"{label}.registry_id {target_registry_id!r} differs from graph registry "
                f"{source_registry_id!r}"
            )
        requirement = require_text(dep.get("requirement"), f"{label}.requirement")
        kind = require_text(dep.get("kind"), f"{label}.kind")
        if kind not in DEPENDENCY_KINDS:
            raise ContractError(f"{label}.kind is unsupported: {kind!r}")
        optional = require_bool(dep.get("optional"), f"{label}.optional")
        default_features = require_bool(dep.get("default_features"), f"{label}.default_features")
        features = require_unique_texts(dep.get("features", []), f"{label}.features")
        target_predicate_raw = dep.get("target")
        target_predicate = (
            require_text(target_predicate_raw, f"{label}.target")
            if target_predicate_raw is not None
            else None
        )
        edge = DeclaredEdge(
            source=expected,
            source_version=version,
            source_registry_id=source_registry_id,
            target=target,
            target_registry_id=target_registry_id,
            requirement=requirement,
            kind=kind,
            optional=optional,
            default_features=default_features,
            features=features,
            target_predicate=target_predicate,
            graph_digest=digest,
        )
        if edge not in seen:
            seen.add(edge)
            edges.append(edge)
    return sorted(edges)

def load_snapshot(
    path: Path,
    *,
    version_policy: str,
    max_packages: int = DEFAULT_MAX_PACKAGES,
    max_versions: int = DEFAULT_MAX_VERSIONS,
    max_edges: int = DEFAULT_MAX_EDGES,
) -> LoadedInventory:
    package_limit = require_positive_limit(max_packages, "max packages")
    version_limit = require_positive_limit(max_versions, "max versions")
    edge_limit = require_positive_limit(max_edges, "max edges")
    root = require_mapping(read_json(path, "snapshot"), "snapshot")
    if root.get("schema") != SNAPSHOT_SCHEMA:
        raise ContractError(f"snapshot.schema must be exactly {SNAPSHOT_SCHEMA!r}")
    snapshot_policy = root.get("versionPolicy", version_policy)
    if snapshot_policy != version_policy:
        raise ContractError(
            f"snapshot versionPolicy {snapshot_policy!r} does not match requested {version_policy!r}"
        )
    inventory_scope = require_text(root.get("inventoryScope"), "snapshot.inventoryScope")
    registry_id_raw = root.get("registryId")
    registry_id = (
        require_text(registry_id_raw, "snapshot.registryId") if registry_id_raw is not None else None
    )
    packages = require_list(root.get("packages"), "snapshot.packages")
    if len(packages) > package_limit:
        raise ContractError(
            f"snapshot package count {len(packages)} exceeds the {package_limit}-package safety limit"
        )
    edges: list[DeclaredEdge] = []
    package_names: list[str] = []
    versions_attempted = 0
    graphs_loaded = 0
    missing: list[dict[str, Any]] = []
    seen_packages: set[str] = set()
    observed_registry_id = registry_id
    for package_index, raw_package in enumerate(packages):
        label = f"snapshot.packages[{package_index}]"
        package = require_mapping(raw_package, label)
        coordinate = PackageCoordinate.from_parts(
            package.get("org"),
            package.get("name"),
            label,
        )
        if coordinate.value in seen_packages:
            raise ContractError(f"snapshot contains duplicate package {coordinate.value}")
        seen_packages.add(coordinate.value)
        package_names.append(coordinate.value)
        versions = require_list(package.get("versions"), f"{label}.versions")
        if version_policy == "latest-visible" and len(versions) > 1:
            raise ContractError(
                f"{coordinate.value}: latest-visible snapshot must contain at most one version"
            )
        for version_index, raw_version in enumerate(versions):
            version_label = f"{label}.versions[{version_index}]"
            version_entry = require_mapping(raw_version, version_label)
            version = require_text(version_entry.get("version"), f"{version_label}.version")
            versions_attempted += 1
            if versions_attempted > version_limit:
                raise ContractError(
                    f"snapshot version count exceeds the {version_limit}-version safety limit"
                )
            if version_entry.get("graph") is None:
                missing.append(
                    {
                        "package": coordinate.value,
                        "version": version,
                        "reason": require_text(
                            version_entry.get("missingReason", "not-found-or-inaccessible"),
                            f"{version_label}.missingReason",
                        ),
                    }
                )
                continue
            graph_registry_id = declared_graph_registry_id(
                version_entry["graph"], expected=coordinate, version=version
            )
            if observed_registry_id is None:
                observed_registry_id = graph_registry_id
            elif graph_registry_id != observed_registry_id:
                raise ContractError(
                    f"{coordinate.value}@{version}: registry_id {graph_registry_id!r} differs "
                    f"from inventory registry {observed_registry_id!r}"
                )
            parsed_edges = parse_declared_graph(
                version_entry["graph"],
                expected=coordinate,
                version=version,
                expected_registry_id=observed_registry_id,
                max_edges=edge_limit,
            )
            edges.extend(parsed_edges)
            if len(edges) > edge_limit:
                raise ContractError(
                    f"snapshot edge count exceeds the {edge_limit}-edge safety limit"
                )
            graphs_loaded += 1
    if observed_registry_id is None:
        raise ContractError("snapshot cannot establish the required registry identity")
    edge_set = tuple(sorted(set(edges)))
    return LoadedInventory(
        edges=edge_set,
        packages_fetched=tuple(sorted(package_names)),
        package_list_total=len(package_names),
        versions_attempted=versions_attempted,
        graphs_loaded=graphs_loaded,
        missing_graphs=tuple(sorted(missing, key=lambda item: (item["package"], item["version"]))),
        inventory_scope=inventory_scope,
        registry_id=observed_registry_id,
        version_policy=version_policy,
    )

def select_versions(
    client: RegistryClient,
    coordinate: PackageCoordinate,
    summary: Mapping[str, Any],
    *,
    version_policy: str,
) -> list[str]:
    if version_policy == "latest-visible":
        latest = summary.get("latest")
        return [require_text(latest, f"{coordinate.value}.latest")] if latest is not None else []
    quoted_org = urllib.parse.quote(coordinate.org, safe="")
    quoted_name = urllib.parse.quote(coordinate.name, safe="")
    payload = client.get_json(f"/v1/packages/{quoted_org}/{quoted_name}")
    metadata = require_mapping(payload, f"metadata {coordinate.value}")
    versions = require_unique_texts(metadata.get("versions", []), f"{coordinate.value}.versions")
    return list(versions)


def load_live_inventory(
    client: RegistryClient,
    *,
    version_policy: str,
    allow_missing_graphs: bool,
    max_packages: int = DEFAULT_MAX_PACKAGES,
    max_versions: int = DEFAULT_MAX_VERSIONS,
    max_edges: int = DEFAULT_MAX_EDGES,
) -> LoadedInventory:
    package_limit = require_positive_limit(max_packages, "max packages")
    version_limit = require_positive_limit(max_versions, "max versions")
    edge_limit = require_positive_limit(max_edges, "max edges")
    limit = 200
    offset = 0
    package_summaries: dict[str, Mapping[str, Any]] = {}
    advertised_total: int | None = None
    while True:
        payload = client.get_json(f"/v1/packages?limit={limit}&offset={offset}")
        items, total = normalize_package_page(payload, f"package page offset={offset}")
        if total > package_limit:
            raise ContractError(
                f"package inventory total {total} exceeds the {package_limit}-package safety limit"
            )
        if advertised_total is None:
            advertised_total = total
        elif total != advertised_total:
            raise ContractError(
                f"package inventory total changed during pagination: {advertised_total} -> {total}"
            )
        if not items:
            break
        for index, item in enumerate(items):
            coordinate = PackageCoordinate.from_parts(
                item.get("org"),
                item.get("name"),
                f"page[{offset + index}]",
            )
            if coordinate.value in package_summaries:
                raise ContractError(f"package inventory contains duplicate {coordinate.value}")
            package_summaries[coordinate.value] = item
        offset += len(items)
        if offset >= total:
            break
        if len(items) < limit:
            raise ContractError(
                f"package inventory ended early at {offset} items but advertises total={total}"
            )
    total = advertised_total or 0
    if len(package_summaries) != total:
        raise ContractError(
            f"package inventory fetched {len(package_summaries)} unique packages, expected {total}"
        )

    edges: list[DeclaredEdge] = []
    missing: list[dict[str, Any]] = []
    versions_attempted = 0
    graphs_loaded = 0
    observed_registry_id: str | None = None
    for coordinate_value in sorted(package_summaries):
        coordinate = PackageCoordinate.parse(coordinate_value)
        versions = select_versions(
            client,
            coordinate,
            package_summaries[coordinate_value],
            version_policy=version_policy,
        )
        for version in versions:
            versions_attempted += 1
            if versions_attempted > version_limit:
                raise ContractError(
                    f"package version census exceeds the {version_limit}-version safety limit"
                )
            path = (
                "/v1/packages/"
                f"{urllib.parse.quote(coordinate.org, safe='')}/"
                f"{urllib.parse.quote(coordinate.name, safe='')}/versions/"
                f"{urllib.parse.quote(version, safe='')}/dependency-graph?view=declared&format=json"
            )
            payload = client.get_declared_graph(path, allow_not_found=True)
            if payload is None:
                missing.append(
                    {
                        "package": coordinate.value,
                        "version": version,
                        "reason": "not-found-or-inaccessible",
                    }
                )
                continue
            graph_registry_id = declared_graph_registry_id(
                payload, expected=coordinate, version=version
            )
            if observed_registry_id is None:
                observed_registry_id = graph_registry_id
            elif graph_registry_id != observed_registry_id:
                raise ContractError(
                    f"{coordinate.value}@{version}: registry_id {graph_registry_id!r} differs "
                    f"from inventory registry {observed_registry_id!r}"
                )
            parsed_edges = parse_declared_graph(
                payload,
                expected=coordinate,
                version=version,
                expected_registry_id=observed_registry_id,
                max_edges=edge_limit,
            )
            edges.extend(parsed_edges)
            if len(edges) > edge_limit:
                raise ContractError(
                    f"package graph census exceeds the {edge_limit}-edge safety limit"
                )
            graphs_loaded += 1
    if missing and not allow_missing_graphs:
        sample = ", ".join(f"{item['package']}@{item['version']}" for item in missing[:5])
        raise ContractError(
            f"{len(missing)} package versions have no accessible declared graph; first: {sample}. "
            "The API intentionally conflates not-found and unauthorized. Use "
            "--allow-missing-graphs only for an explicitly non-strict migration census."
        )
    if observed_registry_id is None:
        raise ContractError(
            "live inventory cannot establish the required registry identity from any declared graph"
        )
    return LoadedInventory(
        edges=tuple(sorted(set(edges))),
        packages_fetched=tuple(sorted(package_summaries)),
        package_list_total=total,
        versions_attempted=versions_attempted,
        graphs_loaded=graphs_loaded,
        missing_graphs=tuple(sorted(missing, key=lambda item: (item["package"], item["version"]))),
        inventory_scope=LIVE_INVENTORY_SCOPE,
        registry_id=observed_registry_id,
        version_policy=version_policy,
    )

def load_curated_fleet(path: Path) -> tuple[str, dict[str, CuratedConsumer]]:
    manifest = require_mapping(read_json(path, "curated fleet"), "curated fleet")
    dependency = require_mapping(manifest.get("dependency"), "curated fleet.dependency")
    root = require_text(dependency.get("package"), "curated fleet.dependency.package")
    PackageCoordinate.parse(root, "curated fleet root")
    wrappers = require_list(manifest.get("wrappers"), "curated fleet.wrappers")
    consumers: dict[str, CuratedConsumer] = {}
    for index, raw in enumerate(wrappers):
        label = f"curated fleet.wrappers[{index}]"
        wrapper = require_mapping(raw, label)
        repository = PackageCoordinate.parse(
            require_text(wrapper.get("repository"), f"{label}.repository"),
            f"{label}.repository",
        ).value
        if repository in consumers:
            raise ContractError(f"curated fleet contains duplicate {repository}")
        e2e = require_mapping(wrapper.get("e2e"), f"{label}.e2e")
        e2e_repository = PackageCoordinate.parse(
            require_text(e2e.get("repository"), f"{label}.e2e.repository"),
            f"{label}.e2e.repository",
        ).value
        consumers[repository] = CuratedConsumer(
            repository=repository,
            e2e_repository=e2e_repository,
            wave=require_text(wrapper.get("wave"), f"{label}.wave"),
            linear_issue=require_text(wrapper.get("linearIssue"), f"{label}.linearIssue"),
            languages=require_unique_texts(wrapper.get("languages"), f"{label}.languages"),
            persistence=require_unique_texts(wrapper.get("persistence"), f"{label}.persistence"),
            legacy_parity_required=require_bool(
                wrapper.get("legacyParityRequired"), f"{label}.legacyParityRequired"
            ),
            bootstrap_independent=require_bool(
                wrapper.get("bootstrapIndependent"), f"{label}.bootstrapIndependent"
            ),
        )
    return root, consumers


def load_classifications(
    path: Path,
    *,
    expected_root: str,
    curated: Mapping[str, CuratedConsumer],
) -> tuple[str, dict[str, Classification]]:
    policy = require_mapping(read_json(path, "classification policy"), "classification policy")
    if policy.get("schemaVersion") != 1:
        raise ContractError("classification policy schemaVersion must be 1")
    root = require_text(policy.get("root"), "classification policy.root")
    if root != expected_root:
        raise ContractError(
            f"classification root {root!r} differs from curated root {expected_root!r}"
        )
    default = require_text(
        policy.get("defaultClassification"), "classification policy.defaultClassification"
    )
    if default not in CLASSIFICATION_VALUES:
        raise ContractError(f"unsupported default classification {default!r}")
    entries = require_mapping(policy.get("entries", {}), "classification policy.entries")
    classifications: dict[str, Classification] = {}
    for repository, raw in entries.items():
        coordinate = PackageCoordinate.parse(repository, "classification entry").value
        if coordinate not in curated:
            raise ContractError(f"classification entry {coordinate} is not in curated fleet")
        entry = require_mapping(raw, f"classification policy.entries[{coordinate!r}]")
        value = require_text(entry.get("classification"), f"{coordinate}.classification")
        if value not in CLASSIFICATION_VALUES:
            raise ContractError(f"{coordinate}: unsupported classification {value!r}")
        evidence = require_unique_texts(entry.get("evidence", []), f"{coordinate}.evidence")
        note_raw = entry.get("note")
        note = require_text(note_raw, f"{coordinate}.note") if note_raw is not None else None
        classifications[coordinate] = Classification(value=value, evidence=evidence, note=note)
    return default, classifications


def build_reverse_adjacency(
    edges: Iterable[DeclaredEdge],
) -> tuple[dict[str, set[str]], dict[tuple[str, str], list[DeclaredEdge]]]:
    reverse: dict[str, set[str]] = defaultdict(set)
    evidence: dict[tuple[str, str], list[DeclaredEdge]] = defaultdict(list)
    for edge in edges:
        dependency = edge.target.value
        consumer = edge.source.value
        reverse[dependency].add(consumer)
        evidence[(dependency, consumer)].append(edge)
    for pair in evidence:
        evidence[pair] = sorted(set(evidence[pair]))
    return reverse, evidence


def shortest_consumer_paths(
    root: str,
    reverse: Mapping[str, set[str]],
) -> tuple[dict[str, int], dict[str, tuple[str, ...]]]:
    distances: dict[str, int] = {root: 0}
    paths: dict[str, tuple[str, ...]] = {root: (root,)}
    queue: deque[str] = deque([root])
    while queue:
        dependency = queue.popleft()
        for consumer in sorted(reverse.get(dependency, set())):
            candidate_distance = distances[dependency] + 1
            candidate_path = paths[dependency] + (consumer,)
            if consumer not in distances:
                distances[consumer] = candidate_distance
                paths[consumer] = candidate_path
                queue.append(consumer)
            elif candidate_distance == distances[consumer] and candidate_path < paths[consumer]:
                paths[consumer] = candidate_path
    distances.pop(root, None)
    paths.pop(root, None)
    return distances, paths


def strongly_connected_components(adjacency: Mapping[str, set[str]]) -> list[list[str]]:
    """Return deterministic non-trivial SCCs without recursion-depth limits."""

    nodes = sorted(set(adjacency) | {item for values in adjacency.values() for item in values})
    visited: set[str] = set()
    finish_order: list[str] = []
    for start in nodes:
        if start in visited:
            continue
        visited.add(start)
        dfs_stack = [(start, iter(sorted(adjacency.get(start, set()))))]
        while dfs_stack:
            node, neighbors = dfs_stack[-1]
            try:
                neighbor = next(neighbors)
            except StopIteration:
                finish_order.append(node)
                dfs_stack.pop()
                continue
            if neighbor not in visited:
                visited.add(neighbor)
                dfs_stack.append((neighbor, iter(sorted(adjacency.get(neighbor, set())))))

    reverse: dict[str, set[str]] = defaultdict(set)
    for source, targets in adjacency.items():
        for target in targets:
            reverse[target].add(source)

    assigned: set[str] = set()
    result: list[list[str]] = []
    for start in reversed(finish_order):
        if start in assigned:
            continue
        assigned.add(start)
        component: list[str] = []
        component_stack = [start]
        while component_stack:
            node = component_stack.pop()
            component.append(node)
            for neighbor in sorted(reverse.get(node, set()), reverse=True):
                if neighbor not in assigned:
                    assigned.add(neighbor)
                    component_stack.append(neighbor)
        component.sort()
        if len(component) > 1 or start in adjacency.get(start, set()):
            result.append(component)
    return sorted(result)


def render_impact(
    inventory: LoadedInventory,
    *,
    root: str,
    curated: Mapping[str, CuratedConsumer],
    default_classification: str,
    classifications: Mapping[str, Classification],
) -> dict[str, Any]:
    PackageCoordinate.parse(root, "root")
    reverse, edge_evidence = build_reverse_adjacency(inventory.edges)
    distances, paths = shortest_consumer_paths(root, reverse)
    discovered = set(distances)
    curated_names = set(curated)
    graph_only = sorted(discovered - curated_names)
    curated_only = sorted(curated_names - discovered)
    direct = sorted(name for name, depth in distances.items() if depth == 1)
    transitive = sorted(name for name, depth in distances.items() if depth > 1)

    union = sorted(discovered | curated_names)
    consumers: list[dict[str, Any]] = []
    unclassified: list[str] = []
    for repository in union:
        curated_entry = curated.get(repository)
        classification_entry = classifications.get(repository)
        classification = (
            classification_entry.value
            if classification_entry is not None
            else default_classification if curated_entry is not None else "unclassified"
        )
        if classification == "unclassified":
            unclassified.append(repository)
        if repository in discovered and repository in curated_names:
            coverage_status = "graph-confirmed"
        elif repository in discovered:
            coverage_status = "graph-only"
        else:
            coverage_status = "curated-only"
        entry: dict[str, Any] = {
            "repository": repository,
            "coverageStatus": coverage_status,
            "adoptionClassification": classification,
            "minimumDepth": distances.get(repository),
            "shortestDependencyToConsumerPath": list(paths[repository])
            if repository in paths
            else None,
            "testRepository": curated_entry.e2e_repository if curated_entry else None,
            "wave": curated_entry.wave if curated_entry else None,
            "linearIssue": curated_entry.linear_issue if curated_entry else None,
            "languages": list(curated_entry.languages) if curated_entry else [],
            "persistence": list(curated_entry.persistence) if curated_entry else [],
            "legacyParityRequired": curated_entry.legacy_parity_required if curated_entry else None,
            "bootstrapIndependent": curated_entry.bootstrap_independent if curated_entry else None,
            "classificationEvidence": list(classification_entry.evidence)
            if classification_entry
            else [],
            "classificationNote": classification_entry.note if classification_entry else None,
        }
        if repository in paths:
            path = paths[repository]
            path_evidence: list[dict[str, Any]] = []
            for dependency, consumer in zip(path, path[1:]):
                path_evidence.extend(
                    edge.to_json() for edge in edge_evidence.get((dependency, consumer), [])
                )
            entry["pathEvidence"] = path_evidence
        else:
            entry["pathEvidence"] = []
        consumers.append(entry)

    forward: dict[str, set[str]] = defaultdict(set)
    for edge in inventory.edges:
        forward[edge.source.value].add(edge.target.value)
    cycles = strongly_connected_components(forward)
    normalized_edges = [edge.to_json() for edge in inventory.edges]
    inventory_preimage = {
        "root": root,
        "inventoryScope": inventory.inventory_scope,
        "registryId": inventory.registry_id,
        "versionPolicy": inventory.version_policy,
        "packageListTotal": inventory.package_list_total,
        "versionsAttempted": inventory.versions_attempted,
        "graphsLoaded": inventory.graphs_loaded,
        "edges": normalized_edges,
        "packagesFetched": list(inventory.packages_fetched),
        "missingGraphs": list(inventory.missing_graphs),
    }
    return {
        "schema": OUTPUT_SCHEMA,
        "root": root,
        "semantics": {
            "graphView": "declared",
            "resolution": "unresolved-requirements",
            "reverseDependentsEndpointUsed": False,
            "consumerDiscovery": "enumerate-registry-package-index-and-invert-caller-authorized-declared-edges",
            "packageIndexScope": "registry-wide-current-list-endpoint",
            "privateCoverage": "graph-fetches-limited-to-caller-authorization",
            "inventoryConsistency": "total-stable-pagination-without-registry-checkpoint",
            "redirectsAllowed": False,
            "registryIdentityRequired": True,
        },
        "inventory": {
            "scope": inventory.inventory_scope,
            "registryId": inventory.registry_id,
            "versionPolicy": inventory.version_policy,
            "packageListTotal": inventory.package_list_total,
            "packagesFetched": len(inventory.packages_fetched),
            "versionsAttempted": inventory.versions_attempted,
            "graphsLoaded": inventory.graphs_loaded,
            "missingGraphCount": len(inventory.missing_graphs),
            "missingGraphs": list(inventory.missing_graphs),
            "declaredEdgeCount": len(inventory.edges),
            "inventoryDigest": sha256_identity(inventory_preimage),
        },
        "summary": {
            "directConsumers": len(direct),
            "transitiveConsumers": len(transitive),
            "allDiscoveredConsumers": len(discovered),
            "curatedConsumers": len(curated_names),
            "graphOnly": len(graph_only),
            "curatedOnly": len(curated_only),
            "unclassified": len(unclassified),
            "cycleComponents": len(cycles),
        },
        "directConsumers": direct,
        "transitiveConsumers": transitive,
        "consumers": consumers,
        "gaps": {
            "graphOnly": graph_only,
            "curatedOnly": curated_only,
            "unclassified": sorted(unclassified),
        },
        "cycles": cycles,
        "declaredEdges": normalized_edges,
    }


def dot_id(value: str) -> str:
    return "n_" + hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]


def escape_dot(value: str) -> str:
    escaped: list[str] = []
    for character in value:
        if character == "\\":
            escaped.append("\\\\")
        elif character == '"':
            escaped.append('\\"')
        elif character == "\n":
            escaped.append("\\n")
        elif character == "\r":
            escaped.append("\\r")
        elif character == "\t":
            escaped.append("\\t")
        elif ord(character) < 0x20 or ord(character) == 0x7F:
            escaped.append(f"\\u{ord(character):04x}")
        else:
            escaped.append(character)
    return "".join(escaped)


def render_dot(report: Mapping[str, Any]) -> str:
    root = require_text(report.get("root"), "report.root")
    consumers = {
        require_text(item.get("repository"), "consumer.repository"): item
        for item in require_list(report.get("consumers"), "report.consumers")
        if isinstance(item, Mapping)
    }
    lines = ["digraph opto_sync_consumers {", "  rankdir=LR;", "  node [shape=box];"]
    nodes = {root} | set(consumers)
    for node in sorted(nodes):
        attributes = [f'label="{escape_dot(node)}"']
        if node == root:
            attributes.append("shape=doubleoctagon")
        elif consumers[node].get("coverageStatus") == "graph-only":
            attributes.append("style=dashed")
        elif consumers[node].get("coverageStatus") == "curated-only":
            attributes.append("style=dotted")
        lines.append(f"  {dot_id(node)} [{', '.join(attributes)}];")
    for raw_edge in require_list(report.get("declaredEdges"), "report.declaredEdges"):
        edge = require_mapping(raw_edge, "report.declaredEdges[]")
        dependency = require_text(edge.get("target"), "edge.target")
        consumer = require_text(edge.get("source"), "edge.source")
        if dependency not in nodes or consumer not in nodes:
            continue
        label = f"{edge.get('kind', '')} {edge.get('requirement', '')}".strip()
        lines.append(
            f'  {dot_id(dependency)} -> {dot_id(consumer)} [label="{escape_dot(label)}"];'
        )
    lines.append("}")
    return "\n".join(lines) + "\n"


def mermaid_id(value: str) -> str:
    return "n" + hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]


def escape_mermaid(value: str) -> str:
    replacements = {
        "&": "&amp;",
        '"': "&quot;",
        "|": "&#124;",
        "[": "&#91;",
        "]": "&#93;",
        "<": "&lt;",
        ">": "&gt;",
    }
    return "".join(
        " "
        if ord(character) < 0x20 or ord(character) == 0x7F
        else replacements.get(character, character)
        for character in value
    )


def render_mermaid(report: Mapping[str, Any]) -> str:
    root = require_text(report.get("root"), "report.root")
    consumers = {
        require_text(item.get("repository"), "consumer.repository"): item
        for item in require_list(report.get("consumers"), "report.consumers")
        if isinstance(item, Mapping)
    }
    nodes = {root} | set(consumers)
    lines = ["graph LR"]
    for node in sorted(nodes):
        label = escape_mermaid(node)
        if node == root:
            lines.append(f'  {mermaid_id(node)}[["{label}"]]')
        else:
            lines.append(f'  {mermaid_id(node)}["{label}"]')
    for raw_edge in require_list(report.get("declaredEdges"), "report.declaredEdges"):
        edge = require_mapping(raw_edge, "report.declaredEdges[]")
        dependency = require_text(edge.get("target"), "edge.target")
        consumer = require_text(edge.get("source"), "edge.source")
        if dependency not in nodes or consumer not in nodes:
            continue
        label = escape_mermaid(
            f"{edge.get('kind', '')} {edge.get('requirement', '')}".strip()
        )
        lines.append(f"  {mermaid_id(dependency)} -->|{label}| {mermaid_id(consumer)}")
    return "\n".join(lines) + "\n"


def write_text(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value, encoding="utf-8", newline="\n")


def parse_failures(values: Sequence[str]) -> set[str]:
    failures: set[str] = set()
    for value in values:
        for item in value.split(","):
            item = item.strip()
            if not item:
                continue
            if item not in FAILURE_VALUES:
                raise ContractError(
                    f"unsupported --fail-on value {item!r}; choose from {sorted(FAILURE_VALUES)}"
                )
            failures.add(item)
    return failures


def enforce_failures(report: Mapping[str, Any], failures: set[str]) -> None:
    gaps = require_mapping(report.get("gaps"), "report.gaps")
    inventory = require_mapping(report.get("inventory"), "report.inventory")
    messages: list[str] = []
    for key in ("graph-only", "curated-only", "unclassified"):
        if key not in failures:
            continue
        report_key = {
            "graph-only": "graphOnly",
            "curated-only": "curatedOnly",
            "unclassified": "unclassified",
        }[key]
        values = require_list(gaps.get(report_key), f"report.gaps.{report_key}")
        if values:
            messages.append(f"{key}: {', '.join(str(item) for item in values)}")
    if "missing-graphs" in failures and inventory.get("missingGraphCount", 0):
        messages.append(f"missing-graphs: {inventory['missingGraphCount']}")
    if messages:
        raise ContractError("impact policy failed: " + "; ".join(messages))


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--snapshot", type=Path, help="deterministic declared-graph snapshot")
    source.add_argument("--registry-url", help="live Zed registry API base URL")
    parser.add_argument(
        "--token-env",
        default="ZED_REGISTRY_TOKEN",
        help="environment variable holding an optional bearer token",
    )
    parser.add_argument(
        "--version-policy",
        choices=sorted(VERSION_POLICY_VALUES),
        default="latest-visible",
    )
    parser.add_argument(
        "--allow-missing-graphs",
        action="store_true",
        help="record missing declared graphs instead of failing live inventory collection",
    )
    parser.add_argument("--root", default="opto-sync/opto-sync-clients")
    parser.add_argument("--curated-fleet", type=Path, required=True)
    parser.add_argument("--classification-policy", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--dot-output", type=Path)
    parser.add_argument("--mermaid-output", type=Path)
    parser.add_argument(
        "--fail-on",
        action="append",
        default=[],
        metavar="GAP",
        help="comma-separated graph-only, curated-only, unclassified, or missing-graphs",
    )
    parser.add_argument("--timeout-seconds", type=float, default=DEFAULT_TIMEOUT_SECONDS)
    parser.add_argument("--max-response-bytes", type=int, default=DEFAULT_MAX_RESPONSE_BYTES)
    parser.add_argument("--max-packages", type=int, default=DEFAULT_MAX_PACKAGES)
    parser.add_argument("--max-versions", type=int, default=DEFAULT_MAX_VERSIONS)
    parser.add_argument("--max-edges", type=int, default=DEFAULT_MAX_EDGES)
    return parser


def run(args: argparse.Namespace) -> dict[str, Any]:
    if (
        not math.isfinite(args.timeout_seconds)
        or args.timeout_seconds <= 0
        or args.timeout_seconds > MAX_TIMEOUT_SECONDS
    ):
        raise ContractError(
            f"--timeout-seconds must be finite and within (0, {MAX_TIMEOUT_SECONDS:g}]"
        )
    response_limit = require_positive_limit(args.max_response_bytes, "--max-response-bytes")
    package_limit = require_positive_limit(args.max_packages, "--max-packages")
    version_limit = require_positive_limit(args.max_versions, "--max-versions")
    edge_limit = require_positive_limit(args.max_edges, "--max-edges")
    root = PackageCoordinate.parse(args.root, "--root").value
    curated_root, curated = load_curated_fleet(args.curated_fleet)
    if curated_root != root:
        raise ContractError(f"curated fleet root {curated_root!r} differs from --root {root!r}")
    default_classification, classifications = load_classifications(
        args.classification_policy,
        expected_root=root,
        curated=curated,
    )
    if args.snapshot is not None:
        inventory = load_snapshot(
            args.snapshot,
            version_policy=args.version_policy,
            max_packages=package_limit,
            max_versions=version_limit,
            max_edges=edge_limit,
        )
    else:
        token = os.environ.get(args.token_env) or None
        client = RegistryClient(
            args.registry_url,
            bearer_token=token,
            timeout_seconds=args.timeout_seconds,
            max_response_bytes=response_limit,
        )
        inventory = load_live_inventory(
            client,
            version_policy=args.version_policy,
            allow_missing_graphs=args.allow_missing_graphs,
            max_packages=package_limit,
            max_versions=version_limit,
            max_edges=edge_limit,
        )
    report = render_impact(
        inventory,
        root=root,
        curated=curated,
        default_classification=default_classification,
        classifications=classifications,
    )
    write_text(args.output, json.dumps(report, indent=2, sort_keys=True) + "\n")
    if args.dot_output is not None:
        write_text(args.dot_output, render_dot(report))
    if args.mermaid_output is not None:
        write_text(args.mermaid_output, render_mermaid(report))
    enforce_failures(report, parse_failures(args.fail_on))
    return report


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_argument_parser()
    args = parser.parse_args(argv)
    try:
        report = run(args)
    except ContractError as exc:
        print(f"zed-consumer-graph: {exc}", file=sys.stderr)
        return 2
    summary = require_mapping(report.get("summary"), "report.summary")
    print(
        "zed-consumer-graph: "
        f"direct={summary['directConsumers']} "
        f"transitive={summary['transitiveConsumers']} "
        f"graph_only={summary['graphOnly']} "
        f"curated_only={summary['curatedOnly']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
