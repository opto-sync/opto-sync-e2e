#!/usr/bin/env python3
"""Write canonical gzip-compressed starter archives for missing E2E repos.

`render-missing-e2e-repository.py` owns the reviewed file tree.  This companion
entrypoint owns the archive representation: sorted file order, fixed tar member
metadata, no directory entries, and a gzip header with mtime zero and no source
filename.  Keeping the concerns separate makes archive determinism easy to
exercise without weakening the repository-tree generator.
"""

from __future__ import annotations

import argparse
import gzip
import importlib.util
import io
import sys
import tarfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
GENERATOR_PATH = ROOT / "scripts/render-missing-e2e-repository.py"
SPEC = importlib.util.spec_from_file_location("missing_e2e_generator", GENERATOR_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"cannot load generator: {GENERATOR_PATH}")
GENERATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GENERATOR)


def canonical_archive_bytes(files: dict[str, bytes], repository: str) -> bytes:
    root_name = repository.split("/", 1)[1]
    tar_bytes = io.BytesIO()
    with tarfile.open(fileobj=tar_bytes, mode="w", format=tarfile.PAX_FORMAT) as handle:
        for relative, content in sorted(files.items()):
            info = tarfile.TarInfo(name=f"{root_name}/{relative}")
            info.size = len(content)
            info.mtime = 0
            info.uid = 0
            info.gid = 0
            info.uname = ""
            info.gname = ""
            info.mode = 0o755 if relative.endswith(".py") else 0o644
            info.pax_headers = {}
            handle.addfile(info, io.BytesIO(content))

    compressed = io.BytesIO()
    with gzip.GzipFile(
        filename="",
        mode="wb",
        compresslevel=9,
        fileobj=compressed,
        mtime=0,
    ) as handle:
        handle.write(tar_bytes.getvalue())
    return compressed.getvalue()


def write_archive(
    files: dict[str, bytes],
    repository: str,
    output: Path,
) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(canonical_archive_bytes(files, repository))


def inspect_archive(data: bytes, repository: str) -> list[dict[str, Any]]:
    if data[:2] != b"\x1f\x8b":
        raise ValueError("archive does not have a gzip header")
    if data[4:8] != b"\x00\x00\x00\x00":
        raise ValueError("gzip mtime is not zero")
    root_name = repository.split("/", 1)[1]
    entries: list[dict[str, Any]] = []
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as handle:
        for member in handle.getmembers():
            if not member.isfile():
                raise ValueError(f"non-file archive entry: {member.name}")
            if not member.name.startswith(root_name + "/"):
                raise ValueError(f"entry escaped repository root: {member.name}")
            entries.append(
                {
                    "name": member.name,
                    "size": member.size,
                    "mtime": member.mtime,
                    "uid": member.uid,
                    "gid": member.gid,
                    "uname": member.uname,
                    "gname": member.gname,
                    "mode": member.mode,
                }
            )
    names = [entry["name"] for entry in entries]
    if names != sorted(names):
        raise ValueError("archive entries are not sorted")
    return entries


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--manifest",
        type=Path,
        default=GENERATOR.DEFAULT_MANIFEST,
    )
    parser.add_argument("--repository", required=True)
    parser.add_argument("--archive", type=Path, required=True)
    args = parser.parse_args()
    try:
        files = GENERATOR.build_files(args.manifest, args.repository)
        write_archive(files, args.repository, args.archive)
        entries = inspect_archive(args.archive.read_bytes(), args.repository)
    except (GENERATOR.BootstrapError, OSError, ValueError) as exc:
        print(f"missing-e2e-archive: {exc}", file=sys.stderr)
        return 1
    print(
        f"rendered canonical archive for {args.repository}: "
        f"files={len(entries)}, bytes={args.archive.stat().st_size}, "
        f"output={args.archive}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
