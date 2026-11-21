-- ROLLBACK for migration 20261121170000_error_email_shared_cap.sql.
-- LOCAL/DISPOSABLE DATABASE TEST, or a deliberate rollback only.
-- Lossy only for today's shared count, which nothing else reads. The
-- application then falls back to its per-instance count (e1 a), the
-- behaviour before N18.

begin;

drop function if exists public.claim_error_email_slot(integer, integer);
drop table if exists public.error_email_throttle;

commit;
