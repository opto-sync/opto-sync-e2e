# Protocol authentication

The reference Node/PostgreSQL service supports two mutually exclusive
production authentication modes:

1. locally verified asymmetric JWTs, intended for Supabase Auth and other
   OIDC-style issuers; or
2. exact static bearer mappings for isolated deployments and deterministic
   testing.

Production startup fails when neither mode is configured or when both are
configured. Test mode remains explicitly header-driven.

## Supabase JWT mode

Supabase exposes an asymmetric project's public signing keys at:

```text
https://PROJECT_REF.supabase.co/auth/v1/.well-known/jwks.json
```

Configure:

```sh
SYNCER_PROTOCOL_JWT_JSON='{
  "jwksUrl": "https://PROJECT_REF.supabase.co/auth/v1/.well-known/jwks.json",
  "issuer": "https://PROJECT_REF.supabase.co/auth/v1",
  "audience": "authenticated",
  "algorithms": ["ES256"],
  "roles": ["authenticated"],
  "tenantClaim": "app_metadata.opto_sync_tenant_id",
  "clientIdsClaim": "app_metadata.opto_sync_client_ids",
  "clockToleranceSeconds": 5,
  "maxTokenAgeSeconds": 3600
}'
```

Use the algorithm shown by the project's JWKS. `ES256` is common for current
Supabase signing keys; `RS256` and the other explicitly supported asymmetric
variants can be configured. Symmetric `HS256` is deliberately unsupported in
this local JWKS path. Supabase recommends checking legacy shared-secret tokens
through its Auth server instead; migrate to asymmetric signing keys for a
locally verified production path.

The verifier requires and validates:

- a signature from the configured JWKS and allowed algorithm;
- exact issuer and audience;
- `exp`, `iat`, optional `nbf`, and maximum token age;
- an allowed `role`;
- a valid `sub`;
- a valid tenant claim; and
- when `clientIdsClaim` is configured, a non-empty, unique exact client-ID
  allowlist.

Claim identifiers use the protocol's bounded scope syntax. A token cannot
select tenant or subject through request headers or JSON. Claim paths under
`user_metadata` are rejected at startup because users may edit that metadata.
Issue authorization claims from a Supabase Custom Access Token Hook or another
server-owned source.

For a single-tenant/device-registration design that cannot place client IDs in
the JWT, set `"clientIdsClaim": null` explicitly. The first authenticated
subject to push a `(tenantId, clientId)` then owns it durably. A later subject
cannot take it over. Keeping an exact signed allowlist is stronger and is the
default.

Inline public keys are supported with `"jwks":{"keys":[...]}` instead of
`jwksUrl`; exactly one source is required. This is intended for self-hosted,
air-gapped, and deterministic test deployments. Never put private keys in the
server configuration.

Remote JWKS uses a five-second timeout, a thirty-second refresh cooldown, and a
ten-minute cache. Invalid tokens return 401. Key-fetch timeout, invalid JWKS, or
transport failure returns 503 `AUTHENTICATION_UNAVAILABLE`; the service never
falls back to unverified claims or static credentials.

Supabase documents its JWKS endpoint and cache/rotation behavior in
[JWT Signing Keys](https://supabase.com/docs/guides/auth/signing-keys) and
[JSON Web Tokens](https://supabase.com/docs/guides/auth/jwts). Wait for JWKS
caches to contain a standby key before rotating it active, and include a
cache-purge/runbook path for emergency revocation.

## Issuing tenant and client claims

Supabase's
[Custom Access Token Hook](https://supabase.com/docs/guides/auth/auth-hooks/custom-access-token-hook)
can add server-owned claims. The application should derive them from membership
and registered-device tables that ordinary users cannot mutate directly.
An executable reference migration is provided in
[`deploy/supabase/custom_access_token_hook.sql`](../deploy/supabase/custom_access_token_hook.sql).

Conceptually, the hook adds:

```json
{
  "app_metadata": {
    "opto_sync_tenant_id": "tenant-a",
    "opto_sync_client_ids": ["durable-device-a", "durable-device-b"]
  }
}
```

Do not trust a tenant ID sent in a push body, `user_metadata`, an unsigned
cookie, or a browser header. If users may belong to several tenants, model an
explicit active tenant and issue a fresh access token when it changes.

The signed tenant claim is an isolation boundary, not a complete record ACL.
The reference schema ensures one tenant cannot read another tenant's ledger,
changes, or snapshots. Applications must still authorize each table and record,
normally through an application policy callback or PostgreSQL RLS. The C merge
result itself is never an authorization decision.

## Static mode

For deployments without JWTs:

```sh
SYNCER_PROTOCOL_AUTH_JSON='[
  {
    "token": "a-long-random-secret",
    "subject": "user-123",
    "tenantId": "acme",
    "clientIds": ["device-a"]
  }
]'
```

The single-entry environment variables remain supported:
`SYNCER_PROTOCOL_BEARER_TOKEN`, `SYNCER_PROTOCOL_SUBJECT`,
`SYNCER_PROTOCOL_TENANT_ID`, and `SYNCER_PROTOCOL_CLIENT_IDS`.

Tokens are SHA-256 hashed in memory and compared in constant time. Duplicate
tokens and conflicting tenant/client ownership fail startup. Static mode does
not become a fallback when JWT verification fails.

## Verification

```sh
# Cryptographic/configuration unit coverage.
cd servers/node
npm test

# Complete Express -> protocol -> PostgreSQL path with signed JWTs.
docker compose --profile jwt-auth up --build \
  --exit-code-from jwt-auth-protocol
```

The integration suite covers signature tampering, expiry, future `nbf`, issuer,
audience, role, algorithm, malformed/missing claims, exact client allowlists,
tenant-filtered pull/snapshot, token refresh, and durable ownership takeover.
