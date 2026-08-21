-- Run this ONLY if you already ran supabase/schema.sql before this file
-- existed. Adds a third profiles.role value, 'admin', for durable,
-- server-enforced marketplace-operator authorization -- see the Phase
-- REFUND-1A audit for why this exists and how the self-promotion risks
-- it introduces are closed in the same migration, not left as a
-- follow-up.
--
-- profiles.role is a CHECK constraint on a plain text column, not a
-- native Postgres ENUM type (confirmed by reading schema.sql before
-- writing this migration -- `role text not null check (role in
-- ('author', 'reader'))`) -- so "add a value" here means dropping and
-- recreating that CHECK constraint with the new value included, not any
-- of the ALTER TYPE ... ADD VALUE machinery a real enum would need.
-- This does not touch any existing row's data.
--
-- The constraint is located dynamically rather than by an assumed name
-- (an earlier draft of this migration assumed Postgres's default
-- auto-generated name, profiles_role_check -- correct for how this
-- table was actually declared, but not something worth depending on
-- when a deterministic lookup is just as easy): this finds whatever
-- check constraint actually governs the role column, by column
-- position (conkey), which is how Postgres itself tracks constraint-to-
-- column ownership regardless of the constraint's name.
do $$
declare
  v_constraint_name text;
  v_role_attnum smallint;
begin
  select attnum into v_role_attnum
  from pg_attribute
  where attrelid = 'public.profiles'::regclass
    and attname = 'role'
    and not attisdropped;

  select con.conname into v_constraint_name
  from pg_constraint con
  where con.conrelid = 'public.profiles'::regclass
    and con.contype = 'c'
    and con.conkey = array[v_role_attnum];

  if v_constraint_name is not null then
    execute format('alter table public.profiles drop constraint %I', v_constraint_name);
  end if;
end;
$$;

alter table public.profiles
  add constraint profiles_role_check check (role in ('author', 'reader', 'admin'));

-- Closes a self-promotion path that would otherwise open the moment
-- 'admin' becomes a valid value: handle_new_user() (defined in
-- schema.sql, bound to the on_auth_user_created trigger) inserts
-- profiles.role directly from auth.users.raw_user_meta_data->>'role',
-- which is signup-time metadata the CLIENT supplies (see
-- src/app/auth/actions.ts's signup() -- it passes the submitted form
-- field straight through as auth.signUp()'s options.data.role, with no
-- server-side validation of its value). Before this migration, the only
-- thing stopping role='admin' from reaching profiles was the CHECK
-- constraint itself rejecting it and failing the whole signup -- once
-- 'admin' becomes a valid value, that protection disappears unless this
-- function is also hardened.
--
-- CREATE OR REPLACE keeps the function's existing name, signature, and
-- trigger binding untouched -- only the role-resolution logic changes.
-- Whitelist, not blacklist: anything other than exactly 'author'
-- becomes 'reader', so 'admin' (or any other future value) can NEVER
-- reach profiles.role through signup, regardless of what a crafted
-- request submits -- independent of and in addition to the
-- application-level validation added alongside this migration in
-- src/app/auth/actions.ts.
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, role, display_name)
  values (
    new.id,
    case
      when new.raw_user_meta_data->>'role' = 'author' then 'author'
      else 'reader'
    end,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1))
  );
  return new;
end;
$$ language plpgsql security definer set search_path = public;

-- Closes the second self-promotion path: profiles' existing UPDATE
-- policy ("Users can update their own profile") is row-scoped only
-- (auth.uid() = id), never column-restricted -- so nothing before this
-- migration stopped an authenticated user from PATCHing their own
-- profiles.role directly via a raw API call (the app's own UI never
-- exposes a role field to edit, but RLS alone doesn't know that).
--
-- A column-scoped REVOKE alone -- `revoke update (role) on
-- public.profiles from authenticated` -- was tried in an earlier draft
-- of this migration and found, on review, to be INSUFFICIENT: Postgres
-- table-level and column-level grants are independent, additive ACL
-- entries, not a hierarchy where a narrower REVOKE overrides a broader,
-- still-standing GRANT. authenticated already holds table-level UPDATE
-- on public.profiles (this project's own default Supabase privilege
-- provisioning -- confirmed directly against the live database via
-- information_schema.role_table_grants, not merely inferred), and a
-- column-scoped REVOKE cannot narrow that standing table-level grant --
-- it only removes a column-level ACL entry that was never separately
-- granted in the first place, so it changes nothing.
--
-- The correct, deterministic fix: revoke the table-level grant
-- entirely, then re-grant UPDATE only on the columns authenticated
-- legitimately needs. Confirmed by tracing every UPDATE this codebase
-- issues against profiles via the request-scoped (non-admin) client:
-- only display_name/bio/avatar_path, all from
-- src/app/dashboard/profile/actions.ts's updateProfile(). role,
-- stripe_account_id, and stripe_payouts_enabled are written exclusively
-- via the admin/service-role client (src/app/dashboard/payouts/
-- actions.ts, src/app/dashboard/payouts/page.tsx) -- service_role is a
-- separate privilege grantee entirely and is completely unaffected by
-- anything revoked from authenticated here.
--
-- This also retroactively closes the identical, already-shipped gap in
-- migration 003 for stripe_account_id/stripe_payouts_enabled: that
-- migration's own column-scoped revoke on those two columns had the
-- same limitation, for the same reason, and is superseded by this
-- table-level revoke (which removes ALL of authenticated's table-level
-- UPDATE, not just on role) followed by the narrow re-grant below.
revoke update on public.profiles from authenticated;

grant update (display_name, bio, avatar_path)
  on public.profiles
  to authenticated;
