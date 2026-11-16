-- K6 free Albanian classics (Renato 2026-11-16).
-- ADDITIVE ONLY: one new table, one new nullable column on pd_works,
-- one new view and two new functions. No drop, no rename, no type
-- change; no existing row, grant, policy or function changes, nothing
-- is backfilled.
--
-- ROLLOUT ORDER. Apply on staging BEFORE the application in the same
-- patch is deployed there. The old code keeps working after it (it
-- reads and writes nothing new). Production gets it only at a release.
--
-- WHAT CHANGES (his answers 2026-11-16):
--
--   1. public.classic_authors: one classic author (Q1 b: own page at
--      /klasiket/<slug>): slug, name, birth and death year, optional
--      birth and death place, staff-written bio. RLS on with no policy;
--      only service_role reads it directly (the admin pages). Written
--      only through staff_save_classic_author().
--
--   2. pd_works.classic_author_id: which classic author a public-domain
--      work belongs to (nullable; K6 Q2 a: a work without one keeps
--      today's byline link to the Libraria search). ON DELETE SET NULL.
--      Set only through staff_set_pd_work_classic_author().
--
--   3. public.public_classic_authors: what readers see. A classic author
--      appears only while at least one of their works has a publicly
--      listed picked edition (K6 Q3 a: no live book = no page), with
--      pd_work_ids = exactly those works. Runs as its owner (like
--      public_books), so readers never get classic_authors or pd_works.
--      anon and authenticated may select it.
--
--   4. staff_save_classic_author(...): books.review (owner and admin).
--      p_id null = add, else edit. Refuses bad fields (LB515), an author
--      who did not die more than 70 years ago (LB516: death year at most
--      this year minus 71, so their works are public domain), a missing
--      id (LB517); a taken slug is the unique violation (23505).
--
--   5. staff_set_pd_work_classic_author(work, author): books.review.
--      Links (or with a null author, unlinks) a work. LB517 for a
--      missing work or author.
--
-- The declarative equivalent is in supabase/schema.sql; see
-- supabase/tests/101_classic_authors.test.sql.
-- Rollback: supabase/tests/101_classic_authors.rollback.sql
-- ============================================================

-- ------------------------------------------------------------
-- 1. The table.
-- ------------------------------------------------------------
create table public.classic_authors (
  id uuid primary key default gen_random_uuid(),
  slug text not null
    constraint classic_authors_slug_key unique
    constraint classic_authors_slug_check
    check (char_length(slug) between 1 and 80
           and slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text not null
    constraint classic_authors_name_check
    check (char_length(name) between 1 and 200
           and name = btrim(name)
           and name !~ '[[:cntrl:]]'),
  birth_year integer not null
    constraint classic_authors_birth_year_check
    check (birth_year between 1000 and 2100),
  death_year integer not null
    constraint classic_authors_death_year_check
    check (death_year between 1000 and 2100),
  birth_place text
    constraint classic_authors_birth_place_check
    check (birth_place is null
           or (char_length(birth_place) between 1 and 120
               and birth_place = btrim(birth_place)
               and birth_place !~ '[[:cntrl:]]')),
  death_place text
    constraint classic_authors_death_place_check
    check (death_place is null
           or (char_length(death_place) between 1 and 120
               and death_place = btrim(death_place)
               and death_place !~ '[[:cntrl:]]')),
  -- Paragraphs are separated by a line feed; no other control character.
  bio text not null
    constraint classic_authors_bio_check
    check (char_length(bio) between 1 and 3000
           and bio = btrim(bio)
           and pg_catalog.replace(bio, chr(10), ' ') !~ '[[:cntrl:]]'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint classic_authors_years_check check (death_year >= birth_year)
);

alter table public.classic_authors enable row level security;

revoke all on public.classic_authors from public, anon, authenticated, service_role;
grant select on public.classic_authors to service_role;

-- ------------------------------------------------------------
-- 2. The link from a public-domain work.
-- ------------------------------------------------------------
alter table public.pd_works
  add column classic_author_id uuid
    constraint pd_works_classic_author_id_fkey
    references public.classic_authors(id) on delete set null;

create index pd_works_classic_author_id_idx on public.pd_works (classic_author_id);

-- ------------------------------------------------------------
-- 3. What readers see.
-- ------------------------------------------------------------
create view public.public_classic_authors
  with (security_barrier)
as
  select ca.id, ca.slug, ca.name, ca.birth_year, ca.death_year,
         ca.birth_place, ca.death_place, ca.bio, live.pd_work_ids
  from public.classic_authors ca
  join lateral (
    select array_agg(w.id order by w.id) as pd_work_ids
      from public.pd_works w
      join public.books b on b.id = w.picked_book_id
     where w.classic_author_id = ca.id
       and public.book_is_publicly_listed(b)
  ) live on live.pd_work_ids is not null;

revoke all on public.public_classic_authors from public, anon, authenticated, service_role;
grant select on public.public_classic_authors to anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 4. Add or edit a classic author.
-- ------------------------------------------------------------
create function public.staff_save_classic_author(
  p_id uuid,
  p_slug text,
  p_name text,
  p_birth_year integer,
  p_death_year integer,
  p_birth_place text,
  p_death_place text,
  p_bio text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if not public.staff_has_permission('books.review') then
    raise exception 'not authorized';
  end if;
  if p_slug is null or p_name is null or p_birth_year is null
     or p_death_year is null or p_bio is null then
    raise exception 'invalid classic author' using errcode = 'LB515';
  end if;
  if p_death_year > extract(year from pg_catalog.now())::integer - 71 then
    raise exception 'classic author died too recently' using errcode = 'LB516';
  end if;

  begin
    if p_id is null then
      insert into public.classic_authors
        (slug, name, birth_year, death_year, birth_place, death_place, bio)
      values
        (p_slug, p_name, p_birth_year, p_death_year, p_birth_place, p_death_place, p_bio)
      returning id into v_id;
    else
      update public.classic_authors
         set slug = p_slug, name = p_name, birth_year = p_birth_year,
             death_year = p_death_year, birth_place = p_birth_place,
             death_place = p_death_place, bio = p_bio,
             updated_at = pg_catalog.now()
       where id = p_id
      returning id into v_id;
      if v_id is null then
        raise exception 'no classic author found for this id' using errcode = 'LB517';
      end if;
    end if;
  exception when check_violation then
    raise exception 'invalid classic author' using errcode = 'LB515';
  end;

  return v_id;
end;
$$;

revoke all on function public.staff_save_classic_author(uuid, text, text, integer, integer, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.staff_save_classic_author(uuid, text, text, integer, integer, text, text, text)
  to authenticated;

-- ------------------------------------------------------------
-- 5. Link a public-domain work to a classic author (null unlinks).
-- ------------------------------------------------------------
create function public.staff_set_pd_work_classic_author(p_work_id uuid, p_author_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if not public.staff_has_permission('books.review') then
    raise exception 'not authorized';
  end if;
  if p_work_id is null then
    raise exception 'no public-domain work found for this id' using errcode = 'LB517';
  end if;
  if p_author_id is not null
     and not exists (select 1 from public.classic_authors ca where ca.id = p_author_id) then
    raise exception 'no classic author found for this id' using errcode = 'LB517';
  end if;

  update public.pd_works w
     set classic_author_id = p_author_id
   where w.id = p_work_id;
  if not found then
    raise exception 'no public-domain work found for this id' using errcode = 'LB517';
  end if;
end;
$$;

revoke all on function public.staff_set_pd_work_classic_author(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.staff_set_pd_work_classic_author(uuid, uuid)
  to authenticated;
