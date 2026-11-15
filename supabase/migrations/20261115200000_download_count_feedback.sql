-- KOLIBER download count + K4 feedback button (Renato 2026-11-15).
-- ADDITIVE ONLY: one new table and four new functions. No drop, no
-- rename, no type change; no existing row, grant, policy or function
-- changes, nothing is backfilled.
--
-- ROLLOUT ORDER. Apply on staging BEFORE the application in the same
-- patch is deployed there. The old code keeps working after it (it
-- reads and writes nothing new). Production gets it only at a release.
--
-- WHAT CHANGES (his answers 2026-11-15):
--
--   1. book_download_count(book): the number on the book page ("N
--      shkarkime"). count a: one per person who got the book (bought or
--      took it free), however often they open it; count c b: no download
--      needed; refunded copies and lost bank disputes do not count (the
--      user_owns_book() predicate). Only a published book has a number
--      (0 otherwise), so a draft's or a taken-down book's count never
--      leaks. count b a: the page hides the line while it is 0. anon and
--      authenticated may call it; it returns a number only, never who.
--
--   2. public.reader_feedback: the "Na tregoni" button's messages.
--      feedback a b: signed-in only; feedback c a: kind (problem/idea),
--      text required (1-1000 characters after trimming), the page path
--      attached; feedback d a: staff see them in the admin, no email.
--      reader_id CASCADE: deleted with the account (Privacy page).
--      RLS on with no policy; anon, authenticated and service_role hold
--      nothing. Written only by submit_reader_feedback(), read only by
--      staff_list_reader_feedback(), closed only by
--      staff_set_reader_feedback_done().
--
--   3. submit_reader_feedback(kind, body, page): authenticated. The
--      caller's own account (auth.uid()); refuses a suspended account
--      (LB510), a bad kind (LB511), empty or over-long text (LB512), a
--      bad page path (LB513: not a site path, or a backslash or control
--      character, which a browser could turn into another site) and more
--      than 10 messages in an hour (LB514). Stores the text trimmed of spaces, no-break and
--      zero-width spaces at both ends.
--
--   4. staff_list_reader_feedback(status): reports.view. 'open', 'done'
--      or 'all', newest first, at most 200 rows. The sender's account
--      email only for staff with people.view (owner, admin; mod a),
--      null for everyone else (a moderator).
--
--   5. staff_set_reader_feedback_done(id, done): reports.resolve. Marks
--      a message done (or open again); records who and when.
--
-- The declarative equivalent is at the end of supabase/schema.sql; see
-- supabase/tests/100_download_count_feedback.test.sql and
-- 100_download_count_feedback.rollback.sql.

-- ------------------------------------------------------------
-- 1. The download count
-- ------------------------------------------------------------
create function public.book_download_count(p_book_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.count(*)::integer
    from public.purchases p
    join public.books b on b.id = p.book_id
   where p.book_id = p_book_id
     and b.status = 'published'
     and p.refunded_at is null
     and not public.payment_intent_has_lost_dispute(p.stripe_payment_intent_id);
$$;

revoke all on function public.book_download_count(uuid) from public, anon, authenticated, service_role;
grant execute on function public.book_download_count(uuid) to anon, authenticated;

-- ------------------------------------------------------------
-- 2. The feedback table
-- ------------------------------------------------------------
create table public.reader_feedback (
  id uuid primary key default gen_random_uuid(),
  reader_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null
    constraint reader_feedback_kind_check check (kind in ('problem', 'idea')),
  body text not null
    constraint reader_feedback_body_check check (char_length(body) between 1 and 1000),
  page_path text not null
    constraint reader_feedback_page_path_check check (
      char_length(page_path) between 1 and 300 and page_path like '/%' and page_path not like '//%'
      and page_path !~ '[\\[:cntrl:]]'
    ),
  created_at timestamptz not null default now(),
  done_at timestamptz,
  done_by uuid references public.profiles(id) on delete set null
);

create index reader_feedback_reader_created_idx on public.reader_feedback (reader_id, created_at);
create index reader_feedback_open_created_idx on public.reader_feedback (created_at) where done_at is null;

alter table public.reader_feedback enable row level security;

revoke all on public.reader_feedback from public, anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 3. Sending a message
-- ------------------------------------------------------------
create function public.submit_reader_feedback(p_kind text, p_body text, p_page_path text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_body text;
  v_recent integer;
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  if exists (
    select 1 from public.account_suspensions s
     where s.user_id = v_uid and s.lifted_at is null
  ) then
    raise exception 'submit_reader_feedback: account suspended' using errcode = 'LB510';
  end if;
  if p_kind is null or p_kind not in ('problem', 'idea') then
    raise exception 'submit_reader_feedback: invalid kind' using errcode = 'LB511';
  end if;
  -- Trim spaces, line breaks, no-break and zero-width spaces at both
  -- ends, so a message of only invisible characters is empty.
  v_body := pg_catalog.regexp_replace(
    coalesce(p_body, ''),
    '^[[:space:]\u00a0\u200b\u200c\u200d\u2060\ufeff]+|[[:space:]\u00a0\u200b\u200c\u200d\u2060\ufeff]+$',
    '',
    'g'
  );
  if pg_catalog.char_length(v_body) < 1 or pg_catalog.char_length(v_body) > 1000 then
    raise exception 'submit_reader_feedback: invalid text' using errcode = 'LB512';
  end if;
  if p_page_path is null
     or pg_catalog.char_length(p_page_path) not between 1 and 300
     or p_page_path not like '/%'
     or p_page_path like '//%'
     or p_page_path ~ '[\\[:cntrl:]]' then
    raise exception 'submit_reader_feedback: invalid page' using errcode = 'LB513';
  end if;

  -- One lock per sender, so two quick sends cannot both slip under the limit.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('reader_feedback'),
    pg_catalog.hashtext(v_uid::text)
  );
  select pg_catalog.count(*) into v_recent
    from public.reader_feedback f
   where f.reader_id = v_uid
     and f.created_at > pg_catalog.now() - interval '1 hour';
  if v_recent >= 10 then
    raise exception 'submit_reader_feedback: too many messages' using errcode = 'LB514';
  end if;

  insert into public.reader_feedback (reader_id, kind, body, page_path)
  values (v_uid, p_kind, v_body, p_page_path)
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.submit_reader_feedback(text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.submit_reader_feedback(text, text, text) to authenticated;

-- ------------------------------------------------------------
-- 4. The admin list
-- ------------------------------------------------------------
create function public.staff_list_reader_feedback(p_status text default 'open')
returns table (
  id uuid,
  kind text,
  body text,
  page_path text,
  sender_email text,
  created_at timestamptz,
  done_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_show_email boolean;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if not public.staff_has_permission('reports.view') then
    raise exception 'not authorized';
  end if;
  if coalesce(p_status, 'open') not in ('open', 'done', 'all') then
    raise exception 'invalid status';
  end if;

  -- Audit r1 F2 (Renato 11-15, mod a): a reader's email only for staff
  -- who may see people (owner, admin), as on the People page.
  v_show_email := public.staff_has_permission('people.view');

  return query
    select f.id, f.kind, f.body, f.page_path,
           case when v_show_email then au.email::text end,
           f.created_at, f.done_at
      from public.reader_feedback f
      left join auth.users au on au.id = f.reader_id
     where coalesce(p_status, 'open') = 'all'
        or (coalesce(p_status, 'open') = 'open' and f.done_at is null)
        or (p_status = 'done' and f.done_at is not null)
     order by f.created_at desc, f.id
     limit 200;
end;
$$;

revoke all on function public.staff_list_reader_feedback(text) from public, anon, authenticated, service_role;
grant execute on function public.staff_list_reader_feedback(text) to authenticated;

-- ------------------------------------------------------------
-- 5. Marking a message done
-- ------------------------------------------------------------
create function public.staff_set_reader_feedback_done(p_id uuid, p_done boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_found boolean;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if not public.staff_has_permission('reports.resolve') then
    raise exception 'not authorized';
  end if;
  if p_id is null or p_done is null then
    raise exception 'invalid arguments';
  end if;

  update public.reader_feedback f
     set done_at = case when p_done then coalesce(f.done_at, pg_catalog.now()) else null end,
         done_by = case when p_done then coalesce(f.done_by, auth.uid()) else null end
   where f.id = p_id;
  v_found := found;
  return v_found;
end;
$$;

revoke all on function public.staff_set_reader_feedback_done(uuid, boolean) from public, anon, authenticated, service_role;
grant execute on function public.staff_set_reader_feedback_done(uuid, boolean) to authenticated;
