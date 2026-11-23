-- BUILD 2a-1 (publishing houses, Renato 11-23: sg4 a, pf3 a): an
-- account kind on profiles. A publishing house is an ordinary author
-- account (profiles.role stays 'author', so every author check, grant
-- and RLS rule applies unchanged) whose account_kind is
-- 'publishing_house'. Everyone else is 'person'.
--
-- Written only by the server with the service role: at sign-up
-- ("Shtëpi botuese"), and when a reader chooses "Bëhuni shtëpi
-- botuese". No grant changes: `authenticated` may update only
-- display_name and public_author_name (column grants, migration
-- 20261019222500), so a signed-in user can't change their own kind.
-- SELECT stays own row + staff (RLS, migration 046).
--
-- A publishing house is always an author account: a reader or any other
-- role can't carry the house kind.

alter table public.profiles
  add column account_kind text not null default 'person'
    constraint profiles_account_kind_check
      check (account_kind in ('person', 'publishing_house'));

alter table public.profiles
  add constraint profiles_publishing_house_is_author
    check (account_kind = 'person' or role = 'author');
