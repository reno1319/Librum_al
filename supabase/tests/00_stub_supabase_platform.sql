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

-- LIBRUM 2.0 AUTHOR-1C: a real Supabase project pre-provisions the
-- `extensions` schema with USAGE already granted to anon/authenticated
-- platform-wide, before any user migration ever runs -- schema.sql's own
-- `create schema if not exists extensions` (where search_books() puts
-- unaccent()) relies on that ambient grant already being in place; it
-- never re-grants USAGE itself, since on the real platform it never
-- needs to. Pre-creating the schema and granting USAGE here, before
-- schema.sql runs, mirrors that real platform precondition -- without
-- this, search_books() called AS anon/authenticated in a test (the only
-- way that actually exercises the RLS/grant boundary these functions
-- run under, since SECURITY INVOKER means they run as the CALLING
-- role) fails with "permission denied for schema extensions" before
-- ever reaching the table-level privileges this suite exists to test,
-- silently masking a real, separate privilege bug underneath it -- this
-- was caught and confirmed exactly that way while building the
-- AUTHOR-1C profiles-privacy fix.
create schema if not exists extensions;
grant usage on schema extensions to anon, authenticated;

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

-- Real Supabase provisions service_role, anon, AND authenticated with
-- broad default table-level privileges (SELECT/INSERT/UPDATE/DELETE/
-- TRUNCATE/REFERENCES/TRIGGER) on every table created under public,
-- until explicitly revoked (see schema.sql's own comment on the
-- profiles table, and the LAUNCH-1 P1-6 audit, which is entirely about
-- this ambient grant). All three roles are stubbed identically here so
-- that a table with no explicit ACL of its own -- most tables in this
-- schema -- behaves exactly as it does in production: readable/
-- writable by anon/authenticated except where RLS independently blocks
-- it, not silently privilege-denied the way an under-stubbed anon/
-- authenticated would be. No migration in this repo ever revokes from
-- service_role, since the Stripe webhook's admin client relies on that
-- ambient grant to write directly to purchases, bundle_checkout_
-- snapshots, and book_checkout_intents' own link-back column. ALTER
-- DEFAULT PRIVILEGES applies to tables schema.sql and the migrations
-- create AFTER this stub runs, not just ones that exist now.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

-- email/raw_user_meta_data exist because supabase/schema.sql's own
-- handle_new_user() trigger (fired after insert on auth.users) reads
-- them to auto-create the matching public.profiles row -- tests insert
-- into auth.users with these populated rather than inserting into
-- public.profiles directly, exactly mirroring how a real signup works.
--
-- email_confirmed_at (ADMIN-1B Part B): added because
-- add_staff_member_by_email() (migration 041) reads it to require a
-- verified account. Nullable, no default -- deliberately does NOT
-- auto-confirm every fixture user, since 041's own test suite needs to
-- exercise both a confirmed and an unconfirmed fixture explicitly. Every
-- OTHER existing test file's auth.users inserts predate this column and
-- never reference it, so they are unaffected by it defaulting to null.
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key,
  email text,
  email_confirmed_at timestamptz,
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

-- BLOG-1B.1: a real Supabase project pre-provisions the `storage`
-- schema with USAGE already granted to anon/authenticated/service_role
-- platform-wide, the same ambient grant this file already replicates
-- for `extensions` above (see that grant's own comment) -- no migration
-- in this repo has ever needed to grant it itself, since it's always
-- already there on the real platform. This was never stubbed because
-- no test file before migration 047's own storage-policy suite ever
-- exercised storage.objects as a real non-superuser role; without it, a
-- real INSERT/SELECT/UPDATE/DELETE against storage.objects as anon/
-- authenticated fails with "permission denied for schema storage"
-- before ever reaching this schema's own RLS policies, masking the
-- exact policy behavior the affected suite exists to prove -- found and
-- confirmed the same way the analogous extensions-schema gap was
-- originally found (see that comment).
create schema if not exists storage;
grant usage on schema storage to anon, authenticated, service_role;
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
-- Same ambient-privilege pattern as `alter default privileges in schema
-- public grant all ... to anon, authenticated, service_role` above,
-- extended to storage's own tables -- the real platform grants this
-- broadly too (Supabase Storage's bucket policies are RLS-only, exactly
-- like this repo's own covers/manuscripts/avatars/blog policies, which
-- all assume the table grant is already ambiently present and RLS
-- alone does the real narrowing).
grant all on storage.buckets, storage.objects to anon, authenticated, service_role;
create or replace function storage.foldername(name text) returns text[]
  language sql immutable as $$ select string_to_array(name, '/') $$;
alter table storage.objects enable row level security;
