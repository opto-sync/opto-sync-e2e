#!/usr/bin/env python3
"""Reject mutable Actions dependencies and persisted checkout credentials."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

SHA = re.compile(r"[0-9a-f]{40}")
REMOTE_USE = re.compile(
    r"(?m)^(?P<indent>[ \t]*)(?:-\s*)?uses:\s*['\"]?(?P<uses>[^'\"\s#]+)"
)
STEP = re.compile(r"^(?P<indent>\s*)-\s+")


def _step_block(lines: list[str], use_index: int) -> str:
    """Return the list-item block that owns a checkout `uses` line."""
    use_indent = len(lines[use_index]) - len(lines[use_index].lstrip())
    start = use_index
    step_indent: int | None = None
    for index in range(use_index, -1, -1):
        match = STEP.match(lines[index])
        if match and len(match.group("indent")) <= use_indent:
            start = index
            step_indent = len(match.group("indent"))
            break
    if step_indent is None:
        return lines[use_index]

    end = len(lines)
    for index in range(start + 1, len(lines)):
        match = STEP.match(lines[index])
        if match and len(match.group("indent")) <= step_indent:
            end = index
            break
    return "\n".join(lines[start:end])


def check(root: Path) -> tuple[list[str], int, int]:
    failures: list[str] = []
    remote_actions = 0
    checkouts = 0
    workflows = root / ".github" / "workflows"
    paths = sorted((*workflows.glob("*.yml"), *workflows.glob("*.yaml")))
    if not paths:
        return [f"{workflows}: no workflows found"], 0, 0

    for path in paths:
        text = path.read_text(encoding="utf-8")
        lines = text.splitlines()
        for match in REMOTE_USE.finditer(text):
            uses = match.group("uses")
            if uses.startswith("./"):
                continue
            if uses.startswith("docker://"):
                if not re.search(r"@sha256:[0-9a-f]{64}$", uses):
                    failures.append(f"{path}: container must use a sha256 digest: {uses}")
                continue

            remote_actions += 1
            ref = uses.rsplit("@", 1)[-1] if "@" in uses else ""
            if not SHA.fullmatch(ref):
                failures.append(f"{path}: remote action must use a 40-hex commit: {uses}")

            if uses.startswith("actions/checkout@"):
                checkouts += 1
                use_index = text[: match.start()].count("\n")
                block = _step_block(lines, use_index)
                if not re.search(r"persist-credentials\s*:\s*false", block):
                    failures.append(
                        f"{path}:{use_index + 1}: checkout must disable persisted credentials"
                    )

    return failures, remote_actions, checkouts


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path.cwd())
    args = parser.parse_args()
    failures, remote_actions, checkouts = check(args.root.resolve())
    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    print(
        "downstream workflow supply chain passed: "
        f"{remote_actions} remote actions pinned; "
        f"{checkouts} checkouts disable persisted credentials"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
