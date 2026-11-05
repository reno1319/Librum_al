-- ============================================================
-- BD15 P7 (migration 20261105180000): public-domain editions.
-- Plan: PLAN-BD15-r1.md §2.6. The tables, columns and locks came with
-- P1 (migration 20261103200000); this adds what staff and readers use.
-- Renato's answers of 5 Nov 2026 (16:45-16:47 UTC):
--   Q1 a: once a book is its work's picked edition, the details that
--         save without review are frozen (LB497). The manuscript,
--         cover, description, 18+ label and original author still go
--         through review. A fix is a new upload that staff swap to.
--   Q2 a: a swapped-out edition goes back to draft (its author keeps
--         it or deletes it); its old page sends readers to the picked
--         edition (pd_edition_redirect).
--   Q3 a: a submission staff don't pick is sent back, never kept as an
--         approved hidden candidate: staff pick an edition only when
--         they approve it (admin_approve_pd_edition).
--   Q4 a: the credited uploader's line is "Përgatiti për botim"
--         (app copy; the database keeps pd_editor_credit).
--
-- What it adds:
--   1. books.public_pen_name_id: the pen name readers may see, kept by
--      Postgres (a stored generated column): the book's pen name, or
--      null on a public-domain edition without an editor mention. It
--      has its own foreign key to pen_names, and public_books shows it
--      as pen_name_id. HARD GATE: that view column stays a PLAIN column
--      reference (no CASE), so the Data API still embeds
--      pen:public_pen_names through it, and the embed is empty for a
--      hidden uploader. The table now has two foreign keys to pen_names,
--      so an embed from books itself names its key
--      (pen_names!books_pen_name_id_fkey); the app does.
--      public_pen_names no longer shows a pen name to a reader only
--      because they own such an edition (audit r1, B1).
--   2. LB497: a picked edition's no-review details and contributors
--      cannot change through the app's roles.
--   3. LB498: a book whose rights choice is "public domain" is
--      published only as the edition of a work.
--   4. staff_set_pd_edition(): staff link a book to a work (an existing
--      one, or a new one), unlink a draft, and set the editor mention.
--   5. admin_approve_pd_edition(): approving a linked draft picks it;
--      the work's previous edition goes back to draft in the same
--      transaction (a swap). A live edition's changes are approved as
--      any live book's.
--   6. pd_edition_redirect(): for a swapped-out edition's old page.
--
-- Rollback: supabase/tests/094_bd15_pd_editions.rollback.sql
-- ============================================================

-- ------------------------------------------------------------
-- 1. The pen name readers may see.
-- ------------------------------------------------------------
alter table public.books
  add column public_pen_name_id uuid
    generated always as (
      case when pd_work_id is null or pd_editor_credit then pen_name_id end
    ) stored
    constraint books_public_pen_name_id_fkey references public.pen_names(id);

-- Same columns, same order, same types: CREATE OR REPLACE keeps every
-- grant and the policies that read the view. Only pen_name_id's source
-- changes, and it stays a plain column.
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
         b.pd_work_id, b.pd_editor_credit
  from public.books b
  where public.book_is_publicly_listed(b)
     or b.author_id = auth.uid()
     or public.user_owns_book(b.id);

-- BD15 P7 audit r1 (B1): a reader who owns a book sees its pen name
-- (BD14 Q1a), but not through a public-domain edition without an editor
-- mention: a free claim would otherwise name the hidden uploader. Same
-- columns, so CREATE OR REPLACE keeps every grant (078/082).
create or replace view public.public_pen_names
  with (security_barrier)
as
  select pn.id, pn.name, pn.bio, pn.avatar_path, pn.links
  from public.pen_names pn
  where (
    -- A series or bundle holds books of its own pen name only (LB451
    -- triggers), so the book carries the rule for them too.
       exists (select 1 from public.books b
                where b.pen_name_id = pn.id
                  and public.book_makes_pen_name_public(b))
    -- Q1a: the author, and a reader who owns one of its books.
    or pn.author_id = auth.uid()
    or (auth.uid() is not null
        and exists (select 1 from public.books b
                     where b.pen_name_id = pn.id
                       and (b.pd_work_id is null or b.pd_editor_credit)
                       and public.user_owns_book(b.id)))
  )
    and not exists (
      select 1 from public.account_suspensions sus
       where sus.user_id = pn.author_id and sus.lifted_at is null
    );

-- ------------------------------------------------------------
-- 2. Q1 a: a picked edition's no-review details are frozen.
-- ------------------------------------------------------------
create function public.books_freeze_picked_pd_edition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if pg_catalog.current_setting('role') in ('anon', 'authenticated', 'service_role')
     and ((new.subtitle, new.language, new.keywords, new.isbn, new.publisher, new.edition,
           new.original_publication_date, new.genre, new.categories, new.reading_age_min,
           new.edition_number, new.price_all)
          is distinct from
          (old.subtitle, old.language, old.keywords, old.isbn, old.publisher, old.edition,
           old.original_publication_date, old.genre, old.categories, old.reading_age_min,
           old.edition_number, old.price_all)
          -- A deleted series clears series_id through its foreign key
          -- (a trigger, so depth > 1): allowed, as in LB490.
          or ((new.series_id, new.series_position) is distinct from (old.series_id, old.series_position)
              and not (pg_catalog.pg_trigger_depth() > 1 and new.series_id is null)))
     and exists (select 1 from public.pd_works w where w.picked_book_id = old.id)
  then
    raise exception 'Librum picked this book as the edition of a public-domain work, so this detail can''t change.'
      using errcode = 'LB497';
  end if;
  return new;
end;
$$;

create trigger books_freeze_picked_pd_edition
  before update of subtitle, language, keywords, isbn, publisher, edition, original_publication_date,
    genre, categories, reading_age_min, edition_number, price_all, series_id, series_position
  on public.books
  for each row
  execute function public.books_freeze_picked_pd_edition();

revoke all on function public.books_freeze_picked_pd_edition()
  from public, anon, authenticated, service_role;

create function public.book_contributors_freeze_picked_pd_edition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- No error oracle for another account's book (RLS refuses the row).
  if pg_catalog.current_setting('role') in ('anon', 'authenticated')
     and not exists (
       select 1 from public.books b
        where b.id in (case when tg_op = 'DELETE' then old.book_id else new.book_id end,
                       case when tg_op = 'UPDATE' then old.book_id end)
          and b.author_id = auth.uid()
     )
  then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  -- A delete that cascades from the book (an account deletion) is not
  -- refused.
  if pg_catalog.current_setting('role') in ('anon', 'authenticated', 'service_role')
     and pg_catalog.pg_trigger_depth() <= 1
     and exists (
       select 1 from public.pd_works w
        where w.picked_book_id in (case when tg_op = 'DELETE' then old.book_id else new.book_id end,
                                   case when tg_op = 'UPDATE' then old.book_id end)
     )
  then
    raise exception 'Librum picked this book as the edition of a public-domain work, so this detail can''t change.'
      using errcode = 'LB497';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger book_contributors_freeze_picked_pd_edition
  before insert or update or delete on public.book_contributors
  for each row
  execute function public.book_contributors_freeze_picked_pd_edition();

revoke all on function public.book_contributors_freeze_picked_pd_edition()
  from public, anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 3. A "public domain" book is published only as a work's edition.
--    Before this, approving one left it a normal book, with its
--    uploader's pen name public.
-- ------------------------------------------------------------
create function public.books_require_pd_work_link()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'published'
     and old.status is distinct from 'published'
     and new.pd_work_id is null
     and pg_catalog.current_setting('role') in ('anon', 'authenticated', 'service_role')
     and (select d.basis
            from public.book_rights_declarations d
           where d.book_id = new.id
           order by d.declared_at desc, d.id desc
           limit 1) = 'public_domain'
  then
    raise exception 'A public-domain book is published only as the edition of a work. Link it to a work first.'
      using errcode = 'LB498';
  end if;
  return new;
end;
$$;

create trigger books_require_pd_work_link
  before update of status on public.books
  for each row
  execute function public.books_require_pd_work_link();

revoke all on function public.books_require_pd_work_link()
  from public, anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 4. Staff link a book to a work and set the editor mention.
--    p_work_id: an existing work. Or p_work_title + p_work_original_author:
--    a new one. Neither: the draft is unlinked (its mention goes too).
--    A live edition keeps its work; only its mention can change.
-- ------------------------------------------------------------
create function public.staff_set_pd_edition(
  p_book_id uuid,
  p_work_id uuid,
  p_work_title text,
  p_work_original_author text,
  p_editor_credit boolean
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_book record;
  v_work_id uuid;
  v_credit boolean;
  v_basis text;
  v_title text;
  v_original text;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;
  if not public.staff_has_permission('books.review') then
    raise exception 'not authorized';
  end if;
  if p_book_id is null or p_editor_credit is null then
    raise exception 'invalid public-domain edition'
      using errcode = 'LB499';
  end if;

  select bo.id, bo.status, bo.pd_work_id, bo.pd_editor_credit
    into v_book
    from public.books bo
   where bo.id = p_book_id
     for update;
  if not found then
    raise exception 'no book found for this id';
  end if;

  v_credit := p_editor_credit;
  if v_book.status = 'published' then
    if v_book.pd_work_id is null then
      raise exception 'This live book is not a public-domain edition.'
        using errcode = 'LB499';
    end if;
    if p_work_id is distinct from v_book.pd_work_id or p_work_title is not null then
      raise exception 'A live edition stays with its work. Only its editor mention can change.'
        using errcode = 'LB499';
    end if;
    v_work_id := v_book.pd_work_id;
  elsif p_work_id is not null then
    if p_work_title is not null or p_work_original_author is not null then
      raise exception 'invalid public-domain edition'
        using errcode = 'LB499';
    end if;
    select w.id into v_work_id from public.pd_works w where w.id = p_work_id;
    if not found then
      raise exception 'That public-domain work no longer exists.'
        using errcode = 'LB499';
    end if;
  elsif p_work_title is not null or p_work_original_author is not null then
    v_title := pg_catalog.btrim(coalesce(p_work_title, ''));
    v_original := pg_catalog.btrim(coalesce(p_work_original_author, ''));
    if v_title = '' or v_original = '' then
      raise exception 'A new work needs its title and its original author.'
        using errcode = 'LB499';
    end if;
    insert into public.pd_works (title, original_author)
    values (v_title, v_original)
    returning id into v_work_id;
  else
    v_work_id := null;
    v_credit := false;
  end if;

  if v_work_id is not null then
    select d.basis into v_basis
      from public.book_rights_declarations d
     where d.book_id = p_book_id
     order by d.declared_at desc, d.id desc
     limit 1;
    if v_basis is distinct from 'public_domain' then
      raise exception 'Only a book whose rights choice is "public domain" can be a work''s edition.'
        using errcode = 'LB499';
    end if;
  end if;

  update public.books
     set pd_work_id = v_work_id,
         pd_editor_credit = v_credit
   where id = p_book_id;

  insert into public.admin_audit_log (actor_id, action, target_type, target_id, metadata)
  values (v_actor_id, 'book.pd_edition_set', 'books', p_book_id,
          pg_catalog.jsonb_build_object('pd_work_id', v_work_id, 'editor_credit', v_credit));

  return v_work_id;
end;
$$;

revoke all on function public.staff_set_pd_edition(uuid, uuid, text, text, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.staff_set_pd_edition(uuid, uuid, text, text, boolean) to authenticated;

-- ------------------------------------------------------------
-- 5. Approve a public-domain edition. A linked draft becomes the work's
--    picked edition; the previous one goes back to draft (its waiting
--    review is cancelled and its waiting changes applied by
--    books_take_pending_changes_offline, as for any book going
--    offline). admin_approve_book_review then checks and publishes as
--    for every book; any refusal rolls back the pick and the swap.
-- ------------------------------------------------------------
create function public.admin_approve_pd_edition(
  p_review_id uuid,
  p_file_path text,
  p_cover_path text,
  p_price_all integer,
  p_checklist jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_book_id uuid;
  v_book record;
  v_previous uuid;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;
  if not public.staff_has_permission('books.review') then
    raise exception 'not authorized';
  end if;

  select r.book_id into v_book_id
    from public.book_reviews r
   where r.id = p_review_id;
  if not found or v_book_id is null then
    raise exception 'no review found for this id';
  end if;

  -- The book first (admin_approve_book_review's order), then the work.
  select bo.id, bo.status, bo.pd_work_id
    into v_book
    from public.books bo
   where bo.id = v_book_id
     for update;
  if not found then
    raise exception 'no review found for this id';
  end if;
  if v_book.pd_work_id is null then
    raise exception 'Link this book to a public-domain work first.'
      using errcode = 'LB499';
  end if;

  if v_book.status = 'draft' then
    select w.picked_book_id into v_previous
      from public.pd_works w
     where w.id = v_book.pd_work_id
       for update;

    if v_previous is distinct from v_book_id then
      update public.pd_works
         set picked_book_id = v_book_id
       where id = v_book.pd_work_id;

      if v_previous is not null then
        update public.books
           set status = 'draft'
         where id = v_previous
           and status = 'published';
        insert into public.admin_audit_log (actor_id, action, target_type, target_id, metadata)
        values (v_actor_id, 'book.pd_edition_replaced', 'books', v_previous,
                pg_catalog.jsonb_build_object('pd_work_id', v_book.pd_work_id, 'replaced_by', v_book_id));
      end if;
    end if;
  end if;

  return public.admin_approve_book_review(p_review_id, p_file_path, p_cover_path, p_price_all, p_checklist);
end;
$$;

revoke all on function public.admin_approve_pd_edition(uuid, text, text, integer, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_approve_pd_edition(uuid, text, text, integer, jsonb) to authenticated;

-- ------------------------------------------------------------
-- 6. A swapped-out edition's page: the work's picked edition, when it
--    is listed. Only for a book that was public once (published_at set)
--    and is not listed now, so it says nothing about a draft that was
--    never public.
-- ------------------------------------------------------------
create function public.pd_edition_redirect(p_book_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.id
    from public.books b
    join public.pd_works w on w.id = b.pd_work_id
    join public.books p on p.id = w.picked_book_id
   where b.id = p_book_id
     and b.published_at is not null
     and not public.book_is_publicly_listed(b)
     and p.id <> b.id
     and public.book_is_publicly_listed(p)
$$;

revoke all on function public.pd_edition_redirect(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.pd_edition_redirect(uuid) to anon, authenticated;
