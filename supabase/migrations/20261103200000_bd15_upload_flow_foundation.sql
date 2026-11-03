-- ============================================================
-- BD15 P1 (migration 20261103200000): the database foundation of the
-- new book upload flow. Plan: PLAN-BD15-r1.md section 3, narrowed by
-- Renato's choice of 3 Nov 2026 (18:48 UTC, option a): this migration
-- holds the foundation only. The review and approval changes (a live
-- book keeping its old version while a change waits, the public-domain
-- publish and price gates at review) come with the patches whose code
-- uses them.
--
-- What it adds:
--   1. pd_works: one public-domain work, and the one edition staff
--      picked for it.
--   2. New books columns: categories (1 to 3 genres, the first kept in
--      books.genre), is_adult, reading_age_min, edition_number,
--      pd_work_id, pd_editor_credit; a CHECK on language (sq, en).
--   3. book_ai_disclosures: the author's "AI used" answer, staff only.
--   4. Locks: title, pen name and published_at cannot change once a
--      book has been published (N1, N3); a picked public-domain edition
--      cannot be unpublished by its author or deleted; a published
--      public-domain edition is always its work's picked one.
--   5. Contributors: at most 3 per book.
--   6. Views: public_books shows the new columns; public_bundles lists
--      a bundle only when its pen name is public (N2), and a bundle
--      cannot be published under a pen name that is not. pen_name_id
--      stays a plain column in both, so the Data API can still embed
--      public_pen_names through it. Hiding a non-credited uploader's pen
--      name on a public-domain edition comes with P7, which links books
--      to works (until then pd_work_id is never set).
--   7. book_makes_pen_name_public: a public-domain edition makes its
--      uploader's pen name public only with an editor mention.
--   8. Backfill: categories from genre, edition_number from a plain
--      whole-number edition. No other stored value changes.
--
-- Rollback: supabase/tests/090_bd15_upload_flow_foundation.rollback.sql
-- ============================================================

-- ------------------------------------------------------------
-- 0. Pre-check: the language CHECK below needs every row to be sq, en
--    or empty. Stop with a readable message instead of a bare CHECK
--    failure.
-- ------------------------------------------------------------
do $$
declare
  v_bad integer;
begin
  select pg_catalog.count(*) into v_bad
    from public.books
   where language is not null and language not in ('sq', 'en');
  if v_bad > 0 then
    raise exception 'BD15: % book(s) have a language other than sq or en; fix them before this migration', v_bad;
  end if;
end $$;

-- ------------------------------------------------------------
-- 1. pd_works: one public-domain work. Staff write it through the
--    service role; nobody else reads it (the public sees a work only
--    through its picked book in public_books).
-- ------------------------------------------------------------
create table public.pd_works (
  id uuid primary key default gen_random_uuid(),
  title text not null
    constraint pd_works_title_check
    check (char_length(title) between 1 and 300
           and title = btrim(title)
           and title !~ '[[:cntrl:]]'),
  -- The same rules as books.original_author.
  original_author text not null
    constraint pd_works_original_author_check
    check (char_length(original_author) between 1 and 200
           and original_author = btrim(original_author)
           and original_author !~ '[[:cntrl:]]'),
  -- The one public edition. Its foreign key (added after the books
  -- columns, below) also requires that book to belong to this work.
  picked_book_id uuid
    constraint pd_works_picked_book_id_key unique,
  created_at timestamptz not null default now()
);

alter table public.pd_works enable row level security;

revoke all on public.pd_works from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.pd_works to service_role;

-- ------------------------------------------------------------
-- 2. New books columns, appended in this order.
-- ------------------------------------------------------------
alter table public.books
  -- Up to three of the eighteen genres (books_genre_check's list), no
  -- repeats; the first is the primary one and is kept in books.genre by
  -- books_sync_categories below, so search and filters keep working.
  add column categories text[]
    constraint books_categories_check
    check (categories is null
           or (pg_catalog.array_ndims(categories) = 1
               and pg_catalog.array_lower(categories, 1) = 1
               and pg_catalog.cardinality(categories) between 1 and 3
               and pg_catalog.array_position(categories, null) is null
               and categories <@ array[
                 'Biografi & kujtime', 'Biznes & ekonomi', 'Drama & teatër',
                 'Fantashkencë', 'Fantazi', 'Filozofi', 'Histori', 'Horror',
                 'Letërsi artistike', 'Për fëmijë', 'Për të rinj', 'Poezi',
                 'Policor & triler', 'Psikologji', 'Publicistikë & ese', 'Romancë',
                 'Shkencë', 'Zhvillim personal'
               ]::text[]
               and (pg_catalog.cardinality(categories) < 2
                    or categories[1] <> categories[2])
               and (pg_catalog.cardinality(categories) < 3
                    or (categories[1] <> categories[3]
                        and categories[2] <> categories[3])))),
  -- Q5 (Renato, 3 Nov): a label only. It shows in the book's details;
  -- the book is listed normally everywhere.
  add column is_adult boolean not null default false,
  add column reading_age_min smallint
    constraint books_reading_age_min_check
    check (reading_age_min is null
           or reading_age_min in (3, 6, 9, 12, 14, 16, 18)),
  add column edition_number integer
    constraint books_edition_number_check
    check (edition_number is null or edition_number between 1 and 999),
  -- The public-domain work this book is an edition of; set by staff at
  -- review. A new translation of a public-domain work is its own work
  -- (basis public_domain_original) and is never linked here.
  add column pd_work_id uuid
    constraint books_pd_work_id_fkey references public.pd_works(id),
  -- Staff only: the uploader added value, so their pen name shows as an
  -- editor line. Without it a public-domain edition never makes the
  -- uploader's pen name public.
  add column pd_editor_credit boolean not null default false;

alter table public.books
  add constraint books_language_check
    check (language is null or language in ('sq', 'en')),
  add constraint books_adult_categories_check
    check (not (is_adult and categories && array['Për fëmijë', 'Për të rinj']::text[])),
  add constraint books_adult_reading_age_check
    check (not is_adult or reading_age_min = 18),
  add constraint books_pd_editor_credit_check
    check (not pd_editor_credit or pd_work_id is not null),
  -- Every public-domain edition is free.
  add constraint books_pd_price_check
    check (pd_work_id is null or price_all = 0),
  -- A series carries a pen name, so a public-domain edition without an
  -- editor mention cannot be in one (bundles: books_pd_edition_rules
  -- and bundle_books_refuse_hidden_pd_edition below).
  add constraint books_pd_series_check
    check (pd_work_id is null or pd_editor_credit or series_id is null),
  -- The target of pd_works' picked-edition foreign key.
  add constraint books_pd_work_id_id_key unique (pd_work_id, id);

-- The picked book must be an edition of this work; deleting the book
-- (an account deletion) clears the pick, and moving a picked book to
-- another work is refused until staff pick another edition.
alter table public.pd_works
  add constraint pd_works_picked_book_fkey
    foreign key (id, picked_book_id)
    references public.books (pd_work_id, id)
    on delete set null (picked_book_id);

-- ------------------------------------------------------------
-- 3. The "AI used" answer: staff only, never in a public view.
--    The author writes and reads it through the service-role catalog
--    writer. No row = not answered.
-- ------------------------------------------------------------
create table public.book_ai_disclosures (
  book_id uuid primary key references public.books(id) on delete cascade,
  ai_used boolean not null,
  answered_at timestamptz not null default now()
);

alter table public.book_ai_disclosures enable row level security;

revoke all on public.book_ai_disclosures from public, anon, authenticated, service_role;
grant select, insert, update on public.book_ai_disclosures to service_role;

-- ------------------------------------------------------------
-- 4. categories <-> genre, and 18+ forces reading age 18.
--    The app before P2 writes genre only: a new genre becomes the first
--    category and the others stay. The new editor writes categories:
--    genre follows its first entry.
-- ------------------------------------------------------------
create function public.books_sync_categories()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.categories is not null then
      new.genre := new.categories[1];
    elsif new.genre is not null then
      new.categories := array[new.genre];
    end if;
  elsif new.categories is distinct from old.categories then
    new.genre := new.categories[1];
  elsif new.genre is distinct from old.genre then
    if new.genre is null then
      new.categories := null;
    else
      new.categories := (array[new.genre] || coalesce(array(
        select c.v
          from pg_catalog.unnest(old.categories) with ordinality as c(v, n)
         where c.v operator(pg_catalog.<>) new.genre
         order by c.n
      ), '{}'::text[]))[1:3];
    end if;
  end if;

  if new.is_adult then
    new.reading_age_min := 18;
  end if;

  return new;
end;
$$;

create trigger books_sync_categories
  before insert or update of genre, categories, is_adult, reading_age_min on public.books
  for each row
  execute function public.books_sync_categories();

revoke all on function public.books_sync_categories()
  from public, anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 5. Locked once published (N1, N3, title). The app's roles (anon,
--    authenticated -- also inside staff functions -- and service_role,
--    the catalog writer) are refused; a migration or Librum's own SQL
--    session (role none) can still correct a title through support.
-- ------------------------------------------------------------
create function public.books_lock_after_first_publish()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.published_at is not null
     and pg_catalog.current_setting('role') in ('anon', 'authenticated', 'service_role')
  then
    if new.published_at is distinct from old.published_at then
      raise exception 'A book''s first publication date never changes.'
        using errcode = 'LB482';
    end if;
    if new.title is distinct from old.title then
      raise exception 'The title of a published book can''t be changed. Write to Librum''s support to correct it.'
        using errcode = 'LB480';
    end if;
    if new.pen_name_id is distinct from old.pen_name_id then
      raise exception 'The pen name of a published book can''t be changed.'
        using errcode = 'LB481';
    end if;
  end if;
  return new;
end;
$$;

create trigger books_lock_after_first_publish
  before update of title, pen_name_id, published_at on public.books
  for each row
  execute function public.books_lock_after_first_publish();

revoke all on function public.books_lock_after_first_publish()
  from public, anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 6. Public-domain editions.
-- ------------------------------------------------------------
-- 6a. Q1 (Renato, 3 Nov): while a book is its work's picked edition,
--     its author cannot unpublish it (the author's path is the
--     service-role catalog writer) or delete it. Staff takedowns and
--     suspensions (staff functions, role authenticated) still unpublish
--     it, and deleting the account (a cascade, trigger depth > 1) still
--     deletes it and clears the pick.
create function public.books_lock_picked_pd_edition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if old.status = 'published'
       and new.status is distinct from 'published'
       and pg_catalog.current_setting('role') in ('anon', 'service_role')
       and exists (select 1 from public.pd_works w where w.picked_book_id = old.id)
    then
      raise exception 'Librum picked this book as the edition of a public-domain work, so it can''t be unpublished.'
        using errcode = 'LB483';
    end if;
    return new;
  end if;

  if pg_catalog.pg_trigger_depth() <= 1
     and pg_catalog.current_setting('role') in ('anon', 'authenticated', 'service_role')
     and exists (select 1 from public.pd_works w where w.picked_book_id = old.id)
  then
    raise exception 'Librum picked this book as the edition of a public-domain work, so it can''t be deleted.'
      using errcode = 'LB484';
  end if;
  return old;
end;
$$;

create trigger books_lock_picked_pd_edition
  before update of status or delete on public.books
  for each row
  execute function public.books_lock_picked_pd_edition();

revoke all on function public.books_lock_picked_pd_edition()
  from public, anon, authenticated, service_role;

-- 6b. One public edition per work: at commit, a published book linked
--     to a work is that work's picked edition. Staff swap by picking the
--     new edition and unpublishing the old one in one transaction; a
--     submission left as a candidate stays a draft.
create function public.books_check_published_pd_edition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_book_id uuid;
begin
  if tg_table_name = 'pd_works' then
    v_book_id := old.picked_book_id;
  else
    v_book_id := new.id;
  end if;

  if v_book_id is not null and exists (
    select 1
      from public.books b
     where b.id = v_book_id
       and b.status = 'published'
       and b.pd_work_id is not null
       and not exists (
         select 1 from public.pd_works w
          where w.id = b.pd_work_id and w.picked_book_id = b.id
       )
  ) then
    raise exception 'A public-domain work has one public edition: this book is not the one Librum picked.'
      using errcode = 'LB485';
  end if;
  return null;
end;
$$;

create constraint trigger books_check_published_pd_edition
  after insert or update of status, pd_work_id on public.books
  deferrable initially deferred
  for each row
  execute function public.books_check_published_pd_edition();

create constraint trigger pd_works_check_published_pd_edition
  after update of picked_book_id on public.pd_works
  deferrable initially deferred
  for each row
  execute function public.books_check_published_pd_edition();

revoke all on function public.books_check_published_pd_edition()
  from public, anon, authenticated, service_role;

-- 6c. A bundle carries a pen name: a public-domain edition without an
--     editor mention is never in one (the series rule is a CHECK).
create function public.books_pd_edition_rules()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.pd_work_id is not null
     and not new.pd_editor_credit
     and exists (select 1 from public.bundle_books bb where bb.book_id = new.id)
  then
    raise exception 'A public-domain edition without an editor mention can''t be in a bundle. Take it out first.'
      using errcode = 'LB487';
  end if;
  return new;
end;
$$;

create trigger books_pd_edition_rules
  before update of pd_work_id, pd_editor_credit on public.books
  for each row
  execute function public.books_pd_edition_rules();

revoke all on function public.books_pd_edition_rules()
  from public, anon, authenticated, service_role;

create function public.bundle_books_refuse_hidden_pd_edition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- A data-API caller adding another account's book is refused by RLS
  -- anyway; answer nothing about that book first (no error oracle).
  if pg_catalog.current_setting('role') in ('anon', 'authenticated')
     and not exists (select 1 from public.books b
                      where b.id = new.book_id and b.author_id = auth.uid())
  then
    return new;
  end if;

  if exists (select 1 from public.books b
              where b.id = new.book_id
                and b.pd_work_id is not null
                and not b.pd_editor_credit)
  then
    raise exception 'A public-domain edition without an editor mention can''t be in a bundle.'
      using errcode = 'LB487';
  end if;
  return new;
end;
$$;

create trigger bundle_books_refuse_hidden_pd_edition
  before insert or update of bundle_id, book_id on public.bundle_books
  for each row
  execute function public.bundle_books_refuse_hidden_pd_edition();

revoke all on function public.bundle_books_refuse_hidden_pd_edition()
  from public, anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 7. Contributors: at most three per book.
-- ------------------------------------------------------------
create function public.book_contributors_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- No error oracle for another account's book (RLS refuses the row).
  if pg_catalog.current_setting('role') in ('anon', 'authenticated')
     and not exists (select 1 from public.books b
                      where b.id = new.book_id and b.author_id = auth.uid())
  then
    return new;
  end if;

  -- Two concurrent inserts for one book queue on the book row.
  perform 1 from public.books b where b.id = new.book_id for update;

  if (select pg_catalog.count(*) from public.book_contributors c
       where c.book_id = new.book_id
         and c.id is distinct from new.id) >= 3
  then
    raise exception 'A book can list at most 3 contributors.'
      using errcode = 'LB486';
  end if;
  return new;
end;
$$;

create trigger book_contributors_limit
  before insert or update of book_id on public.book_contributors
  for each row
  execute function public.book_contributors_limit();

revoke all on function public.book_contributors_limit()
  from public, anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 8. The "is this book public" rules, each in one place.
--    BD16 (pre-order) changes only these two functions. A version that
--    reads now() or another table must become STABLE (N5), and then it
--    is no longer inlined into the views.
-- ------------------------------------------------------------
create or replace function public.book_makes_pen_name_public(b public.books)
returns boolean
language sql
immutable
parallel safe
as $$
  select (b.status operator(pg_catalog.=) 'published'
          or b.published_at is not null)
     -- BD15 Q1: a public-domain edition shows its uploader only as an
     -- editor, and only when staff gave that mention.
     and (b.pd_work_id is null or b.pd_editor_credit)
$$;

create function public.book_is_publicly_listed(b public.books)
returns boolean
language sql
immutable
parallel safe
as $$
  -- A published public-domain edition is always its work's picked one
  -- (books_check_published_pd_edition), so status alone decides.
  select b.status operator(pg_catalog.=) 'published'
$$;

revoke all on function public.book_is_publicly_listed(public.books)
  from public, anon, authenticated, service_role;
grant execute on function public.book_is_publicly_listed(public.books)
  to anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 9. public_books: the new columns appended, never ai_used (it is not
--    on books). Same leading columns, so CREATE OR REPLACE keeps every
--    grant and the policies that read it. Every column stays a plain
--    reference to a books column: the Data API (PostgREST) finds the
--    view's relationships (pen:public_pen_names, series, contributors)
--    only through plain columns, never through an expression.
--    P7 hides a non-credited uploader's pen name on a public-domain
--    edition without breaking that (BD15 P1 audit N1 and r2).
-- ------------------------------------------------------------
create or replace view public.public_books
  with (security_barrier)
as
  select b.id, b.title, b.subtitle, b.description, b.preview_text, b.keywords,
         b.isbn, b.language, b.publisher, b.edition, b.original_publication_date,
         b.genre, b.series_id, b.series_position, b.price_cents, b.cover_path,
         b.status, b.published_at, b.created_at, b.updated_at, b.price_all,
         b.librum_choice_at, b.pen_name_id,
         b.original_author,
         -- BD15 P1 (migration 20261103200000): appended last.
         b.categories, b.is_adult, b.reading_age_min, b.edition_number,
         b.pd_work_id, b.pd_editor_credit
  from public.books b
  where public.book_is_publicly_listed(b)
     or b.author_id = auth.uid()
     or public.user_owns_book(b.id);

-- ------------------------------------------------------------
-- 10. N2: a published bundle is listed only while its pen name is
--     public by the book rule (its author always sees it), and a bundle
--     cannot be published under a pen name that is not public.
--     pen_name_id stays a plain column (see 9).
-- ------------------------------------------------------------
create or replace view public.public_bundles
  with (security_barrier)
as
  select bu.id, bu.title, bu.description, bu.price_cents, bu.status,
         bu.created_at, bu.updated_at, bu.price_all, bu.pen_name_id
  from public.bundles bu
  where (bu.status = 'published'
         and exists (select 1 from public.books b
                      where b.pen_name_id = bu.pen_name_id
                        and public.book_makes_pen_name_public(b)))
     or bu.author_id = auth.uid();

create function public.bundles_require_public_pen_name()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- The app's roles only (staff functions run as authenticated); a row
  -- written by Librum's own SQL session or a migration is not checked.
  if new.status = 'published'
     and (tg_op = 'INSERT' or old.status is distinct from 'published')
     and pg_catalog.current_setting('role') in ('anon', 'authenticated', 'service_role')
     and not exists (select 1 from public.books b
                      where b.pen_name_id = new.pen_name_id
                        and public.book_makes_pen_name_public(b))
  then
    raise exception 'A bundle can be published only under a pen name with a published book.'
      using errcode = 'LB488';
  end if;
  return new;
end;
$$;

create trigger bundles_require_public_pen_name
  before insert or update of status on public.bundles
  for each row
  execute function public.bundles_require_public_pen_name();

revoke all on function public.bundles_require_public_pen_name()
  from public, anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 11. Backfill. Only categories and edition_number are written.
-- ------------------------------------------------------------
update public.books
   set categories = array[genre]
 where genre is not null;

update public.books
   set edition_number = pg_catalog.btrim(edition)::integer
 where pg_catalog.btrim(edition) ~ '^[1-9][0-9]{0,2}$';
