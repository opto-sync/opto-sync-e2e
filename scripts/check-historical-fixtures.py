#!/usr/bin/env python3
"""Validate historical compatibility fixtures and exercise real SQLite recovery."""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "compatibility/fixtures"
MANIFEST = FIXTURES / "fixture-set.v1.json"
CONTRACT = ROOT / "compatibility/contract.v1.json"


def fail(message: str) -> None:
    print(f"compatibility-fixtures: {message}", file=sys.stderr)
    raise SystemExit(1)


def load_json(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"cannot load {path.relative_to(ROOT)}: {exc}")
    if not isinstance(value, dict):
        fail(f"{path.relative_to(ROOT)} must contain a JSON object")
    return value


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def split_sql(text: str) -> list[str]:
    statements = []
    for chunk in text.split(";"):
        statement = chunk.strip()
        if statement:
            statements.append(statement)
    return statements


def create_v1_database(path: Path, seed_sql: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(path)
    connection.executescript(seed_sql.read_text(encoding="utf-8"))
    return connection


def apply_migration(connection: sqlite3.Connection, statements: list[str]) -> None:
    connection.execute("BEGIN IMMEDIATE")
    try:
        for statement in statements:
            connection.execute(statement)
    except Exception:
        connection.rollback()
        raise
    else:
        connection.commit()


def columns(connection: sqlite3.Connection, table: str) -> set[str]:
    return {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}


def assert_v1(connection: sqlite3.Connection) -> None:
    version = connection.execute("PRAGMA user_version").fetchone()[0]
    if version != 1:
        fail(f"expected SQLite fixture version 1, got {version}")
    if {"hlc", "attempts"} & columns(connection, "opto_sync_mutations"):
        fail("rolled-back v1 database leaked v2 columns")
    mutation = connection.execute(
        "SELECT mutation_id, state, checkpoint FROM opto_sync_mutations"
    ).fetchone()
    if mutation != ("fixture-mutation-1", "pending", None):
        fail(f"v1 queued mutation changed unexpectedly: {mutation!r}")


def assert_v2(connection: sqlite3.Connection) -> None:
    version = connection.execute("PRAGMA user_version").fetchone()[0]
    if version != 2:
        fail(f"expected SQLite fixture version 2, got {version}")
    expected_columns = {
        "mutation_id",
        "document_id",
        "payload_json",
        "state",
        "checkpoint",
        "hlc",
        "attempts",
    }
    if columns(connection, "opto_sync_mutations") != expected_columns:
        fail("v2 mutation table does not match the expected migrated shape")
    mutation = connection.execute(
        "SELECT mutation_id, state, checkpoint, hlc, attempts "
        "FROM opto_sync_mutations"
    ).fetchone()
    if mutation != (
        "fixture-mutation-1",
        "pending",
        None,
        "0:0:fixture-device",
        0,
    ):
        fail(f"queued mutation was not preserved across migration: {mutation!r}")
    meta = dict(connection.execute("SELECT key, value FROM opto_sync_meta"))
    if meta != {"storage_version": "2", "migration_state": "complete"}:
        fail(f"migration metadata mismatch: {meta!r}")


def validate_sqlite(seed: Path, migration: Path) -> None:
    statements = split_sql(migration.read_text(encoding="utf-8"))
    if len(statements) < 4:
        fail("SQLite migration fixture is unexpectedly small")

    with tempfile.TemporaryDirectory(prefix="opto-sync-fixture-") as tmp:
        tmp_root = Path(tmp)

        normal = create_v1_database(tmp_root / "normal.sqlite", seed)
        try:
            assert_v1(normal)
            apply_migration(normal, statements)
            assert_v2(normal)
        finally:
            normal.close()

        interrupted = create_v1_database(tmp_root / "interrupted.sqlite", seed)
        try:
            assert_v1(interrupted)
            interrupted.execute("BEGIN IMMEDIATE")
            try:
                for statement in statements[:2]:
                    interrupted.execute(statement)
                raise RuntimeError("deterministic migration interruption")
            except RuntimeError:
                interrupted.rollback()
            assert_v1(interrupted)
            apply_migration(interrupted, statements)
            assert_v2(interrupted)
        finally:
            interrupted.close()


def validate_indexeddb(path: Path) -> None:
    fixture = load_json(path)
    if fixture.get("storageVersion") != 1:
        fail("IndexedDB seed must represent the pre-migration storage version")
    stores = {store.get("name"): store for store in fixture.get("objectStores", [])}
    if set(stores) != {"records", "mutations"}:
        fail("IndexedDB seed must contain records and mutations stores")
    pending = stores["mutations"].get("rows", [])
    if len(pending) != 1 or pending[0].get("state") != "pending":
        fail("IndexedDB seed must preserve one pending mutation")
    if pending[0].get("mutationId") != "fixture-mutation-1":
        fail("IndexedDB mutation identity differs from the SQLite/wire fixtures")


def validate_wire(wire_path: Path, log_path: Path, contract: dict) -> None:
    wire = load_json(wire_path)
    mutation_log = load_json(log_path)
    handshake = wire.get("handshake", {})
    expected = {
        "protocol": contract["protocol"]["current"],
        "schema": contract["versions"]["schema"],
        "mutationLog": contract["versions"]["mutationLog"],
        "checkpoint": contract["versions"]["checkpoint"],
        "indexedDbStorage": contract["versions"]["indexedDbStorage"],
        "sqliteStorage": contract["versions"]["sqliteStorage"],
    }
    if handshake != expected:
        fail(
            "wire fixture handshake differs from compatibility contract: "
            f"{handshake!r}"
        )
    mutations = wire.get("push", {}).get("mutations", [])
    if len(mutations) != 1 or mutations[0].get("mutationId") != "fixture-mutation-1":
        fail("wire fixture mutation identity is incomplete")
    entries = mutation_log.get("entries", [])
    states = [entry.get("state") for entry in entries]
    if states != ["pending", "acknowledged"]:
        fail(f"mutation-log lifecycle must be pending -> acknowledged, got {states!r}")
    replay = mutation_log.get("replayExpectation", {})
    if replay.get("result") != "duplicate" or replay.get("checkpoint") != "1":
        fail("mutation-log duplicate replay expectation is incomplete")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--require-history",
        action="store_true",
        help="fail until immutable N-1 and N-2 fixture slots are present",
    )
    args = parser.parse_args()

    manifest = load_json(MANIFEST)
    contract = load_json(CONTRACT)
    if manifest.get("schemaVersion") != 1:
        fail("unexpected fixture-set schema version")
    fixture_set = manifest.get("fixtureSet", {})
    if fixture_set.get("compatibilityContract") != "../contract.v1.json":
        fail("fixture set must reference the canonical compatibility contract")
    if fixture_set.get("releaseSetId") != "opto-sync-2026-07-27-certified-candidate":
        fail("fixture set must name the candidate release-set identity")

    releases = manifest.get("releases", {})
    current = releases.get("current")
    if not isinstance(current, dict):
        fail("current release fixture is missing")

    for key in (
        "protocol",
        "schema",
        "mutationLog",
        "checkpoint",
        "indexedDbStorage",
        "sqliteStorage",
    ):
        contract_value = (
            contract["protocol"]["current"]
            if key == "protocol"
            else contract["versions"][key]
        )
        if current.get(key) != contract_value:
            fail(
                f"current fixture {key}={current.get(key)!r} differs from "
                f"contract {contract_value!r}"
            )

    artifacts = current.get("artifacts", {})
    expected_hashes = current.get("sha256", {})
    resolved: dict[str, Path] = {}
    for logical_name, relative in artifacts.items():
        path = FIXTURES / relative
        if not path.is_file():
            fail(f"fixture artifact is missing: {relative}")
        expected = expected_hashes.get(relative)
        actual = sha256(path)
        if expected != actual:
            fail(f"fixture checksum mismatch for {relative}: {actual}")
        resolved[logical_name] = path

    if set(expected_hashes) != set(artifacts.values()):
        fail("fixture checksum map must exactly cover the declared artifacts")

    serialized = json.dumps(manifest, sort_keys=True).lower()
    for forbidden in (
        "password",
        "private key",
        "access_token",
        "api_key",
        "kubeconfig",
    ):
        if forbidden in serialized:
            fail(f"fixture manifest contains forbidden secret-like text: {forbidden}")

    validate_sqlite(resolved["sqliteSeed"], resolved["sqliteMigration"])
    validate_indexeddb(resolved["indexedDbSeed"])
    validate_wire(resolved["wire"], resolved["mutationLogFixture"], contract)

    missing = [
        slot
        for slot in manifest.get("requiredHistoricalSlots", [])
        if slot not in releases
    ]
    if args.require_history and missing:
        fail(
            "stable compatibility requires immutable historical fixtures: "
            + ", ".join(missing)
        )
    if not missing and fixture_set.get("status") == "bootstrap":
        fail("fixture set must leave bootstrap status after historical slots are populated")

    suffix = (
        f"; historical slots intentionally pending: {', '.join(missing)}"
        if missing
        else "; current/N-1/N-2 fixture set complete"
    )
    print("compatibility fixture integrity and SQLite migration recovery passed" + suffix)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
