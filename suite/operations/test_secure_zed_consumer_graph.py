from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path
from unittest import mock

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
    def test_normalizes_https_and_loopback_origins(self) -> None:
        self.assertEqual(
            secure.normalized_origin("https://REGISTRY.example.test:443/v1/"),
            "https://registry.example.test",
        )
        self.assertEqual(
            secure.normalized_origin("http://[::1]:8080/v1"),
            "http://[::1]:8080",
        )

    def test_reuses_underlying_fail_closed_url_policy(self) -> None:
        for value in (
            "https://user:secret@registry.example.test",
            "http://registry.example.test",
            "https://registry.example.test/v1?redirect=https://evil.example",
            "https://registry.example.test/v1#fragment",
        ):
            with self.subTest(value=value), self.assertRaises(secure.LiveRegistrySecurityError):
                secure.normalized_origin(value)

    def test_rejects_duplicate_and_invalid_cli_options(self) -> None:
        with self.assertRaisesRegex(secure.LiveRegistrySecurityError, "must not be repeated"):
            secure.option_value(
                ["--registry-url", "https://one.example", "--registry-url=https://two.example"],
                "--registry-url",
            )
        with self.assertRaisesRegex(secure.LiveRegistrySecurityError, "requires a value"):
            secure.option_value(["--registry-url", "--token-env", "TOKEN"], "--registry-url")
        with self.assertRaisesRegex(secure.LiveRegistrySecurityError, "valid environment"):
            secure.validate_live_registry(
                ["--registry-url", "https://registry.example", "--token-env", "BAD-NAME"],
                {},
            )

    def test_bearer_token_requires_exact_bound_origin(self) -> None:
        argv = ["--registry-url", "https://registry.example.test/v1", "--token-env", "ZED_TOKEN"]
        with self.assertRaises(secure.LiveRegistrySecurityError):
            secure.validate_live_registry(argv, {"ZED_TOKEN": "secret"})
        with self.assertRaises(secure.LiveRegistrySecurityError):
            secure.validate_live_registry(
                argv,
                {"ZED_TOKEN": "secret", "ZED_TOKEN_ORIGIN": "https://other.example.test"},
            )
        with self.assertRaisesRegex(secure.LiveRegistrySecurityError, "scheme, host"):
            secure.validate_live_registry(
                argv,
                {
                    "ZED_TOKEN": "secret",
                    "ZED_TOKEN_ORIGIN": "https://registry.example.test/v1",
                },
            )
        self.assertEqual(
            secure.validate_live_registry(
                argv,
                {
                    "ZED_TOKEN": "secret",
                    "ZED_TOKEN_ORIGIN": "https://registry.example.test",
                },
            ),
            "https://registry.example.test",
        )

    def test_main_does_not_install_process_global_redirect_policy(self) -> None:
        with (
            mock.patch.object(secure, "validate_live_registry", return_value="https://registry.example"),
            mock.patch.object(secure.zed_consumer_graph, "main", return_value=0) as graph_main,
            mock.patch("urllib.request.install_opener") as install_opener,
        ):
            self.assertEqual(secure.main(["--registry-url", "https://registry.example"]), 0)
        install_opener.assert_not_called()
        graph_main.assert_called_once_with(["--registry-url", "https://registry.example"])


if __name__ == "__main__":
    unittest.main()
