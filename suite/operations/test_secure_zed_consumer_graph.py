from __future__ import annotations

import importlib.util
import sys
import unittest
import urllib.error
import urllib.request
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "secure_zed_consumer_graph.py"
SCRIPTS = SCRIPT.parent
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location("secure_zed_consumer_graph", SCRIPT)
assert spec and spec.loader
secure = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = secure
spec.loader.exec_module(secure)


class SecureLiveRegistryTests(unittest.TestCase):
    def test_normalizes_https_origin_and_rejects_userinfo(self) -> None:
        self.assertEqual(
            secure.normalized_origin("https://registry.example.test/v1"),
            "https://registry.example.test",
        )
        with self.assertRaises(secure.LiveRegistrySecurityError):
            secure.normalized_origin("https://user:secret@registry.example.test")

    def test_rejects_non_loopback_http(self) -> None:
        with self.assertRaises(secure.LiveRegistrySecurityError):
            secure.normalized_origin("http://registry.example.test")
        self.assertEqual(
            secure.normalized_origin("http://127.0.0.1:8080"),
            "http://127.0.0.1:8080",
        )

    def test_bearer_token_requires_exact_bound_origin(self) -> None:
        argv = ["--registry-url", "https://registry.example.test", "--token-env", "ZED_REGISTRY_TOKEN"]
        with self.assertRaises(secure.LiveRegistrySecurityError):
            secure.validate_live_registry(argv, {"ZED_REGISTRY_TOKEN": "secret"})
        with self.assertRaises(secure.LiveRegistrySecurityError):
            secure.validate_live_registry(
                argv,
                {
                    "ZED_REGISTRY_TOKEN": "secret",
                    "ZED_REGISTRY_TOKEN_ORIGIN": "https://other.example.test",
                },
            )
        self.assertEqual(
            secure.validate_live_registry(
                argv,
                {
                    "ZED_REGISTRY_TOKEN": "secret",
                    "ZED_REGISTRY_TOKEN_ORIGIN": "https://registry.example.test",
                },
            ),
            "https://registry.example.test",
        )

    def test_same_origin_redirect_is_allowed(self) -> None:
        handler = secure.SameOriginRedirectHandler("https://registry.example.test")
        request = urllib.request.Request("https://registry.example.test/v1/packages")
        redirected = handler.redirect_request(
            request,
            None,
            302,
            "Found",
            {},
            "/v1/packages?offset=1",
        )
        self.assertIsNotNone(redirected)
        assert redirected is not None
        self.assertTrue(redirected.full_url.startswith("https://registry.example.test/"))

    def test_cross_origin_redirect_is_blocked_before_header_copy(self) -> None:
        handler = secure.SameOriginRedirectHandler("https://registry.example.test")
        request = urllib.request.Request("https://registry.example.test/v1/packages")
        request.add_header("Authorization", "Bearer must-not-leak")
        with self.assertRaises(urllib.error.HTTPError):
            handler.redirect_request(
                request,
                None,
                302,
                "Found",
                {},
                "https://evil.example.test/steal",
            )


if __name__ == "__main__":
    unittest.main()
