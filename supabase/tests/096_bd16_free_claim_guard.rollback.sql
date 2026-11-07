-- LOCAL/DISPOSABLE DATABASE, or an authorized database run only.
--
-- BD16 CF1 ROLLBACK: undoes migration
-- 20261106200000_bd16_free_claim_guard.sql. Drops the trigger and its
-- function; no row was changed by the migration, so nothing else is
-- left behind. Afterwards only the website's status check in
-- getFreeBook() guards a free claim again (as before).
--
-- Run only together with the app revert. Safe to run more than once.

begin;

drop trigger if exists purchases_free_claim_live_only on public.purchases;
drop function if exists public.purchases_free_claim_live_only();

commit;
