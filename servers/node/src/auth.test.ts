import assert from "node:assert/strict";
import test from "node:test";

import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWK,
} from "jose";

import {
  createProtocolAuthenticator,
  readBearerToken,
} from "./auth.js";

const issuer = "https://project-ref.supabase.co/auth/v1";
let privateKey: CryptoKey;
let publicJwk: JWK;

test.before(async () => {
  const generated = await generateKeyPair("ES256", { extractable: true });
  privateKey = generated.privateKey;
  publicJwk = {
    ...(await exportJWK(generated.publicKey)),
    kid: "auth-test-key",
    alg: "ES256",
    use: "sig",
  };
});

function jwtEnvironment(overrides: Record<string, unknown> = {}): NodeJS.ProcessEnv {
  return {
    SYNCER_PROTOCOL_JWT_JSON: JSON.stringify({
      jwks: { keys: [publicJwk] },
      issuer,
      audience: "authenticated",
      algorithms: ["ES256"],
      roles: ["authenticated"],
      tenantClaim: "app_metadata.opto_sync_tenant_id",
      clientIdsClaim: "app_metadata.opto_sync_client_ids",
      ...overrides,
    }),
  };
}

async function token(
  claims: Record<string, unknown> = {},
  protectedHeader: Record<string, unknown> = {},
  standard: {
    issuer?: string;
    audience?: string;
    subject?: string;
    issuedAt?: number;
    expirationTime?: number;
  } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    role: "authenticated",
    app_metadata: {
      opto_sync_tenant_id: "tenant-a",
      opto_sync_client_ids: ["client-a", "client-a-secondary"],
    },
    ...claims,
  })
    .setProtectedHeader({
      alg: "ES256",
      kid: "auth-test-key",
      typ: "JWT",
      ...protectedHeader,
    })
    .setIssuer(standard.issuer ?? issuer)
    .setAudience(standard.audience ?? "authenticated")
    .setSubject(standard.subject ?? "user-a")
    .setIssuedAt(standard.issuedAt ?? now)
    .setExpirationTime(standard.expirationTime ?? now + 300)
    .sign(privateKey);
}

test("JWT mode derives only verified subject, tenant, role, and client bindings", async () => {
  const authenticator = createProtocolAuthenticator(jwtEnvironment());
  assert.equal(authenticator.mode, "jwt");
  const result = await authenticator.authenticateAuthorization(
    `Bearer ${await token()}`,
  );
  assert.equal(result.status, "authenticated");
  if (result.status !== "authenticated") return;
  assert.equal(result.identity.subject, "user-a");
  assert.equal(result.identity.tenantId, "tenant-a");
  assert.deepEqual(
    [...(result.identity.clientIds ?? [])],
    ["client-a", "client-a-secondary"],
  );
});

test("JWT mode rejects bad signatures, expiry, issuer, audience, and role", async () => {
  const authenticator = createProtocolAuthenticator(jwtEnvironment());
  const now = Math.floor(Date.now() / 1000);
  const valid = await token();
  const [tamperedHeader, tamperedPayload, encodedSignature] = valid.split(".");
  const signature = Buffer.from(encodedSignature, "base64url");
  signature[0] ^= 1;
  const tampered = `${tamperedHeader}.${tamperedPayload}.${signature.toString(
    "base64url",
  )}`;
  const expired = await token({}, {}, { expirationTime: now - 30 });
  const futureIssued = await token(
    {},
    {},
    { issuedAt: now + 60, expirationTime: now + 300 },
  );
  const tooOld = await token(
    {},
    {},
    { issuedAt: now - 3_700, expirationTime: now + 300 },
  );
  const wrongRole = await token({ role: "service_role" });
  const wrongIssuer = await token(
    {},
    {},
    { issuer: "https://attacker.invalid/auth/v1" },
  );
  const wrongAudience = await token(
    {},
    {},
    { audience: "service_role" },
  );

  for (const [label, invalid] of [
    ["tampered signature", tampered],
    ["expired", expired],
    ["future iat", futureIssued],
    ["maximum age", tooOld],
    ["issuer", wrongIssuer],
    ["audience", wrongAudience],
    ["role", wrongRole],
  ]) {
    assert.deepEqual(
      await authenticator.authenticateAuthorization(`Bearer ${invalid}`),
      { status: "denied" },
      label,
    );
  }
});

test("JWT mode rejects missing, malformed, duplicate, and user-controlled authorization claims", async () => {
  const authenticator = createProtocolAuthenticator(jwtEnvironment());
  for (const invalid of [
    await token({ app_metadata: {} }),
    await token({
      app_metadata: {
        opto_sync_tenant_id: "../other",
        opto_sync_client_ids: ["client-a"],
      },
    }),
    await token({
      app_metadata: {
        opto_sync_tenant_id: "tenant-a",
        opto_sync_client_ids: ["client-a", "client-a"],
      },
    }),
  ]) {
    assert.deepEqual(
      await authenticator.authenticateAuthorization(`Bearer ${invalid}`),
      { status: "denied" },
    );
  }

  assert.throws(
    () =>
      createProtocolAuthenticator(
        jwtEnvironment({ tenantClaim: "user_metadata.tenant_id" }),
      ),
    /authorization claims must not come from user_metadata/,
  );
});

test("client claim may be disabled only explicitly, leaving durable ownership enforcement", async () => {
  const authenticator = createProtocolAuthenticator(
    jwtEnvironment({ clientIdsClaim: null }),
  );
  const result = await authenticator.authenticateAuthorization(
    `Bearer ${await token({ app_metadata: { opto_sync_tenant_id: "tenant-a" } })}`,
  );
  assert.equal(result.status, "authenticated");
  if (result.status === "authenticated") {
    assert.equal(result.identity.clientIds, null);
  }
});

test("static mode remains exact and cannot be ambiguously combined with JWT mode", async () => {
  const staticEnvironment = {
    SYNCER_PROTOCOL_AUTH_JSON: JSON.stringify([
      {
        token: "static-test-token-00000001",
        subject: "user-a",
        tenantId: "tenant-a",
        clientIds: ["client-a"],
      },
    ]),
  };
  const authenticator = createProtocolAuthenticator(staticEnvironment);
  assert.equal(authenticator.mode, "static");
  assert.equal(
    (
      await authenticator.authenticateAuthorization(
        "Bearer static-test-token-00000001",
      )
    ).status,
    "authenticated",
  );
  assert.deepEqual(
    await authenticator.authenticateAuthorization("Bearer wrong"),
    { status: "denied" },
  );
  assert.throws(
    () =>
      createProtocolAuthenticator({
        ...staticEnvironment,
        ...jwtEnvironment(),
      }),
    /either SYNCER_PROTOCOL_JWT_JSON or static protocol auth/,
  );
});

test("bearer parsing rejects whitespace, alternate schemes, and multiple credentials", () => {
  assert.equal(readBearerToken("Bearer exact.token"), "exact.token");
  for (const invalid of [
    undefined,
    "",
    "bearer exact.token",
    "Bearer",
    "Bearer  exact.token",
    "Bearer exact.token trailing",
    "Basic exact.token",
  ]) {
    assert.equal(readBearerToken(invalid), null);
  }
});

test("JWT configuration fails closed on missing auth, insecure discovery, and algorithm gaps", () => {
  assert.throws(
    () => createProtocolAuthenticator({}),
    /protocol authentication is not configured/,
  );
  assert.throws(
    () =>
      createProtocolAuthenticator(
        jwtEnvironment({
          jwks: undefined,
          jwksUrl: "http://project-ref.supabase.co/auth/v1/.well-known/jwks.json",
        }),
      ),
    /remote JWKS discovery requires HTTPS/,
  );
  assert.throws(
    () =>
      createProtocolAuthenticator(
        jwtEnvironment({
          algorithms: ["HS256"],
        }),
      ),
    /Invalid enum value/,
  );
});
