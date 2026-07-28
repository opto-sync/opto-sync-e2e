#!/usr/bin/env python3
"""CLI for protected opto-sync canary monitoring and Linear delivery."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from canary_delivery_common import (  # noqa: E402
    INCIDENT,
    ROOT,
    iso_now,
    load_json,
    validate_config,
    fail,
)
from canary_delivery_github import GitHubAPI, monitor  # noqa: E402
from canary_delivery_linear import (  # noqa: E402
    DryRunLinear,
    LinearGraphQL,
    apply_event,
    controlled_drill,
)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "command",
        choices=("validate-config", "dry-run", "deliver", "apply", "drill"),
    )
    parser.add_argument(
        "--config",
        type=Path,
        default=ROOT / "operations/canary-workflows.v1.json",
    )
    parser.add_argument("--now", default=None)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    config = load_json(args.config)
    validate_config(config)
    if args.command == "validate-config":
        print(
            f"canary delivery config ok: "
            f"{len(config['workflows'])} monitored workflows"
        )
        return 0

    if args.command == "drill":
        linear = LinearGraphQL(os.environ.get("LINEAR_API_KEY", ""))
        github_run_id = os.environ.get("GITHUB_RUN_ID", "")
        if not github_run_id.isdigit():
            fail("GITHUB_RUN_ID is required for the controlled drill")
        run_url = os.environ.get("GITHUB_RUN_URL") or (
            f"{os.environ.get('GITHUB_SERVER_URL', 'https://github.com')}/"
            f"{os.environ.get('GITHUB_REPOSITORY', 'opto-sync/opto-sync-e2e')}/"
            f"actions/runs/{github_run_id}"
        )
        head_sha = os.environ.get("GITHUB_SHA", "")
        if not re.fullmatch(r"[0-9a-f]{40}", head_sha):
            fail("GITHUB_SHA must be a 40-hex commit for the controlled drill")
        output = controlled_drill(
            linear,
            config,
            run_id=int(github_run_id),
            run_url=run_url,
            head_sha=head_sha,
            occurred_at=args.now or iso_now(),
        )
        json.dump(output, sys.stdout, indent=2, sort_keys=True)
        sys.stdout.write("\n")
        return 0

    if args.command == "apply":
        try:
            raw_event = json.load(sys.stdin)
        except json.JSONDecodeError as exc:
            fail(f"invalid event JSON: {exc}")
        if not isinstance(raw_event, dict):
            fail("apply input must be an event object")
        linear = (
            DryRunLinear()
            if args.dry_run
            else LinearGraphQL(os.environ.get("LINEAR_API_KEY", ""))
        )
        output = apply_event(
            linear, raw_event, config, dry_run=args.dry_run
        )
        json.dump(
            {"schemaVersion": 1, "actions": output},
            sys.stdout,
            indent=2,
            sort_keys=True,
        )
        sys.stdout.write("\n")
        return 0

    now = args.now or iso_now()
    INCIDENT.parse_time(now)
    github = GitHubAPI(os.environ.get("GITHUB_TOKEN"))
    dry_run = args.command == "dry-run"
    linear = (
        DryRunLinear()
        if dry_run
        else LinearGraphQL(os.environ.get("LINEAR_API_KEY", ""))
    )
    output = monitor(
        config, github, linear, now=now, dry_run=dry_run
    )
    json.dump(output, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
