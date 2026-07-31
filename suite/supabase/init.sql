-- PostgREST bootstrap for the Supabase-path e2e suite.
--
-- Runs as a one-shot container (service `supabase-init`) against the ALREADY
-- RUNNING postgres service — it never restarts or resets the database, and it
-- never touches `syncer_test_docs`, which the node-server suites own.
--
-- Everything here is idempotent so `up -d` can be repeated freely.

-- ── Roles ───────────────────────────────────────────────────────────────
-- Mirrors a real Supabase project's role layout: PostgREST logs in as a
-- privilege-less `authenticator` and SET ROLEs to the role named in the JWT's
-- `role` claim (here always `anon`).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator LOGIN NOINHERIT PASSWORD 'authenticator_test';
  ELSE
    ALTER ROLE authenticator LOGIN NOINHERIT PASSWORD 'authenticator_test';
  END IF;
END
$$;

GRANT anon TO authenticator;
GRANT USAGE ON SCHEMA public TO anon, authenticator;

-- ── Table ───────────────────────────────────────────────────────────────
-- Deliberately a SEPARATE table from `syncer_test_docs`: the Postgres-path
-- suites run concurrently against that one, and a shared table would make
-- both suites flaky for reasons unrelated to the code under test. Same shape,
-- so the two paths stay comparable.
CREATE TABLE IF NOT EXISTS public.supabase_sync_docs (
  id         TEXT PRIMARY KEY,
  data       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  version    INTEGER     NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

-- Refresh updated_at on every write. rust-mash deliberately omits the column
-- from its upserts, so this proves the write reached real Postgres storage
-- (a server-side value the server itself never sent).
CREATE OR REPLACE FUNCTION public.supabase_sync_docs_touch()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS supabase_sync_docs_touch ON public.supabase_sync_docs;
CREATE TRIGGER supabase_sync_docs_touch
  BEFORE INSERT OR UPDATE ON public.supabase_sync_docs
  FOR EACH ROW EXECUTE FUNCTION public.supabase_sync_docs_touch();

GRANT SELECT, INSERT, UPDATE, DELETE ON public.supabase_sync_docs TO anon;

-- PostgREST caches the schema; tell any running instance to reload so a fresh
-- table/grant is visible without restarting the container.
NOTIFY pgrst, 'reload schema';
