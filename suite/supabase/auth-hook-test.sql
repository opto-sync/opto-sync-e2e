\set ON_ERROR_STOP on

INSERT INTO auth.users(id)
VALUES ('00000000-0000-4000-8000-000000000001')
ON CONFLICT (id) DO NOTHING;

INSERT INTO opto_sync_private.tenant_memberships(user_id, tenant_id)
VALUES ('00000000-0000-4000-8000-000000000001', 'tenant-a')
ON CONFLICT DO NOTHING;

INSERT INTO opto_sync_private.active_tenants(user_id, tenant_id)
VALUES ('00000000-0000-4000-8000-000000000001', 'tenant-a')
ON CONFLICT (user_id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id;

INSERT INTO opto_sync_private.registered_clients(
  user_id, tenant_id, client_id, revoked_at
)
VALUES
  ('00000000-0000-4000-8000-000000000001', 'tenant-a', 'client-a', NULL),
  ('00000000-0000-4000-8000-000000000001', 'tenant-a', 'client-b', NULL)
ON CONFLICT (user_id, tenant_id, client_id)
DO UPDATE SET revoked_at = NULL;

DO $$
DECLARE
  result JSONB;
BEGIN
  result := public.opto_sync_custom_access_token_hook(
    jsonb_build_object(
      'user_id', '00000000-0000-4000-8000-000000000001',
      'claims', jsonb_build_object(
        'sub', '00000000-0000-4000-8000-000000000001',
        'app_metadata', jsonb_build_object(
          'provider', 'email',
          'opto_sync_tenant_id', 'stale',
          'opto_sync_client_ids', jsonb_build_array('stale-client')
        )
      )
    )
  );
  IF result #>> '{claims,app_metadata,opto_sync_tenant_id}' <> 'tenant-a' THEN
    RAISE EXCEPTION 'tenant claim was not derived from active membership: %', result;
  END IF;
  IF result #> '{claims,app_metadata,opto_sync_client_ids}'
       <> '["client-a", "client-b"]'::JSONB THEN
    RAISE EXCEPTION 'client claims are not deterministic and complete: %', result;
  END IF;
  IF result #>> '{claims,app_metadata,provider}' <> 'email' THEN
    RAISE EXCEPTION 'unrelated app_metadata was not preserved: %', result;
  END IF;
END
$$;

UPDATE opto_sync_private.registered_clients
   SET revoked_at = NOW()
 WHERE user_id = '00000000-0000-4000-8000-000000000001'
   AND tenant_id = 'tenant-a'
   AND client_id = 'client-a';

DO $$
DECLARE
  result JSONB;
BEGIN
  result := public.opto_sync_custom_access_token_hook(
    jsonb_build_object(
      'user_id', '00000000-0000-4000-8000-000000000001',
      'claims', jsonb_build_object('app_metadata', '{}'::JSONB)
    )
  );
  IF result #> '{claims,app_metadata,opto_sync_client_ids}'
       <> '["client-b"]'::JSONB THEN
    RAISE EXCEPTION 'revoked client remained in signed claims: %', result;
  END IF;
END
$$;

DELETE FROM opto_sync_private.active_tenants
 WHERE user_id = '00000000-0000-4000-8000-000000000001';

DO $$
DECLARE
  result JSONB;
BEGIN
  result := public.opto_sync_custom_access_token_hook(
    jsonb_build_object(
      'user_id', '00000000-0000-4000-8000-000000000001',
      'claims', jsonb_build_object(
        'app_metadata', jsonb_build_object(
          'provider', 'email',
          'opto_sync_tenant_id', 'stale',
          'opto_sync_client_ids', jsonb_build_array('stale-client')
        )
      )
    )
  );
  IF result #> '{claims,app_metadata}' ? 'opto_sync_tenant_id'
     OR result #> '{claims,app_metadata}' ? 'opto_sync_client_ids' THEN
    RAISE EXCEPTION 'stale sync authorization survived no membership: %', result;
  END IF;
  IF result #>> '{claims,app_metadata,provider}' <> 'email' THEN
    RAISE EXCEPTION 'ordinary metadata was removed with sync claims: %', result;
  END IF;
END
$$;

DELETE FROM auth.users
 WHERE id = '00000000-0000-4000-8000-000000000001';

\echo 'Supabase custom access token hook: all assertions passed'
