-- LR1 PATCH 4 (Renato 2026-11-25/26: lb2 a, lb3 a, lb6 a, lb8 a, lr4-1 a,
-- lr4-2 a, lr4-3 a, lr4-4 a, lr4-5): "Çfarë po lexojmë" on Libraria.
--
-- WHAT CHANGES:
--   1. public.libraria_reading_picks: one row per pick. A pick is a book
--      staff choose, an optional badge (at most 24 characters; the admin
--      form starts it as "Zgjedhja e Librum", lr4-4 a), the note staff
--      write (why we read it, at most 400 characters, lb2 a), a quote
--      (at most 240 characters) and whether the quote is from the book or
--      from the author (lb8 a), and when it was published. Publishing
--      happens when staff save a new pick (lr4-1 a); editing keeps the
--      date. Staff with catalog.feature read every row; nobody writes it
--      directly.
--   2. public.public_libraria_reading_picks: what readers see. Only picks
--      whose book Libraria lists now (published or pre-order, priced).
--      The newest is the one on Libraria; all of them, newest first, are
--      on the "Më shumë" page (lr4-2 a). A pick whose book stops being
--      listed hides everywhere and comes back with the book, so Libraria
--      shows the newest pick that is still on sale (lr4-3 a). Everyone
--      may read it.
--   3. staff_save_libraria_reading_pick() and
--      staff_delete_libraria_reading_pick(): catalog.feature (owner and
--      admin), checked inside, each audited. Saving refuses a book
--      Libraria does not list (LB540).
--
--   4. public.staff_has_permission(): an admin now has catalog.feature
--      in the database too (lr4-6 a). The website already gives it to
--      owner and admin (src/lib/staff-permissions.ts), but until now the
--      database knew it only for the owner, so an admin's saves on Admin
--      › Libraria (category buttons, banner slides, picks) were refused.
--      The function is otherwise unchanged (same body as migration
--      20261119180000_blog_categories_manage, plus 'catalog.feature' in
--      the admin list); create or replace keeps its grants.
--
-- No existing row changes. No storage change.

-- ------------------------------------------------------------
-- 1. The picks.
-- ------------------------------------------------------------
create table public.libraria_reading_picks (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.books (id) on delete cascade,
  badge text
    constraint libraria_reading_picks_badge_check
    check (badge is null
           or (badge = pg_catalog.btrim(badge)
               and pg_catalog.char_length(badge) between 1 and 24
               and badge !~ '[\r\n]')),
  note text not null
    constraint libraria_reading_picks_note_check
    check (note = pg_catalog.btrim(note)
           and pg_catalog.char_length(note) between 1 and 400
           and note !~ '[\r\n]'),
  quote text not null
    constraint libraria_reading_picks_quote_check
    check (quote = pg_catalog.btrim(quote)
           and pg_catalog.char_length(quote) between 1 and 240
           and quote !~ '[\r\n]'),
  quote_from text not null
    constraint libraria_reading_picks_quote_from_check
    check (quote_from in ('book', 'author')),
  published_at timestamptz not null default pg_catalog.now(),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now()
);

create index libraria_reading_picks_book_id_idx on public.libraria_reading_picks (book_id);
create index libraria_reading_picks_published_at_idx on public.libraria_reading_picks (published_at desc);

alter table public.libraria_reading_picks enable row level security;

revoke all on public.libraria_reading_picks from public, anon, authenticated, service_role;
grant select on public.libraria_reading_picks to authenticated, service_role;

create policy libraria_reading_picks_staff_read
  on public.libraria_reading_picks
  for select
  to authenticated
  using (public.staff_has_permission('catalog.feature'));

create policy libraria_reading_picks_service_read
  on public.libraria_reading_picks
  for select
  to service_role
  using (true);

comment on table public.libraria_reading_picks is
  'LR1 patch 4: the Libraria "Çfarë po lexojmë" picks. Written only by the staff_*_libraria_reading_pick() functions.';

-- ------------------------------------------------------------
-- 2. What readers see: picks whose book Libraria lists now.
-- ------------------------------------------------------------
create view public.public_libraria_reading_picks
  with (security_barrier)
as
  select p.id, p.book_id, p.badge, p.note, p.quote, p.quote_from, p.published_at
  from public.libraria_reading_picks p
  join public.books b on b.id = p.book_id
  where public.book_is_publicly_listed(b)
    and b.price_all is not null;

revoke all on public.public_libraria_reading_picks from public, anon, authenticated, service_role;
grant select on public.public_libraria_reading_picks to anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 3. Staff functions.
-- ------------------------------------------------------------
create function public.staff_save_libraria_reading_pick(
  p_id uuid,
  p_book_id uuid,
  p_badge text,
  p_note text,
  p_quote text,
  p_quote_from text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_id uuid;
  v_badge text := nullif(pg_catalog.btrim(coalesce(p_badge, '')), '');
  v_note text := pg_catalog.btrim(coalesce(p_note, ''));
  v_quote text := pg_catalog.btrim(coalesce(p_quote, ''));
  v_before jsonb;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('catalog.feature') then
    raise exception 'not authorized';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('public.libraria_reading_picks'));

  if not exists (
    select 1 from public.books b
     where b.id = p_book_id
       and public.book_is_publicly_listed(b)
       and b.price_all is not null
  ) then
    raise exception 'That book is not on Libraria now.'
      using errcode = 'LB540';
  end if;

  if p_id is null then
    -- A new pick is published now and becomes the one on Libraria
    -- (lr4-1 a).
    insert into public.libraria_reading_picks (book_id, badge, note, quote, quote_from)
    values (p_book_id, v_badge, v_note, v_quote, p_quote_from)
    returning id into v_id;
  else
    select pg_catalog.to_jsonb(p.*) into v_before
      from public.libraria_reading_picks p
     where p.id = p_id
       for update;
    if v_before is null then
      return null;
    end if;
    -- Editing keeps the published date, so it does not change which
    -- pick is the newest.
    update public.libraria_reading_picks
       set book_id = p_book_id,
           badge = v_badge,
           note = v_note,
           quote = v_quote,
           quote_from = p_quote_from,
           updated_at = pg_catalog.now()
     where id = p_id
    returning id into v_id;
  end if;

  insert into public.admin_audit_log (actor_id, action, target_type, target_id, metadata)
  values (v_actor_id, 'libraria.reading_pick_saved', 'libraria_reading_picks', v_id,
          pg_catalog.jsonb_build_object(
            'before', v_before,
            'after', (select pg_catalog.to_jsonb(p.*) from public.libraria_reading_picks p where p.id = v_id)));
  return v_id;
end;
$$;

revoke all on function public.staff_save_libraria_reading_pick(uuid, uuid, text, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.staff_save_libraria_reading_pick(uuid, uuid, text, text, text, text) to authenticated;

create function public.staff_delete_libraria_reading_pick(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_before jsonb;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('catalog.feature') then
    raise exception 'not authorized';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('public.libraria_reading_picks'));

  delete from public.libraria_reading_picks p
   where p.id = p_id
  returning pg_catalog.to_jsonb(p.*) into v_before;

  if v_before is null then
    return false;
  end if;

  insert into public.admin_audit_log (actor_id, action, target_type, target_id, metadata)
  values (v_actor_id, 'libraria.reading_pick_deleted', 'libraria_reading_picks', p_id,
          pg_catalog.jsonb_build_object('before', v_before));
  return true;
end;
$$;

revoke all on function public.staff_delete_libraria_reading_pick(uuid) from public, anon, authenticated, service_role;
grant execute on function public.staff_delete_libraria_reading_pick(uuid) to authenticated;

-- ------------------------------------------------------------
-- 4. Admin gets catalog.feature in the database too (lr4-6 a).
-- ------------------------------------------------------------
create or replace function public.staff_has_permission(p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.staff_members sm
    where sm.user_id = auth.uid()
      and (
        sm.role = 'owner'
        or (
          sm.role = 'admin'
          and p_permission in (
            'admin.access', 'reports.view', 'reports.resolve',
            'refunds.view', 'refunds.resolve', 'staff.view', 'audit.view',
            'finance.view', 'finance.payout_export', 'finance.payout_operate',
            'blog.view', 'blog.manage', 'blog.categories', 'books.review',
            'people.view', 'people.manage', 'catalog.feature'
          )
        )
        or (
          sm.role = 'editor'
          and p_permission in ('admin.access', 'blog.view', 'blog.manage')
        )
        or (
          sm.role = 'moderator'
          and p_permission in ('admin.access', 'reports.view', 'reports.resolve')
        )
        or (
          sm.role = 'support'
          and p_permission in ('admin.access', 'refunds.view')
        )
      )
  );
$$;
