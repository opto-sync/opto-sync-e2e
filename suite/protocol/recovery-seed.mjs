import { writeFileSync } from "node:fs";

const baseUrl = (process.env.BASE_URL || "http://node:3003").replace(/\/$/, "");

async function request(method, path, body, headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
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

async function waitReady() {
  let lastError;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const health = await request("GET", "/health");
      if (
        health.status === 200 &&
        health.json.syncer === "native" &&
        health.json.protocolSchemaVersion === 3
      ) {
        return;
      }
      lastError = new Error(`unexpected health: ${JSON.stringify(health)}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastError ?? new Error("protocol server did not become ready");
}

function identityHeaders(tenant, subject, clientId) {
  return {
    "x-syncer-test-tenant": tenant,
    "x-syncer-test-subject": subject,
    "x-syncer-test-client-id": clientId,
  };
}

await waitReady();
const reset = await request("POST", "/reset", {});
if (reset.status !== 200) throw new Error(`reset failed: ${reset.status}`);

const tenantA = identityHeaders("recovery-a", "recovery-user-a", "recovery-client-a");
const a = await request(
  "POST",
  "/v1/sync/push",
  {
    protocolVersion: 1,
    clientId: "recovery-client-a",
    mutations: [
      {
        mutationId: "1",
        operation: "upsert",
        table: "docs",
        recordId: "recovery-tombstone",
        baseRevision: "0",
        payload: { title: "created before backup", updatedAt: "1000" },
      },
      {
        mutationId: "2",
        operation: "delete",
        table: "docs",
        recordId: "recovery-tombstone",
        baseRevision: "1",
      },
    ],
  },
  tenantA,
);
if (a.status !== 200 || a.json.lastMutationId !== "2") {
  throw new Error(`tenant A seed failed: ${JSON.stringify(a)}`);
}

const tenantB = identityHeaders("recovery-b", "recovery-user-b", "recovery-client-b");
const b = await request(
  "POST",
  "/v1/sync/push",
  {
    protocolVersion: 1,
    clientId: "recovery-client-b",
    mutations: [
      {
        mutationId: "1",
        operation: "upsert",
        table: "docs",
        recordId: "recovery-live",
        baseRevision: "0",
        payload: { title: "survives restore", nested: { exact: true } },
      },
    ],
  },
  tenantB,
);
if (b.status !== 200 || b.json.lastMutationId !== "1") {
  throw new Error(`tenant B seed failed: ${JSON.stringify(b)}`);
}

const pullA = await request(
  "GET",
  "/v1/sync/pull?checkpoint=0",
  undefined,
  tenantA,
);
const pullB = await request(
  "GET",
  "/v1/sync/pull?checkpoint=0",
  undefined,
  tenantB,
);
if (
  pullA.status !== 200 ||
  pullA.json.changes.length !== 2 ||
  pullB.status !== 200 ||
  pullB.json.changes.length !== 1
) {
  throw new Error("seeded pull streams are not tenant-consistent");
}

writeFileSync("/tmp/opto-sync-recovery-seed-ready", "ready\n");
console.log("Recovery seed: ledger, tombstone, and two tenants are ready");
setInterval(() => {}, 60_000);
