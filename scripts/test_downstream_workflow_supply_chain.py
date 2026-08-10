#!/usr/bin/env python3
"""Regression tests for downstream workflow supply-chain enforcement."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from check_downstream_workflow_supply_chain import check

SHA = "a" * 40
DIGEST = "b" * 64


class WorkflowSupplyChainTests(unittest.TestCase):
    def check_fixture(self, workflow: str) -> list[str]:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workflows = root / ".github" / "workflows"
            workflows.mkdir(parents=True)
            (workflows / "ci.yml").write_text(workflow, encoding="utf-8")
            failures, _, _ = check(root)
            return failures

    def test_accepts_pinned_actions_digest_and_inline_checkout_opt_out(self) -> None:
        failures = self.check_fixture(
            f"""jobs:
  test:
    steps:
      - uses: actions/checkout@{SHA}
        with: {{persist-credentials: false}}
      - uses: example/action@{SHA}
      - uses: docker://example/image@sha256:{DIGEST}
"""
        )
        self.assertEqual(failures, [])

    def test_checkout_after_blank_line_keeps_its_with_block(self) -> None:
        failures = self.check_fixture(
            f"""jobs:
  test:
    steps:
      - run: echo ready

      - uses: actions/checkout@{SHA}
        with:
          persist-credentials: false
"""
        )
        self.assertEqual(failures, [])

    def test_rejects_moving_action_tag(self) -> None:
        failures = self.check_fixture(
            "jobs:\n  test:\n    steps:\n      - uses: example/action@v1\n"
        )
        self.assertTrue(any("40-hex" in failure for failure in failures))

    def test_rejects_checkout_credential_persistence(self) -> None:
        failures = self.check_fixture(
            f"jobs:\n  test:\n    steps:\n      - uses: actions/checkout@{SHA}\n"
        )
        self.assertTrue(any("persisted credentials" in failure for failure in failures))

    def test_rejects_moving_container_tag(self) -> None:
        failures = self.check_fixture(
            "jobs:\n  test:\n    steps:\n      - uses: docker://example/image:latest\n"
        )
        self.assertTrue(any("sha256" in failure for failure in failures))


if __name__ == "__main__":
    unittest.main()
