-- PEN-NAMES-2 CONTRACT (PEN-2, PR B of 2, migration 2 of 2): remove
-- every public read of an account column -- books, series, bundles,
-- reviews, public_author_profiles, author_follows, the buyer's and the
-- refund reader's views of the base tables, bucket listings and the
-- account folders in storage keys. Owner decisions 9a, 13a, 3a, 4a/12a,
-- 17a-22a and 23b (owner answer 2026-10-19 22:30Z).
--
-- PROMISE AND RELEASE RULE. Readers and signed-out visitors must never
-- learn the account behind a pen name, nor that two pen names share an
-- account (site, data API, image URLs). The promise holds in an
-- environment only after THIS migration (rollout step 4) has run there.
-- PEN-1 (20261019184512_pen_names.sql) never reaches Production without
-- PEN-2, including this step.
--
-- ROLLOUT ORDER (staging now, Production later):
--   1. the expand migration 20261019222500_pen_names_private_reads.sql;
--   2. the PR B code;
--   3. the storage script (scripts/pen-names-storage/move.mts copy, then
--      verify);
--   4. THIS migration;
--   5. move.mts delete-old --contract-applied (19a/20a).
--      Its run plan notes that deleted public objects can stay cached
--      at the CDN for the bucket's cache-control period (O16).
-- WHY NOT EARLIER: before step 2 the running code reads books, series,
-- bundles, reviews and public_author_profiles directly with the anon or
-- user key, and writes covers and avatars under "<account id>/" with the
-- user's own storage policies -- all removed here. Before step 3 rows
-- still name old storage keys, which C0 refuses and C8/C10 forbid.
-- Vercel previews of older branches that point at a database where this
-- has run will break; that is expected.
--
-- WHAT CHANGES (brief sections):
--   C0  guard: old cover/photo keys, a referenced object missing from
--       storage.objects, or one with an owner -> raise, change nothing.
--   C1  books, bundles: no anon SELECT; authors read their own rows;
--       staff with reports.resolve read every book (13a, MF2).
--   C2  series: own rows; grants reset to what the code uses.
--   C3  reviews: own rows; grants reset to the upsert's needs; no delete.
--   C4  search_books reads public_books; book_contributors and
--       bundle_books policies read the public views; book_views is
--       authenticated-only; book_contributors grants reset.
--   C5  public_author_profiles dropped.
--   C6  author_follows, its mirror trigger and function dropped (21a).
--   C7  bundle snapshots: the reader policy dropped (readers use
--       reader_bundle_purchases). [23b] the author policy too, and with
--       no policy left authenticated loses SELECT.
--   C7b refund_requests: the reader policy dropped (readers use
--       reader_refund_requests); the reader's refund items policy reads
--       that view (O-a).
--   C8  pen_names photos: random "<uuid>/pen-name.<ext>" keys only; the
--       profile trigger stops copying the photo (it still copies the
--       bio, 17a).
--   C9  storage: no listing of covers, avatars or blog (blog: staff
--       with blog.manage only); no user writes to covers or avatars.
--   C10 books.cover_path: random "<uuid>/cover.<ext>" keys only.
--   C11 books_enforce_pen_name: data-API guard, no text sync, column
--       list without pen_name; pen_names_after_update: no text sync;
--       books.pen_name dropped (no CASCADE).
--   C13 profiles: support (refunds.view) no longer reads other profiles.
--   [23b] purchases: the author policy dropped (authors use
--       author_book_purchases).
--
-- ROLLBACK: PEN-2-ROLLBACK-CONTRACT-r1.sql (run plan). It restores the
-- policies, grants, view, books.pen_name (backfilled) and the old
-- trigger, checks and functions; author_follows comes back empty.
--
-- The declarative equivalent is in supabase/schema.sql; see
-- supabase/tests/075_pen_names_private_reads.test.sql and
-- supabase/tests/075_pen_names_private_reads_catalog_equivalence.sh.

-- ------------------------------------------------------------
-- C0. Guard. PEN-2-PRECHECK-CONTRACT-r1.sql counts the same rows.
-- ------------------------------------------------------------
do $$
declare
  v_old_covers integer;
  v_old_photos integer;
  v_missing integer;
  v_owned integer;
begin
  select pg_catalog.count(*) into v_old_covers
    from public.books b
   where b.cover_path is not null
     and b.cover_path !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/cover\.(jpg|png)$';
  if v_old_covers > 0 then
    raise exception 'pen names contract: % book cover(s) still use an old storage key -- run the storage script (rollout step 3) first', v_old_covers;
  end if;

  select pg_catalog.count(*) into v_old_photos
    from public.pen_names pn
   where pn.avatar_path is not null
     and pn.avatar_path !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/pen-name\.(jpg|png)$';
  if v_old_photos > 0 then
    raise exception 'pen names contract: % pen name photo(s) still use an old storage key -- run the storage script (rollout step 3) first', v_old_photos;
  end if;

  select (select pg_catalog.count(*)
            from public.books b
           where b.cover_path is not null
             and not exists (select 1 from storage.objects o
                              where o.bucket_id = 'covers' and o.name = b.cover_path))
       + (select pg_catalog.count(*)
            from public.pen_names pn
           where pn.avatar_path is not null
             and not exists (select 1 from storage.objects o
                              where o.bucket_id = 'avatars' and o.name = pn.avatar_path))
    into v_missing;
  if v_missing > 0 then
    raise exception 'pen names contract: % referenced cover or photo object(s) are missing from storage -- run the storage script verify (rollout step 3) first', v_missing;
  end if;

  select (select pg_catalog.count(*)
            from public.books b
            join storage.objects o on o.bucket_id = 'covers' and o.name = b.cover_path
           where o.owner is not null or o.owner_id is not null)
       + (select pg_catalog.count(*)
            from public.pen_names pn
            join storage.objects o on o.bucket_id = 'avatars' and o.name = pn.avatar_path
           where o.owner is not null or o.owner_id is not null)
    into v_owned;
  if v_owned > 0 then
    raise exception 'pen names contract: % referenced cover or photo object(s) carry an owner account -- they must be written by the service role', v_owned;
  end if;
end;
$$;

-- ------------------------------------------------------------
-- C11 (1-2). The books trigger first: it must not depend on
-- books.pen_name when the column is dropped below.
-- ------------------------------------------------------------
create or replace function public.books_enforce_pen_name()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
  v_series_pen uuid;
begin
  -- PEN-NAMES-2 (MF1): a data-API caller (anon or authenticated) writing
  -- a book row for ANOTHER account is refused by grants or RLS anyway.
  -- Return before any pen name lookup, so the refusal never tells
  -- whether an account has a default pen name or whether a series' pen
  -- name is its default -- the same guard as series_enforce_pen_name.
  if pg_catalog.current_setting('role') in ('anon', 'authenticated')
     and new.author_id is distinct from auth.uid()
  then
    return new;
  end if;

  if new.pen_name_id is null then
    new.pen_name_id := public.resolve_author_pen_name(new.author_id, null);
  end if;

  select pn.author_id into v_owner
    from public.pen_names pn where pn.id = new.pen_name_id;
  if v_owner is null or v_owner <> new.author_id then
    raise exception 'pen names: the pen name does not belong to this book''s author' using errcode = '42501';
  end if;

  if tg_op = 'UPDATE' and new.pen_name_id is distinct from old.pen_name_id then
    if (old.series_id is not null and new.series_id is not null)
       or exists (select 1 from public.bundle_books bb where bb.book_id = new.id)
    then
      raise exception 'This book is in a series or bundle. Take it out first, then change its pen name.'
        using errcode = 'LB452';
    end if;
  end if;

  if new.series_id is not null
     and (tg_op = 'INSERT'
          or new.series_id is distinct from old.series_id
          or new.pen_name_id is distinct from old.pen_name_id)
  then
    select s.pen_name_id into v_series_pen from public.series s where s.id = new.series_id;
    if found and v_series_pen is distinct from new.pen_name_id then
      raise exception 'A series holds books of one pen name only.' using errcode = 'LB451';
    end if;
  end if;

  return new;
end;
$$;

drop trigger books_enforce_pen_name on public.books;

create trigger books_enforce_pen_name
  before insert or update of pen_name_id, author_id, series_id on public.books
  for each row
  execute function public.books_enforce_pen_name();

create or replace function public.pen_names_after_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- The default pen name's name -> profiles.public_author_name (the
  -- Profile field IS the default). books.pen_name no longer exists.
  if new.is_default and new.name is distinct from old.name then
    update public.profiles p
       set public_author_name = new.name
     where p.id = new.author_id
       and pg_catalog.btrim(coalesce(p.public_author_name, ''), E' \t\r\n') is distinct from new.name;
  end if;

  return null;
end;
$$;

-- ------------------------------------------------------------
-- C11 (3). books.pen_name: the code reads pen names only through
-- pen_name_id. No CASCADE: nothing may depend on the column any more.
-- ------------------------------------------------------------
alter table public.books drop column pen_name;

-- ------------------------------------------------------------
-- C1. books and bundles
-- ------------------------------------------------------------
revoke select on public.books from anon;
revoke select on public.bundles from anon;

drop policy "Published books are viewable by everyone, drafts by their author" on public.books;
drop policy "Owners can view books they've acquired" on public.books;
drop policy "Published bundles are viewable by everyone, drafts by their author" on public.bundles;

create policy "Authors can view their own books"
  on public.books for select
  to authenticated
  using (auth.uid() = author_id);

create policy "Staff with reports.resolve can view every book"
  on public.books for select
  to authenticated
  using (public.staff_has_permission('reports.resolve'));

create policy "Authors can view their own bundles"
  on public.bundles for select
  to authenticated
  using (auth.uid() = author_id);

-- ------------------------------------------------------------
-- C2. series
-- ------------------------------------------------------------
drop policy "Series are viewable by everyone" on public.series;

create policy "Authors can view their own series"
  on public.series for select
  to authenticated
  using (auth.uid() = author_id);

revoke all on public.series from public, anon, authenticated;
grant select, delete on public.series to authenticated;
grant insert (author_id, title, pen_name_id)
  on public.series
  to authenticated;

-- ------------------------------------------------------------
-- C3. reviews
-- ------------------------------------------------------------
drop policy "Reviews are viewable by everyone" on public.reviews;
drop policy "Readers can delete their own review" on public.reviews;

create policy "Readers can view their own reviews"
  on public.reviews for select
  to authenticated
  using (auth.uid() = reader_id);

revoke all on public.reviews from public, anon, authenticated;
grant select, insert on public.reviews to authenticated;
grant update (book_id, reader_id, rating, body)
  on public.reviews
  to authenticated;

-- ------------------------------------------------------------
-- C4. Objects that read books or bundles with the caller's rights.
-- ------------------------------------------------------------
create or replace function public.search_books(
  search_term text default null,
  genre_filter text default null,
  min_price_cents int default null,
  max_price_cents int default null,
  result_limit int default 500
)
returns table (book_id uuid)
language sql
security invoker
set search_path = ''
stable
as $$
  -- PEN-NAMES-2: public_books (no account columns), so this keeps working
  -- for anon after books' public SELECT is removed.
  select books.id as book_id
  from public.public_books books
  where books.status = 'published'
    and (genre_filter is null or books.genre = genre_filter)
    -- ALL-SEARCH-1: a row with no authored ALL price is not ALL-ready.
    -- Unconditional, never folded into the two bound checks below: a
    -- reader who applies no price filter at all must not be shown an
    -- unpriced book either.
    and books.price_all is not null
    -- ALL-SEARCH-1: whole-ALL catalog bounds. The parameter names still
    -- read "cents" and are deliberately not renamed here -- see the
    -- header. `price_cents` is never consulted: it is legacy USD minor
    -- units and its values are not lek.
    and (min_price_cents is null or books.price_all >= min_price_cents)
    and (max_price_cents is null or books.price_all <= max_price_cents)
    and (
      search_term is null
      or extensions.unaccent(books.title) ilike extensions.unaccent('%' || search_term || '%')
      or extensions.unaccent(books.description) ilike extensions.unaccent('%' || search_term || '%')
      or extensions.unaccent(books.keywords) ilike extensions.unaccent('%' || search_term || '%')
      or exists (
        -- PEN-NAMES-1 (5a): the book's OWN pen name, through the public
        -- view (no author_id). The account's public name finds only the
        -- books published under it (its default pen name), never a book
        -- under another pen name.
        select 1
        from public.public_pen_names pn
        where pn.id = books.pen_name_id
          and extensions.unaccent(pn.name)
            ilike extensions.unaccent('%' || search_term || '%')
      )
    )
  -- SEARCH CANDIDATE LIMIT (500) -- see the comment block above. NOT the
  -- 48-row VISIBLE SEARCH RESULT LIMIT the bookstore displays.
  limit least(greatest(coalesce(result_limit, 500), 1), 500);
$$;

drop policy "Contributors are viewable wherever the book is" on public.book_contributors;

create policy "Contributors are viewable wherever the book is"
  on public.book_contributors for select
  using (exists (select 1 from public.public_books pb where pb.id = book_contributors.book_id));

revoke all on public.book_contributors from public, anon, authenticated;
grant select on public.book_contributors to anon;
grant select, insert, delete on public.book_contributors to authenticated;

drop policy "Bundle contents are viewable wherever the bundle is" on public.bundle_books;

create policy "Bundle contents are viewable wherever the bundle is"
  on public.bundle_books for select
  using (exists (select 1 from public.public_bundles pb where pb.id = bundle_books.bundle_id));

-- book_views stays on base books (authors read their own rows); only
-- authenticated callers ever get rows.
alter policy "Authors can view the view-counts of their own books"
  on public.book_views
  to authenticated;

revoke all on public.book_views from anon;

-- ------------------------------------------------------------
-- C5, C6
-- ------------------------------------------------------------
drop view public.public_author_profiles;

drop trigger author_follows_mirror_pen_name_follows on public.author_follows;
drop function public.author_follows_mirror_pen_name_follows();
drop table public.author_follows;

-- ------------------------------------------------------------
-- C7, [23b], C7b
-- ------------------------------------------------------------
drop policy "Readers can view their own fulfilled bundle snapshot transactions"
  on public.bundle_checkout_snapshots;

-- [23b] authors read their bundle sales through author_bundle_sales.
drop policy "Authors can view their own fulfilled bundle snapshot transactions"
  on public.bundle_checkout_snapshots;

-- [23b] no SELECT policy is left on the table.
revoke select on public.bundle_checkout_snapshots from authenticated;

-- [23b] authors read their book sales through author_book_purchases.
drop policy "Authors can view purchases of their own books" on public.purchases;

drop policy "Readers can view their own refund requests" on public.refund_requests;

-- O-a: the reader's refund items follow their requests through the
-- reader view (the base table no longer shows them their own requests).
drop policy "Readers can view items on their own refund requests" on public.refund_request_items;

create policy "Readers can view items on their own refund requests"
  on public.refund_request_items
  for select
  using (
    exists (
      select 1 from public.reader_refund_requests rr
      where rr.id = refund_request_items.refund_request_id
    )
  );

-- ------------------------------------------------------------
-- C8. pen_names photos
-- ------------------------------------------------------------
alter table public.pen_names drop constraint pen_names_avatar_path_check;

alter table public.pen_names
  add constraint pen_names_avatar_path_check
  check (avatar_path is null
         or avatar_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/pen-name\.(jpg|png)$');

create or replace function public.pen_names_sync_profile_default()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text;
  v_default_id uuid;
  v_default_name text;
  v_clash uuid;
  v_bio text;
begin
  if new.role <> 'author' then
    return null;
  end if;
  if tg_op = 'UPDATE'
     and new.role is not distinct from old.role
     and new.public_author_name is not distinct from old.public_author_name
  then
    return null;
  end if;

  v_name := pg_catalog.btrim(coalesce(new.public_author_name, ''), E' \t\r\n');
  if v_name = '' then
    raise exception 'Your public author name cannot be empty.' using errcode = '23514';
  end if;

  select pn.id, pn.name into v_default_id, v_default_name
    from public.pen_names pn
   where pn.author_id = new.id and pn.is_default;

  select pn.id into v_clash
    from public.pen_names pn
   where pn.author_id = new.id
     and pg_catalog.lower(pn.name) = pg_catalog.lower(v_name)
     and pn.id is distinct from v_default_id;

  -- 17a: a new default pen name starts with the profile's bio, when set;
  -- an existing pen name promoted to default keeps its own. PEN-NAMES-2
  -- (C8): the photo is no longer copied here -- a profile photo lives
  -- under the account folder; becomeAuthor copies it server side to a
  -- random pen-name key instead.
  v_bio := case when pg_catalog.btrim(coalesce(new.bio, ''), E' \t\r\n') = '' then null else new.bio end;

  if v_default_id is null then
    if v_clash is not null then
      update public.pen_names
         set is_default = true, name = v_name,
             bio = coalesce(bio, v_bio)
       where id = v_clash;
    else
      insert into public.pen_names (author_id, name, is_default, bio)
      values (new.id, v_name, true, v_bio);
    end if;
  elsif v_default_name is distinct from v_name then
    if v_clash is not null then
      raise exception 'You already use "%" as one of your pen names. Choose another name, or rename that pen name first.', v_name
        using errcode = 'LB453';
    end if;
    update public.pen_names set name = v_name where id = v_default_id;
  end if;

  return null;
end;
$$;

-- ------------------------------------------------------------
-- C9. storage.objects
-- ------------------------------------------------------------
drop policy "Cover images are publicly readable" on storage.objects;
drop policy "Avatars are publicly readable" on storage.objects;
drop policy "Blog images are publicly readable" on storage.objects;
drop policy "Authors can upload their own cover images" on storage.objects;
drop policy "Authors can replace their own cover images" on storage.objects;
drop policy "Authors can delete their own cover images" on storage.objects;
drop policy "Users can upload their own avatar" on storage.objects;
drop policy "Users can replace their own avatar" on storage.objects;

-- Storage's remove and upsert need SELECT on the object.
create policy "Staff with blog.manage can read blog images"
  on storage.objects for select
  using (bucket_id = 'blog' and public.staff_has_permission('blog.manage'));

-- ------------------------------------------------------------
-- C10. books.cover_path
-- ------------------------------------------------------------
alter table public.books
  add constraint books_cover_path_check
  check (cover_path is null
         or cover_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/cover\.(jpg|png)$');

-- ------------------------------------------------------------
-- C13. profiles: support (refunds.view) reads display names through
-- staff_profile_display_names() only.
-- ------------------------------------------------------------
drop policy "Staff with an authorized permission can view any profile" on public.profiles;

create policy "Staff with an authorized permission can view any profile"
  on public.profiles
  for select
  using (
    public.staff_has_permission('reports.view')
    or public.staff_has_permission('staff.view')
    or public.staff_has_permission('audit.view')
  );
