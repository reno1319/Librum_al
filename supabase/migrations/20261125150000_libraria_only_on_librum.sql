-- LR1 PATCH 2 (Renato 2026-11-25: lr1-1 c, lb5 a, lr2-1 a, lr2-2 a,
-- lr2-3 a, lr2-4 b, lr2-5 b): the "only on Librum" tick, the Libraria
-- shelf "Libra që i gjeni vetëm në Librum", and the category buttons
-- staff choose and order.
--
-- WHAT CHANGES:
--   1. books.only_on_librum: the author's tick (lr1-1 c), set in the
--      book editor at any time, also on a live book, with no review
--      (lr2-2 a). books.only_on_librum_removed_at: when staff took the
--      tick off (lr2-1 a). While it is set the tick stays off, so the
--      author cannot tick it again (books_only_on_librum_removed_check).
--      Both are written by the app's trusted catalog writer (the
--      authenticated role has no UPDATE on these columns) and by
--      staff_remove_only_on_librum() below.
--   2. public_books gets one column appended, only_on_librum: true only
--      for a ticked book that is NOT a public-domain edition (a free
--      classic never qualifies, lr1-1 c), so the shelf and every reader
--      read the same rule.
--   3. public.libraria_category_buttons: up to 6 categories (lr2-3 a),
--      in the order staff gave them (lb5 a). Everyone may read it; only
--      staff_set_libraria_category_buttons() writes it. With no rows the
--      page shows the first 4 categories with books, A–Zh (lr2-5 b).
--   4. staff_remove_only_on_librum(book) and
--      staff_set_libraria_category_buttons(categories): catalog.feature
--      (owner and admin), checked inside, each audited.
--
-- Nothing is backfilled: every existing book starts unticked.

-- ------------------------------------------------------------
-- 1. The tick.
-- ------------------------------------------------------------
alter table public.books
  add column only_on_librum boolean not null default false,
  add column only_on_librum_removed_at timestamptz,
  add constraint books_only_on_librum_removed_check
    check (not (only_on_librum and only_on_librum_removed_at is not null));

-- ------------------------------------------------------------
-- 2. public_books: same columns, one appended.
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
         b.lbn,
         -- LR1 patch 2 (migration 20261125150000): appended last. A free
         -- classic (a public-domain edition) never qualifies.
         (b.only_on_librum and b.pd_work_id is null) as only_on_librum
  from public.books b
  where public.book_is_publicly_listed(b)
     or b.author_id = auth.uid()
     or public.user_owns_book(b.id);

-- ------------------------------------------------------------
-- 3. The category buttons.
-- ------------------------------------------------------------
create table public.libraria_category_buttons (
  position smallint primary key
    constraint libraria_category_buttons_position_check check (position between 1 and 6),
  category text not null
    constraint libraria_category_buttons_category_key unique
    constraint libraria_category_buttons_category_check
    check (category = any (array[
      'Biografi & kujtime', 'Biznes & ekonomi', 'Drama & teatër',
      'Fantashkencë', 'Fantazi', 'Filozofi', 'Histori', 'Horror',
      'Letërsi artistike', 'Për fëmijë', 'Për të rinj', 'Poezi',
      'Policor & triler', 'Psikologji', 'Publicistikë & ese', 'Romancë',
      'Shkencë', 'Zhvillim personal'
    ]::text[]))
);

alter table public.libraria_category_buttons enable row level security;

revoke all on public.libraria_category_buttons from public, anon, authenticated, service_role;
grant select on public.libraria_category_buttons to anon, authenticated, service_role;

create policy libraria_category_buttons_read
  on public.libraria_category_buttons
  for select
  to anon, authenticated, service_role
  using (true);

comment on table public.libraria_category_buttons is
  'LR1 patch 2: the category buttons under "Më të rinjtë në Librum", in order. Written only by staff_set_libraria_category_buttons().';

-- ------------------------------------------------------------
-- 4. The two staff functions.
-- ------------------------------------------------------------
-- Staff take a book's tick off (lr2-1 a). Returns false, changing
-- nothing, when there is no such book or it is not ticked.
create function public.staff_remove_only_on_librum(p_book_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('catalog.feature') then
    raise exception 'not authorized';
  end if;

  update public.books
     set only_on_librum = false,
         only_on_librum_removed_at = pg_catalog.now()
   where id = p_book_id
     and only_on_librum;

  if not found then
    return false;
  end if;

  insert into public.admin_audit_log (actor_id, action, target_type, target_id, metadata)
  values (v_actor_id, 'book.only_on_librum_removed', 'books', p_book_id, '{}'::jsonb);
  return true;
end;
$$;

revoke all on function public.staff_remove_only_on_librum(uuid) from public, anon, authenticated, service_role;
grant execute on function public.staff_remove_only_on_librum(uuid) to authenticated;

-- Staff save the whole row of buttons at once, in order (lb5 a). An
-- empty list removes them all (the page then shows the A–Zh fallback,
-- lr2-5 b). More than 6, a repeat or an unknown category is refused
-- with nothing changed.
create function public.staff_set_libraria_category_buttons(p_categories text[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_before text[];
  v_list text[] := coalesce(p_categories, array[]::text[]);
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('catalog.feature') then
    raise exception 'not authorized';
  end if;

  if pg_catalog.cardinality(v_list) > 6 then
    raise exception 'At most 6 category buttons.'
      using errcode = 'LB537';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('public.libraria_category_buttons'));

  select coalesce(pg_catalog.array_agg(c.category order by c.position), array[]::text[])
    into v_before
    from public.libraria_category_buttons c;

  delete from public.libraria_category_buttons where true;

  -- The table's own checks refuse a repeat or an unknown category, and
  -- the whole call rolls back.
  insert into public.libraria_category_buttons (position, category)
  select t.ord::smallint, t.category
    from pg_catalog.unnest(v_list) with ordinality as t(category, ord);

  insert into public.admin_audit_log (actor_id, action, target_type, target_id, metadata)
  values (v_actor_id, 'libraria.category_buttons_set', 'libraria_category_buttons', null,
          pg_catalog.jsonb_build_object('before', pg_catalog.to_jsonb(v_before),
                                        'after', pg_catalog.to_jsonb(v_list)));
end;
$$;

revoke all on function public.staff_set_libraria_category_buttons(text[]) from public, anon, authenticated, service_role;
grant execute on function public.staff_set_libraria_category_buttons(text[]) to authenticated;
