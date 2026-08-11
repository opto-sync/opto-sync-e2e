#!/usr/bin/env python3
from __future__ import annotations

import json
from itertools import product
from pathlib import Path

MANIFEST = Path("compatibility/engine-store-transport.v1.json")


def fail(message: str) -> None:
    raise SystemExit(f"capability manifest invalid: {message}")


def main() -> None:
    data = json.loads(MANIFEST.read_text())
    if data.get("manifestVersion") != 1:
        fail("manifestVersion must be 1")
    if data.get("linearIssue") != "DEN-821":
        fail("manifest must remain bound to DEN-821")
    if data.get("releasePromotionRequiresAllRequiredCertified") is not True:
        fail("release promotion must fail closed")

    engines = data.get("engines")
    stores = data.get("stores")
    transports = data.get("transports")
    if engines != ["rust", "c"]:
        fail("engines must be exactly rust and c")
    if stores != ["indexeddb", "sqlite", "postgres", "supabase"]:
        fail("store matrix changed without contract review")
    if transports != ["http", "websocket", "tcp"]:
        fail("transport matrix changed without contract review")

    allowed_states = {"required_unverified", "certified", "unsupported"}
    expected = set(product(engines, stores, transports))
    seen: set[tuple[str, str, str]] = set()

    for row in data.get("matrix", []):
        key = (row.get("engine"), row.get("store"), row.get("transport"))
        if key not in expected:
            fail(f"unknown combination {key}")
        if key in seen:
            fail(f"duplicate combination {key}")
        seen.add(key)
        state = row.get("state")
        if state not in allowed_states:
            fail(f"invalid state {state!r} for {key}")
        evidence = row.get("evidence", [])
        if state == "required_unverified" and evidence:
            fail(f"unverified combination {key} cannot carry evidence")
        if state == "unsupported":
            if not isinstance(row.get("reason"), str) or not row["reason"].strip():
                fail(f"unsupported combination {key} needs a reason")
            if evidence:
                fail(f"unsupported combination {key} cannot carry certification evidence")
        if state == "certified":
            if not isinstance(evidence, list) or not evidence:
                fail(f"certified combination {key} needs evidence")
            required = {"source_sha", "workflow_run", "seed_or_fixture", "observable_state_digest"}
            for item in evidence:
                if not isinstance(item, dict) or set(item) != required:
                    fail(f"certification evidence for {key} must have exactly {sorted(required)}")
                if len(str(item["source_sha"])) != 40:
                    fail(f"source_sha for {key} is not an immutable commit")
                if not str(item["workflow_run"]).isdigit():
                    fail(f"workflow_run for {key} must be numeric")
                digest = str(item["observable_state_digest"])
                if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
                    fail(f"observable_state_digest for {key} must be lowercase sha256")

        if key[1] == "indexeddb" and key[2] == "tcp" and state != "unsupported":
            fail("browser IndexedDB/TCP must remain unsupported")
        if key[1] == "supabase" and key[2] == "tcp" and state != "unsupported":
            fail("Supabase raw-TCP certification is outside the approved API/Realtime boundary")

    missing = expected - seen
    if missing:
        fail(f"implicit/missing combinations: {sorted(missing)}")
    if seen - expected:
        fail("unexpected combinations present")

    scenarios = data.get("requiredScenarios", [])
    if len(scenarios) != len(set(scenarios)) or len(scenarios) < 10:
        fail("required scenario corpus is missing or duplicated")

    print(f"validated {len(seen)} explicit engine/store/transport combinations; release gate remains fail-closed")


if __name__ == "__main__":
    main()
