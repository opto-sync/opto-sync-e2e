from __future__ import annotations

import email.message
import importlib.util
import io
import sys
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/audit-syncer-publication-outcome.py"
SPEC = importlib.util.spec_from_file_location(
    "syncer_publication_download_security", SCRIPT
)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class Response:
    def __init__(self, data: bytes, *, content_length: str | None = None):
        self._data = data
        self.headers: dict[str, str] = {}
        if content_length is not None:
            self.headers["Content-Length"] = content_length

    def read(self, amount: int = -1) -> bytes:
        if amount < 0:
            return self._data
        return self._data[:amount]

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False


class RedirectingOpener:
    def __init__(self, location: str):
        self.location = location
        self.api_request = None

    def open(self, request, timeout=0):
        self.api_request = request
        headers = email.message.Message()
        headers["Location"] = self.location
        raise urllib.error.HTTPError(
            request.full_url,
            302,
            "Found",
            headers,
            None,
        )


class SyncerPublicationDownloadSecurityTests(unittest.TestCase):
    def test_redirect_request_is_https_and_contains_no_authorization(self):
        request = MODULE.artifact_redirect_request(
            "https://objects.example.invalid/signed-locks.zip?signature=redacted"
        )
        self.assertTrue(request.full_url.startswith("https://"))
        headers = {key.lower(): value for key, value in request.header_items()}
        self.assertNotIn("authorization", headers)
        self.assertEqual(headers["accept"], "application/octet-stream")
        self.assertIn("user-agent", headers)

    def test_insecure_relative_or_userinfo_redirects_fail(self):
        for location in (
            "http://objects.example.invalid/locks.zip",
            "/relative/locks.zip",
            "https://user:password@objects.example.invalid/locks.zip",
            "file:///tmp/locks.zip",
            "",
        ):
            with self.subTest(location=location):
                with self.assertRaises(MODULE.AuditError):
                    MODULE.artifact_redirect_request(location)

    def test_bounded_read_accepts_small_nonempty_response(self):
        data = MODULE.bounded_read(
            Response(b"PK\x03\x04fixture", content_length="11"),
            max_bytes=64,
        )
        self.assertEqual(data, b"PK\x03\x04fixture")

    def test_bounded_read_rejects_invalid_large_empty_and_stream_overflow(self):
        cases = (
            Response(b"x", content_length="not-an-int"),
            Response(b"x", content_length="65"),
            Response(b"", content_length="0"),
            Response(b"x" * 65),
        )
        for response in cases:
            with self.subTest(headers=response.headers, size=len(response._data)):
                with self.assertRaises(MODULE.AuditError):
                    MODULE.bounded_read(response, max_bytes=64)

    def test_get_bytes_authenticates_only_to_github_api(self):
        location = "https://objects.example.invalid/signed-locks.zip?signature=redacted"
        opener = RedirectingOpener(location)
        signed_requests = []

        def signed_urlopen(request, timeout=0):
            signed_requests.append(request)
            return Response(b"PK\x03\x04", content_length="4")

        client = MODULE.GitHubClient(
            "test-token-that-must-not-cross-the-redirect",
            api_url="https://api.github.invalid",
            max_artifact_bytes=64,
        )
        with mock.patch.object(
            MODULE.urllib.request,
            "build_opener",
            return_value=opener,
        ), mock.patch.object(
            MODULE.urllib.request,
            "urlopen",
            side_effect=signed_urlopen,
        ):
            data = client.get_bytes(
                "/repos/opto-sync/syncer.c/actions/artifacts/123/zip"
            )

        self.assertEqual(data, b"PK\x03\x04")
        self.assertIsNotNone(opener.api_request)
        api_headers = {
            key.lower(): value for key, value in opener.api_request.header_items()
        }
        self.assertIn("authorization", api_headers)
        self.assertTrue(api_headers["authorization"].startswith("Bearer "))
        self.assertEqual(len(signed_requests), 1)
        signed_headers = {
            key.lower(): value for key, value in signed_requests[0].header_items()
        }
        self.assertNotIn("authorization", signed_headers)
        self.assertEqual(signed_requests[0].full_url, location)

    def test_nonredirect_api_failure_is_bounded_and_redacted(self):
        class FailingOpener:
            def open(self, request, timeout=0):
                raise urllib.error.HTTPError(
                    request.full_url,
                    403,
                    "Forbidden secret response body is ignored",
                    email.message.Message(),
                    io.BytesIO(b"private response content"),
                )

        client = MODULE.GitHubClient(
            "secret-test-token",
            api_url="https://api.github.invalid",
            max_artifact_bytes=64,
        )
        with mock.patch.object(
            MODULE.urllib.request,
            "build_opener",
            return_value=FailingOpener(),
        ):
            with self.assertRaises(MODULE.GitHubApiError) as captured:
                client.get_bytes(
                    "/repos/opto-sync/syncer.c/actions/artifacts/123/zip"
                )
        text = str(captured.exception).lower()
        self.assertIn("http 403", text)
        self.assertNotIn("secret-test-token", text)
        self.assertNotIn("private response", text)
        self.assertNotIn("authorization", text)

    def test_signed_storage_failure_does_not_expose_signed_url(self):
        location = "https://objects.example.invalid/locks.zip?signature=do-not-log"
        opener = RedirectingOpener(location)

        def storage_failure(request, timeout=0):
            raise urllib.error.HTTPError(
                request.full_url,
                500,
                "Storage failure",
                email.message.Message(),
                io.BytesIO(b"private storage response"),
            )

        client = MODULE.GitHubClient(
            "secret-test-token",
            api_url="https://api.github.invalid",
            max_artifact_bytes=64,
        )
        with mock.patch.object(
            MODULE.urllib.request,
            "build_opener",
            return_value=opener,
        ), mock.patch.object(
            MODULE.urllib.request,
            "urlopen",
            side_effect=storage_failure,
        ):
            with self.assertRaises(RuntimeError) as captured:
                client.get_bytes(
                    "/repos/opto-sync/syncer.c/actions/artifacts/123/zip"
                )
        text = str(captured.exception)
        self.assertEqual(
            text,
            "artifact storage returned HTTP 500 for the signed download",
        )
        self.assertNotIn("do-not-log", text)
        self.assertNotIn("objects.example.invalid", text)


if __name__ == "__main__":
    unittest.main()
