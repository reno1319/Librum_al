-- Blog categories that staff manage (Renato 2026-11-19, patch B for
-- Enkelejd; pictures approved 16:42 UTC).
--
--   b1 a  Deleting a category asks where its articles move.
--   b2 b  Editorial can be renamed (name, short name, description), never
--         deleted; it keeps gold, the "Nga Librum" tag and first place.
--   b3 a  A colour is one of 8 tested pairs (gold is Editorial's only).
--   b4 a  A category's address is fixed when it is created.
--   b5 a  Owner and admin only: new permission 'blog.categories' (the
--         editor role does not get it).
--   b6 b  No visible limit; a hidden cap of 50 categories.
--   b7 a  The bottom button (publish / browse) is picked per category.
--
-- WHAT CHANGES
--   1. New table blog_categories, filled with today's six rows (same
--      values, names, addresses, colours and buttons as the app's old
--      fixed list). Everyone can read it; nobody can write it except
--      through the functions below.
--   2. blog_posts.category: the fixed-list CHECK becomes "not
--      editorial", and a foreign key to blog_categories(value) (no
--      cascade: deleting a category that still has articles fails).
--   3. staff_has_permission(): 'blog.categories' added to the admin
--      list (owner already has every permission). Full body restated.
--   4. create_blog_post()/update_blog_post(): CREATE OR REPLACE, same
--      signatures and bodies as migration 20261119130000 except the
--      category check reads the table.
--   5. New functions, all SECURITY DEFINER, 'blog.categories' only,
--      each writes one admin_audit_log row:
--        create_blog_category(label, short_label, description,
--          url_slug, colour, cta) -> value (= url_slug); goes last.
--        update_blog_category(value, label, short_label, description,
--          colour, cta); for Editorial only the three texts change.
--        move_blog_category(value, 'up' | 'down'); Editorial never moves.
--        delete_blog_category(value, move_to) -> articles moved; never
--          Editorial; with articles, move_to must be another category.
--
-- SAFETY: one transaction. Section 2 adds a foreign key that every
-- existing row already satisfies (the old CHECK allowed exactly the five
-- values inserted in section 1); if any row did not, the whole migration
-- fails and nothing changes.
-- ROLLOUT ORDER: apply BEFORE the app in the same patch is deployed.
-- The old app keeps working on the migrated database: it never reads
-- blog_categories, and it only saves the five old values, which exist.
-- ROLLBACK: supabase/tests/107_blog_categories_manage.rollback.sql
-- (lossy: articles in a category added later move to 'zeja').

begin;

-- 1. The table.
create table public.blog_categories (
  value text primary key,
  label text not null,
  short_label text not null,
  url_slug text not null,
  description text not null,
  colour text not null,
  cta text not null,
  sort_order integer not null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint blog_categories_value_check
    check (value ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and pg_catalog.char_length(value) <= 60),
  constraint blog_categories_url_slug_check
    check (url_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and pg_catalog.char_length(url_slug) <= 60),
  constraint blog_categories_url_slug_key unique (url_slug),
  constraint blog_categories_label_check
    check (pg_catalog.char_length(pg_catalog.btrim(label)) between 1 and 60 and label = pg_catalog.btrim(label)),
  constraint blog_categories_short_label_check
    check (pg_catalog.char_length(pg_catalog.btrim(short_label)) between 1 and 24 and short_label = pg_catalog.btrim(short_label)),
  constraint blog_categories_description_check
    check (pg_catalog.char_length(pg_catalog.btrim(description)) between 1 and 200 and description = pg_catalog.btrim(description)),
  constraint blog_categories_colour_check
    check (colour in ('green', 'blue', 'terracotta', 'purple', 'olive', 'teal', 'rose', 'slate', 'gold')),
  -- Gold is Editorial's, and Editorial is always gold (b2 b).
  constraint blog_categories_gold_check check ((value = 'editorial') = (colour = 'gold')),
  constraint blog_categories_cta_check check (cta in ('publish', 'browse'))
);

insert into public.blog_categories (value, label, short_label, url_slug, description, colour, cta, sort_order) values
  ('editorial', 'Editorial', 'Editorial', 'editorial',
   'Zëri editorial i Librum: opinione dhe analiza nga redaksia.', 'gold', 'browse', 0),
  ('zeja', 'Zeja e Shkrimit', 'Zeja e Shkrimit', 'zeja-e-shkrimit',
   'Teknika dhe udhëzues për prozën, poezinë, personazhet dhe dialogun.', 'green', 'publish', 1),
  ('tregu', 'Tregu i Librit & Botimet', 'Botimet', 'tregu-i-librit-dhe-botimet',
   'Botimi profesional, vetë-botimi, tregu i e-librave dhe marketingu letrar.', 'blue', 'publish', 2),
  ('kultura', 'Kulturë & Njohuri', 'Kulturë', 'kulture-dhe-njohuri',
   'Histori e letërsisë, gjuha shqipe, profile shkrimtarësh dhe qytete librash.', 'terracotta', 'browse', 3),
  ('reflektime', 'Reflektime & Frymëzim', 'Reflektime', 'reflektime-dhe-frymezim',
   'Intervista, ese mbi leximin dhe histori nga udhëtimi krijues.', 'purple', 'browse', 4),
  ('vleresime', 'Vlerësimet & Rekomandimet', 'Vlerësime', 'vleresimet-dhe-rekomandimet',
   'Vlerësime librash, lista leximi dhe sugjerime sipas zhanrit.', 'olive', 'browse', 5);

alter table public.blog_categories enable row level security;
revoke all on public.blog_categories from public, anon, authenticated, service_role;
grant select on public.blog_categories to anon, authenticated;
create policy "Anyone can read blog categories"
  on public.blog_categories for select
  using (true);

-- 2. Posts point at a real category, never at Editorial.
alter table public.blog_posts drop constraint blog_posts_category_check;
alter table public.blog_posts
  add constraint blog_posts_category_check check (category <> 'editorial');
alter table public.blog_posts
  add constraint blog_posts_category_fkey foreign key (category)
  references public.blog_categories (value);

-- 3. The permission.
create or replace function public.staff_has_permission(p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.staff_members sm
    where sm.user_id = auth.uid()
      and (
        sm.role = 'owner'
        or (
          sm.role = 'admin'
          and p_permission in (
            'admin.access', 'reports.view', 'reports.resolve',
            'refunds.view', 'refunds.resolve', 'staff.view', 'audit.view',
            'finance.view', 'finance.payout_export', 'finance.payout_operate',
            'blog.view', 'blog.manage', 'blog.categories', 'books.review',
            'people.view', 'people.manage'
          )
        )
        or (
          sm.role = 'editor'
          and p_permission in ('admin.access', 'blog.view', 'blog.manage')
        )
        or (
          sm.role = 'moderator'
          and p_permission in ('admin.access', 'reports.view', 'reports.resolve')
        )
        or (
          sm.role = 'support'
          and p_permission in ('admin.access', 'refunds.view')
        )
      )
  );
$$;

-- 4. Saving an article: the category must be a row of the table.
create or replace function public.create_blog_post(
  p_title text,
  p_slug text,
  p_excerpt text,
  p_content_markdown text,
  p_cover_image_path text,
  p_category text,
  p_featured boolean,
  p_seo_title text,
  p_seo_description text,
  p_is_editorial boolean default false,
  p_keywords text[] default '{}'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_new_id uuid;
  v_keyword text;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('blog.manage') then
    raise exception 'not authorized';
  end if;

  -- Patch B: any blog_categories row except the Editorial section.
  if p_category is null or p_category = 'editorial'
     or not exists (select 1 from public.blog_categories c where c.value = p_category) then
    raise exception 'invalid category';
  end if;

  if p_title is null or pg_catalog.char_length(p_title) = 0 or pg_catalog.char_length(p_title) > 200 then
    raise exception 'title must be between 1 and 200 characters';
  end if;
  if p_slug is null or pg_catalog.char_length(p_slug) = 0 or pg_catalog.char_length(p_slug) > 200 then
    raise exception 'slug must be between 1 and 200 characters';
  end if;
  if p_excerpt is null or pg_catalog.char_length(p_excerpt) = 0 or pg_catalog.char_length(p_excerpt) > 500 then
    raise exception 'excerpt must be between 1 and 500 characters';
  end if;
  if p_content_markdown is null or pg_catalog.char_length(p_content_markdown) = 0
     or pg_catalog.char_length(p_content_markdown) > 50000 then
    raise exception 'content_markdown must be between 1 and 50000 characters';
  end if;
  if p_seo_title is not null and pg_catalog.char_length(p_seo_title) > 70 then
    raise exception 'seo_title must be 70 characters or fewer';
  end if;
  if p_seo_description is not null and pg_catalog.char_length(p_seo_description) > 160 then
    raise exception 'seo_description must be 160 characters or fewer';
  end if;

  if pg_catalog.cardinality(coalesce(p_keywords, '{}')) > 10 then
    raise exception 'too many keywords';
  end if;
  foreach v_keyword in array coalesce(p_keywords, '{}') loop
    if v_keyword is null or pg_catalog.char_length(pg_catalog.btrim(v_keyword)) = 0
       or pg_catalog.char_length(v_keyword) > 40 then
      raise exception 'each keyword must be between 1 and 40 characters';
    end if;
  end loop;

  -- e4: one pin.
  if coalesce(p_featured, false) then
    update public.blog_posts set featured = false where featured;
  end if;

  insert into public.blog_posts
    (title, slug, excerpt, content_markdown, cover_image_path, category, featured,
     seo_title, seo_description, status, created_by, is_editorial, keywords)
  values
    (p_title, p_slug, p_excerpt, p_content_markdown, p_cover_image_path, p_category, coalesce(p_featured, false),
     nullif(trim(coalesce(p_seo_title, '')), ''), nullif(trim(coalesce(p_seo_description, '')), ''),
     'draft', v_actor_id, coalesce(p_is_editorial, false), coalesce(p_keywords, '{}'))
  returning id into v_new_id;

  return v_new_id;
end;
$$;

create or replace function public.update_blog_post(
  p_id uuid,
  p_title text,
  p_slug text,
  p_excerpt text,
  p_content_markdown text,
  p_cover_image_path text,
  p_category text,
  p_featured boolean,
  p_seo_title text,
  p_seo_description text,
  p_is_editorial boolean default null,
  p_keywords text[] default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_published_at timestamptz;
  v_current_slug text;
  v_is_editorial boolean;
  v_keywords text[];
  v_keyword text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('blog.manage') then
    raise exception 'not authorized';
  end if;

  select status, published_at, slug, is_editorial, keywords
    into v_status, v_published_at, v_current_slug, v_is_editorial, v_keywords
  from public.blog_posts
  where id = p_id;

  if v_status is null then
    raise exception 'no such blog post';
  end if;

  -- e5: locked once live. A scheduled article that is not live yet
  -- can still change it.
  if v_status = 'published' and v_published_at <= pg_catalog.now()
     and p_slug is distinct from v_current_slug then
    raise exception 'slug is immutable once a post is published';
  end if;

  -- Patch B: any blog_categories row except the Editorial section.
  if p_category is null or p_category = 'editorial'
     or not exists (select 1 from public.blog_categories c where c.value = p_category) then
    raise exception 'invalid category';
  end if;

  if p_title is null or pg_catalog.char_length(p_title) = 0 or pg_catalog.char_length(p_title) > 200 then
    raise exception 'title must be between 1 and 200 characters';
  end if;
  if p_slug is null or pg_catalog.char_length(p_slug) = 0 or pg_catalog.char_length(p_slug) > 200 then
    raise exception 'slug must be between 1 and 200 characters';
  end if;
  if p_excerpt is null or pg_catalog.char_length(p_excerpt) = 0 or pg_catalog.char_length(p_excerpt) > 500 then
    raise exception 'excerpt must be between 1 and 500 characters';
  end if;
  if p_content_markdown is null or pg_catalog.char_length(p_content_markdown) = 0
     or pg_catalog.char_length(p_content_markdown) > 50000 then
    raise exception 'content_markdown must be between 1 and 50000 characters';
  end if;
  if p_seo_title is not null and pg_catalog.char_length(p_seo_title) > 70 then
    raise exception 'seo_title must be 70 characters or fewer';
  end if;
  if p_seo_description is not null and pg_catalog.char_length(p_seo_description) > 160 then
    raise exception 'seo_description must be 160 characters or fewer';
  end if;

  v_is_editorial := coalesce(p_is_editorial, v_is_editorial);
  v_keywords := coalesce(p_keywords, v_keywords);

  if pg_catalog.cardinality(v_keywords) > 10 then
    raise exception 'too many keywords';
  end if;
  foreach v_keyword in array v_keywords loop
    if v_keyword is null or pg_catalog.char_length(pg_catalog.btrim(v_keyword)) = 0
       or pg_catalog.char_length(v_keyword) > 40 then
      raise exception 'each keyword must be between 1 and 40 characters';
    end if;
  end loop;

  -- A live or scheduled post always keeps at least one keyword.
  if v_status = 'published' and pg_catalog.cardinality(v_keywords) = 0 then
    raise exception 'a published article needs at least one keyword';
  end if;

  -- e4: one pin.
  if coalesce(p_featured, false) then
    update public.blog_posts set featured = false where featured and id <> p_id;
  end if;

  update public.blog_posts
  set title = p_title,
      slug = p_slug,
      excerpt = p_excerpt,
      content_markdown = p_content_markdown,
      cover_image_path = p_cover_image_path,
      category = p_category,
      featured = coalesce(p_featured, false),
      seo_title = nullif(trim(coalesce(p_seo_title, '')), ''),
      seo_description = nullif(trim(coalesce(p_seo_description, '')), ''),
      is_editorial = v_is_editorial,
      keywords = v_keywords,
      updated_at = pg_catalog.now()
  where id = p_id;
end;
$$;

-- 5a. create_blog_category.
create function public.create_blog_category(
  p_label text,
  p_short_label text,
  p_description text,
  p_url_slug text,
  p_colour text,
  p_cta text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_label text := pg_catalog.btrim(coalesce(p_label, ''));
  v_short text := pg_catalog.btrim(coalesce(p_short_label, ''));
  v_description text := pg_catalog.btrim(coalesce(p_description, ''));
  v_slug text := coalesce(p_url_slug, '');
  v_next integer;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;
  if not public.staff_has_permission('blog.categories') then
    raise exception 'not authorized';
  end if;

  if pg_catalog.char_length(v_label) not between 1 and 60 then
    raise exception 'category name must be between 1 and 60 characters';
  end if;
  if pg_catalog.char_length(v_short) not between 1 and 24 then
    raise exception 'short name must be between 1 and 24 characters';
  end if;
  if pg_catalog.char_length(v_description) not between 1 and 200 then
    raise exception 'description must be between 1 and 200 characters';
  end if;
  if v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or pg_catalog.char_length(v_slug) > 60 then
    raise exception 'invalid category address';
  end if;
  if p_colour is null or p_colour not in ('green', 'blue', 'terracotta', 'purple', 'olive', 'teal', 'rose', 'slate') then
    raise exception 'invalid colour';
  end if;
  if p_cta is null or p_cta not in ('publish', 'browse') then
    raise exception 'invalid bottom button';
  end if;

  -- One writer at a time for the order and the cap.
  lock table public.blog_categories in share row exclusive mode;

  if (select pg_catalog.count(*) from public.blog_categories) >= 50 then
    raise exception 'too many categories';
  end if;
  if exists (select 1 from public.blog_categories where value = v_slug or url_slug = v_slug) then
    raise exception 'category address already used';
  end if;

  select coalesce(pg_catalog.max(sort_order), 0) + 1 into v_next from public.blog_categories;

  insert into public.blog_categories (value, label, short_label, url_slug, description, colour, cta, sort_order)
  values (v_slug, v_label, v_short, v_slug, v_description, p_colour, p_cta, v_next);

  insert into public.admin_audit_log (actor_id, action, target_type, target_id, metadata)
  values (v_actor_id, 'blog_category.created', 'blog_categories', null,
          pg_catalog.jsonb_build_object('value', v_slug, 'label', v_label));

  return v_slug;
end;
$$;

-- 5b. update_blog_category.
create function public.update_blog_category(
  p_value text,
  p_label text,
  p_short_label text,
  p_description text,
  p_colour text,
  p_cta text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_label text := pg_catalog.btrim(coalesce(p_label, ''));
  v_short text := pg_catalog.btrim(coalesce(p_short_label, ''));
  v_description text := pg_catalog.btrim(coalesce(p_description, ''));
  v_old_label text;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;
  if not public.staff_has_permission('blog.categories') then
    raise exception 'not authorized';
  end if;

  if pg_catalog.char_length(v_label) not between 1 and 60 then
    raise exception 'category name must be between 1 and 60 characters';
  end if;
  if pg_catalog.char_length(v_short) not between 1 and 24 then
    raise exception 'short name must be between 1 and 24 characters';
  end if;
  if pg_catalog.char_length(v_description) not between 1 and 200 then
    raise exception 'description must be between 1 and 200 characters';
  end if;

  select label into v_old_label from public.blog_categories where value = p_value for update;
  if v_old_label is null then
    raise exception 'no such category';
  end if;

  if p_value = 'editorial' then
    -- b2 b: Editorial keeps gold and its button; only the texts change.
    update public.blog_categories
    set label = v_label, short_label = v_short, description = v_description,
        updated_at = pg_catalog.now()
    where value = p_value;
  else
    if p_colour is null or p_colour not in ('green', 'blue', 'terracotta', 'purple', 'olive', 'teal', 'rose', 'slate') then
      raise exception 'invalid colour';
    end if;
    if p_cta is null or p_cta not in ('publish', 'browse') then
      raise exception 'invalid bottom button';
    end if;
    update public.blog_categories
    set label = v_label, short_label = v_short, description = v_description,
        colour = p_colour, cta = p_cta, updated_at = pg_catalog.now()
    where value = p_value;
  end if;

  insert into public.admin_audit_log (actor_id, action, target_type, target_id, metadata)
  values (v_actor_id, 'blog_category.updated', 'blog_categories', null,
          pg_catalog.jsonb_build_object('value', p_value, 'old_label', v_old_label, 'label', v_label));
end;
$$;

-- 5c. move_blog_category: one place up or down. The others are
-- renumbered 1..n so the order never has ties. At the top or bottom
-- already: nothing changes, no audit row.
create function public.move_blog_category(p_value text, p_direction text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_order text[];
  v_pos integer;
  v_other integer;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;
  if not public.staff_has_permission('blog.categories') then
    raise exception 'not authorized';
  end if;
  if p_direction is null or p_direction not in ('up', 'down') then
    raise exception 'invalid direction';
  end if;
  if p_value = 'editorial' then
    raise exception 'editorial always comes first';
  end if;

  lock table public.blog_categories in share row exclusive mode;

  select pg_catalog.array_agg(value order by sort_order, value) into v_order
  from public.blog_categories
  where value <> 'editorial';

  v_pos := pg_catalog.array_position(v_order, p_value);
  if v_pos is null then
    raise exception 'no such category';
  end if;

  v_other := case when p_direction = 'up' then v_pos - 1 else v_pos + 1 end;
  if v_other < 1 or v_other > pg_catalog.cardinality(v_order) then
    return;
  end if;

  v_order[v_pos] := v_order[v_other];
  v_order[v_other] := p_value;

  update public.blog_categories c
  set sort_order = o.ord::integer, updated_at = pg_catalog.now()
  from pg_catalog.unnest(v_order) with ordinality as o(value, ord)
  where c.value = o.value and c.sort_order is distinct from o.ord::integer;

  insert into public.admin_audit_log (actor_id, action, target_type, target_id, metadata)
  values (v_actor_id, 'blog_category.moved', 'blog_categories', null,
          pg_catalog.jsonb_build_object('value', p_value, 'direction', p_direction));
end;
$$;

-- 5d. delete_blog_category: every article in it (drafts and scheduled
-- too) moves to p_move_to first (b1 a). Returns how many moved.
create function public.delete_blog_category(p_value text, p_move_to text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_label text;
  v_slug text;
  v_count integer;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;
  if not public.staff_has_permission('blog.categories') then
    raise exception 'not authorized';
  end if;
  if p_value = 'editorial' then
    raise exception 'editorial cannot be deleted';
  end if;

  lock table public.blog_categories in share row exclusive mode;

  -- FOR UPDATE also waits for, and then blocks, any article being saved
  -- into this category (its foreign key check locks the same row).
  select label, url_slug into v_label, v_slug
  from public.blog_categories where value = p_value for update;
  if v_label is null then
    raise exception 'no such category';
  end if;

  select pg_catalog.count(*) into v_count from public.blog_posts where category = p_value;

  if v_count > 0 then
    if p_move_to is null or p_move_to = p_value or p_move_to = 'editorial'
       or not exists (select 1 from public.blog_categories where value = p_move_to) then
      raise exception 'choose where its articles move';
    end if;
    update public.blog_posts
    set category = p_move_to, updated_at = pg_catalog.now()
    where category = p_value;
  end if;

  delete from public.blog_categories where value = p_value;

  update public.blog_categories c
  set sort_order = o.ord::integer
  from (
    select value, pg_catalog.row_number() over (order by sort_order, value) as ord
    from public.blog_categories
    where value <> 'editorial'
  ) o
  where c.value = o.value and c.sort_order is distinct from o.ord::integer;

  insert into public.admin_audit_log (actor_id, action, target_type, target_id, metadata)
  values (v_actor_id, 'blog_category.deleted', 'blog_categories', null,
          pg_catalog.jsonb_build_object('value', p_value, 'label', v_label, 'url_slug', v_slug,
                                        'articles_moved', v_count,
                                        'moved_to', case when v_count > 0 then p_move_to end));
  return v_count;
end;
$$;

revoke all on function public.create_blog_category(text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.update_blog_category(text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.move_blog_category(text, text) from public, anon, authenticated;
revoke all on function public.delete_blog_category(text, text) from public, anon, authenticated;
grant execute on function public.create_blog_category(text, text, text, text, text, text) to authenticated;
grant execute on function public.update_blog_category(text, text, text, text, text, text) to authenticated;
grant execute on function public.move_blog_category(text, text) to authenticated;
grant execute on function public.delete_blog_category(text, text) to authenticated;

commit;
