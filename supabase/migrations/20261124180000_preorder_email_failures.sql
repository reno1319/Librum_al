-- G4 build 1 (Renato 11-24): staff learn when a pre-order reader email
-- fails. Watches the two reader emails sent from «Më njofto» rows (the
-- "book is out" and "pre-order cancelled" emails, g4q3 a) and all three
-- kinds of failure (g4q4 a):
--   address_refused  Resend refused this one reader's address (never
--                    retried by the sweep);
--   unclear          no clear answer (timeout, 5xx, a throw): it may
--                    have arrived (never retried by the sweep);
--   batch_refused    Resend refused the whole batch (for example the
--                    daily limit): the row is un-claimed and the next
--                    sweep tries again.
-- The app (src/lib/preorder-emails.ts) writes the two new columns with
-- the service role; a later successful claim clears them.
--
-- Owner and Admin (people.view, g4q6 a) list the failures on the admin
-- Today page and press "Send again" (the row waits again, g4q5 a) or
-- "Mark handled" (the row counts as sent: no more retry, g4e2 a). Each
-- press writes the audit log. A failed row stays until one of the two
-- (g4e1 a): the 30-day clean-up (src/lib/preorder-notify-cleanup.ts)
-- skips rows with send_failure set.
--
-- At most one alert email a day (g4q7 a): claim_preorder_failure_alert()
-- counts the failures since the last alert and stamps the alert, once
-- per Tirana day, under a row lock (service role only).
--
-- No existing row changes: both columns start null on every row.

-- ------------------------------------------------------------
-- 1. The failure on the request row
-- ------------------------------------------------------------
alter table public.preorder_notify_requests
  add column send_failure text,
  add column send_failed_at timestamptz,
  add constraint preorder_notify_requests_send_failure_check check (
    (send_failure is null and send_failed_at is null)
    or (send_failure in ('address_refused', 'unclear', 'batch_refused') and send_failed_at is not null)
  );

create index preorder_notify_requests_send_failed_idx
  on public.preorder_notify_requests (send_failed_at)
  where send_failure is not null;

-- ------------------------------------------------------------
-- 2. One alert email a day
-- ------------------------------------------------------------
create table public.preorder_failure_alert_state (
  id boolean primary key default true,
  last_alert_at timestamptz,
  constraint preorder_failure_alert_state_single_row check (id)
);

insert into public.preorder_failure_alert_state (id, last_alert_at) values (true, null);

alter table public.preorder_failure_alert_state enable row level security;
revoke all on public.preorder_failure_alert_state from public, anon, authenticated, service_role;

-- The number of failures to report now, or 0 (none new, or an alert
-- already went out this Tirana day). A non-zero answer stamps the alert.
create function public.claim_preorder_failure_alert()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_last timestamptz;
  v_count integer;
begin
  select s.last_alert_at into v_last
    from public.preorder_failure_alert_state s
   where s.id
   for update;
  if not found then
    insert into public.preorder_failure_alert_state (id, last_alert_at) values (true, null)
    on conflict (id) do nothing;
    v_last := null;
  end if;

  if v_last is not null
     and (v_last at time zone 'Europe/Tirane')::date = (pg_catalog.now() at time zone 'Europe/Tirane')::date then
    return 0;
  end if;

  select pg_catalog.count(*)::integer into v_count
    from public.preorder_notify_requests r
   where r.send_failure is not null
     and (v_last is null or r.send_failed_at > v_last);

  if v_count = 0 then
    return 0;
  end if;

  update public.preorder_failure_alert_state
     set last_alert_at = pg_catalog.now()
   where id;
  return v_count;
end;
$$;

revoke all on function public.claim_preorder_failure_alert() from public, anon, authenticated, service_role;
grant execute on function public.claim_preorder_failure_alert() to service_role;

-- ------------------------------------------------------------
-- 3. Staff: list, send again, mark handled (people.view)
-- ------------------------------------------------------------
create function public.staff_list_preorder_email_failures()
returns table (
  book_id uuid,
  user_id uuid,
  book_title text,
  reader_name text,
  email_kind text,
  send_failure text,
  send_failed_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if not public.staff_has_permission('people.view') then
    raise exception 'not authorized';
  end if;

  return query
    select r.book_id,
           r.user_id,
           b.title,
           p.display_name,
           case when r.book_cancelled_at is null then 'released' else 'cancelled' end,
           r.send_failure,
           r.send_failed_at
      from public.preorder_notify_requests r
      join public.books b on b.id = r.book_id
      left join public.profiles p on p.id = r.user_id
     where r.send_failure is not null
     order by r.send_failed_at desc, r.book_id, r.user_id
     limit 200;
end;
$$;

revoke all on function public.staff_list_preorder_email_failures() from public, anon, authenticated, service_role;
grant execute on function public.staff_list_preorder_email_failures() to authenticated;

-- "Send again": the row waits again; the app then runs the sweep. False
-- when the row has no failure (already handled, or gone).
create function public.staff_resend_preorder_email(p_book_id uuid, p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_failure text;
begin
  if v_actor is null then
    raise exception 'not authenticated';
  end if;
  if not public.staff_has_permission('people.view') then
    raise exception 'not authorized';
  end if;
  if p_book_id is null or p_user_id is null then
    raise exception 'invalid arguments';
  end if;

  select r.send_failure into v_failure
    from public.preorder_notify_requests r
   where r.book_id = p_book_id and r.user_id = p_user_id and r.send_failure is not null
   for update;
  if not found then
    return false;
  end if;

  update public.preorder_notify_requests
     set notified_at = null,
         send_failure = null,
         send_failed_at = null
   where book_id = p_book_id and user_id = p_user_id;

  insert into public.admin_audit_log (actor_id, action, target_type, target_id, metadata)
  values (v_actor, 'preorder_email.send_again', 'books', p_book_id,
          jsonb_build_object('user_id', p_user_id, 'failure', v_failure));
  return true;
end;
$$;

revoke all on function public.staff_resend_preorder_email(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.staff_resend_preorder_email(uuid, uuid) to authenticated;

-- "Mark handled": staff dealt with the reader; the row counts as sent,
-- so the sweep sends nothing more for it (g4e2 a).
create function public.staff_mark_preorder_email_handled(p_book_id uuid, p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_failure text;
begin
  if v_actor is null then
    raise exception 'not authenticated';
  end if;
  if not public.staff_has_permission('people.view') then
    raise exception 'not authorized';
  end if;
  if p_book_id is null or p_user_id is null then
    raise exception 'invalid arguments';
  end if;

  select r.send_failure into v_failure
    from public.preorder_notify_requests r
   where r.book_id = p_book_id and r.user_id = p_user_id and r.send_failure is not null
   for update;
  if not found then
    return false;
  end if;

  update public.preorder_notify_requests
     set notified_at = coalesce(notified_at, pg_catalog.now()),
         send_failure = null,
         send_failed_at = null
   where book_id = p_book_id and user_id = p_user_id;

  insert into public.admin_audit_log (actor_id, action, target_type, target_id, metadata)
  values (v_actor, 'preorder_email.handled', 'books', p_book_id,
          jsonb_build_object('user_id', p_user_id, 'failure', v_failure));
  return true;
end;
$$;

revoke all on function public.staff_mark_preorder_email_handled(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.staff_mark_preorder_email_handled(uuid, uuid) to authenticated;
