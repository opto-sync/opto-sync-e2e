#!/usr/bin/env python3
"""Security launcher for live Zed consumer-graph enumeration.

The graph implementation intentionally supports arbitrary registry URLs for local
and fixture use. Live CI may attach a bearer token, so this launcher binds that
token to an explicit origin and installs a same-origin redirect policy before
handing control to ``zed_consumer_graph``.
"""

from __future__ import annotations

import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping, Sequence

import zed_consumer_graph


class LiveRegistrySecurityError(ValueError):
    """Raised when live registry configuration could expose credentials."""


def normalized_origin(url: str) -> str:
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise LiveRegistrySecurityError("registry URL must be an absolute http(s) URL")
    if parsed.username is not None or parsed.password is not None:
        raise LiveRegistrySecurityError("registry URL must not contain userinfo")
    if parsed.query or parsed.fragment:
        raise LiveRegistrySecurityError("registry URL must not contain a query or fragment")
    host = parsed.hostname.lower()
    if parsed.scheme == "http" and host not in {"localhost", "127.0.0.1", "::1"}:
        raise LiveRegistrySecurityError("live registry must use HTTPS except for an explicit loopback canary")
    default_port = 443 if parsed.scheme == "https" else 80
    port = parsed.port or default_port
    host_text = f"[{host}]" if ":" in host else host
    suffix = "" if port == default_port else f":{port}"
    return f"{parsed.scheme.lower()}://{host_text}{suffix}"


def option_value(argv: Sequence[str], name: str, default: str | None = None) -> str | None:
    for index, value in enumerate(argv):
        if value == name:
            if index + 1 >= len(argv):
                raise LiveRegistrySecurityError(f"{name} requires a value")
            return argv[index + 1]
        prefix = name + "="
        if value.startswith(prefix):
            return value[len(prefix) :]
    return default


def validate_live_registry(argv: Sequence[str], environ: Mapping[str, str]) -> str | None:
    registry_url = option_value(argv, "--registry-url")
    if registry_url is None:
        return None
    origin = normalized_origin(registry_url)
    token_env = option_value(argv, "--token-env", "ZED_REGISTRY_TOKEN")
    assert token_env is not None
    token = environ.get(token_env, "")
    if token:
        origin_env = f"{token_env}_ORIGIN"
        configured = environ.get(origin_env, "")
        if not configured:
            raise LiveRegistrySecurityError(
                f"{origin_env} is required whenever {token_env} contains a bearer token"
            )
        configured_origin = normalized_origin(configured)
        if configured_origin != origin:
            raise LiveRegistrySecurityError(
                f"registry origin {origin!r} does not match credential-bound {origin_env}={configured_origin!r}"
            )
    return origin


class SameOriginRedirectHandler(urllib.request.HTTPRedirectHandler):
    def __init__(self, allowed_origin: str) -> None:
        super().__init__()
        self.allowed_origin = allowed_origin

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[override]
        candidate = urllib.parse.urljoin(req.full_url, newurl)
        try:
            candidate_origin = normalized_origin(candidate)
        except LiveRegistrySecurityError as exc:
            raise urllib.error.HTTPError(req.full_url, code, str(exc), headers, fp) from exc
        if candidate_origin != self.allowed_origin:
            raise urllib.error.HTTPError(
                req.full_url,
                code,
                f"cross-origin registry redirect blocked: {candidate_origin} != {self.allowed_origin}",
                headers,
                fp,
            )
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def main(argv: Sequence[str] | None = None) -> int:
    effective_argv = list(sys.argv[1:] if argv is None else argv)
    try:
        origin = validate_live_registry(effective_argv, os.environ)
    except LiveRegistrySecurityError as exc:
        print(f"secure-zed-consumer-graph: {exc}", file=sys.stderr)
        return 2
    if origin is not None:
        urllib.request.install_opener(
            urllib.request.build_opener(SameOriginRedirectHandler(origin))
        )
    return zed_consumer_graph.main(effective_argv)


if __name__ == "__main__":
    raise SystemExit(main())
