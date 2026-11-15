-- ============================================================
-- K8 + K10 (migration 20261115160000): the buyer's reading place,
-- bookmarks and highlights in the online reader.
-- Renato 11-15: K8 + K10 together, one patch, one migration. Picks:
-- buyers only, inside books they own (Q4 a); marks follow access, and a
-- refund or a deleted account deletes them for good (Q5 a); the most
-- recent place on any device wins (Q6 a); highlights whose words changed
-- in a new version are kept and labelled (Q3 a); per book at most 3,000
-- highlights and 500 bookmarks, a note at most 1,000 characters.
--
-- What it changes, and nothing else:
--   1. reading_places: one row per (reader, book): the place as a
--      character offset into the book's text, and the share read (0..1)
--      for the Biblioteka ime bar.
--   2. reader_bookmarks: a page, kept as the offset of its first
--      character.
--   3. reader_highlights: a span of the text (start/end offsets) with
--      its exact words and up to 64 characters on each side, so it can
--      be found again in a changed version; a colour; an optional note;
--      orphaned_at = the words were not found in the current text.
--   4. Row rules for all three: a signed-in reader reads and writes only
--      their own rows, and only while they own the book
--      (user_owns_book: refunds and lost disputes do not own). anon and
--      service_role get nothing (no server code uses these tables with
--      the service key).
--   5. The per-book limits, as a BEFORE INSERT trigger (one advisory
--      lock per reader and book, so two parallel inserts cannot pass the
--      limit together). SQLSTATE 23514 'reader_marks_limit'.
--   6. A refund deletes the reader's place, bookmarks and highlights for
--      that book (AFTER UPDATE OF refunded_at on purchases, null to set).
--      Account deletion deletes them through ON DELETE CASCADE on
--      profiles.
--   7. reader_highlights_reanchor(book, moves, not found): after a new
--      version, one call moves the highlights found again and marks the
--      ones not found (SECURITY INVOKER: the reader's own rules apply).
--
-- No row of any existing table changes. Nothing reads these tables
-- except the marks route (src/app/api/books/[id]/marks/route.ts) and
-- the Biblioteka ime page, both as the signed-in reader.
--
-- The declarative equivalent is in supabase/schema.sql; see
-- supabase/tests/099_reader_marks.test.sql.
-- Rollback: supabase/tests/099_reader_marks.rollback.sql
-- ============================================================

-- ------------------------------------------------------------
-- 1. The tables.
-- ------------------------------------------------------------
create table public.reading_places (
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  book_id uuid not null references public.books(id) on delete cascade,
  char_offset integer not null constraint reading_places_char_offset_check check (char_offset >= 0),
  progress numeric(5, 4) not null constraint reading_places_progress_check check (progress >= 0 and progress <= 1),
  updated_at timestamptz not null default now(),
  primary key (user_id, book_id)
);

create table public.reader_bookmarks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  book_id uuid not null references public.books(id) on delete cascade,
  char_offset integer not null constraint reader_bookmarks_char_offset_check check (char_offset >= 0),
  created_at timestamptz not null default now(),
  constraint reader_bookmarks_unique_place unique (user_id, book_id, char_offset)
);

create table public.reader_highlights (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  book_id uuid not null references public.books(id) on delete cascade,
  start_offset integer not null constraint reader_highlights_start_offset_check check (start_offset >= 0),
  end_offset integer not null,
  quote text not null constraint reader_highlights_quote_check check (char_length(quote) between 1 and 4000),
  prefix text not null default '' constraint reader_highlights_prefix_check check (char_length(prefix) <= 64),
  suffix text not null default '' constraint reader_highlights_suffix_check check (char_length(suffix) <= 64),
  color text not null constraint reader_highlights_color_check check (color in ('yellow', 'green', 'blue', 'pink')),
  note text constraint reader_highlights_note_check check (note is null or char_length(note) between 1 and 1000),
  orphaned_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reader_highlights_span_check check (end_offset > start_offset)
);

create index reader_bookmarks_user_book_idx on public.reader_bookmarks (user_id, book_id);
create index reader_highlights_user_book_idx on public.reader_highlights (user_id, book_id);
-- The FK to books is ON DELETE CASCADE; these keep a book delete cheap.
create index reading_places_book_idx on public.reading_places (book_id);
create index reader_bookmarks_book_idx on public.reader_bookmarks (book_id);
create index reader_highlights_book_idx on public.reader_highlights (book_id);

-- ------------------------------------------------------------
-- 4. Row rules and grants.
-- ------------------------------------------------------------
alter table public.reading_places enable row level security;
alter table public.reader_bookmarks enable row level security;
alter table public.reader_highlights enable row level security;

create policy "Readers manage their own place in books they own"
  on public.reading_places for all to authenticated
  using (user_id = auth.uid() and public.user_owns_book(book_id))
  with check (user_id = auth.uid() and public.user_owns_book(book_id));

create policy "Readers manage their own bookmarks in books they own"
  on public.reader_bookmarks for all to authenticated
  using (user_id = auth.uid() and public.user_owns_book(book_id))
  with check (user_id = auth.uid() and public.user_owns_book(book_id));

create policy "Readers manage their own highlights in books they own"
  on public.reader_highlights for all to authenticated
  using (user_id = auth.uid() and public.user_owns_book(book_id))
  with check (user_id = auth.uid() and public.user_owns_book(book_id));

revoke all on public.reading_places from public, anon, authenticated, service_role;
revoke all on public.reader_bookmarks from public, anon, authenticated, service_role;
revoke all on public.reader_highlights from public, anon, authenticated, service_role;

-- A place is written whole (upsert); a bookmark is added or removed,
-- never changed; a highlight keeps its owner, book and creation time.
grant select, insert, delete on public.reading_places to authenticated;
grant update (char_offset, progress, updated_at) on public.reading_places to authenticated;
grant select, insert, delete on public.reader_bookmarks to authenticated;
grant select, insert, delete on public.reader_highlights to authenticated;
grant update (start_offset, end_offset, color, note, orphaned_at, updated_at) on public.reader_highlights to authenticated;

-- ------------------------------------------------------------
-- 5. The per-book limits.
-- ------------------------------------------------------------
create or replace function public.reader_marks_enforce_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer;
  v_count integer;
begin
  v_limit := case tg_table_name when 'reader_highlights' then 3000 when 'reader_bookmarks' then 500 end;
  if v_limit is null then
    raise exception 'reader_marks_enforce_limit: unexpected table %', tg_table_name;
  end if;
  -- One lock per (table, reader, book) for the rest of the transaction.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(tg_table_name),
    pg_catalog.hashtext(new.user_id::text || '/' || new.book_id::text)
  );
  if tg_table_name = 'reader_highlights' then
    select pg_catalog.count(*) into v_count
      from public.reader_highlights h
     where h.user_id = new.user_id and h.book_id = new.book_id;
  else
    select pg_catalog.count(*) into v_count
      from public.reader_bookmarks m
     where m.user_id = new.user_id and m.book_id = new.book_id;
  end if;
  if v_count >= v_limit then
    raise exception 'reader_marks_limit' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.reader_marks_enforce_limit() from public, anon, authenticated, service_role;

create trigger reader_highlights_enforce_limit
  before insert on public.reader_highlights
  for each row execute function public.reader_marks_enforce_limit();

create trigger reader_bookmarks_enforce_limit
  before insert on public.reader_bookmarks
  for each row execute function public.reader_marks_enforce_limit();

-- ------------------------------------------------------------
-- 6. A refund deletes the reader's marks in that book (Q5 a).
-- ------------------------------------------------------------
create or replace function public.reader_marks_delete_on_refund()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.refunded_at is null and new.refunded_at is not null and new.reader_id is not null then
    delete from public.reading_places where user_id = new.reader_id and book_id = new.book_id;
    delete from public.reader_bookmarks where user_id = new.reader_id and book_id = new.book_id;
    delete from public.reader_highlights where user_id = new.reader_id and book_id = new.book_id;
  end if;
  return null;
end;
$$;

revoke all on function public.reader_marks_delete_on_refund() from public, anon, authenticated, service_role;

create trigger purchases_delete_reader_marks_on_refund
  after update of refunded_at on public.purchases
  for each row execute function public.reader_marks_delete_on_refund();

-- ------------------------------------------------------------
-- 7. After the author's new version: move the highlights found again and
--    mark the ones not found, in one call. SECURITY INVOKER: it runs as
--    the reader, so the row rules and column grants above still decide.
--    p_moves = [{"id": uuid, "start": int, "end": int}, ...]
-- ------------------------------------------------------------
create or replace function public.reader_highlights_reanchor(p_book_id uuid, p_moves jsonb, p_orphaned uuid[])
returns void
language sql
security invoker
set search_path = ''
as $$
  update public.reader_highlights h
     set start_offset = m.start_offset, end_offset = m.end_offset, orphaned_at = null, updated_at = pg_catalog.now()
    from pg_catalog.jsonb_to_recordset(coalesce(p_moves, '[]'::jsonb)) as m(id uuid, start_offset integer, end_offset integer)
   where h.id = m.id and h.book_id = p_book_id;
  update public.reader_highlights h
     set orphaned_at = pg_catalog.now(), updated_at = pg_catalog.now()
   where h.book_id = p_book_id and h.id = any(coalesce(p_orphaned, '{}'::uuid[])) and h.orphaned_at is null;
$$;

revoke all on function public.reader_highlights_reanchor(uuid, jsonb, uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.reader_highlights_reanchor(uuid, jsonb, uuid[]) to authenticated;
