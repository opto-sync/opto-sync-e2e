import assert from "node:assert/strict";
import { createPrivateKey, randomUUID, sign } from "node:crypto";

const baseUrl = (process.env.BASE_URL || "http://node-jwt-auth:3033").replace(
  /\/$/,
  "",
);
const resetUrl = (process.env.RESET_URL || "http://node:3003/reset").replace(
  /\/$/,
  "",
);
const issuer = "https://opto-sync-test.supabase.co/auth/v1";

// Deliberately public, test-only fixture. The corresponding public JWK is the
// only key installed in node-jwt-auth. Never copy this key into a deployment.
const privateJwk = {
  kty: "RSA",
  n: "oTv_60xVk6clsCV18hmq3uivYWkTiSvjcJsDvrU2jfk1hfsORa8vLbUav3Pdz2dEpjlP43F40jNnngY2pqO4hdP3h1_7mZynd2wFSZoFUrzPmQLlmjJGoZjQBwneDAmGPhPgUd5vAZWNiQ0PWgg2KvN0Sor2zd34_8ndwnPttxcGqLFgq-yN46NMrB9LCRkfuMPBOz0FMNBmFPKiYbFPKljlhszQEO18jHC4M5lME16ZrZcQp1kYGI_nuQd0anGaGj2KuG8XBP_Rt1FX8k-9OSMbtyzS2cXXRJ4-XumljqVPfiNqRV9Ka6bV2e5kFij1cFjdxGVQxSMboWzBou-vQQ",
  e: "AQAB",
  d: "HVnRCWo0tOOLWJDFMwyJnrkAfizU5dZjuaK6cIvH8dnhLLHqY_STU9CBXUNQKFqd9F2ABcEpE6jQbsOmTLkGlPQkfhQStuC92p9DKiYb3HcrGmlc1zBaS74H9pQNBCdytNfE8NpbXlA1evKx7fuLMs_tRkmcSpcjJhs_H5AfgMHp2EWiw9GzH1f2SOoMkf1TxNkbeuSKwQ2oMKqEOCHUaK6OM170j1No0dJkDcjBVg9frw8joYXUHZ0JWnGitU-MtnigOMrboVDNuLJU3hZ7KSMloMMJE8JXsKW0XkBjiTQCFXsBujA6zK5Rh0jaxuBROaior-lmWOnaGYrcOnLRDQ",
  p: "3I2BUJSsJTAXRswf7j7HZZ22OUgyojnoFYF0ujlFszzNfU1vspKpyZhrpCVvlll1BvW3gay2brcimYY8rVlvS5qsTZ7EutayOMH6P8ZCMkIERcS8TAmKdykj3beuTWVlxUBD92gz_MGhS6X6fTaFj1uj3KL3UMW2KO2lvEHD3XU",
  q: "uyXhMAbZAPz-_3ISSe7m7hbkhIV9yOz-6mQsIJbiqFM2rriClnvbP7JvIzCyysZx29aJB7m1pMjQYiZCxe4pNEgPDcl4OZj02f4Lsd394kPPcMpTWNwqEhHo9hlNfeHmMtaAh6WyFOo0nUWGJz4otGteLtyO5R7EIyFHXHihFR0",
  dp: "DVqD-d0GjznaLu8s_7_NUtm5rr4wUqIu6x5rctsE3VVRG8UUfjtjDFGuMsIRf4jrDQDTm4ZZhVqRPbpi8hv4IRu8UvbJ8oYNRGJ6RGI8n85fc9n1jKUHPS_AfCwi4YzCHK9HbjNg8mzG1021XN9wNr3VrgYv8zQFU3UQE9XnhgE",
  dq: "W8jyLmnNWAy8y2-YxKXkoHSd0tjdngON6ksC0WDu_PsC4KIhech4-T57_1hM9-JnyRfo0N8l1RGgEeMN8KEjmD6XE33x9t2riJZuCegEMkprnLe-NOCVyZL7HGfAd7KpAdnt45lCQ7ux3khQyUJVGFdoM7d8Zaa3LzuNEi8fYYk",
  qi: "EVHa8sEX8DVxY8Lx5Pc4tZ9k0pQxguo65HP_a29wC9UIzRdAXu2f6-7ONPzRDp5Zzd12M0Md8jWQJp3ZfWbXHAnYQnTSZSGqFl9rOb2KOt3pIjlS9eis_yNXUWbO0d1IbQlCuFW75ruMd1QJapzDkIslCE8GSbHor4U1lNWUPnA",
  kid: "opto-sync-jwt-e2e",
  alg: "RS256",
  use: "sig",
};
const privateKey = createPrivateKey({ key: privateJwk, format: "jwk" });

let assertions = 0;
let cases = 0;

function equal(actual, expected, message) {
  assertions += 1;
  assert.deepEqual(actual, expected, message);
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function jwt({
  subject = "user-a",
  tenantId = "tenant-a",
  clientIds = ["jwt-client-a"],
  role = "authenticated",
  audience = "authenticated",
  tokenIssuer = issuer,
  expiresIn = 300,
  notBefore,
  issuedAtOffset = 0,
  includeTenant = true,
  includeClients = true,
  algorithm = "RS256",
} = {}) {
  const now = Math.floor(Date.now() / 1000);
  const appMetadata = {
    ...(includeTenant ? { opto_sync_tenant_id: tenantId } : {}),
    ...(includeClients ? { opto_sync_client_ids: clientIds } : {}),
  };
  const header = encode({
    alg: algorithm,
    kid: "opto-sync-jwt-e2e",
    typ: "JWT",
  });
  const payload = encode({
    iss: tokenIssuer,
    aud: audience,
    exp: now + expiresIn,
    iat: now + issuedAtOffset,
    sub: subject,
    role,
    app_metadata: appMetadata,
    session_id: randomUUID(),
    ...(notBefore === undefined ? {} : { nbf: now + notBefore }),
  });
  const input = `${header}.${payload}`;
  const signature = sign("RSA-SHA256", Buffer.from(input), privateKey).toString(
    "base64url",
  );
  return `${input}.${signature}`;
}

async function request(method, path, body, credential) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(credential === undefined
        ? {}
        : { authorization: `Bearer ${credential}` }),
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
  throw lastError ?? new Error("JWT server did not become ready");
}

function push(clientId, mutationId, value) {
  return {
    protocolVersion: 1,
    clientId,
    mutations: [
      {
        mutationId,
        operation: "upsert",
        table: "docs",
        recordId: "jwt-shared-record",
        baseRevision: mutationId === "1" ? "0" : undefined,
        payload: { value },
      },
    ],
  };
}

console.log("\n=== opto-sync Supabase-compatible JWT authorization ===");
await waitForServer();
const reset = await fetch(resetUrl, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
  signal: AbortSignal.timeout(10_000),
});
equal(reset.status, 200);

await test("invalid signature and registered claims are denied", async () => {
  equal((await request("GET", "/v1/sync/pull?checkpoint=0")).status, 401);
  const valid = jwt();
  const [tamperedHeader, tamperedPayload, encodedSignature] = valid.split(".");
  const signature = Buffer.from(encodedSignature, "base64url");
  signature[0] ^= 1;
  const tampered = `${tamperedHeader}.${tamperedPayload}.${signature.toString(
    "base64url",
  )}`;
  for (const credential of [
    tampered,
    jwt({ expiresIn: -30 }),
    jwt({ notBefore: 60 }),
    jwt({ issuedAtOffset: 60 }),
    jwt({ issuedAtOffset: -3_700 }),
    jwt({ tokenIssuer: "https://attacker.invalid/auth/v1" }),
    jwt({ audience: "service_role" }),
    jwt({ role: "service_role" }),
    jwt({ algorithm: "HS256" }),
  ]) {
    equal(
      (await request("GET", "/v1/sync/pull?checkpoint=0", undefined, credential))
        .status,
      401,
    );
  }
});

await test("missing or unsafe authorization claims are denied", async () => {
  for (const credential of [
    jwt({ includeTenant: false }),
    jwt({ includeClients: false }),
    jwt({ tenantId: "../other" }),
    jwt({ clientIds: ["jwt-client-a", "jwt-client-a"] }),
  ]) {
    equal(
      (await request("GET", "/v1/sync/pull?checkpoint=0", undefined, credential))
        .status,
      401,
    );
  }
});

await test("verified client allowlists prevent client-id spoofing", async () => {
  const result = await request(
    "POST",
    "/v1/sync/push",
    push("jwt-client-b", "1", "spoof"),
    jwt(),
  );
  equal(result.status, 403);
  equal(result.json.error, "CLIENT_ID_FORBIDDEN");
});

await test("verified tenant claims isolate writes, pulls, and snapshots", async () => {
  const tokenA = jwt();
  const tokenB = jwt({
    subject: "user-b",
    tenantId: "tenant-b",
    clientIds: ["jwt-client-b"],
  });
  equal(
    (
      await request(
        "POST",
        "/v1/sync/push",
        push("jwt-client-a", "1", "alpha"),
        tokenA,
      )
    ).status,
    200,
  );
  equal(
    (
      await request(
        "POST",
        "/v1/sync/push",
        push("jwt-client-b", "1", "bravo"),
        tokenB,
      )
    ).status,
    200,
  );
  for (const [credential, value] of [
    [tokenA, "alpha"],
    [tokenB, "bravo"],
  ]) {
    const pull = await request(
      "GET",
      "/v1/sync/pull?checkpoint=0",
      undefined,
      credential,
    );
    equal(pull.status, 200);
    equal(pull.json.changes.length, 1);
    equal(pull.json.changes[0].record, { value });
    const snapshot = await request(
      "GET",
      "/v1/sync/snapshot",
      undefined,
      credential,
    );
    equal(snapshot.status, 200);
    equal(snapshot.json.records.length, 1);
    equal(snapshot.json.records[0].record, { value });
  }
});

await test("new JWTs preserve retry identity for the same subject", async () => {
  const retry = await request(
    "POST",
    "/v1/sync/push",
    push("jwt-client-a", "1", "alpha"),
    jwt(),
  );
  equal(retry.status, 200);
  equal(retry.json.results[0].status, "duplicate");
  equal(retry.json.results[0].originalStatus, "applied");
});

await test("durable ownership rejects another subject even with a matching claim", async () => {
  const conflict = await request(
    "POST",
    "/v1/sync/push",
    push("jwt-client-a", "2", "takeover"),
    jwt({ subject: "user-c" }),
  );
  equal(conflict.status, 403);
  equal(conflict.json.error, "CLIENT_OWNERSHIP_CONFLICT");
});

console.log(
  `\nJWT auth: ${cases} cases passed, ${assertions} assertions passed\n`,
);
