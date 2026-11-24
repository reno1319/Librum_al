-- LBN (Renato 2026-11-24, lbnq1 a .. lbnq10 a, lbnq3b a; pictures lbnp1 a):
-- the Librum Book Number, Librum's own code for every book, like
-- Amazon's ASIN.
--
-- The code: 10 characters, "LE" (an ebook on Librum; print will get
-- "LP" when print exists) + 7 random characters + 1 check character,
-- e.g. LE7K4M9X2D. The 31-character alphabet leaves out 0/O and 1/I/L:
--   23456789ABCDEFGHJKMNPQRSTUVWXYZ
-- The check character is the alphabet's character at
--   (k + 1*v1 + 2*v2 + ... + 7*v7) mod 31
-- where vN is the Nth random character's place in the alphabet (0..30)
-- and k is 1 for "LE", 2 for "LP". 31 is prime and the weights 1..7 are
-- distinct, so one wrong character, or two neighbouring random characters
-- swapped, always gives a different check character. src/lib/lbn.ts
-- computes the same.
--
-- WHAT CHANGES:
--   1. public.lbn_issued: every LBN ever given, kept forever, so a
--      deleted book's code is never given again (lbnq7 a). No grants;
--      only the definer function below writes it.
--   2. public.lbn_check_char(), public.lbn_is_valid(): pure helpers.
--      public.lbn_generate(prefix): a new random code, recorded in
--      lbn_issued (definer). None of the three is granted to any
--      role: only the triggers below use them.
--   3. books.lbn: every existing book (drafts, hidden and taken-down
--      ones too) gets its own random LBN in this same statement, through a
--      volatile column default that is evaluated once per row (lbnq10
--      a). The default is then dropped; NOT NULL, UNIQUE and a CHECK
--      follow. Adding the column runs no row trigger and changes no
--      other column (updated_at included).
--   4. books_assign_lbn (BEFORE INSERT): every new book gets its LBN the
--      moment it is created (lbnq6 a); a value sent with the insert is
--      replaced. books_lbn_never_changes (BEFORE UPDATE OF lbn): any
--      change is refused with LB528, for every role (lbnq7 a).
--   5. public.public_books: the same definer view, same rows, same
--      options, with lbn appended as its LAST column.
--
-- books' grants are unchanged (authenticated: SELECT and DELETE only).
--
-- ROLLBACK: supabase/tests/115_lbn_book_number.rollback.sql drops the
-- two triggers, their functions and the generator, and drops books.lbn's
-- NOT NULL and CHECK so the reverted app can still create books. The
-- codes, their UNIQUE, lbn_issued, the two helpers and the view column
-- STAY: removing a view column means dropping public.public_books, which
-- other policies depend on.

-- ------------------------------------------------------------
-- 1. Every LBN ever given
-- ------------------------------------------------------------
create table public.lbn_issued (
  lbn text primary key,
  issued_at timestamptz not null default pg_catalog.now()
);

alter table public.lbn_issued enable row level security;
revoke all on table public.lbn_issued from public, anon, authenticated, service_role;

comment on table public.lbn_issued is
  'LBN: every Librum Book Number ever given, kept forever so a code is never given twice (also after its book is deleted). Written only by lbn_generate().';

-- ------------------------------------------------------------
-- 2. Helpers
-- ------------------------------------------------------------
-- The check character for a prefix ("LE"/"LP") and the 7 random
-- characters; null when either is not well formed.
create function public.lbn_check_char(p_prefix text, p_body text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_alphabet constant text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  v_sum integer;
  v_pos integer;
  i integer;
begin
  if p_prefix = 'LE' then
    v_sum := 1;
  elsif p_prefix = 'LP' then
    v_sum := 2;
  else
    return null;
  end if;
  if p_body is null or pg_catalog.length(p_body) <> 7 then
    return null;
  end if;
  for i in 1..7 loop
    v_pos := pg_catalog.strpos(v_alphabet, pg_catalog.substr(p_body, i, 1));
    if v_pos = 0 then
      return null;
    end if;
    v_sum := v_sum + i * (v_pos - 1);
  end loop;
  return pg_catalog.substr(v_alphabet, (v_sum % 31) + 1, 1);
end;
$$;

-- True only for a well-formed LBN with the right check character
-- (capital letters only; the app upper-cases what a visitor types).
create function public.lbn_is_valid(p_lbn text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    p_lbn ~ '^L[EP][23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$'
    and pg_catalog.substr(p_lbn, 10, 1)
        = public.lbn_check_char(pg_catalog.substr(p_lbn, 1, 2), pg_catalog.substr(p_lbn, 3, 7)),
    false);
$$;

-- A new random LBN, recorded in lbn_issued before it is returned. The
-- randomness is gen_random_uuid()'s (a strong random source); a byte of
-- 248 or more is skipped so each character is equally likely.
create function public.lbn_generate(p_prefix text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_alphabet constant text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  v_bytes bytea;
  v_body text;
  v_lbn text;
  v_byte integer;
  v_try integer := 0;
  i integer;
begin
  if p_prefix is distinct from 'LE' and p_prefix is distinct from 'LP' then
    raise exception 'lbn_generate: unknown prefix';
  end if;
  loop
    v_try := v_try + 1;
    if v_try > 50 then
      raise exception 'lbn_generate: no free code found';
    end if;
    v_body := '';
    while pg_catalog.length(v_body) < 7 loop
      v_bytes := pg_catalog.uuid_send(pg_catalog.gen_random_uuid());
      -- Bytes 6 and 8 carry the uuid's version and variant bits: skipped.
      for i in 0..15 loop
        continue when i in (6, 8);
        v_byte := pg_catalog.get_byte(v_bytes, i);
        continue when v_byte >= 248;
        v_body := v_body || pg_catalog.substr(v_alphabet, (v_byte % 31) + 1, 1);
        exit when pg_catalog.length(v_body) = 7;
      end loop;
    end loop;
    v_lbn := p_prefix || v_body || public.lbn_check_char(p_prefix, v_body);
    insert into public.lbn_issued (lbn) values (v_lbn) on conflict (lbn) do nothing;
    if found then
      return v_lbn;
    end if;
  end loop;
end;
$$;

revoke all on function public.lbn_check_char(text, text) from public, anon, authenticated, service_role;
revoke all on function public.lbn_is_valid(text) from public, anon, authenticated, service_role;
revoke all on function public.lbn_generate(text) from public, anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 3. The column, every existing book included
-- ------------------------------------------------------------
-- All of Librum's books are ebooks today, so every code starts "LE".
alter table public.books
  add column lbn text default public.lbn_generate('LE');

alter table public.books
  alter column lbn drop default,
  alter column lbn set not null,
  add constraint books_lbn_key unique (lbn),
  -- The shape only: a CHECK runs as whoever writes the row, and the
  -- helpers are not granted to anyone. The check character is right
  -- because only lbn_generate() makes codes and they never change.
  add constraint books_lbn_check check (lbn ~ '^L[EP][23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$');

comment on column public.books.lbn is
  'LBN (Librum Book Number): given when the book is created, never changes, never reused. See migration 20261124190000_lbn_book_number.sql.';

-- ------------------------------------------------------------
-- 4. Given at creation, never changed
-- ------------------------------------------------------------
create function public.books_assign_lbn()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Print books will take 'LP' once Librum sells print.
  new.lbn := public.lbn_generate('LE');
  return new;
end;
$$;

revoke all on function public.books_assign_lbn() from public, anon, authenticated, service_role;

create trigger books_assign_lbn
  before insert on public.books
  for each row
  execute function public.books_assign_lbn();

create function public.books_lbn_never_changes()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.lbn is distinct from old.lbn then
    raise exception 'A book''s LBN never changes.'
      using errcode = 'LB528';
  end if;
  return new;
end;
$$;

revoke all on function public.books_lbn_never_changes() from public, anon, authenticated, service_role;

create trigger books_lbn_never_changes
  before update of lbn on public.books
  for each row
  execute function public.books_lbn_never_changes();

-- ------------------------------------------------------------
-- 5. public_books: same columns, one appended
-- ------------------------------------------------------------
create or replace view public.public_books
  with (security_barrier)
as
  select b.id, b.title, b.subtitle, b.description, b.preview_text, b.keywords,
         b.isbn, b.language, b.publisher, b.edition, b.original_publication_date,
         b.genre, b.series_id, b.series_position, b.price_cents, b.cover_path,
         b.status, b.published_at, b.created_at, b.updated_at, b.price_all,
         b.librum_choice_at,
         -- BD15 P7: null on a public-domain edition without an editor
         -- mention, for every reader (its author too).
         b.public_pen_name_id as pen_name_id,
         b.original_author,
         b.categories, b.is_adult, b.reading_age_min, b.edition_number,
         b.pd_work_id, b.pd_editor_credit,
         -- BD16 P1 (migration 20261106120000): appended last.
         b.release_date,
         -- Upload notes C (migration 20261107120000): appended last.
         b.book_type,
         -- Upload notes D (migration 20261107140000): appended last.
         (select w.word_count
            from public.book_file_words w
           where w.book_id = b.id and w.file_path = b.file_path) as word_count,
         -- X19 (migration 20261121180000): appended last.
         b.original_title,
         -- LBN (migration 20261124190000): appended last.
         b.lbn
  from public.books b
  where public.book_is_publicly_listed(b)
     or b.author_id = auth.uid()
     or public.user_owns_book(b.id);
