#!/usr/bin/env python3
"""Fail-closed launcher for credentialed live Zed graph enumeration.

The graph client itself rejects every HTTP redirect and bounds all responses.
This launcher adds an independent configuration guard: whenever a bearer token
is present, its expected origin must be supplied separately and must match the
registry URL exactly. This prevents a compromised or mistyped registry variable
from silently redirecting credentials to a different configured origin.
"""

from __future__ import annotations

import os
import re
import sys
import urllib.parse
from collections.abc import Mapping, Sequence

import zed_consumer_graph

TOKEN_ENV_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


class LiveRegistrySecurityError(ValueError):
    """Raised when live registry configuration could expose credentials."""


def normalized_origin(url: str) -> str:
    """Return the normalized origin accepted by the underlying graph client."""

    try:
        normalized = zed_consumer_graph.normalize_registry_url(url)
    except zed_consumer_graph.ContractError as exc:
        raise LiveRegistrySecurityError(str(exc)) from exc
    parsed = urllib.parse.urlsplit(normalized)
    assert parsed.hostname is not None
    default_port = 443 if parsed.scheme == "https" else 80
    port = parsed.port or default_port
    host = parsed.hostname.lower()
    host_text = f"[{host}]" if ":" in host else host
    suffix = "" if port == default_port else f":{port}"
    return f"{parsed.scheme}://{host_text}{suffix}"


def option_value(argv: Sequence[str], name: str, default: str | None = None) -> str | None:
    """Read exactly one CLI option, rejecting duplicate or missing values."""

    matches: list[str] = []
    index = 0
    while index < len(argv):
        value = argv[index]
        if value == name:
            if index + 1 >= len(argv) or argv[index + 1].startswith("--"):
                raise LiveRegistrySecurityError(f"{name} requires a value")
            matches.append(argv[index + 1])
            index += 2
            continue
        prefix = name + "="
        if value.startswith(prefix):
            matches.append(value[len(prefix) :])
        index += 1
    if len(matches) > 1:
        raise LiveRegistrySecurityError(f"{name} must not be repeated")
    return matches[0] if matches else default


def validate_live_registry(argv: Sequence[str], environ: Mapping[str, str]) -> str | None:
    """Validate registry URL and bind any bearer token to an explicit origin."""

    registry_url = option_value(argv, "--registry-url")
    if registry_url is None:
        return None
    origin = normalized_origin(registry_url)
    token_env = option_value(argv, "--token-env", "ZED_REGISTRY_TOKEN")
    assert token_env is not None
    if not TOKEN_ENV_RE.fullmatch(token_env):
        raise LiveRegistrySecurityError("--token-env must be a valid environment variable name")
    token = environ.get(token_env, "")
    if token:
        origin_env = f"{token_env}_ORIGIN"
        configured = environ.get(origin_env, "")
        if not configured:
            raise LiveRegistrySecurityError(
                f"{origin_env} is required whenever {token_env} contains a bearer token"
            )
        configured_parsed = urllib.parse.urlsplit(configured)
        if configured_parsed.path not in {"", "/"} or configured_parsed.query or configured_parsed.fragment:
            raise LiveRegistrySecurityError(
                f"{origin_env} must contain only a scheme, host, and optional port"
            )
        configured_origin = normalized_origin(configured)
        if configured_origin != origin:
            raise LiveRegistrySecurityError(
                f"registry origin {origin!r} does not match credential-bound {origin_env}={configured_origin!r}"
            )
    return origin


def main(argv: Sequence[str] | None = None) -> int:
    effective_argv = list(sys.argv[1:] if argv is None else argv)
    try:
        validate_live_registry(effective_argv, os.environ)
    except LiveRegistrySecurityError as exc:
        print(f"secure-zed-consumer-graph: {exc}", file=sys.stderr)
        return 2
    # RegistryClient constructs a private opener with RejectRedirectHandler;
    # never install or rely on process-global urllib state here.
    return zed_consumer_graph.main(effective_argv)


if __name__ == "__main__":
    raise SystemExit(main())
