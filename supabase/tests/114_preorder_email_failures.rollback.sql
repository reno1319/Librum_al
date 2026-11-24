-- ROLLBACK for migration 20261124180000_preorder_email_failures.sql.
-- LOCAL/DISPOSABLE DATABASE TEST, or a deliberate rollback only.
-- Safe to run twice. Lossy only for what the migration added: the
-- failure marks on «Më njofto» rows and the last alert time. A row
-- marked 'batch_refused' is already un-claimed, so the old sweep still
-- retries it; 'address_refused' and 'unclear' rows stay counted as sent,
-- exactly as the old code left them. Deploy the old app first.

begin;

drop function if exists public.staff_mark_preorder_email_handled(uuid, uuid);
drop function if exists public.staff_resend_preorder_email(uuid, uuid);
drop function if exists public.staff_list_preorder_email_failures();
drop function if exists public.claim_preorder_failure_alert();
drop table if exists public.preorder_failure_alert_state;

drop index if exists public.preorder_notify_requests_send_failed_idx;
alter table public.preorder_notify_requests
  drop constraint if exists preorder_notify_requests_send_failure_check,
  drop column if exists send_failed_at,
  drop column if exists send_failure;

commit;
