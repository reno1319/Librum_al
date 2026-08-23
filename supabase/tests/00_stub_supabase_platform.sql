-- Stubs the pieces of the real Supabase platform that supabase/schema.sql
-- assumes already exist when it runs against a real Supabase project:
-- the anon/authenticated/service_role roles, the auth schema, auth.uid(),
-- and a minimal storage schema (schema.sql seeds storage.buckets and
-- adds storage.objects policies for cover/manuscript uploads).
--
-- ONLY for running supabase/schema.sql and the supabase/tests/*.sql
-- regression suites against a disposable local/CI Postgres instance.
-- NEVER run this against a real Supabase project -- it already provides
-- all of this for real, and creating these roles/schemas there would be
-- redundant at best and could error against the platform's own setup.

create extension if not exists pgcrypto;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end $$;

grant anon, authenticated, service_role to current_user;

-- Real Supabase provisions service_role with broad default table-level
-- privileges on every table created under public, same as anon/
-- authenticated get until explicitly revoked (see schema.sql's own
-- comment on the profiles table) -- no migration in this repo ever
-- revokes from service_role, since the Stripe webhook's admin client
-- relies on that ambient grant to write directly to purchases,
-- bundle_checkout_snapshots, and book_checkout_intents' own link-back
-- column. ALTER DEFAULT PRIVILEGES applies to tables schema.sql and the
-- migrations create AFTER this stub runs, not just ones that exist now.
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;

-- email/raw_user_meta_data exist because supabase/schema.sql's own
-- handle_new_user() trigger (fired after insert on auth.users) reads
-- them to auto-create the matching public.profiles row -- tests insert
-- into auth.users with these populated rather than inserting into
-- public.profiles directly, exactly mirroring how a real signup works.
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key,
  email text,
  raw_user_meta_data jsonb not null default '{}'::jsonb
);

-- Mirrors real Supabase auth.uid(): reads the request's JWT `sub` claim
-- out of a session-local GUC. Tests drive this directly via
-- set_config('request.jwt.claim.sub', '<uuid>', true) instead of an
-- actual JWT, which is sufficient for exercising SECURITY DEFINER
-- functions that call auth.uid().
create or replace function auth.uid() returns uuid
  language sql stable
  as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

create schema if not exists storage;
create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text,
  name text,
  owner uuid
);
create or replace function storage.foldername(name text) returns text[]
  language sql immutable as $$ select string_to_array(name, '/') $$;
alter table storage.objects enable row level security;
