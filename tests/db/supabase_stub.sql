-- 로컬 테스트용 Supabase 흉내 (운영 DB에 실행하지 않는다)
-- 역할(anon·authenticated·service_role), auth.jwt()/auth.uid(), auth.users, storage.buckets만 만든다.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS storage;
GRANT USAGE ON SCHEMA auth, public, storage TO anon, authenticated, service_role;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
  $$ SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(auth.jwt() ->> 'sub', '')::uuid $$;
GRANT EXECUTE ON FUNCTION auth.jwt(), auth.uid() TO anon, authenticated, service_role;
CREATE TABLE IF NOT EXISTS auth.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text UNIQUE, raw_app_meta_data jsonb DEFAULT '{}'::jsonb,
  dev_password text, created_at timestamptz DEFAULT now(), last_sign_in_at timestamptz);
CREATE TABLE IF NOT EXISTS storage.buckets (id text PRIMARY KEY, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
-- Supabase 기본값처럼 public의 새 표·함수 권한을 API 역할에 모두 준다(최악의 경우를 가정. 01이 이를 회수해야 한다)
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
