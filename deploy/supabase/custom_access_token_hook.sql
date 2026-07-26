-- Reference Supabase Auth claim source for opto-sync.
--
-- Run as a migration owner after reviewing names and lifecycle for your app.
-- The private tables are intentionally inaccessible to anon/authenticated
-- users. Register memberships, active tenants, and durable client IDs only
-- through a trusted administrator or a narrowly authorized SECURITY DEFINER
-- RPC of your own.

CREATE SCHEMA IF NOT EXISTS opto_sync_private;
REVOKE ALL ON SCHEMA opto_sync_private FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS opto_sync_private.tenant_memberships (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL
    CHECK (tenant_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  PRIMARY KEY (user_id, tenant_id)
);

CREATE TABLE IF NOT EXISTS opto_sync_private.active_tenants (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  FOREIGN KEY (user_id, tenant_id)
    REFERENCES opto_sync_private.tenant_memberships(user_id, tenant_id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS opto_sync_private.registered_clients (
  user_id UUID NOT NULL,
  tenant_id TEXT NOT NULL,
  client_id TEXT NOT NULL
    CHECK (client_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, tenant_id, client_id),
  FOREIGN KEY (user_id, tenant_id)
    REFERENCES opto_sync_private.tenant_memberships(user_id, tenant_id)
    ON DELETE CASCADE
);

REVOKE ALL ON ALL TABLES IN SCHEMA opto_sync_private
  FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA opto_sync_private TO supabase_auth_admin;
GRANT SELECT ON
  opto_sync_private.tenant_memberships,
  opto_sync_private.active_tenants,
  opto_sync_private.registered_clients
TO supabase_auth_admin;

CREATE OR REPLACE FUNCTION public.opto_sync_custom_access_token_hook(event JSONB)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  claims JSONB;
  metadata JSONB;
  selected_tenant TEXT;
  selected_clients JSONB;
BEGIN
  claims := event -> 'claims';
  metadata := COALESCE(claims -> 'app_metadata', '{}'::JSONB);

  SELECT active.tenant_id,
         COALESCE(
           jsonb_agg(client.client_id ORDER BY client.client_id)
             FILTER (WHERE client.client_id IS NOT NULL),
           '[]'::JSONB
         )
    INTO selected_tenant, selected_clients
    FROM opto_sync_private.active_tenants AS active
    JOIN opto_sync_private.tenant_memberships AS membership
      ON membership.user_id = active.user_id
     AND membership.tenant_id = active.tenant_id
    LEFT JOIN opto_sync_private.registered_clients AS client
      ON client.user_id = active.user_id
     AND client.tenant_id = active.tenant_id
     AND client.revoked_at IS NULL
   WHERE active.user_id = (event ->> 'user_id')::UUID
   GROUP BY active.tenant_id;

  -- No active membership means no sync authorization. Preserve ordinary login
  -- but ensure stale opto-sync claims cannot survive a metadata merge.
  metadata := metadata
    - 'opto_sync_tenant_id'
    - 'opto_sync_client_ids';

  IF selected_tenant IS NOT NULL THEN
    metadata := jsonb_set(
      jsonb_set(
        metadata,
        '{opto_sync_tenant_id}',
        to_jsonb(selected_tenant),
        TRUE
      ),
      '{opto_sync_client_ids}',
      selected_clients,
      TRUE
    );
  END IF;

  claims := jsonb_set(claims, '{app_metadata}', metadata, TRUE);
  RETURN jsonb_build_object('claims', claims);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.opto_sync_custom_access_token_hook(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.opto_sync_custom_access_token_hook(JSONB)
  TO supabase_auth_admin;

-- Configure this function as the project's Custom Access Token Hook:
-- pg-functions://postgres/public/opto_sync_custom_access_token_hook
