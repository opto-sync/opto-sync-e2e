from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "scripts/canary-incident.py"
SPEC = importlib.util.spec_from_file_location("canary_incident", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def failure_event(
    error: str = "AddressSanitizer: heap-use-after-free at 0x1234",
    run_id: int = 10,
) -> dict:
    return {
        "repository": "opto-sync/syncer.c",
        "workflow": "Fuzz and leak canary",
        "event": "schedule",
        "conclusion": "failure",
        "runId": run_id,
        "runUrl": f"https://github.com/opto-sync/syncer.c/actions/runs/{run_id}",
        "headSha": "a" * 40,
        "startedAt": "2026-07-28T05:23:00Z",
        "completedAt": "2026-07-28T05:25:00Z",
        "job": "fuzz",
        "step": "Run all fuzzers plus dedicated leak passes",
        "error": error,
    }


class CanaryIncidentTests(unittest.TestCase):
    def test_normalization_deduplicates_addresses_shas_and_run_numbers(self) -> None:
        first = MODULE.classify(failure_event())
        second = failure_event(
            "AddressSanitizer: heap-use-after-free at 0xDEADBEEF "
            + "b" * 40
            + " run 999"
        )
        classified_second = MODULE.classify(second)
        self.assertEqual(first["signature"], classified_second["signature"])
        self.assertEqual(first["priority"], "urgent")

    def test_repeated_scheduled_failure_updates_one_incident(self) -> None:
        created = MODULE.reduce_state({"incident": None, "event": failure_event()})
        self.assertEqual(created["action"], "create")
        updated = MODULE.reduce_state(
            {
                "incident": created["incident"],
                "event": failure_event(run_id=11),
            }
        )
        self.assertEqual(updated["action"], "update")
        self.assertEqual(updated["incident"]["occurrences"], 2)

    def test_materially_different_failure_creates_a_new_signature(self) -> None:
        first = MODULE.classify(failure_event())
        second = MODULE.classify(
            failure_event("protocol mismatch: server schema 1 client schema 3")
        )
        self.assertNotEqual(first["signature"], second["signature"])
        self.assertEqual(second["priority"], "high")

    def test_only_scheduled_success_recovers(self) -> None:
        created = MODULE.reduce_state({"incident": None, "event": failure_event()})
        manual_success = failure_event()
        manual_success.update(
            {
                "event": "workflow_dispatch",
                "conclusion": "success",
                "runId": 12,
                "error": "",
            }
        )
        evidence = MODULE.reduce_state(
            {"incident": created["incident"], "event": manual_success}
        )
        self.assertEqual(evidence["action"], "record_manual_success_evidence")
        self.assertEqual(evidence["incident"]["state"], "open")

        scheduled_success = dict(manual_success)
        scheduled_success["event"] = "schedule"
        scheduled_success["runId"] = 13
        scheduled_success["completedAt"] = "2026-07-29T05:25:00Z"
        recovered = MODULE.reduce_state(
            {"incident": evidence["incident"], "event": scheduled_success}
        )
        self.assertEqual(recovered["action"], "recover")
        self.assertEqual(recovered["incident"]["state"], "recovered")
        self.assertEqual(recovered["incident"]["recoveryRunId"], 13)

    def test_missed_schedule_detection_has_grace_window(self) -> None:
        on_time = MODULE.detect_missed(
            {
                "repository": "opto-sync/opto-sync-e2e",
                "workflow": "Weekly E2E",
                "now": "2026-07-28T06:59:00Z",
                "lastScheduledRunAt": "2026-07-27T05:00:00Z",
                "intervalMinutes": 1440,
                "graceMinutes": 120,
            }
        )
        self.assertFalse(on_time["missed"])

        late = MODULE.detect_missed(
            {
                "repository": "opto-sync/opto-sync-e2e",
                "workflow": "Weekly E2E",
                "now": "2026-07-28T07:01:00Z",
                "lastScheduledRunAt": "2026-07-27T05:00:00Z",
                "intervalMinutes": 1440,
                "graceMinutes": 120,
            }
        )
        self.assertTrue(late["missed"])
        self.assertEqual(late["event"]["event"], "missed")

    def test_non_scheduled_failure_does_not_create_incident(self) -> None:
        event = failure_event()
        event["event"] = "pull_request"
        result = MODULE.reduce_state({"incident": None, "event": event})
        self.assertEqual(result["action"], "record_non_scheduled_failure_evidence")
        self.assertIsNone(result["incident"])


if __name__ == "__main__":
    unittest.main()
