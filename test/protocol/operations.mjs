import assert from "node:assert/strict";

const baseUrl = (process.env.BASE_URL || "http://node-ops:3023").replace(/\/$/, "");
const resetUrl = (process.env.RESET_URL || "http://node:3003/reset").replace(/\/$/, "");
const quotaToken =
  process.env.QUOTA_TOKEN || "ops-quota-test-token-000000000001";
const rateToken =
  process.env.RATE_TOKEN || "ops-rate-test-token-0000000000002";
const snapshotToken =
  process.env.SNAPSHOT_TOKEN || "ops-snapshot-test-token-000000003";
const metricsToken =
  process.env.METRICS_TOKEN || "ops-metrics-test-token-0000000000001";

let assertions = 0;
let cases = 0;

function equal(actual, expected, message) {
  assertions += 1;
  assert.deepEqual(actual, expected, message);
}

function check(value, message) {
  assertions += 1;
  assert.ok(value, message);
}

async function rawRequest(method, path, body, token, contentType = "application/json") {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": contentType }),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    text,
    json: response.headers.get("content-type")?.includes("json")
      ? JSON.parse(text)
      : null,
  };
}

function request(method, path, body, token) {
  return rawRequest(
    method,
    path,
    body === undefined ? undefined : JSON.stringify(body),
    token,
  );
}

async function test(name, run) {
  await run();
  cases += 1;
  console.log(`  PASS ${name}`);
}

async function waitForServer() {
  let lastError;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const result = await request("GET", "/health");
      if (result.status === 200) return;
      lastError = new Error(`health returned ${result.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastError ?? new Error("operations server did not become ready");
}

function mutation(clientId, mutationId, recordId, payload) {
  return {
    protocolVersion: 1,
    clientId,
    mutations: [
      {
        mutationId: String(mutationId),
        operation: "upsert",
        table: "docs",
        recordId,
        baseRevision: "0",
        payload,
      },
    ],
  };
}

console.log("\n=== opto-sync operational controls ===");
await waitForServer();
const reset = await fetch(resetUrl, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
  signal: AbortSignal.timeout(10_000),
});
equal(reset.status, 200);

await test("metrics require their own bearer credential", async () => {
  equal((await request("GET", "/metrics")).status, 401);
  equal((await request("GET", "/metrics", undefined, "wrong-token")).status, 401);
  const metrics = await request("GET", "/metrics", undefined, metricsToken);
  equal(metrics.status, 200);
  check(
    metrics.text.includes('opto_sync_info{protocol_version="1"} 1'),
    "metrics endpoint did not return the Prometheus information series",
  );
});

await test("push quotas reject wire bytes, mutation bytes, and batch count", async () => {
  const oversizedWire = JSON.stringify({
    protocolVersion: 1,
    clientId: "ops-quota-client",
    mutations: [],
    padding: "x".repeat(1100),
  });
  const wire = await rawRequest(
    "POST",
    "/v1/sync/push",
    oversizedWire,
    quotaToken,
  );
  equal(wire.status, 413);
  equal(wire.json.error, "PUSH_TOO_LARGE");
  check(Number(wire.json.limitBytes) === 1024);

  const mutationTooLarge = await request(
    "POST",
    "/v1/sync/push",
    mutation("ops-quota-client", 1, "too-large", {
      value: "x".repeat(450),
    }),
    quotaToken,
  );
  equal(mutationTooLarge.status, 413);
  equal(mutationTooLarge.json.error, "MUTATION_TOO_LARGE");
  equal(mutationTooLarge.json.mutationIndex, 0);

  const tooMany = await request(
    "POST",
    "/v1/sync/push",
    {
      protocolVersion: 1,
      clientId: "ops-quota-client",
      mutations: [1, 2, 3].map((mutationId) => ({
        mutationId: String(mutationId),
        operation: "upsert",
        table: "docs",
        recordId: `quota-${mutationId}`,
        payload: { value: mutationId },
      })),
    },
    quotaToken,
  );
  equal(tooMany.status, 413);
  equal(tooMany.json.error, "PUSH_MUTATION_LIMIT");
  equal(tooMany.json.limit, 2);
});

await test("repeated invalid bearer attempts are rate limited by remote address", async () => {
  for (let index = 0; index < 3; index += 1) {
    const denied = await request(
      "GET",
      "/v1/sync/pull?checkpoint=0",
      undefined,
      "invalid-bearer",
    );
    equal(denied.status, 401);
  }
  const limited = await request(
    "GET",
    "/v1/sync/pull?checkpoint=0",
    undefined,
    "invalid-bearer",
  );
  equal(limited.status, 429);
  equal(limited.json.error, "RATE_LIMITED");
  check(Number(limited.headers.get("retry-after")) >= 1);
});

await test("per-principal rate limiting returns 429 and Retry-After", async () => {
  for (let index = 0; index < 3; index += 1) {
    const allowed = await request(
      "GET",
      "/v1/sync/pull?checkpoint=0",
      undefined,
      rateToken,
    );
    equal(allowed.status, 200);
    check(allowed.headers.get("x-request-id"), "protocol response lacks request id");
  }
  const limited = await request(
    "GET",
    "/v1/sync/pull?checkpoint=0",
    undefined,
    rateToken,
  );
  equal(limited.status, 429);
  equal(limited.json.error, "RATE_LIMITED");
  check(Number(limited.headers.get("retry-after")) >= 1);
  check(limited.json.retryAfterSeconds >= 1);
});

await test("snapshot record quota refuses an unsafe all-at-once reset", async () => {
  for (let mutationId = 1; mutationId <= 3; mutationId += 1) {
    const applied = await request(
      "POST",
      "/v1/sync/push",
      mutation(
        "ops-snapshot-client",
        mutationId,
        `snapshot-${mutationId}`,
        { value: mutationId },
      ),
      snapshotToken,
    );
    equal(applied.status, 200);
    equal(applied.json.results[0].status, "applied");
  }
  const snapshot = await request(
    "GET",
    "/v1/sync/snapshot",
    undefined,
    snapshotToken,
  );
  equal(snapshot.status, 413);
  equal(snapshot.json.error, "SNAPSHOT_QUOTA_EXCEEDED");
  equal(snapshot.json.recordCount, "3");
  equal(snapshot.json.maxRecords, 2);
});

await test("metrics expose bounded operational outcomes without tenant labels", async () => {
  const metrics = await request("GET", "/metrics", undefined, metricsToken);
  equal(metrics.status, 200);
  check(
    metrics.text.includes("opto_sync_protocol_rate_limited_total"),
    "rate-limit counter missing",
  );
  check(
    metrics.text.includes("opto_sync_protocol_quota_rejections_total"),
    "quota counter missing",
  );
  check(
    metrics.text.includes("opto_sync_protocol_mutations_total"),
    "mutation outcome counter missing",
  );
  check(!metrics.text.includes("ops-rate"), "metrics leaked a subject or tenant label");
  check(!metrics.text.includes("ops-snapshot-client"), "metrics leaked a client label");
});

console.log(
  `\nOperational controls: ${cases} cases passed, ${assertions} assertions passed\n`,
);
