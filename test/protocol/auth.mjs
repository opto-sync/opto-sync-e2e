import assert from "node:assert/strict";

const baseUrl = (process.env.BASE_URL || "http://node-auth:3013").replace(/\/$/, "");
const resetUrl = (process.env.RESET_URL || "http://node:3003/reset").replace(/\/$/, "");
const tokenA = process.env.TENANT_A_TOKEN || "tenant-a-test-token-000000000001";
const tokenARotated =
  process.env.TENANT_A_ROTATED_TOKEN || "tenant-a-test-token-rotated-000001";
const tokenB = process.env.TENANT_B_TOKEN || "tenant-b-test-token-000000000002";
const adminToken =
  process.env.ADMIN_TOKEN || "protocol-admin-test-token-0000000001";

let assertions = 0;
let cases = 0;

function equal(actual, expected, message) {
  assertions += 1;
  assert.deepEqual(actual, expected, message);
}

async function request(method, path, body, token) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  return {
    status: response.status,
    json: text ? JSON.parse(text) : null,
  };
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
  throw lastError ?? new Error("authenticated server did not become ready");
}

function push(clientId, tenant, value) {
  return {
    protocolVersion: 1,
    clientId,
    mutations: [
      {
        mutationId: "1",
        operation: "upsert",
        table: "docs",
        recordId: "shared-record-id",
        baseRevision: "0",
        payload: { tenant, value },
      },
    ],
  };
}

console.log("\n=== opto-sync production-auth isolation ===");
await waitForServer();
const reset = await fetch(resetUrl, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
  signal: AbortSignal.timeout(10_000),
});
equal(reset.status, 200, "test-mode peer must reset shared protocol state");

await test("protocol routes reject absent and invalid credentials", async () => {
  equal((await request("GET", "/v1/sync/pull?checkpoint=0")).status, 401);
  equal(
    (await request("GET", "/v1/sync/pull?checkpoint=0", undefined, "wrong-token")).status,
    401,
  );
});

await test("bearer identity cannot claim another configured client", async () => {
  const result = await request(
    "POST",
    "/v1/sync/push",
    push("auth-client-b", "tenant-a", "spoofed"),
    tokenA,
  );
  equal(result.status, 403);
  equal(result.json.error, "CLIENT_ID_FORBIDDEN");
});

await test("two tenants may safely reuse record, client, and mutation identities", async () => {
  const a = await request(
    "POST",
    "/v1/sync/push",
    push("auth-client-a", "tenant-a", "alpha"),
    tokenA,
  );
  const b = await request(
    "POST",
    "/v1/sync/push",
    push("auth-client-b", "tenant-b", "bravo"),
    tokenB,
  );
  equal(a.status, 200);
  equal(b.status, 200);
  equal(a.json.lastMutationId, "1");
  equal(b.json.lastMutationId, "1");
});

await test("token rotation preserves durable client ownership and retry identity", async () => {
  const retry = await request(
    "POST",
    "/v1/sync/push",
    push("auth-client-a", "tenant-a", "alpha"),
    tokenARotated,
  );
  equal(retry.status, 200);
  equal(retry.json.results[0].status, "duplicate");
  equal(retry.json.results[0].originalStatus, "applied");
});

await test("pull and snapshot expose only the authenticated tenant", async () => {
  for (const [token, tenant, value] of [
    [tokenA, "tenant-a", "alpha"],
    [tokenB, "tenant-b", "bravo"],
  ]) {
    const pull = await request("GET", "/v1/sync/pull?checkpoint=0", undefined, token);
    equal(pull.status, 200);
    equal(pull.json.changes.length, 1);
    equal(pull.json.changes[0].record, { tenant, value });

    const snapshot = await request("GET", "/v1/sync/snapshot", undefined, token);
    equal(snapshot.status, 200);
    equal(snapshot.json.records.length, 1);
    equal(snapshot.json.records[0].record, { tenant, value });
  }
});

await test("compaction requires a separate administrator credential", async () => {
  equal(
    (
      await request(
        "POST",
        "/v1/sync/admin/compact",
        { throughCheckpoint: "0" },
        tokenA,
      )
    ).status,
    401,
  );
  const compacted = await request(
    "POST",
    "/v1/sync/admin/compact",
    { throughCheckpoint: "0" },
    adminToken,
  );
  equal(compacted.status, 200);
  equal(compacted.json.compactedThrough, "0");

  const forbiddenWriter = await request(
    "POST",
    "/v1/sync/admin/external-write",
    {
      operation: "upsert",
      recordId: "must-not-write",
      payload: { forbidden: true },
    },
    adminToken,
  );
  equal(forbiddenWriter.status, 403);
});

console.log(
  `\nProduction auth: ${cases} cases passed, ${assertions} assertions passed\n`,
);
