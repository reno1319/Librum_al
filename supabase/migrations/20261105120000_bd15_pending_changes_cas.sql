-- ============================================================
-- BD15 P5b-3b (migration 20261105120000): a save of a live book's
-- waiting changes never overwrites another one it did not see.
-- Audit BD15-P5b2 r1 F4: two saves of the same book's waiting changes
-- (a Details save and a Content save, or two tabs) each read the row,
-- then wrote all five values back. The later write put back the value
-- the earlier one had replaced: the waiting ballinë could name a cover
-- that had just been removed, and the new upload was orphaned.
--
-- Renato, 5 Nov 2026 (Q1 a, 11:37 UTC): the later save is refused. The
-- app deletes its new upload and asks the author to reload and save
-- again. Nothing is retried or merged.
--
-- What it changes, and nothing else:
--   1. book_pending_changes.version: a fresh number from one sequence
--      on every insert and every update (a trigger sets it; nobody else
--      can). The sequence never restarts, so a row deleted and created
--      again (a discard, an approval, going offline, then a new save)
--      never gets back a number an older request read (audit P5b-3b r1,
--      F1: with 1 on every new row, such a request passed the compare).
--      Rows already there keep 1; the sequence starts at 2.
--   2. save_book_pending_changes() and discard_book_pending_changes()
--      take the version the caller read (null: it read no row). They
--      lock the row, and refuse with LB496 when it is not the version
--      the caller read: another save, a discard, an approval or the book
--      going offline came in between. save returns the new version.
--      Two first saves at the same moment: the second finds the row the
--      first inserted and is refused too (never an overwrite).
--   The old signatures are dropped: the app before this patch calls the
--   seven- and two-argument forms and gets "function not found" (a save
--   failure, nothing written) until the new app is deployed.
--
-- New SQLSTATE: LB496.
--
-- The declarative equivalent is in supabase/schema.sql; see
-- supabase/tests/093_bd15_pending_changes_cas.test.sql and
-- 093_bd15_pending_changes_cas_catalog_equivalence.sh.
-- Rollback: supabase/tests/093_bd15_pending_changes_cas.rollback.sql
-- ============================================================

-- ------------------------------------------------------------
-- 1. The row's version
-- ------------------------------------------------------------
alter table public.book_pending_changes
  add column version bigint not null default 1;

-- Only the trigger function (as its owner) draws from it.
create sequence public.book_pending_changes_version_seq as bigint start with 2;
revoke all on sequence public.book_pending_changes_version_seq
  from public, anon, authenticated, service_role;

-- SECURITY DEFINER so it draws from the sequence as its owner; nobody
-- else holds a privilege on the sequence.
create function public.book_pending_changes_set_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.version := pg_catalog.nextval('public.book_pending_changes_version_seq');
  return new;
end;
$$;

create trigger book_pending_changes_set_version
  before insert or update on public.book_pending_changes
  for each row
  execute function public.book_pending_changes_set_version();

revoke all on function public.book_pending_changes_set_version()
  from public, anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 2. Compare-and-set saves and discards
-- ------------------------------------------------------------
drop function public.save_book_pending_changes(uuid, uuid, text, text, text, boolean, text);
drop function public.discard_book_pending_changes(uuid, uuid);

-- The catalog writer's two writes. p_author_id is the session's verified
-- user: a book of another account is answered as missing. The book is
-- locked first (the order of an unpublish, a takedown or an approval),
-- then the waiting row.
create function public.save_book_pending_changes(
  p_author_id uuid,
  p_book_id uuid,
  p_expected_version bigint,
  p_file_path text,
  p_cover_path text,
  p_description text,
  p_is_adult boolean,
  p_original_author text
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version bigint;
begin
  perform 1 from public.books bo
   where bo.id = p_book_id and bo.author_id = p_author_id
     for share;
  if not found or p_author_id is null then
    raise exception 'no book found for this id';
  end if;
  select c.version into v_version
    from public.book_pending_changes c
   where c.book_id = p_book_id
     for update;
  if not found then
    if p_expected_version is not null then
      raise exception 'The waiting changes changed since they were read.'
        using errcode = 'LB496';
    end if;
    insert into public.book_pending_changes
           (book_id, file_path, cover_path, description, is_adult, original_author)
    values (p_book_id, p_file_path, p_cover_path, p_description, p_is_adult, p_original_author)
    on conflict (book_id) do nothing
    returning version into v_version;
    -- Another first save inserted the row after our read.
    if v_version is null then
      raise exception 'The waiting changes changed since they were read.'
        using errcode = 'LB496';
    end if;
    return v_version;
  end if;
  if p_expected_version is null or v_version <> p_expected_version then
    raise exception 'The waiting changes changed since they were read.'
      using errcode = 'LB496';
  end if;
  update public.book_pending_changes c
     set file_path = p_file_path,
         cover_path = p_cover_path,
         description = p_description,
         is_adult = p_is_adult,
         original_author = p_original_author
   where c.book_id = p_book_id
  returning c.version into v_version;
  return v_version;
end;
$$;

revoke all on function public.save_book_pending_changes(uuid, uuid, bigint, text, text, text, boolean, text)
  from public, anon, authenticated, service_role;
grant execute on function public.save_book_pending_changes(uuid, uuid, bigint, text, text, text, boolean, text)
  to service_role;

-- "Hidh poshtë ndryshimet". True when the row the caller read was
-- discarded; false when it read none and there is still none.
create function public.discard_book_pending_changes(
  p_author_id uuid,
  p_book_id uuid,
  p_expected_version bigint
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version bigint;
begin
  perform 1 from public.books bo
   where bo.id = p_book_id and bo.author_id = p_author_id
     for share;
  if not found or p_author_id is null then
    raise exception 'no book found for this id';
  end if;
  select c.version into v_version
    from public.book_pending_changes c
   where c.book_id = p_book_id
     for update;
  if not found then
    if p_expected_version is not null then
      raise exception 'The waiting changes changed since they were read.'
        using errcode = 'LB496';
    end if;
    return false;
  end if;
  if p_expected_version is null or v_version <> p_expected_version then
    raise exception 'The waiting changes changed since they were read.'
      using errcode = 'LB496';
  end if;
  delete from public.book_pending_changes where book_id = p_book_id;
  return true;
end;
$$;

revoke all on function public.discard_book_pending_changes(uuid, uuid, bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.discard_book_pending_changes(uuid, uuid, bigint)
  to service_role;
