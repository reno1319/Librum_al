-- ROLLBACK for migration 20261123140000_publishing_house_account_kind.sql.
-- LOCAL/DISPOSABLE DATABASE TEST, or a deliberate rollback only.
-- Revert the app first. Roll back 20261123160000_publishing_house_pages
-- first (112_publishing_house_pages.rollback.sql): its view reads this column. Lossy: every publishing house becomes an
-- ordinary author account (its role, pen names and books are untouched).
-- Drops profiles.account_kind and its two CHECKs.

begin;

alter table public.profiles
  drop constraint if exists profiles_publishing_house_is_author;

alter table public.profiles
  drop column if exists account_kind;

commit;
