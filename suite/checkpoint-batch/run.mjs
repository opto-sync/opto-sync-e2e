#!/usr/bin/env node
/**
 * Black-box, exact-head CLI checkpoint-batch conformance.
 *
 * OPTO_SYNC_CLI_BIN must name a real, built opto-sync executable. This suite
 * deliberately has no JavaScript checkpoint-policy fallback and never skips.
 * It neither starts a server nor opens the network.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const binary = process.env.OPTO_SYNC_CLI_BIN;
assert.ok(binary, "OPTO_SYNC_CLI_BIN must point to the real opto-sync executable");

const root = mkdtempSync(join(tmpdir(), "opto-sync-checkpoint-batch-"));
const external = mkdtempSync(join(tmpdir(), "opto-sync-outside-root-"));
const inputPath = join(root, "batch.json");
const secret = "sensitive-operation-a";

const batch = (operations, overrides = {}) => ({
  schema: "opto-sync.checkpoint-batch.v1",
  initialCheckpoint: "0",
  maximumSeenOperations: 3,
  operations,
  ...overrides,
});

const operation = (operationId, checkpoint) => ({ operationId, checkpoint });

const invoke = (name, payload, expected) => {
  const bytes = typeof payload === "string" ? payload : JSON.stringify(payload);
  writeFileSync(inputPath, bytes, { flag: "w" });
  const before = readFileSync(inputPath);

  const result = spawnSync(binary, [
    "--root", root, "validate", "--kind", "checkpoint-batch", "--input", "batch.json",
  ], { encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });

  assert.equal(result.error, undefined, name + ": executable failed to run");
  assert.equal(result.signal, null, name + ": executable terminated by signal");
  assert.equal(result.status, expected.status, name + ": incorrect exit code");
  assert.ok(!result.stdout.includes(secret), name + ": stdout leaked an operation ID");
  assert.ok(!result.stderr.includes(secret), name + ": stderr leaked an operation ID");

  if (expected.status === 0) {
    const lines = result.stdout.trim().split(/\r?\n/);
    assert.equal(lines.length, 1, name + ": stdout must contain exactly one JSON envelope");
    const output = JSON.parse(lines[0]);
    assert.equal(output.schema, "opto-sync.cli.output.v1");
    assert.equal(output.ok, true);
    assert.equal(output.command, "validate");
    assert.equal(output.interfacesRevision, "b92b3a2eb43eeb183144521a188ae465a013951e");
    assert.equal(output.policyRevision, "f2ea017328aff58401d38a6d36480c45b39d3c15");
    assert.equal(output.data.kind, "checkpoint_batch");
    assert.equal(output.data.schema, "opto-sync.checkpoint-batch.v1");
    assert.equal(output.data.redacted, true);
    assert.equal(output.data.operationCount, expected.count);
    assert.equal(output.data.advancedCount, expected.advanced);
    assert.equal(output.data.duplicateCount, expected.duplicate);
    assert.equal(output.data.finalCheckpoint, expected.finalCheckpoint);
  } else {
    assert.equal(result.stdout, "", name + ": failed validation emitted success data");
  }

  assert.deepEqual(readFileSync(inputPath), before, name + ": validator changed the input");
  assert.deepEqual(readdirSync(root).sort(), ["batch.json"], name + ": validator created files");
  console.log("PASS " + name);
};

try {
  invoke("ordered admission plus idempotent duplicate", batch([
    operation(secret, "1"), operation(secret, "1"), operation("operation-b", "2"),
  ]), { status: 0, count: 3, advanced: 2, duplicate: 1, finalCheckpoint: "2" });

  const invalid = [
    ["regression after valid advance", batch([operation("a", "1"), operation("b", "0")])],
    ["noncanonical checkpoint", batch([operation("a", "1"), operation("b", "01")])],
    ["invalid operation ID", batch([operation("bad id", "1")])],
    ["bounded seen window", batch([operation("a", "1"), operation("b", "2")], { maximumSeenOperations: 1 })],
    ["empty batch", batch([])],
    ["unexpected operation property", batch([{ operationId: "a", checkpoint: "1", tenantId: "secret" }])],
    ["wrong schema", batch([operation("a", "1")], { schema: "opto-sync.checkpoint-batch.v2" })],
    ["oversized batch", batch(Array.from({ length: 1025 }, (_, i) => operation("op-" + i, String(i + 1))))],
    ["malformed JSON", "{not-json"],
    ["noncanonical initial checkpoint", batch([operation("a", "1")], { initialCheckpoint: "00" })],
    ["zero seen-operation budget", batch([operation("a", "1")], { maximumSeenOperations: 0 })],
    ["oversized seen-operation budget", batch([operation("a", "1")], { maximumSeenOperations: 1025 })],
    ["u64 checkpoint overflow", batch([operation("a", "18446744073709551616")])],
    ["missing operation ID", batch([{ checkpoint: "1" }])],
    ["numeric checkpoint rejected", batch([{ operationId: "a", checkpoint: 1 }])],
  ];
  invalid.forEach(([name, payload]) => invoke(name, payload, { status: 4 }));

  writeFileSync(join(external, "escaped.json"), JSON.stringify(batch([operation(secret, "1")])));
  symlinkSync(join(external, "escaped.json"), join(root, "escape.json"));
  const escaped = spawnSync(binary, [
    "--root", root, "validate", "--kind", "checkpoint-batch", "--input", "escape.json",
  ], { encoding: "utf8", timeout: 30_000 });
  assert.equal(escaped.error, undefined, "symlink: executable failed to run");
  assert.equal(escaped.status, 3, "symlink outside trust root must be rejected as input policy");
  assert.equal(escaped.stdout, "", "symlink: no success output permitted");
  assert.ok(!escaped.stderr.includes(secret), "symlink: stderr leaked an operation ID");
  console.log("PASS symlink outside trust root");

  console.log("Checkpoint-batch CLI conformance: 17/17 cases passed");
} finally {
  rmSync(root, { recursive: true, force: true });
  rmSync(external, { recursive: true, force: true });
}
