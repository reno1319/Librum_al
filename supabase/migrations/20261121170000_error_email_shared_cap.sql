-- N18 (Renato 11-21, e1 a, e2 a): one daily limit for error emails,
-- shared by every server instance. ALERTS-1/2 (src/lib/error-alerts.ts)
-- kept the count in memory, so each Vercel instance had its own 3 a day
-- and many instances could eat Resend's free 100 a day that sign-up and
-- password emails also need. Site errors and nightly-job failures share
-- this one count (e2 a).
--
-- One new table (a single row) and one new function. Nothing existing
-- changes.
--
--   1. error_email_throttle: one row, created by the first claim. The
--      UTC day it counts, how many error emails went out that day, and
--      when the last one went out. RLS on, no policies, no grants: only
--      the function below touches it.
--
--   2. claim_error_email_slot(p_per_day, p_min_interval_seconds):
--      SECURITY DEFINER, search_path ''. Returns true and records a send
--      when fewer than p_per_day went out this UTC day AND the last one
--      is at least p_min_interval_seconds old (the hour gap holds across
--      midnight, as before); otherwise false and nothing changes. One
--      INSERT .. ON CONFLICT DO UPDATE .. WHERE, so two instances asking
--      at the same moment cannot both pass the limit. The database
--      clock decides, not the instance's. EXECUTE for service_role only.
--
-- ROLLOUT ORDER: either order is safe. Until the function exists, or
-- whenever the database cannot be reached, the application falls back
-- to its old per-instance count (e1 a).

create table public.error_email_throttle (
  id boolean primary key default true
    constraint error_email_throttle_single_row check (id),
  day date not null,
  sent_today integer not null
    constraint error_email_throttle_sent_today_check check (sent_today >= 0),
  last_sent_at timestamptz not null
);

comment on table public.error_email_throttle is
  'N18: the one shared count of error emails (src/lib/error-alerts.ts). A single row; written only by claim_error_email_slot().';

alter table public.error_email_throttle enable row level security;
revoke all on public.error_email_throttle from public, anon, authenticated, service_role;

create function public.claim_error_email_slot(p_per_day integer, p_min_interval_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.now();
  v_day date := (pg_catalog.timezone('UTC', v_now))::date;
  v_claimed boolean;
begin
  if p_per_day is null or p_per_day < 1 or p_per_day > 100 then
    raise exception 'p_per_day must be between 1 and 100' using errcode = '22023';
  end if;
  if p_min_interval_seconds is null or p_min_interval_seconds < 0 or p_min_interval_seconds > 86400 then
    raise exception 'p_min_interval_seconds must be between 0 and 86400' using errcode = '22023';
  end if;

  insert into public.error_email_throttle as t (id, day, sent_today, last_sent_at)
  values (true, v_day, 1, v_now)
  on conflict (id) do update
    set day = excluded.day,
        sent_today = case when t.day = excluded.day then t.sent_today + 1 else 1 end,
        last_sent_at = excluded.last_sent_at
    where (t.day <> excluded.day or t.sent_today < p_per_day)
      and t.last_sent_at <= excluded.last_sent_at - pg_catalog.make_interval(secs => p_min_interval_seconds)
  returning true into v_claimed;

  return coalesce(v_claimed, false);
end;
$$;

comment on function public.claim_error_email_slot(integer, integer) is
  'N18: true (and the send is counted) when an error email may go out now under the shared daily and hourly limit; false otherwise.';

revoke all on function public.claim_error_email_slot(integer, integer) from public, anon, authenticated;
grant execute on function public.claim_error_email_slot(integer, integer) to service_role;
