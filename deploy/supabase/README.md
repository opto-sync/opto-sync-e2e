# Supabase authentication deployment

[`custom_access_token_hook.sql`](custom_access_token_hook.sql) is a reference
migration for issuing the signed claims consumed by the Node protocol server.
It creates:

- private tenant membership;
- one active tenant per user;
- registered/revocable durable client IDs; and
- a Supabase Custom Access Token Hook that injects the active tenant and client
  allowlist into `app_metadata`.

After applying the migration:

1. populate membership, active tenant, and client rows through a trusted
   administrative path;
2. configure
   `pg-functions://postgres/public/opto_sync_custom_access_token_hook` as the
   project's Custom Access Token Hook;
3. refresh the user's session so Auth issues a new token;
4. configure the sync server's `SYNCER_PROTOCOL_JWT_JSON` as described in
   [AUTHENTICATION.md](../../docs/AUTHENTICATION.md); and
5. verify that a revoked client disappears after token refresh and that the
   server still enforces its durable ownership row.

The migration does not expose a device-registration RPC because the correct
proof of device ownership, tenant invitation policy, and administrative
workflow are application-specific. Do not grant direct writes on these tables
to `anon` or `authenticated`.

The hook leaves ordinary login intact for users without an active membership,
but removes opto-sync claims. Such a token receives 401 from the sync service.
An active membership with zero registered clients receives an empty allowlist,
which is also denied until a client is registered.

Changing the active tenant or revoking a client does not rewrite an already
issued JWT. Require a session refresh and choose a short JWT lifetime. Emergency
revocation must account for both Supabase's JWKS cache and the sync server's
ten-minute public-key cache.
