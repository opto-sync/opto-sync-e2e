from __future__ import annotations

import copy
import importlib.util
import json
import sys
import tempfile
import threading
import unittest
from dataclasses import replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "scripts" / "zed_consumer_graph.py"
FIXTURES = REPO_ROOT / "suite" / "fixtures" / "zed-consumer-graph"

spec = importlib.util.spec_from_file_location("zed_consumer_graph", SCRIPT)
assert spec is not None and spec.loader is not None
zed_consumer_graph = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = zed_consumer_graph
spec.loader.exec_module(zed_consumer_graph)


class ZedConsumerGraphTests(unittest.TestCase):
    maxDiff = None

    def build_report(self):
        inventory = zed_consumer_graph.load_snapshot(
            FIXTURES / "inventory.json",
            version_policy="latest-visible",
        )
        root, curated = zed_consumer_graph.load_curated_fleet(
            FIXTURES / "curated-fleet.json"
        )
        default, classifications = zed_consumer_graph.load_classifications(
            FIXTURES / "classification.json",
            expected_root=root,
            curated=curated,
        )
        return zed_consumer_graph.render_impact(
            inventory,
            root=root,
            curated=curated,
            default_classification=default,
            classifications=classifications,
        )

    def test_discovers_direct_transitive_and_cycle_safe_consumers(self):
        report = self.build_report()
        self.assertEqual(
            report["directConsumers"],
            [
                "cycle/a",
                "newco/new-sync",
                "sonus-auris/sonus-auris-sync",
                "voxletra/voxletra-sync",
            ],
        )
        self.assertEqual(
            report["transitiveConsumers"],
            ["cycle/b", "example/desktop-app"],
        )
        self.assertEqual(report["cycles"], [["cycle/a", "cycle/b"]])
        self.assertEqual(report["summary"]["allDiscoveredConsumers"], 6)

    def test_reconciles_discovery_with_curated_execution_metadata(self):
        report = self.build_report()
        self.assertEqual(
            report["gaps"]["graphOnly"],
            ["cycle/a", "cycle/b", "example/desktop-app", "newco/new-sync"],
        )
        self.assertEqual(report["gaps"]["curatedOnly"], ["zed-pkg/zed-sync"])
        by_repo = {item["repository"]: item for item in report["consumers"]}
        sonus = by_repo["sonus-auris/sonus-auris-sync"]
        self.assertEqual(sonus["coverageStatus"], "graph-confirmed")
        self.assertEqual(sonus["adoptionClassification"], "exact-pin")
        self.assertEqual(sonus["testRepository"], "sonus-auris/sonus-auris-e2e")
        self.assertEqual(
            by_repo["example/desktop-app"]["shortestDependencyToConsumerPath"],
            [
                "opto-sync/opto-sync-clients",
                "sonus-auris/sonus-auris-sync",
                "example/desktop-app",
            ],
        )
        self.assertEqual(
            by_repo["newco/new-sync"]["adoptionClassification"],
            "unclassified",
        )

    def test_output_is_deterministic_and_carries_semantic_scope(self):
        first = self.build_report()
        second = self.build_report()
        self.assertEqual(
            json.dumps(first, sort_keys=True, separators=(",", ":")),
            json.dumps(second, sort_keys=True, separators=(",", ":")),
        )
        self.assertEqual(first["semantics"]["graphView"], "declared")
        self.assertEqual(first["semantics"]["resolution"], "unresolved-requirements")
        self.assertFalse(first["semantics"]["reverseDependentsEndpointUsed"])
        self.assertEqual(
            first["semantics"]["privateCoverage"],
            "graph-fetches-limited-to-caller-authorization",
        )
        self.assertEqual(first["inventory"]["registryId"], "registry:test")
        self.assertRegex(first["inventory"]["inventoryDigest"], r"^sha256:[0-9a-f]{64}$")

    def test_fail_on_policy_rejects_new_untested_consumers(self):
        report = self.build_report()
        with self.assertRaisesRegex(zed_consumer_graph.ContractError, "graph-only"):
            zed_consumer_graph.enforce_failures(report, {"graph-only"})
        with self.assertRaisesRegex(zed_consumer_graph.ContractError, "curated-only"):
            zed_consumer_graph.enforce_failures(report, {"curated-only"})
        with self.assertRaisesRegex(zed_consumer_graph.ContractError, "unclassified"):
            zed_consumer_graph.enforce_failures(report, {"unclassified"})

    def test_dot_and_mermaid_orient_dependency_to_consumer(self):
        report = self.build_report()
        dot = zed_consumer_graph.render_dot(report)
        mermaid = zed_consumer_graph.render_mermaid(report)
        root_id = zed_consumer_graph.dot_id("opto-sync/opto-sync-clients")
        sonus_id = zed_consumer_graph.dot_id("sonus-auris/sonus-auris-sync")
        self.assertIn(f"{root_id} -> {sonus_id}", dot)
        self.assertIn("graph LR", mermaid)
        self.assertIn("runtime ^0.4", mermaid)
        self.assertEqual(zed_consumer_graph.escape_dot('a"\n'), 'a\\"\\n')
        self.assertEqual(
            zed_consumer_graph.escape_mermaid('a|[b]"'),
            'a&#124;&#91;b&#93;&quot;',
        )

    def test_validates_zed_graph_transport_headers(self):
        payload = json.loads((FIXTURES / "inventory.json").read_text())
        graph = payload["packages"][1]["versions"][0]["graph"]
        digest = graph["graph_digest"]
        encoded_length = 123
        protected_headers = {
            "x-zpkg-graph-digest": digest,
            "x-zpkg-graph-authoritative": "true",
            "etag": '"representation-sha256"',
            "content-length": str(encoded_length),
            "cache-control": "private, no-store",
            "vary": "Accept, Authorization",
        }
        zed_consumer_graph.validate_graph_transport(
            graph,
            protected_headers,
            "fixture",
            encoded_length=encoded_length,
        )
        public_headers = {
            **protected_headers,
            "cache-control": "public, max-age=31536000, immutable",
            "vary": "Accept",
        }
        zed_consumer_graph.validate_graph_transport(
            graph,
            public_headers,
            "fixture",
            encoded_length=encoded_length,
        )
        with self.assertRaisesRegex(zed_consumer_graph.ContractError, "does not match"):
            zed_consumer_graph.validate_graph_transport(
                graph,
                {
                    **public_headers,
                    "x-zpkg-graph-digest": "sha256:" + "f" * 64,
                },
                "fixture",
                encoded_length=encoded_length,
            )
        with self.assertRaisesRegex(zed_consumer_graph.ContractError, "strong quoted ETag"):
            zed_consumer_graph.validate_graph_transport(
                graph,
                {**public_headers, "etag": 'W/"representation-sha256"'},
                "fixture",
                encoded_length=encoded_length,
            )
        with self.assertRaisesRegex(zed_consumer_graph.ContractError, "authoritative"):
            headers = dict(public_headers)
            headers.pop("x-zpkg-graph-authoritative")
            zed_consumer_graph.validate_graph_transport(
                graph,
                headers,
                "fixture",
                encoded_length=encoded_length,
            )
        with self.assertRaisesRegex(zed_consumer_graph.ContractError, "Content-Length"):
            zed_consumer_graph.validate_graph_transport(
                graph,
                {**public_headers, "content-length": "122"},
                "fixture",
                encoded_length=encoded_length,
            )
        with self.assertRaisesRegex(zed_consumer_graph.ContractError, "private, no-store"):
            zed_consumer_graph.validate_graph_transport(
                graph,
                {**protected_headers, "cache-control": "public, immutable"},
                "fixture",
                encoded_length=encoded_length,
            )

    def test_registry_url_rejects_userinfo_and_non_loopback_http(self):
        invalid = (
            "https://token@example.com",
            "http://localhost:8080@evil.example",
            "http://example.com",
            "https://example.com?query=1",
            " https://example.com",
            "https://régistry.example",
        )
        for value in invalid:
            with self.subTest(value=value):
                with self.assertRaises(zed_consumer_graph.ContractError):
                    zed_consumer_graph.normalize_registry_url(value)
        self.assertEqual(
            zed_consumer_graph.normalize_registry_url("http://127.0.0.1:8080/"),
            "http://127.0.0.1:8080",
        )
        self.assertEqual(
            zed_consumer_graph.normalize_registry_url("https://REGISTRY.EXAMPLE/v1/"),
            "https://registry.example/v1",
        )

    def test_registry_client_rejects_redirect_without_leaking_bearer(self):
        received_authorization: list[str | None] = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                if self.path == "/redirect":
                    self.send_response(302)
                    self.send_header("Location", "/sink")
                    self.end_headers()
                    return
                received_authorization.append(self.headers.get("Authorization"))
                body = b'{"ok":true}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, _format, *_args):
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            client = zed_consumer_graph.RegistryClient(
                f"http://127.0.0.1:{server.server_port}",
                bearer_token="must-not-leak",
            )
            with self.assertRaisesRegex(zed_consumer_graph.ContractError, "redirects are forbidden"):
                client.get_json("/redirect")
            self.assertEqual(received_authorization, [])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    def test_registry_client_rejects_oversized_response_before_read(self):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", "1024")
                self.end_headers()

            def log_message(self, _format, *_args):
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            client = zed_consumer_graph.RegistryClient(
                f"http://127.0.0.1:{server.server_port}",
                max_response_bytes=32,
            )
            with self.assertRaisesRegex(zed_consumer_graph.ContractError, "safety limit"):
                client.get_json("/large")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


    def test_rejects_graph_root_mismatch_and_invalid_digest(self):
        payload = json.loads((FIXTURES / "inventory.json").read_text())
        graph = payload["packages"][1]["versions"][0]["graph"]
        graph["package"]["name"] = "wrong"
        with self.assertRaisesRegex(zed_consumer_graph.ContractError, "graph root"):
            zed_consumer_graph.parse_declared_graph(
                graph,
                expected=zed_consumer_graph.PackageCoordinate.parse(
                    "sonus-auris/sonus-auris-sync"
                ),
                version="1.0.0",
            )
        graph["package"]["name"] = "sonus-auris-sync"
        graph["graph_digest"] = "sha256:not-a-digest"
        with self.assertRaisesRegex(zed_consumer_graph.ContractError, "invalid graph_digest"):
            zed_consumer_graph.parse_declared_graph(
                graph,
                expected=zed_consumer_graph.PackageCoordinate.parse(
                    "sonus-auris/sonus-auris-sync"
                ),
                version="1.0.0",
            )

    def test_rejects_coordinate_and_registry_identity_injection(self):
        payload = json.loads((FIXTURES / "inventory.json").read_text())
        graph = copy.deepcopy(payload["packages"][1]["versions"][0]["graph"])
        graph["dependencies"][0]["org"] = ".."
        with self.assertRaisesRegex(zed_consumer_graph.ContractError, "normalized package component"):
            zed_consumer_graph.parse_declared_graph(
                graph,
                expected=zed_consumer_graph.PackageCoordinate.parse(
                    "sonus-auris/sonus-auris-sync"
                ),
                version="1.0.0",
                expected_registry_id="registry:test",
            )
        graph = copy.deepcopy(payload["packages"][1]["versions"][0]["graph"])
        graph["dependencies"][0]["registry_id"] = "registry:other"
        with self.assertRaisesRegex(zed_consumer_graph.ContractError, "differs from graph registry"):
            zed_consumer_graph.parse_declared_graph(
                graph,
                expected=zed_consumer_graph.PackageCoordinate.parse(
                    "sonus-auris/sonus-auris-sync"
                ),
                version="1.0.0",
                expected_registry_id="registry:test",
            )

    def test_snapshot_requires_one_registry_identity_and_enforces_limits(self):
        payload = json.loads((FIXTURES / "inventory.json").read_text())
        payload["packages"][1]["versions"][0]["graph"]["package"]["registry_id"] = "registry:other"
        payload["packages"][1]["versions"][0]["graph"]["dependencies"][0]["registry_id"] = "registry:other"
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "inventory.json"
            path.write_text(json.dumps(payload))
            with self.assertRaisesRegex(zed_consumer_graph.ContractError, "differs from inventory registry"):
                zed_consumer_graph.load_snapshot(
                    path,
                    version_policy="latest-visible",
                )
            with self.assertRaisesRegex(zed_consumer_graph.ContractError, "package count"):
                zed_consumer_graph.load_snapshot(
                    FIXTURES / "inventory.json",
                    version_policy="latest-visible",
                    max_packages=1,
                )
            with self.assertRaisesRegex(zed_consumer_graph.ContractError, "edge count"):
                zed_consumer_graph.load_snapshot(
                    FIXTURES / "inventory.json",
                    version_policy="latest-visible",
                    max_edges=1,
                )

    def test_inventory_digest_binds_scope_and_registry_identity(self):
        inventory = zed_consumer_graph.load_snapshot(
            FIXTURES / "inventory.json",
            version_policy="latest-visible",
        )
        root, curated = zed_consumer_graph.load_curated_fleet(
            FIXTURES / "curated-fleet.json"
        )
        default, classifications = zed_consumer_graph.load_classifications(
            FIXTURES / "classification.json",
            expected_root=root,
            curated=curated,
        )
        original = zed_consumer_graph.render_impact(
            inventory,
            root=root,
            curated=curated,
            default_classification=default,
            classifications=classifications,
        )
        changed_scope = zed_consumer_graph.render_impact(
            replace(inventory, inventory_scope="different-scope"),
            root=root,
            curated=curated,
            default_classification=default,
            classifications=classifications,
        )
        changed_registry = zed_consumer_graph.render_impact(
            replace(inventory, registry_id="registry:other"),
            root=root,
            curated=curated,
            default_classification=default,
            classifications=classifications,
        )
        digests = {
            original["inventory"]["inventoryDigest"],
            changed_scope["inventory"]["inventoryDigest"],
            changed_registry["inventory"]["inventoryDigest"],
        }
        self.assertEqual(len(digests), 3)

    def test_cli_rejects_non_finite_timeout(self):
        with tempfile.TemporaryDirectory() as directory:
            exit_code = zed_consumer_graph.main(
                [
                    "--snapshot",
                    str(FIXTURES / "inventory.json"),
                    "--curated-fleet",
                    str(FIXTURES / "curated-fleet.json"),
                    "--classification-policy",
                    str(FIXTURES / "classification.json"),
                    "--output",
                    str(Path(directory) / "impact.json"),
                    "--timeout-seconds",
                    "nan",
                ]
            )
            self.assertEqual(exit_code, 2)

    def test_rejects_incomplete_latest_snapshot(self):
        payload = json.loads((FIXTURES / "inventory.json").read_text())
        payload["packages"][0]["versions"].append(
            payload["packages"][0]["versions"][0]
        )
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "inventory.json"
            path.write_text(json.dumps(payload))
            with self.assertRaisesRegex(zed_consumer_graph.ContractError, "at most one version"):
                zed_consumer_graph.load_snapshot(
                    path,
                    version_policy="latest-visible",
                )

    def test_cli_writes_all_three_artifacts(self):
        with tempfile.TemporaryDirectory() as directory:
            directory_path = Path(directory)
            report_path = directory_path / "impact.json"
            dot_path = directory_path / "impact.dot"
            mermaid_path = directory_path / "impact.mmd"
            exit_code = zed_consumer_graph.main(
                [
                    "--snapshot",
                    str(FIXTURES / "inventory.json"),
                    "--curated-fleet",
                    str(FIXTURES / "curated-fleet.json"),
                    "--classification-policy",
                    str(FIXTURES / "classification.json"),
                    "--output",
                    str(report_path),
                    "--dot-output",
                    str(dot_path),
                    "--mermaid-output",
                    str(mermaid_path),
                ]
            )
            self.assertEqual(exit_code, 0)
            self.assertEqual(json.loads(report_path.read_text())["schema"], "opto-sync/consumer-impact/v1")
            self.assertTrue(dot_path.read_text().startswith("digraph"))
            self.assertTrue(mermaid_path.read_text().startswith("graph LR"))


if __name__ == "__main__":
    unittest.main()
