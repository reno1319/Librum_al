-- BOOK-PEN-NAME-RIGHTS-CHOICE-1 (fix step F3): the one database change
-- for a per-book pen name, the author's rights declaration with who and
-- when, and the "Librum's choice" pick. ADDITIVE ONLY: no drop, no
-- rename, no type change, and no existing row is rewritten.
--
-- ROLLOUT ORDER. The application in the same patch works BEFORE and
-- AFTER this migration: its new reads and writes treat a missing
-- column, table or function (42703, 42P01, 42883 and PostgREST's
-- PGRST202/PGRST204/PGRST205) as "feature off" and nothing in a page,
-- layout or route calls them yet. So the code may be merged and deployed
-- first and this migration applied afterwards, on staging and then on
-- Production, through the authorized migration route only; there is no
-- broken window in either order.
--
-- WHAT CHANGES, and nothing else:
--
--   1. books.pen_name (text, null = use the author's public name, which
--      is today's byline). 1..120 characters with no leading or trailing
--      space, tab, CR or LF; 120 is public_author_name's own limit
--      (migration 045). Public like the title: readable through the
--      existing books SELECT grants and policies. Not insertable or
--      updatable by anon or authenticated: their books grants name
--      columns (migration 20260924141734), so a new column gets none.
--      Written only by the Server Actions through the service role.
--
--   2. public.book_rights_declarations: an append-only history of which
--      rights basis an author claimed for a book ('own_rights' or
--      'public_domain'), with the exact sentence shown, its version, the
--      book's title and the author's public name at that moment, and
--      when. The current choice is the newest row for the book.
--        * The record outlives the book and the account (Renato,
--          2026-10-18 "Keep it"): both foreign keys are ON DELETE SET
--          NULL and the title and name are copies. How long rows are
--          kept, and keeping a deleted account's public name, are
--          questions for the lawyer review before launch.
--        * anon and authenticated hold no write privilege at all. An
--          author may read only their own rows. Rows are inserted by a
--          server function through the service role after it checks the
--          caller owns the book. service_role holds SELECT and INSERT
--          only (no UPDATE, DELETE or TRUNCATE); deleting rows needs the
--          owner role through the authorized migration route.
--        * A BEFORE UPDATE trigger refuses every UPDATE, for every role
--          including the table owner, except book_id or author_id
--          becoming null when the book or profile it pointed at no
--          longer exists: the foreign keys' own SET NULL path. A direct
--          null on a live parent is refused, so a record cannot be
--          detached from a book that still exists.
--
--   3. books.librum_choice_at (timestamptz, null = not picked) and a
--      partial unique index so at most ONE book is picked at a time.
--      Readable like the title; written only by
--      public.set_librum_choice / public.clear_librum_choice, which only
--      service_role may execute. Both take one transaction-level
--      advisory lock, so two concurrent picks are serialized instead of
--      one failing on the unique index. A refused pick (the book is
--      missing or not published) changes nothing: the current pick
--      stays.
--
-- UNCHANGED: every existing column, row, grant, policy, function and
-- trigger. staff_has_permission() is not changed: the TypeScript
-- permission catalog.feature gates the staff action, and the two
-- functions here are service_role-only and never call it.
--
-- The declarative equivalent is in supabase/schema.sql; see
-- supabase/tests/072_book_pen_name_rights_librum_choice.test.sql and its
-- catalog equivalence and contention scripts.

-- ------------------------------------------------------------
-- 1. Pen name
-- ------------------------------------------------------------
alter table public.books
  add column pen_name text
    constraint books_pen_name_check
    check (
      pen_name is null
      or (char_length(pen_name) between 1 and 120
          and pen_name = btrim(pen_name, E' \t\r\n'))
    );

-- ------------------------------------------------------------
-- 3a. Librum's choice column (added here so books' column order is
--     pen_name, librum_choice_at in both build paths)
-- ------------------------------------------------------------
alter table public.books
  add column librum_choice_at timestamptz;

create unique index books_one_librum_choice
  on public.books ((true))
  where librum_choice_at is not null;

-- ------------------------------------------------------------
-- 2. Rights declarations
-- ------------------------------------------------------------
create table public.book_rights_declarations (
  id uuid primary key default gen_random_uuid(),
  book_id uuid references public.books(id) on delete set null,
  book_title text not null,
  author_id uuid references public.profiles(id) on delete set null,
  author_public_name text not null,
  basis text not null check (basis in ('own_rights', 'public_domain')),
  statement_version text not null,
  statement_text text not null check (btrim(statement_text) <> ''),
  declared_at timestamptz not null default now()
);

create index book_rights_declarations_book_id_declared_at_idx
  on public.book_rights_declarations (book_id, declared_at desc);

alter table public.book_rights_declarations enable row level security;

-- service_role (the application's key) may only read and insert: no
-- UPDATE, DELETE or TRUNCATE, so the key cannot destroy a record. The
-- foreign keys' SET NULL runs as the table owner. Deleting rows (a
-- retention purge, if the lawyer sets one) needs the owner role through
-- the authorized migration route.
revoke all on public.book_rights_declarations from public, anon, authenticated, service_role;
grant select, insert on public.book_rights_declarations to service_role;
grant select on public.book_rights_declarations to authenticated;

create policy "Authors can read their own rights declarations"
  on public.book_rights_declarations for select
  to authenticated
  using (auth.uid() = author_id);

-- Everything except book_id/author_id is compared as one jsonb value, so
-- a column added later is protected without editing this function.
create function public.enforce_book_rights_declarations_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (pg_catalog.to_jsonb(new) - 'book_id' - 'author_id')
     is distinct from (pg_catalog.to_jsonb(old) - 'book_id' - 'author_id')
  then
    raise exception
      'book_rights_declarations is append-only (declaration %)', old.id;
  end if;

  if new.book_id is distinct from old.book_id
     and (new.book_id is not null
          or exists (select 1 from public.books b where b.id = old.book_id))
  then
    raise exception
      'book_rights_declarations: book_id may only become null when its book is deleted (declaration %)', old.id;
  end if;

  if new.author_id is distinct from old.author_id
     and (new.author_id is not null
          or exists (select 1 from public.profiles p where p.id = old.author_id))
  then
    raise exception
      'book_rights_declarations: author_id may only become null when its profile is deleted (declaration %)', old.id;
  end if;

  return new;
end;
$$;

create trigger book_rights_declarations_enforce_append_only
  before update on public.book_rights_declarations
  for each row
  execute function public.enforce_book_rights_declarations_append_only();

-- ------------------------------------------------------------
-- 3b. Librum's choice writers
-- ------------------------------------------------------------
-- A partial unique index cannot be deferred and is checked row by row,
-- so "clear the old pick, set the new one" is two statements, in this
-- order, under one lock.
create function public.set_librum_choice(p_book_id uuid)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('public.books.librum_choice'));

  perform 1 from public.books where id = p_book_id and status = 'published' for update;
  if not found then
    return false;
  end if;

  update public.books set librum_choice_at = null
   where librum_choice_at is not null and id <> p_book_id;

  update public.books set librum_choice_at = now() where id = p_book_id;
  return true;
end;
$$;

create function public.clear_librum_choice()
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('public.books.librum_choice'));

  update public.books set librum_choice_at = null where librum_choice_at is not null;
end;
$$;

revoke execute on function public.set_librum_choice(uuid) from public, anon, authenticated;
revoke execute on function public.clear_librum_choice() from public, anon, authenticated;
grant execute on function public.set_librum_choice(uuid) to service_role;
grant execute on function public.clear_librum_choice() to service_role;
