-- BD15 P5b-3b ROLLBACK: undoes migration 20261105120000.
-- Puts back save_book_pending_changes(uuid, uuid, text, text, text,
-- boolean, text) and discard_book_pending_changes(uuid, uuid) exactly as
-- migration 20261104170000 made them (with their grants), and removes
-- the three-argument discard, the eight-argument save, the version
-- trigger, its function and sequence, and book_pending_changes.version.
--
-- DATA: only the version numbers are dropped; every waiting change stays
-- as it is. Run only together with the app revert (the app before this
-- patch calls the old forms). Safe to run more than once.

begin;

drop function if exists public.save_book_pending_changes(uuid, uuid, bigint, text, text, text, boolean, text);
drop function if exists public.discard_book_pending_changes(uuid, uuid, bigint);
drop trigger if exists book_pending_changes_set_version on public.book_pending_changes;
drop function if exists public.book_pending_changes_set_version();
drop sequence if exists public.book_pending_changes_version_seq;
alter table public.book_pending_changes drop column if exists version;

-- As migration 20261104170000 made them.
create or replace function public.save_book_pending_changes(
  p_author_id uuid,
  p_book_id uuid,
  p_file_path text,
  p_cover_path text,
  p_description text,
  p_is_adult boolean,
  p_original_author text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1 from public.books bo
   where bo.id = p_book_id and bo.author_id = p_author_id
     for share;
  if not found or p_author_id is null then
    raise exception 'no book found for this id';
  end if;
  insert into public.book_pending_changes as c
         (book_id, file_path, cover_path, description, is_adult, original_author)
  values (p_book_id, p_file_path, p_cover_path, p_description, p_is_adult, p_original_author)
  on conflict (book_id) do update
     set file_path = excluded.file_path,
         cover_path = excluded.cover_path,
         description = excluded.description,
         is_adult = excluded.is_adult,
         original_author = excluded.original_author;
end;
$$;

revoke all on function public.save_book_pending_changes(uuid, uuid, text, text, text, boolean, text)
  from public, anon, authenticated, service_role;
grant execute on function public.save_book_pending_changes(uuid, uuid, text, text, text, boolean, text)
  to service_role;

-- "Hidh poshtë ndryshimet". True when there was something to discard.
create or replace function public.discard_book_pending_changes(p_author_id uuid, p_book_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows integer;
begin
  perform 1 from public.books bo
   where bo.id = p_book_id and bo.author_id = p_author_id
     for share;
  if not found or p_author_id is null then
    raise exception 'no book found for this id';
  end if;
  delete from public.book_pending_changes where book_id = p_book_id;
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

revoke all on function public.discard_book_pending_changes(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.discard_book_pending_changes(uuid, uuid)
  to service_role;

commit;
