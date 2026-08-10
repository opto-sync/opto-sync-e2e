from __future__ import annotations

import base64
import copy
import importlib.util
import json
import unittest
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/audit-final-zed-package-plane-pins.py"
CONTRACT_PATH = ROOT / "operations/zed-package-plane-contract.v1.json"
FLEET_PATH = ROOT / "operations/downstream-wrapper-fleet.v1.json"
SPEC = importlib.util.spec_from_file_location("final_zed_package_plane_pins", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
CONTRACT = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
FLEET = json.loads(FLEET_PATH.read_text(encoding="utf-8"))


def workflow_text(
    *,
    cli: str | None = None,
    interfaces: str | None = None,
    frozen: bool = True,
    cargo_locked: bool = True,
) -> str:
    cli = cli or CONTRACT["requiredWorkflowVariables"]["ZED_CLI_SHA"]
    interfaces = interfaces or CONTRACT["requiredWorkflowVariables"]["ZED_INTERFACES_SHA"]
    lines = [
        "name: opto-sync adoption",
        "env:",
        f"  ZED_CLI_SHA: {cli}",
        f"  ZED_INTERFACES_SHA: {interfaces}",
        "jobs:",
        "  live:",
        "    steps:",
    ]
    if cargo_locked:
        lines.append(
            "      - run: cargo build --locked --release --manifest-path .tools/zed-cli/Cargo.toml --bin zed"
        )
    if frozen:
        lines.append(
            "      - run: zed install --frozen --install-mode copy"
        )
    return "\n".join(lines) + "\n"


class FixtureClient:
    def __init__(self, targets: list[dict[str, Any]], text: str | None = None):
        self.values = {
            (target["repository"], target["path"], target["branch"]): text
            or workflow_text()
            for target in targets
        }

    def read_text(self, repository: str, path: str, ref: str) -> str:
        value = self.values[(repository, path, ref)]
        if isinstance(value, Exception):
            raise value
        return value


class FinalZedPackagePlanePinTests(unittest.TestCase):
    def test_contract_produces_exact_17_wrapper_and_17_e2e_targets(self):
        targets = MODULE.validate_contract(copy.deepcopy(CONTRACT), copy.deepcopy(FLEET))
        self.assertEqual(len(targets), 34)
        self.assertEqual(sum(item["kind"] == "wrapper" for item in targets), 17)
        self.assertEqual(sum(item["kind"] == "e2e" for item in targets), 17)
        self.assertEqual(len({(item["repository"], item["path"]) for item in targets}), 34)
        wave_a = [item for item in targets if item["kind"] == "e2e" and item["wave"] == "A"]
        self.assertTrue(wave_a)
        self.assertTrue(
            all(item["path"] == ".github/workflows/opto-sync-adoption.yml" for item in wave_a)
        )
        later = [item for item in targets if item["kind"] == "e2e" and item["wave"] in {"B", "C"}]
        self.assertTrue(
            all(item["path"] == ".github/workflows/opto-sync-wrapper-e2e.yml" for item in later)
        )

    def test_valid_workflow_text_requires_exact_single_assignments(self):
        target = {"repository": "example/project", "path": "workflow.yml", "branch": "agent/test"}
        self.assertEqual(MODULE.validate_workflow_text(workflow_text(), CONTRACT, target), [])

        duplicate = workflow_text() + (
            f"ZED_CLI_SHA: {CONTRACT['requiredWorkflowVariables']['ZED_CLI_SHA']}\n"
        )
        errors = MODULE.validate_workflow_text(duplicate, CONTRACT, target)
        self.assertTrue(any("assignments" in error for error in errors))

    def test_stale_cli_interface_and_strict_only_pins_fail(self):
        target = {"repository": "example/project", "path": "workflow.yml", "branch": "agent/test"}
        stale_cli = CONTRACT["forbiddenPins"][0]
        stale_interface = CONTRACT["zedInterfaces"]["strictParserSha"]
        text = workflow_text(cli=stale_cli, interfaces=stale_interface)
        errors = MODULE.validate_workflow_text(text, CONTRACT, target)
        self.assertTrue(any("ZED_CLI_SHA" in error for error in errors))
        self.assertTrue(any("ZED_INTERFACES_SHA" in error for error in errors))
        self.assertTrue(any(stale_cli in error for error in errors))
        self.assertTrue(any(stale_interface in error for error in errors))

    def test_missing_frozen_install_or_locked_build_fails(self):
        target = {"repository": "example/project", "path": "workflow.yml", "branch": "agent/test"}
        errors = MODULE.validate_workflow_text(
            workflow_text(frozen=False, cargo_locked=False),
            CONTRACT,
            target,
        )
        self.assertIn("workflow lacks frozen copy-mode installation", errors)
        self.assertIn("workflow does not build the pinned Zed CLI with Cargo --locked", errors)

    def test_contract_rejects_cli_interface_mismatch_and_final_pin_in_denylist(self):
        mismatch = copy.deepcopy(CONTRACT)
        mismatch["zedCli"]["interfaceDependencySha"] = "1" * 40
        with self.assertRaisesRegex(MODULE.PinAuditError, "dependency SHA"):
            MODULE.validate_contract(mismatch, FLEET)

        forbidden = copy.deepcopy(CONTRACT)
        forbidden["forbiddenPins"].append(forbidden["zedCli"]["sha"])
        with self.assertRaisesRegex(MODULE.PinAuditError, "cannot be forbidden"):
            MODULE.validate_contract(forbidden, FLEET)

    def test_contract_rejects_removed_wrapper_or_unexpected_e2e_status(self):
        missing = copy.deepcopy(FLEET)
        missing["wrappers"].pop()
        with self.assertRaisesRegex(MODULE.PinAuditError, "exactly 17"):
            MODULE.validate_contract(CONTRACT, missing)

        bad_status = copy.deepcopy(FLEET)
        bad_status["wrappers"][0]["e2e"]["status"] = "done"
        with self.assertRaisesRegex(MODULE.PinAuditError, "unsupported E2E status"):
            MODULE.validate_contract(CONTRACT, bad_status)

    def test_complete_mocked_live_audit_passes_34_targets(self):
        targets = MODULE.validate_contract(CONTRACT, FLEET)
        report = MODULE.audit(CONTRACT, targets, FixtureClient(targets))
        self.assertEqual(
            report["summary"],
            {"targets": 34, "passed": 34, "failed": 0},
        )
        self.assertTrue(report["readOnly"])
        self.assertTrue(all(entry["passed"] for entry in report["entries"]))

    def test_one_stale_branch_is_reported_without_leaking_content(self):
        targets = MODULE.validate_contract(CONTRACT, FLEET)
        client = FixtureClient(targets)
        first = targets[0]
        client.values[(first["repository"], first["path"], first["branch"])] = workflow_text(
            cli=CONTRACT["forbiddenPins"][0]
        )
        report = MODULE.audit(CONTRACT, targets, client)
        self.assertEqual(report["summary"]["failed"], 1)
        failed = next(entry for entry in report["entries"] if not entry["passed"])
        self.assertEqual(failed["repository"], first["repository"])
        serialized = json.dumps(failed).lower()
        self.assertNotIn("authorization", serialized)
        self.assertNotIn("bearer", serialized)

    def test_api_404_is_bounded_to_status_and_resource(self):
        targets = MODULE.validate_contract(CONTRACT, FLEET)
        client = FixtureClient(targets)
        first = targets[0]
        resource = "/repos/example/project/contents/workflow"
        client.values[(first["repository"], first["path"], first["branch"])] = MODULE.GitHubApiError(
            404, resource
        )
        report = MODULE.audit(CONTRACT, targets, client)
        failed = next(entry for entry in report["entries"] if not entry["passed"])
        self.assertEqual(failed["httpStatus"], 404)
        self.assertEqual(failed["errors"], [f"GitHub API returned HTTP 404 for {resource}"])


if __name__ == "__main__":
    unittest.main()
