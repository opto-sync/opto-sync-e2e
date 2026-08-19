from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
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

    def test_validates_zed_graph_transport_headers(self):
        payload = json.loads((FIXTURES / "inventory.json").read_text())
        graph = payload["packages"][1]["versions"][0]["graph"]
        digest = graph["graph_digest"]
        zed_consumer_graph.validate_graph_transport(
            graph,
            {
                "x-zpkg-graph-digest": digest,
                "etag": '"representation-sha256"',
                "vary": "Accept, Authorization",
            },
            "fixture",
        )
        with self.assertRaisesRegex(zed_consumer_graph.ContractError, "does not match"):
            zed_consumer_graph.validate_graph_transport(
                graph,
                {
                    "x-zpkg-graph-digest": "sha256:" + "f" * 64,
                    "etag": '"representation-sha256"',
                    "vary": "Accept",
                },
                "fixture",
            )
        with self.assertRaisesRegex(zed_consumer_graph.ContractError, "strong quoted ETag"):
            zed_consumer_graph.validate_graph_transport(
                graph,
                {
                    "x-zpkg-graph-digest": digest,
                    "etag": 'W/"representation-sha256"',
                    "vary": "Accept",
                },
                "fixture",
            )

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
