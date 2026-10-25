-- HOME-PICKS-1 (brief "home cover fan and Bookstore shelf", Patch 2):
-- the three home page cover slots staff fill by hand, each with a
-- "Sponsored" tick. ADDITIVE ONLY: one new table, one new view and two
-- new functions. No drop, no rename, no type change; no existing row,
-- grant, policy or function changes.
--
-- ROLLOUT ORDER. The application in the same patch works BEFORE and
-- AFTER this migration: the home page and the admin page treat a missing
-- view or function (42P01, 42883, PGRST202, PGRST205) as "no slots
-- filled", and then the home fan shows the newest books. So code and
-- migration may land on staging in either order. Production gets it only
-- at a release, through the authorized route.
--
-- WHAT CHANGES (Renato 2026-10-25: 3 slots on phone and desktop, middle
-- slot in front; an empty or no-longer-live slot falls back to the
-- newest book; paid spots have no end date; free books allowed; one
-- book per slot, never two slots; a pick records Paid yes/no each time):
--
--   1. public.home_featured_slots: at most one row per slot 1..3 (slot 1
--      is the middle, front cover). A row exists only while a book is
--      in the slot (book_id not null, ON DELETE CASCADE: deleting the
--      book empties its slot). book_id is unique, so one book fills at
--      most one slot. sponsored = the slot is a paid placement; the home
--      page shows a "Sponsored" tag on it. set_by (SET NULL when the
--      account is deleted) and set_at record the last change.
--        * RLS on with no policy; anon, authenticated and PUBLIC hold
--          nothing (set_by is a staff account id); service_role holds
--          SELECT only. Rows are written only by the two functions below.
--
--   2. public.public_home_featured_slots: the public read path, a
--      definer view (owner postgres, like public_books) with slot,
--      book_id and sponsored only, and only for slots whose book is
--      published right now. A book that is unpublished, taken down,
--      out of the store for review or hidden by a suspension is
--      status 'draft', so its slot is simply absent and the page falls
--      back. anon, authenticated and service_role hold SELECT only.
--
--   3. set_home_featured_slot(slot, book, sponsored, set_by) and
--      clear_home_featured_slot(slot): service_role only. The admin
--      Server Actions call them after requireStaff("catalog.feature"),
--      exactly like set_librum_choice. Both are SECURITY DEFINER (owned
--      by the migration owner, search_path ''), because service_role
--      itself may only read the table. Both take one transaction-level
--      advisory lock, so concurrent changes are serialized. set_ returns
--        'ok'           the slot now holds the book with that tick;
--        'not_eligible' the book is missing, not published, has no cover
--                       or no price (free = 0 counts); nothing changed;
--        'in_slot_N'    the book already fills slot N (1, 2 or 3);
--                       nothing changed.
--      Re-saving the same book in the same slot only changes the tick.
--      A bad slot number or a null argument raises (the app never sends
--      one).
--
-- UNCHANGED: books.librum_choice_at and its functions (Librum's choice
-- stays on the Bookstore), every existing table, view, function, grant
-- and policy.
--
-- The declarative equivalent is in supabase/schema.sql; see
-- supabase/tests/083_home_featured_slots.test.sql and
-- 083_home_featured_slots_catalog_equivalence.sh.

-- ------------------------------------------------------------
-- 1. The slots
-- ------------------------------------------------------------
create table public.home_featured_slots (
  slot smallint primary key
    constraint home_featured_slots_slot_check check (slot between 1 and 3),
  book_id uuid not null references public.books(id) on delete cascade
    constraint home_featured_slots_book_id_key unique,
  sponsored boolean not null default false,
  set_by uuid references public.profiles(id) on delete set null,
  set_at timestamptz not null default now()
);

create index home_featured_slots_set_by_idx
  on public.home_featured_slots (set_by);

alter table public.home_featured_slots enable row level security;

revoke all on public.home_featured_slots from public, anon, authenticated, service_role;
grant select on public.home_featured_slots to service_role;

-- ------------------------------------------------------------
-- 2. The public read path
-- ------------------------------------------------------------
create view public.public_home_featured_slots
  with (security_barrier)
as
  select s.slot, s.book_id, s.sponsored
  from public.home_featured_slots s
  join public.books b on b.id = s.book_id
  where b.status = 'published';

revoke all on public.public_home_featured_slots from public, anon, authenticated, service_role;
grant select on public.public_home_featured_slots to anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 3. The writers
-- ------------------------------------------------------------
create function public.set_home_featured_slot(
  p_slot smallint,
  p_book_id uuid,
  p_sponsored boolean,
  p_set_by uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_other_slot smallint;
begin
  if p_slot is null or p_slot not between 1 and 3 then
    raise exception 'home slot must be 1, 2 or 3';
  end if;
  if p_book_id is null or p_sponsored is null then
    raise exception 'home slot needs a book and a sponsored value';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('public.home_featured_slots'));

  -- FOR SHARE: an unpublish racing this waits, and a book that stops
  -- being eligible afterwards simply drops out of the public view.
  perform 1 from public.books
   where id = p_book_id
     and status = 'published'
     and cover_path is not null
     and price_all is not null
     for share;
  if not found then
    return 'not_eligible';
  end if;

  select slot into v_other_slot
    from public.home_featured_slots
   where book_id = p_book_id and slot <> p_slot;
  if found then
    return 'in_slot_' || v_other_slot;
  end if;

  insert into public.home_featured_slots (slot, book_id, sponsored, set_by, set_at)
  values (p_slot, p_book_id, p_sponsored, p_set_by, now())
  on conflict (slot) do update
    set book_id = excluded.book_id,
        sponsored = excluded.sponsored,
        set_by = excluded.set_by,
        set_at = excluded.set_at;
  return 'ok';
end;
$$;

create function public.clear_home_featured_slot(p_slot smallint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_slot is null or p_slot not between 1 and 3 then
    raise exception 'home slot must be 1, 2 or 3';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('public.home_featured_slots'));

  delete from public.home_featured_slots where slot = p_slot;
end;
$$;

revoke all on function public.set_home_featured_slot(smallint, uuid, boolean, uuid) from public, anon, authenticated, service_role;
revoke all on function public.clear_home_featured_slot(smallint) from public, anon, authenticated, service_role;
grant execute on function public.set_home_featured_slot(smallint, uuid, boolean, uuid) to service_role;
grant execute on function public.clear_home_featured_slot(smallint) to service_role;
