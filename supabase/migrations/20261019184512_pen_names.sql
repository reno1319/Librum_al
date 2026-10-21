-- PEN-NAMES-1 (PEN-1, PR A of 2): a pen name becomes its own public
-- identity -- its own id, name, bio, photo and links -- so a reader
-- follows, finds and reads an author page per pen name instead of per
-- account. Owner decisions 1a-16a (Renato, 2026-10-19).
--
-- RELEASE RULE. PR A alone does NOT keep the promise "readers never
-- learn the account behind a pen name, nor that two pen names share an
-- account": books.author_id, series.author_id, bundles.author_id and
-- public.public_author_profiles stay publicly readable until PR B, and
-- the pen_name_id columns added here are readable beside them. PR A
-- MUST NOT be released to Production without PR B.
--
-- ROLLOUT ORDER: this migration FIRST, then the code. The application
-- that is live when the migration lands (old code) keeps working:
--   * books/series/bundles inserted without pen_name_id get the
--     author's default pen name (BEFORE INSERT triggers), so the NOT
--     NULL columns never break old createBook/createSeries/createBundle;
--   * old code that writes only books.pen_name (text) keeps working:
--     the books trigger finds or creates that pen name and sets
--     pen_name_id (two-way sync, below);
--   * old code that follows/unfollows through author_follows is
--     mirrored into pen_name_follows (author's default pen name);
--   * the bundle RPCs keep their signatures.
-- The new code reads public_pen_names, pen_names and pen_name_follows,
-- which exist only after this migration, so it must not be deployed
-- before it.
--
-- WHAT CHANGES:
--   1. public.pen_names (owner-only table; never readable by anon) with
--      a default pen name per author (= profiles.public_author_name,
--      kept in step by a trigger on profiles, both ways).
--   2. books/series/bundles.pen_name_id (NOT NULL after the backfill),
--      book_rights_declarations.pen_name (16a).
--   3. Triggers: default fill, ownership, 11a (a series or bundle holds
--      books of one pen name), 14a (a book in a series or bundle keeps
--      its pen name), books.pen_name text <-> pen_name_id sync.
--   4. public.public_pen_names view (id, name, bio, avatar_path, links;
--      NO author_id), only for pen names used by a book (any status), a
--      series or a bundle.
--   5. public.pen_name_follows (4a), backfilled from author_follows
--      (12a: the author's default pen name) and mirrored from it.
--   6. search_books() matches the book's own pen name (5a) and no longer
--      reads public_author_profiles.
--   7. Bundle RPCs: the bundle's pen name is computed from p_book_ids,
--      mixed sets refused, BEFORE the bundle INSERT/UPDATE (N4).
--   8. public.staff_remove_pen_name_links(uuid): staff with
--      reports.resolve clear a pen name's links, audited (8a, 13a, 15a);
--      list_admin_audit_events() can filter for that event (r4).
--   9. r4 (17a): each author's default pen name starts with the profile
--      bio and photo (backfill and the default-pen-name trigger).
--
-- NOT CHANGED: books.pen_name stays (dropped later), author_follows and
-- public_author_profiles stay (PR B), every existing grant and policy
-- on books, series, bundles, bundle_books and profiles.
--
-- Foreign keys from books/series/bundles to pen_names are NO ACTION
-- (the default), not RESTRICT: both refuse deleting a pen name that is
-- still used, but RESTRICT is checked before the rest of an account
-- deletion's cascade has removed the account's books, so deleting an
-- account with books could fail depending on trigger order.
--
-- Backfill notes (the pre-check SQL counts each case):
--   * one default per author (or per account owning a book, series or
--     bundle) from btrim(public_author_name); an owner of content with
--     an empty name stops the migration;
--   * one pen name per (author, lower(books.pen_name)); a pen_name equal
--     to the author's public name, ignoring case, uses the default;
--   * books.pen_name is rewritten to the pen name's name, or null for
--     the default (so case variants collapse to the first-written one);
--   * a series or bundle whose books are under more than one pen name
--     keeps its rows and gets the default pen name (listed in a NOTICE).
--   * r4 (17a): the default pen name copies profiles.bio (a blank bio
--     stays null) and profiles.avatar_path when it is the canonical
--     "<account id>/avatar.<ext>"; any other stored photo value is not
--     copied (listed in a NOTICE). The copied photo stays in the account
--     folder until PR B moves it.
--
-- The declarative equivalent is in supabase/schema.sql; see
-- supabase/tests/074_pen_names.test.sql and
-- supabase/tests/074_pen_names_catalog_equivalence.sh.

-- ------------------------------------------------------------
-- 1. pen_names
-- ------------------------------------------------------------
create function public.pen_name_links_valid(p_links jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_links is not null
    and pg_catalog.jsonb_typeof(p_links) = 'array'
    and pg_catalog.jsonb_array_length(p_links) <= 3
    and not exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_links) as e(value)
      where pg_catalog.jsonb_typeof(e.value) <> 'string'
         or pg_catalog.char_length(e.value #>> '{}') > 500
         or (e.value #>> '{}') !~ '^https://[^[:space:]/?#]+[^[:space:]]*$'
    );
$$;

create table public.pen_names (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.profiles(id) on delete cascade,
  name text not null
    constraint pen_names_name_check
    check (char_length(name) between 1 and 120
           and name = btrim(name, E' \t\r\n')),
  bio text,
  avatar_path text
    constraint pen_names_avatar_path_check
    check (avatar_path is null
           or avatar_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/pen-name\.(jpg|png)$'
           -- r4 (17a): the account's own profile photo, copied onto its
           -- default pen name ("<account id>/avatar.<ext>", the one key
           -- shape the profile photo writer ever used). Moved off the
           -- account folder in PR B.
           or avatar_path in (author_id::text || '/avatar.jpg', author_id::text || '/avatar.png')),
  links jsonb not null default '[]'::jsonb
    constraint pen_names_links_check
    check (public.pen_name_links_valid(links)),
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);

create unique index pen_names_author_id_lower_name_key
  on public.pen_names (author_id, lower(name));

create unique index pen_names_one_default_per_author
  on public.pen_names (author_id)
  where is_default;

alter table public.pen_names enable row level security;

revoke all on public.pen_names from public, anon, authenticated;
grant select on public.pen_names to authenticated;
grant update (name, bio, links) on public.pen_names to authenticated;

create policy "Authors can view their own pen names"
  on public.pen_names for select
  to authenticated
  using (auth.uid() = author_id);

create policy "Staff with reports.resolve can view every pen name"
  on public.pen_names for select
  to authenticated
  using (public.staff_has_permission('reports.resolve'));

create policy "Authors can edit their own pen names"
  on public.pen_names for update
  to authenticated
  using (auth.uid() = author_id)
  with check (auth.uid() = author_id);

-- ------------------------------------------------------------
-- 2. Backfill: default pen names
-- ------------------------------------------------------------
do $$
declare
  v_missing integer;
begin
  select pg_catalog.count(*)
    into v_missing
    from public.profiles p
   where pg_catalog.btrim(coalesce(p.public_author_name, ''), E' \t\r\n') = ''
     and (exists (select 1 from public.books b where b.author_id = p.id)
          or exists (select 1 from public.series s where s.author_id = p.id)
          or exists (select 1 from public.bundles bu where bu.author_id = p.id));
  if v_missing > 0 then
    raise exception 'pen names backfill: % account(s) own a book, series or bundle but have no public author name', v_missing;
  end if;
end;
$$;

-- r4 (owner decision 17a): the default pen name takes the profile's bio
-- and photo, so nothing readers see today disappears (that name is
-- already public). A blank bio stays null; the photo is copied only in
-- its canonical "<account id>/avatar.<ext>" shape (pen_names'
-- avatar_path check) -- any other stored value is not copied and is
-- listed in the NOTICE below (PEN-1-r4-PRECHECK.sql counts them first).
-- Both rows then name the same Storage object: no code path removes it
-- while the other still does (src/app/(public)/dashboard/pen-names/
-- actions.ts removes only "<uuid>/pen-name.<ext>" keys; deleteAccount
-- removes each object once).
insert into public.pen_names (author_id, name, is_default, bio, avatar_path)
select p.id, pg_catalog.btrim(p.public_author_name, E' \t\r\n'), true,
       case when pg_catalog.btrim(coalesce(p.bio, ''), E' \t\r\n') = '' then null else p.bio end,
       case when p.avatar_path in (p.id::text || '/avatar.jpg', p.id::text || '/avatar.png')
            then p.avatar_path end
  from public.profiles p
 where pg_catalog.btrim(coalesce(p.public_author_name, ''), E' \t\r\n') <> ''
   and (p.role = 'author'
        or exists (select 1 from public.books b where b.author_id = p.id)
        or exists (select 1 from public.series s where s.author_id = p.id)
        or exists (select 1 from public.bundles bu where bu.author_id = p.id));

do $$
declare
  v_ids uuid[];
begin
  select pg_catalog.array_agg(p.id order by p.id)
    into v_ids
    from public.profiles p
    join public.pen_names d on d.author_id = p.id and d.is_default
   where p.avatar_path is not null
     and d.avatar_path is null;
  if v_ids is not null then
    raise notice 'pen names backfill: % profile photo(s) not in the canonical "<account id>/avatar.<ext>" shape were not copied to the default pen name: %',
      pg_catalog.cardinality(v_ids), v_ids;
  end if;
end;
$$;

-- One pen name per (author, lower(pen_name)); the first-written spelling
-- wins. A pen_name equal to the default's name, ignoring case, is the
-- default.
insert into public.pen_names (author_id, name)
select distinct on (b.author_id, pg_catalog.lower(b.pen_name)) b.author_id, b.pen_name
  from public.books b
  join public.pen_names d on d.author_id = b.author_id and d.is_default
 where b.pen_name is not null
   and pg_catalog.lower(b.pen_name) <> pg_catalog.lower(d.name)
 order by b.author_id, pg_catalog.lower(b.pen_name), b.created_at, b.id;

-- ------------------------------------------------------------
-- 3. pen_name_id columns and their backfill
-- ------------------------------------------------------------
alter table public.books
  add column pen_name_id uuid references public.pen_names(id);

alter table public.series
  add column pen_name_id uuid references public.pen_names(id);

alter table public.bundles
  add column pen_name_id uuid references public.pen_names(id);

update public.books b
   set pen_name_id = pn.id,
       pen_name = case when pn.is_default then null else pn.name end
  from public.pen_names pn
 where pn.author_id = b.author_id
   and pn.id = coalesce(
         (select x.id from public.pen_names x
           where x.author_id = b.author_id
             and b.pen_name is not null
             and pg_catalog.lower(x.name) = pg_catalog.lower(b.pen_name)),
         (select d.id from public.pen_names d
           where d.author_id = b.author_id and d.is_default));

do $$
declare
  v_mixed_series uuid[];
  v_mixed_bundles uuid[];
begin
  select coalesce(pg_catalog.array_agg(m.id order by m.id), '{}')
    into v_mixed_series
    from (
      select s.id
        from public.series s
        join public.books b on b.series_id = s.id
       group by s.id
      having pg_catalog.count(distinct b.pen_name_id) > 1
    ) m;

  select coalesce(pg_catalog.array_agg(m.id order by m.id), '{}')
    into v_mixed_bundles
    from (
      select bb.bundle_id as id
        from public.bundle_books bb
        join public.books b on b.id = bb.book_id
       group by bb.bundle_id
      having pg_catalog.count(distinct b.pen_name_id) > 1
    ) m;

  if pg_catalog.cardinality(v_mixed_series) > 0 then
    raise notice 'pen names backfill: % series hold books of more than one pen name and were given the default pen name: %',
      pg_catalog.cardinality(v_mixed_series), v_mixed_series;
  end if;
  if pg_catalog.cardinality(v_mixed_bundles) > 0 then
    raise notice 'pen names backfill: % bundles hold books of more than one pen name and were given the default pen name: %',
      pg_catalog.cardinality(v_mixed_bundles), v_mixed_bundles;
  end if;
end;
$$;

-- A series or bundle takes the one pen name all its own books share
-- (books of the same author only); otherwise -- no books, or mixed --
-- the author's default.
update public.series s
   set pen_name_id = coalesce(
         (select pg_catalog.min(b.pen_name_id::text)::uuid
            from public.books b
           where b.series_id = s.id and b.author_id = s.author_id
          having pg_catalog.count(distinct b.pen_name_id) = 1
             and pg_catalog.count(*) = (select pg_catalog.count(*) from public.books b2 where b2.series_id = s.id)),
         (select d.id from public.pen_names d where d.author_id = s.author_id and d.is_default));

update public.bundles bu
   set pen_name_id = coalesce(
         (select pg_catalog.min(b.pen_name_id::text)::uuid
            from public.bundle_books bb
            join public.books b on b.id = bb.book_id
           where bb.bundle_id = bu.id and b.author_id = bu.author_id
          having pg_catalog.count(distinct b.pen_name_id) = 1
             and pg_catalog.count(*) = (select pg_catalog.count(*) from public.bundle_books bb2 where bb2.bundle_id = bu.id)),
         (select d.id from public.pen_names d where d.author_id = bu.author_id and d.is_default));

alter table public.books alter column pen_name_id set not null;
alter table public.series alter column pen_name_id set not null;
alter table public.bundles alter column pen_name_id set not null;

create index books_pen_name_id_idx on public.books(pen_name_id);
create index series_pen_name_id_idx on public.series(pen_name_id);
create index bundles_pen_name_id_idx on public.bundles(pen_name_id);

-- ------------------------------------------------------------
-- 4. Rights declaration: the book's pen name (16a)
-- ------------------------------------------------------------
alter table public.book_rights_declarations
  add column pen_name text
    constraint book_rights_declarations_pen_name_check
    check (pen_name is null or char_length(pen_name) between 1 and 120);

-- ------------------------------------------------------------
-- 5. Functions and triggers. Every trigger function is SECURITY
--    DEFINER with an empty search_path: they read other authors' pen
--    names (RLS shows only your own), write books.pen_name (not
--    granted to authenticated) and write pen_names (author_id and
--    is_default are not granted to anyone but the server).
-- ------------------------------------------------------------

-- Finds the author's pen name for p_name (case-insensitive, trimmed),
-- creating it when it does not exist; null, blank or the default's own
-- name gives the default. service_role (the server writer) may call it.
create function public.resolve_author_pen_name(p_author_id uuid, p_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text;
  v_id uuid;
begin
  if p_author_id is null then
    raise exception 'pen names: an author is required' using errcode = '22023';
  end if;

  v_name := pg_catalog.btrim(coalesce(p_name, ''), E' \t\r\n');

  if v_name = '' then
    select pn.id into v_id
      from public.pen_names pn
     where pn.author_id = p_author_id and pn.is_default;
    if v_id is null then
      raise exception 'pen names: this account has no default pen name' using errcode = 'LB454';
    end if;
    return v_id;
  end if;

  select pn.id into v_id
    from public.pen_names pn
   where pn.author_id = p_author_id
     and pg_catalog.lower(pn.name) = pg_catalog.lower(v_name);
  if v_id is not null then
    return v_id;
  end if;

  insert into public.pen_names (author_id, name)
  values (p_author_id, v_name)
  on conflict (author_id, (pg_catalog.lower(name))) do nothing
  returning id into v_id;

  if v_id is null then
    select pn.id into v_id
      from public.pen_names pn
     where pn.author_id = p_author_id
       and pg_catalog.lower(pn.name) = pg_catalog.lower(v_name);
  end if;

  return v_id;
end;
$$;

-- profiles -> default pen name. AFTER (the pen name's foreign key needs
-- the profile row). Covers handle_new_user() and becomeAuthor.
create function public.pen_names_sync_profile_default()
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
  v_avatar text;
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

  -- r4 (17a): a new default pen name starts with the profile's bio and
  -- photo, when set (the photo only in its canonical
  -- "<account id>/avatar.<ext>" shape); an existing pen name promoted to
  -- default keeps its own and takes the profile's only where it has none.
  v_bio := case when pg_catalog.btrim(coalesce(new.bio, ''), E' \t\r\n') = '' then null else new.bio end;
  v_avatar := case when new.avatar_path in (new.id::text || '/avatar.jpg', new.id::text || '/avatar.png')
                   then new.avatar_path end;

  if v_default_id is null then
    if v_clash is not null then
      update public.pen_names
         set is_default = true, name = v_name,
             bio = coalesce(bio, v_bio), avatar_path = coalesce(avatar_path, v_avatar)
       where id = v_clash;
    else
      insert into public.pen_names (author_id, name, is_default, bio, avatar_path)
      values (new.id, v_name, true, v_bio, v_avatar);
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

create trigger profiles_sync_default_pen_name
  after insert or update of role, public_author_name on public.profiles
  for each row
  execute function public.pen_names_sync_profile_default();

-- pen_names rename -> books.pen_name text, and the default's name ->
-- profiles.public_author_name (the Profile field IS the default).
create function public.pen_names_after_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_text text;
begin
  if new.name is distinct from old.name or new.is_default is distinct from old.is_default then
    v_text := case when new.is_default then null else new.name end;
    update public.books b
       set pen_name = v_text
     where b.pen_name_id = new.id
       and b.pen_name is distinct from v_text;
  end if;

  if new.is_default and new.name is distinct from old.name then
    update public.profiles p
       set public_author_name = new.name
     where p.id = new.author_id
       and pg_catalog.btrim(coalesce(p.public_author_name, ''), E' \t\r\n') is distinct from new.name;
  end if;

  return null;
end;
$$;

create trigger pen_names_after_update
  after update of name, is_default on public.pen_names
  for each row
  execute function public.pen_names_after_update();

-- The default pen name goes only with its account.
create function public.pen_names_before_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.is_default and exists (select 1 from public.profiles p where p.id = old.author_id) then
    raise exception 'The default pen name cannot be deleted.' using errcode = 'LB456';
  end if;
  return old;
end;
$$;

create trigger pen_names_before_delete
  before delete on public.pen_names
  for each row
  execute function public.pen_names_before_delete();

-- books: default fill, ownership, two-way text sync (N1), 14a and 11a.
create function public.books_enforce_pen_name()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
  v_name text;
  v_is_default boolean;
  v_series_pen uuid;
begin
  -- The text keeps books_pen_name_check's own refusal (old code, and
  -- any direct write) before it is resolved to a pen name.
  if new.pen_name is not null
     and (tg_op = 'INSERT' or new.pen_name is distinct from old.pen_name)
     and not (pg_catalog.char_length(new.pen_name) between 1 and 120
              and new.pen_name = pg_catalog.btrim(new.pen_name, E' \t\r\n'))
  then
    raise exception 'new row for relation "books" violates check constraint "books_pen_name_check"'
      using errcode = '23514', constraint = 'books_pen_name_check';
  end if;

  if tg_op = 'INSERT' then
    if new.pen_name_id is null then
      new.pen_name_id := public.resolve_author_pen_name(new.author_id, new.pen_name);
    end if;
  elsif new.pen_name_id is null then
    new.pen_name_id := public.resolve_author_pen_name(new.author_id, null);
  elsif new.pen_name_id is not distinct from old.pen_name_id
        and new.pen_name is distinct from old.pen_name
  then
    -- Only the text changed: a pen-name rename being synced (it already
    -- equals the pen name's text) or old code writing books.pen_name.
    select pn.name, pn.is_default into v_name, v_is_default
      from public.pen_names pn where pn.id = new.pen_name_id;
    if new.pen_name is distinct from (case when v_is_default then null else v_name end) then
      new.pen_name_id := public.resolve_author_pen_name(new.author_id, new.pen_name);
    end if;
  end if;

  select pn.author_id, pn.name, pn.is_default into v_owner, v_name, v_is_default
    from public.pen_names pn where pn.id = new.pen_name_id;
  if v_owner is null or v_owner <> new.author_id then
    raise exception 'pen names: the pen name does not belong to this book''s author' using errcode = '42501';
  end if;

  new.pen_name := case when v_is_default then null else v_name end;

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

create trigger books_enforce_pen_name
  before insert or update of pen_name_id, pen_name, author_id, series_id on public.books
  for each row
  execute function public.books_enforce_pen_name();

-- series: default fill, ownership, and a non-empty series keeps the pen
-- name of its books (11a).
create function public.series_enforce_pen_name()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
begin
  -- r5 (audit F1): a data-API caller (anon or authenticated) writing a
  -- series row for ANOTHER account is refused by RLS anyway. Return
  -- before any pen name lookup, so that refusal is RLS's generic error
  -- whatever the pen name is -- never an error that tells whether a pen
  -- name belongs to that account (or whether it has a default one).
  -- The role GUC is the caller's role even inside SECURITY DEFINER.
  -- service_role and the owner's own rows are checked as before.
  if pg_catalog.current_setting('role') in ('anon', 'authenticated')
     and new.author_id is distinct from auth.uid()
  then
    return new;
  end if;

  if new.pen_name_id is null then
    new.pen_name_id := public.resolve_author_pen_name(new.author_id, null);
  end if;

  select pn.author_id into v_owner from public.pen_names pn where pn.id = new.pen_name_id;
  if v_owner is null or v_owner <> new.author_id then
    raise exception 'pen names: the pen name does not belong to this series'' author' using errcode = '42501';
  end if;

  if tg_op = 'UPDATE'
     and new.pen_name_id is distinct from old.pen_name_id
     and exists (select 1 from public.books b
                  where b.series_id = new.id and b.pen_name_id is distinct from new.pen_name_id)
  then
    raise exception 'A series holds books of one pen name only.' using errcode = 'LB451';
  end if;

  return new;
end;
$$;

create trigger series_enforce_pen_name
  before insert or update of pen_name_id, author_id on public.series
  for each row
  execute function public.series_enforce_pen_name();

-- bundles: default fill and ownership. Membership is checked per row
-- by bundle_books_enforce_pen_name and, for a change of the bundle's
-- pen name, at commit by bundles_check_member_pen_names (the update RPC
-- sets the pen name before it replaces the membership).
create function public.bundles_enforce_pen_name()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
begin
  if new.pen_name_id is null then
    new.pen_name_id := public.resolve_author_pen_name(new.author_id, null);
  end if;

  select pn.author_id into v_owner from public.pen_names pn where pn.id = new.pen_name_id;
  if v_owner is null or v_owner <> new.author_id then
    raise exception 'pen names: the pen name does not belong to this bundle''s author' using errcode = '42501';
  end if;

  return new;
end;
$$;

create trigger bundles_enforce_pen_name
  before insert or update of pen_name_id, author_id on public.bundles
  for each row
  execute function public.bundles_enforce_pen_name();

create function public.bundles_check_member_pen_names()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
      from public.bundles bu
      join public.bundle_books bb on bb.bundle_id = bu.id
      join public.books b on b.id = bb.book_id
     where bu.id = new.id
       and b.pen_name_id is distinct from bu.pen_name_id
  ) then
    raise exception 'A bundle holds books of one pen name only.' using errcode = 'LB451';
  end if;
  return null;
end;
$$;

create constraint trigger bundles_check_member_pen_names
  after update of pen_name_id on public.bundles
  deferrable initially deferred
  for each row
  execute function public.bundles_check_member_pen_names();

create function public.bundle_books_enforce_pen_name()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_book_pen uuid;
  v_book_author uuid;
  v_bundle_pen uuid;
  v_bundle_author uuid;
begin
  -- One author's pen names only: a book of another account is refused
  -- by the bundle writers' own ownership checks, not here.
  select b.pen_name_id, b.author_id into v_book_pen, v_book_author
    from public.books b where b.id = new.book_id;
  select bu.pen_name_id, bu.author_id into v_bundle_pen, v_bundle_author
    from public.bundles bu where bu.id = new.bundle_id;
  if v_book_author = v_bundle_author and v_book_pen <> v_bundle_pen then
    raise exception 'A bundle holds books of one pen name only.' using errcode = 'LB451';
  end if;
  return new;
end;
$$;

create trigger bundle_books_enforce_pen_name
  before insert or update of bundle_id, book_id on public.bundle_books
  for each row
  execute function public.bundle_books_enforce_pen_name();

-- ------------------------------------------------------------
-- 6. Public view: no author_id
-- ------------------------------------------------------------
create view public.public_pen_names as
  select pn.id, pn.name, pn.bio, pn.avatar_path, pn.links
  from public.pen_names pn
  where exists (select 1 from public.books b where b.pen_name_id = pn.id)
     or exists (select 1 from public.series s where s.pen_name_id = pn.id)
     or exists (select 1 from public.bundles bu where bu.pen_name_id = pn.id);

revoke insert, update, delete, truncate, references, trigger, maintain
  on table public.public_pen_names
  from anon, authenticated;

grant select
  on table public.public_pen_names
  to anon, authenticated;

-- ------------------------------------------------------------
-- 7. Follows (4a, 12a)
-- ------------------------------------------------------------
create table public.pen_name_follows (
  follower_id uuid not null references public.profiles(id) on delete cascade,
  pen_name_id uuid not null references public.pen_names(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, pen_name_id)
);

create index pen_name_follows_pen_name_id_idx on public.pen_name_follows(pen_name_id);

alter table public.pen_name_follows enable row level security;

revoke all on public.pen_name_follows from public, anon, authenticated;
grant select, insert, delete on public.pen_name_follows to authenticated;

create policy "Readers can view their own pen name follows"
  on public.pen_name_follows for select
  to authenticated
  using (auth.uid() = follower_id);

create policy "Readers can follow a pen name"
  on public.pen_name_follows for insert
  to authenticated
  with check (auth.uid() = follower_id);

create policy "Readers can unfollow a pen name"
  on public.pen_name_follows for delete
  to authenticated
  using (auth.uid() = follower_id);

insert into public.pen_name_follows (follower_id, pen_name_id, created_at)
select af.follower_id, pn.id, af.created_at
  from public.author_follows af
  join public.pen_names pn on pn.author_id = af.author_id and pn.is_default
on conflict (follower_id, pen_name_id) do nothing;

create function public.pen_name_follows_refuse_own()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- r5 (audit F1): a row for ANOTHER follower is refused by RLS anyway;
  -- return before the lookup so the refusal is RLS's generic error
  -- whether or not the pen name is that follower's own. The caller's
  -- own follows and service_role writes are checked as before.
  if pg_catalog.current_setting('role') in ('anon', 'authenticated')
     and new.follower_id is distinct from auth.uid()
  then
    return new;
  end if;

  if exists (select 1 from public.pen_names pn
              where pn.id = new.pen_name_id and pn.author_id = new.follower_id) then
    raise exception 'You cannot follow your own pen name.' using errcode = 'LB457';
  end if;
  return new;
end;
$$;

create trigger pen_name_follows_refuse_own
  before insert or update on public.pen_name_follows
  for each row
  execute function public.pen_name_follows_refuse_own();

-- Until PR B drops author_follows: old code's follow and unfollow land
-- on the author's default pen name.
create function public.author_follows_mirror_pen_name_follows()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pen uuid;
begin
  if tg_op = 'INSERT' then
    select pn.id into v_pen from public.pen_names pn
     where pn.author_id = new.author_id and pn.is_default;
    if v_pen is not null then
      insert into public.pen_name_follows (follower_id, pen_name_id)
      values (new.follower_id, v_pen)
      on conflict (follower_id, pen_name_id) do nothing;
    end if;
  else
    select pn.id into v_pen from public.pen_names pn
     where pn.author_id = old.author_id and pn.is_default;
    if v_pen is not null then
      delete from public.pen_name_follows f
       where f.follower_id = old.follower_id and f.pen_name_id = v_pen;
    end if;
  end if;
  return null;
end;
$$;

create trigger author_follows_mirror_pen_name_follows
  after insert or delete on public.author_follows
  for each row
  execute function public.author_follows_mirror_pen_name_follows();

-- ------------------------------------------------------------
-- 8. Staff: remove a pen name's links (8a, 13a, 15a), audited
-- ------------------------------------------------------------
create function public.staff_remove_pen_name_links(p_pen_name_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_links jsonb;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('reports.resolve') then
    raise exception 'not authorized';
  end if;

  select pn.links into v_links
    from public.pen_names pn
   where pn.id = p_pen_name_id
     for update;

  if not found then
    raise exception 'no pen name found for this id';
  end if;

  update public.pen_names set links = '[]'::jsonb where id = p_pen_name_id;

  insert into public.admin_audit_log (actor_id, action, target_type, target_id, metadata)
  values (v_actor_id, 'pen_name.links_removed', 'pen_names', p_pen_name_id,
          pg_catalog.jsonb_build_object('removed_links', v_links));
end;
$$;

-- The admin audit log's filter vocabulary gains this event and its
-- target type, so staff can filter for it (r4). Full body restated from
-- the current definition; only the two allow-lists change. CREATE OR
-- REPLACE keeps the function's existing grants.
create or replace function public.list_admin_audit_events(
  p_action text default null,
  p_actor_id uuid default null,
  p_target_type text default null,
  p_created_after timestamptz default null,
  p_created_before timestamptz default null,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null,
  p_limit integer default 25
)
returns table (
  id uuid,
  actor_id uuid,
  actor_display_name text,
  action text,
  target_type text,
  target_id uuid,
  metadata jsonb,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  v_limit integer;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('audit.view') then
    raise exception 'not authorized';
  end if;

  if p_action is not null and p_action not in (
    'staff.added', 'staff.role_changed', 'staff.removed',
    'report.resolved', 'report.dismissed',
    'refund.review_approved', 'refund.review_rejected',
    'refund.issuance_submitted',
    'blog_post.published', 'blog_post.unpublished', 'blog_post.deleted',
    'pen_name.links_removed'
  ) then
    raise exception 'invalid action filter';
  end if;

  if p_target_type is not null and p_target_type not in (
    'staff_members', 'book_reports', 'refund_requests', 'blog_posts',
    'pen_names'
  ) then
    raise exception 'invalid target_type filter';
  end if;

  if (p_cursor_created_at is null) <> (p_cursor_id is null) then
    raise exception 'invalid cursor';
  end if;

  if p_created_after is not null and p_created_before is not null
     and p_created_after >= p_created_before then
    raise exception 'invalid date range';
  end if;

  v_limit := coalesce(p_limit, 25);
  if v_limit < 1 then
    v_limit := 1;
  elsif v_limit > 100 then
    v_limit := 100;
  end if;

  return query
    select
      aal.id,
      aal.actor_id,
      p.display_name as actor_display_name,
      aal.action,
      aal.target_type,
      aal.target_id,
      aal.metadata,
      aal.created_at
    from public.admin_audit_log aal
    left join public.profiles p on p.id = aal.actor_id
    where (p_action is null or aal.action = p_action)
      and (p_actor_id is null or aal.actor_id = p_actor_id)
      and (p_target_type is null or aal.target_type = p_target_type)
      and (p_created_after is null or aal.created_at >= p_created_after)
      and (p_created_before is null or aal.created_at < p_created_before)
      and (
        p_cursor_created_at is null
        or (aal.created_at, aal.id) < (p_cursor_created_at, p_cursor_id)
      )
    order by aal.created_at desc, aal.id desc
    limit v_limit;
end;
$$;

-- ------------------------------------------------------------
-- 9. search_books(): the book's own pen name (5a)
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
  select books.id as book_id
  from public.books
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

-- ------------------------------------------------------------
-- 10. Bundle RPCs (N4): the pen name comes from p_book_ids, before the
--     bundle row is written. Signatures and ACL unchanged.
-- ------------------------------------------------------------
create or replace function public.create_bundle_with_membership(
  p_bundle_id uuid,
  p_author_id uuid,
  p_title text,
  p_description text,
  p_price_all integer,
  p_book_ids uuid[]
)
returns table (member_bundle_id uuid, member_book_id uuid)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_pen_count integer;
  v_pen_name_id uuid;
begin
  if p_bundle_id is null or p_author_id is null then
    raise exception 'bundle membership: bundle and author are required'
      using errcode = '22023';
  end if;

  -- PEN-NAMES-1 (11a): one pen name per bundle, taken from its books.
  select pg_catalog.count(distinct bo.pen_name_id), pg_catalog.min(bo.pen_name_id::text)::uuid
    into v_pen_count, v_pen_name_id
    from public.books bo
   where bo.id = any (p_book_ids)
     and bo.author_id = p_author_id;

  if v_pen_count > 1 then
    raise exception 'A bundle holds books of one pen name only.'
      using errcode = 'LB451';
  end if;

  insert into public.bundles (id, author_id, title, description, price_all, pen_name_id)
  values (p_bundle_id, p_author_id, p_title, p_description, p_price_all, v_pen_name_id);

  return query
    select r.member_bundle_id, r.member_book_id
      from public.replace_bundle_membership(p_bundle_id, p_author_id, p_book_ids) as r;
end;
$$;

create or replace function public.update_bundle_with_membership(
  p_bundle_id uuid,
  p_author_id uuid,
  p_expected_status text,
  p_check_expected_price_all boolean,
  p_expected_price_all integer,
  p_title text,
  p_description text,
  p_price_all integer,
  p_book_ids uuid[]
)
returns table (
  member_bundle_id uuid,
  member_book_id uuid,
  bundle_title text,
  bundle_description text,
  bundle_price_all integer,
  bundle_status text
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_status text;
  v_price_all integer;
  v_updated integer;
  v_title text;
  v_description text;
  v_new_price_all integer;
  v_pen_count integer;
  v_pen_name_id uuid;
begin
  if p_bundle_id is null or p_author_id is null or p_check_expected_price_all is null then
    raise exception 'bundle update: bundle, author and guard are required'
      using errcode = '22023';
  end if;

  -- 1. Lock the bundle, bound to this author. Two complete edits of the
  --    same bundle serialize here for their WHOLE transaction.
  select b.status, b.price_all
    into v_status, v_price_all
    from public.bundles b
   where b.id = p_bundle_id
     and b.author_id = p_author_id
     for update of b;

  if not found then
    raise exception 'bundle update: bundle not found for this author'
      using errcode = '42501';
  end if;

  -- 2. PAID-REPRICING-1 compare-and-set, evaluated on the LOCKED row.
  --    p_expected_status null means "no status condition";
  --    p_check_expected_price_all false means "no price condition", and
  --    when true a null p_expected_price_all means "still unpriced".
  if (p_expected_status is not null and v_status is distinct from p_expected_status)
    or (p_check_expected_price_all and v_price_all is distinct from p_expected_price_all)
  then
    raise exception 'bundle update: the bundle changed since it was read'
      using errcode = 'LB409';
  end if;

  -- PEN-NAMES-1 (11a, N4): one pen name per bundle, taken from the
  -- requested books, refused when they are mixed -- before the bundle
  -- row is written.
  select pg_catalog.count(distinct bo.pen_name_id), pg_catalog.min(bo.pen_name_id::text)::uuid
    into v_pen_count, v_pen_name_id
    from public.books bo
   where bo.id = any (p_book_ids)
     and bo.author_id = p_author_id;

  if v_pen_count > 1 then
    raise exception 'A bundle holds books of one pen name only.'
      using errcode = 'LB451';
  end if;

  -- 3. The details. price_cents and status are never named. The pen
  --    name is set here, before the membership is replaced (step 4).
  update public.bundles b
     set title = p_title,
         description = p_description,
         price_all = p_price_all,
         pen_name_id = coalesce(v_pen_name_id, b.pen_name_id)
   where b.id = p_bundle_id
     and b.author_id = p_author_id;

  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    raise exception 'bundle update: expected to update exactly one bundle, updated %', v_updated
      using errcode = '23000';
  end if;

  -- 4. The membership, in this same transaction: validates and locks
  --    every book (distinct, published, this author's own), replaces the
  --    membership and raises unless the stored set is exactly the
  --    requested one. A refusal here rolls the details back too.
  perform 1 from public.replace_bundle_membership(p_bundle_id, p_author_id, p_book_ids);

  -- 5. The details as persisted must be exactly what was submitted.
  select b.title, b.description, b.price_all
    into v_title, v_description, v_new_price_all
    from public.bundles b
   where b.id = p_bundle_id
     and b.author_id = p_author_id;

  if v_title is distinct from p_title
    or v_description is distinct from p_description
    or v_new_price_all is distinct from p_price_all
  then
    raise exception 'bundle update: stored details do not equal the submitted details'
      using errcode = '23000';
  end if;

  -- 6. Proof of the complete resulting state: one row per member, each
  --    carrying the bundle's persisted details.
  return query
    select bb.bundle_id, bb.book_id, b.title, b.description, b.price_all, b.status
      from public.bundle_books bb
      join public.bundles b on b.id = bb.bundle_id
     where bb.bundle_id = p_bundle_id
     order by bb.book_id;
end;
$$;

-- ------------------------------------------------------------
-- 11. Function privileges. The platform grants EXECUTE on every new
--     public function to anon, authenticated and service_role, and
--     PostgreSQL to PUBLIC; reset, then grant only what is called.
--     Trigger functions are never callable directly anyway.
--     pen_name_links_valid keeps its default EXECUTE: the CHECK on
--     pen_names.links runs it as whoever writes the row.
-- ------------------------------------------------------------
revoke all on function public.resolve_author_pen_name(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.resolve_author_pen_name(uuid, text) to service_role;
revoke all on function public.pen_names_sync_profile_default() from public, anon, authenticated;
revoke all on function public.pen_names_after_update() from public, anon, authenticated;
revoke all on function public.pen_names_before_delete() from public, anon, authenticated;
revoke all on function public.books_enforce_pen_name() from public, anon, authenticated;
revoke all on function public.series_enforce_pen_name() from public, anon, authenticated;
revoke all on function public.bundles_enforce_pen_name() from public, anon, authenticated;
revoke all on function public.bundles_check_member_pen_names() from public, anon, authenticated;
revoke all on function public.bundle_books_enforce_pen_name() from public, anon, authenticated;
revoke all on function public.pen_name_follows_refuse_own() from public, anon, authenticated;
revoke all on function public.author_follows_mirror_pen_name_follows() from public, anon, authenticated;
revoke all on function public.staff_remove_pen_name_links(uuid) from public, anon, authenticated;
grant execute on function public.staff_remove_pen_name_links(uuid) to authenticated;
