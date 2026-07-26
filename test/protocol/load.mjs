import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

const baseUrl = (process.env.BASE_URL || "http://node:3003").replace(/\/$/, "");
const clients = integerSetting("LOAD_CLIENTS", 96, 2, 500);
const p95LimitMs = integerSetting("LOAD_P95_MS", 10_000, 100, 120_000);
const maxLimitMs = integerSetting("LOAD_MAX_MS", 15_000, 100, 120_000);
const recordId = `protocol-load-${process.pid}`;

function integerSetting(name, fallback, minimum, maximum) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

async function request(method, path, body) {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  return {
    status: response.status,
    json: text ? JSON.parse(text) : null,
    elapsedMs: performance.now() - startedAt,
  };
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index];
}

function summary(name, values) {
  const stats = {
    count: values.length,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    p99Ms: percentile(values, 0.99),
    maxMs: Math.max(...values),
  };
  console.log(
    `${name}: count=${stats.count} p50=${stats.p50Ms.toFixed(1)}ms ` +
      `p95=${stats.p95Ms.toFixed(1)}ms p99=${stats.p99Ms.toFixed(1)}ms ` +
      `max=${stats.maxMs.toFixed(1)}ms`,
  );
  assert.ok(
    stats.p95Ms <= p95LimitMs,
    `${name} p95 ${stats.p95Ms.toFixed(1)}ms exceeds ${p95LimitMs}ms`,
  );
  assert.ok(
    stats.maxMs <= maxLimitMs,
    `${name} max ${stats.maxMs.toFixed(1)}ms exceeds ${maxLimitMs}ms`,
  );
  return stats;
}

function envelope(index) {
  const suffix = String(index).padStart(3, "0");
  return {
    protocolVersion: 1,
    clientId: `load-client-${process.pid}-${suffix}`,
    mutations: [
      {
        mutationId: "1",
        operation: "upsert",
        table: "docs",
        recordId,
        payload: { [`client_${suffix}`]: true },
      },
    ],
  };
}

console.log("\n=== opto-sync protocol concurrency/latency probe ===");
console.log(`target: ${baseUrl}; clients: ${clients}`);

const reset = await request("POST", "/reset", {});
assert.equal(reset.status, 200);

const envelopes = Array.from({ length: clients }, (_, index) => envelope(index));
const writeWallStarted = performance.now();
const writes = await Promise.all(
  envelopes.map((body) => request("POST", "/v1/sync/push", body)),
);
const writeWallMs = performance.now() - writeWallStarted;
for (const [index, result] of writes.entries()) {
  assert.equal(
    result.status,
    200,
    `initial client ${index} failed: ${JSON.stringify(result.json)}`,
  );
  assert.equal(result.json.results[0].status, "applied");
  assert.equal(result.json.lastMutationId, "1");
}
summary(
  "concurrent initial pushes",
  writes.map((result) => result.elapsedMs),
);
console.log(
  `initial throughput: ${(clients / (writeWallMs / 1000)).toFixed(1)} committed pushes/s`,
);

const retryWallStarted = performance.now();
const retries = await Promise.all(
  envelopes.map((body) => request("POST", "/v1/sync/push", body)),
);
const retryWallMs = performance.now() - retryWallStarted;
for (const [index, result] of retries.entries()) {
  assert.equal(
    result.status,
    200,
    `retry client ${index} failed: ${JSON.stringify(result.json)}`,
  );
  assert.equal(result.json.results[0].status, "duplicate");
  assert.equal(result.json.results[0].originalStatus, "applied");
}
summary(
  "concurrent duplicate retries",
  retries.map((result) => result.elapsedMs),
);
console.log(
  `retry throughput: ${(clients / (retryWallMs / 1000)).toFixed(1)} deduplicated pushes/s`,
);

const pull = await request("GET", "/v1/sync/pull?checkpoint=0&limit=1000");
assert.equal(pull.status, 200);
const recordChanges = pull.json.changes.filter(
  (change) => change.recordId === recordId,
);
assert.equal(recordChanges.length, clients, "a committed change was lost or duplicated");
assert.equal(pull.json.hasMore, false);

const snapshot = await request("GET", "/v1/sync/snapshot");
assert.equal(snapshot.status, 200);
const document = snapshot.json.records.find((record) => record.recordId === recordId);
assert.ok(document, "shared load document missing from snapshot");
for (let index = 0; index < clients; index += 1) {
  const key = `client_${String(index).padStart(3, "0")}`;
  assert.equal(document.record[key], true, `merged document lost ${key}`);
}

console.log(
  `Protocol load probe passed: ${clients} concurrent writers, ${clients} ` +
    `ambiguous retries, ${recordChanges.length} ordered changes, one converged snapshot.\n`,
);
