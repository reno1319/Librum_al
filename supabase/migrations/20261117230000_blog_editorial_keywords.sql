-- Blog: Editorial tick, hidden keywords, blog search (Renato 2026-11-17,
-- asks from Enkelejd; pictures approved 22:33 UTC).
--
--   bs1  Editorial is no longer a category. A post is filed under one of
--        the five categories and Editorial is a tick on top
--        (is_editorial). The /blog Editorial section and
--        /blog/kategoria/editorial list the ticked posts; an Editorial
--        post also stays in its own category.
--   bs2  Production's "Pse ekziston Librum?" (the only Editorial post)
--        moves to tregu with the tick.
--   bs3  keywords: hidden search words (never shown on the site).
--   bs4  at least one keyword to publish; at most 10, each 1-40
--        characters. A draft may have none. A post that is already live
--        cannot be saved with none.
--   bs5  search_blog_posts(): published posts only, title + excerpt +
--        keywords (never the body), accents, capitals and hyphens
--        ignored, every word must match, newest first.
--
-- WHAT CHANGES
--   1. blog_posts gets is_editorial (boolean, default false) and
--      keywords (text[], default '{}', at most 10). Both are added to
--      the public column SELECT grant (PEN-NAMES-2 list).
--   2. The one Editorial row moves (by id AND slug AND category) to
--      tregu + is_editorial; 2c stops everything if any other row is
--      still 'editorial'.
--   3. The category CHECK drops 'editorial' (five values).
--   4. create_blog_post()/update_blog_post() are DROPPED and re-created
--      with two more parameters at the end (p_is_editorial,
--      p_keywords), both with defaults so an older 9/10-argument call
--      still resolves: create defaults to false / '{}', update defaults
--      to NULL = "keep what the row has". Same body otherwise, plus the
--      keyword checks. Grants are re-stated exactly as before
--      (authenticated + service_role only).
--   5. publish_blog_post(): same body plus "a published article needs at
--      least one keyword". CREATE OR REPLACE keeps owner and grants.
--   6. search_blog_posts(search_term, result_limit): new, SECURITY
--      INVOKER (like search_books), EXECUTE to anon + authenticated +
--      service_role.
--
-- updated_at is deliberately left alone on the moved row (not an edit
-- by staff).
--
-- SAFETY: one transaction. Section 2c stops the whole migration, with
-- nothing changed, if a row other than the one listed is 'editorial'.
--
-- ROLLOUT ORDER: apply BEFORE the app in the same patch is deployed
-- (the new app reads is_editorial/keywords). Between this migration and
-- the deploy, the old app cannot save a post as Editorial (old category
-- value) and cannot save a live post that has no keywords; reading is
-- unaffected. Production gets it only at a release.
--
-- ROLLBACK: supabase/tests/104_blog_editorial_keywords.rollback.sql
-- (lossy: keywords are dropped; ticked posts go back to 'editorial').

begin;

-- 1. The two columns.
alter table public.blog_posts
  add column is_editorial boolean not null default false,
  add column keywords text[] not null default '{}'
    constraint blog_posts_keywords_count_check
    check (pg_catalog.cardinality(keywords) <= 10);

grant select (is_editorial, keywords) on public.blog_posts to anon, authenticated;

-- 2. The old list goes first, so rows can move.
alter table public.blog_posts drop constraint blog_posts_category_check;

-- 2a. bs2: "Pse ekziston Librum?" -> Tregu + Editorial. Matched by id AND
-- slug AND category, so it touches that one row or none (staging has no
-- posts).
update public.blog_posts set category = 'tregu', is_editorial = true
where id = '9a3e08e1-4f7a-4340-946c-6963f687c9b9'
  and slug = 'pse-ekziston-librum'
  and category = 'editorial';

-- 2c. Stop if any other row is still 'editorial' (or anything else
-- outside the five).
do $$
declare
  v_left integer;
begin
  select pg_catalog.count(*) into v_left
  from public.blog_posts
  where category not in ('zeja', 'tregu', 'kultura', 'reflektime', 'vleresime');
  if v_left > 0 then
    raise exception 'blog editorial: % post(s) still outside the five categories; place them in section 2a', v_left;
  end if;
end;
$$;

-- 3. The five.
alter table public.blog_posts
  add constraint blog_posts_category_check
  check (category in ('zeja', 'tregu', 'kultura', 'reflektime', 'vleresime'));

-- 4. The two save functions, new parameters at the end.
drop function public.create_blog_post(text, text, text, text, text, text, boolean, text, text);
drop function public.update_blog_post(uuid, text, text, text, text, text, text, boolean, text, text);

create function public.create_blog_post(
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

  if p_category is null or p_category not in ('zeja', 'tregu', 'kultura', 'reflektime', 'vleresime') then
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

  -- bs4: at most 10 keywords, each 1-40 characters (no blanks/NULLs).
  if pg_catalog.cardinality(coalesce(p_keywords, '{}')) > 10 then
    raise exception 'too many keywords';
  end if;
  foreach v_keyword in array coalesce(p_keywords, '{}') loop
    if v_keyword is null or pg_catalog.char_length(pg_catalog.btrim(v_keyword)) = 0
       or pg_catalog.char_length(v_keyword) > 40 then
      raise exception 'each keyword must be between 1 and 40 characters';
    end if;
  end loop;

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

revoke all on function public.create_blog_post(text, text, text, text, text, text, boolean, text, text, boolean, text[])
  from public, anon, authenticated;
grant execute on function public.create_blog_post(text, text, text, text, text, text, boolean, text, text, boolean, text[])
  to authenticated, service_role;

create function public.update_blog_post(
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

  select status, slug, is_editorial, keywords
    into v_status, v_current_slug, v_is_editorial, v_keywords
  from public.blog_posts
  where id = p_id;

  if v_status is null then
    raise exception 'no such blog post';
  end if;

  if v_status = 'published' and p_slug is distinct from v_current_slug then
    raise exception 'slug is immutable once a post is published';
  end if;

  if p_category is null or p_category not in ('zeja', 'tregu', 'kultura', 'reflektime', 'vleresime') then
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

  -- NULL = keep what the row has (an older caller that does not send
  -- the two new parameters).
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

  -- bs4: a live post always keeps at least one keyword.
  if v_status = 'published' and pg_catalog.cardinality(v_keywords) = 0 then
    raise exception 'a published article needs at least one keyword';
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

revoke all on function public.update_blog_post(uuid, text, text, text, text, text, text, boolean, text, text, boolean, text[])
  from public, anon, authenticated;
grant execute on function public.update_blog_post(uuid, text, text, text, text, text, text, boolean, text, text, boolean, text[])
  to authenticated, service_role;

-- 5. Publish needs at least one keyword (bs4). Same body as migration
-- 047 otherwise.
create or replace function public.publish_blog_post(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_updated_id uuid;
  v_slug text;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('blog.manage') then
    raise exception 'not authorized';
  end if;

  if exists (
    select 1 from public.blog_posts
    where id = p_id and status = 'draft' and pg_catalog.cardinality(keywords) = 0
  ) then
    raise exception 'a published article needs at least one keyword';
  end if;

  update public.blog_posts
  set status = 'published',
      published_at = coalesce(published_at, pg_catalog.now()),
      updated_at = pg_catalog.now()
  where id = p_id and status = 'draft'
  returning id, slug into v_updated_id, v_slug;

  if v_updated_id is null then
    raise exception 'no publishable draft found for this id';
  end if;

  insert into public.admin_audit_log (actor_id, action, target_type, target_id, metadata)
  values (v_actor_id, 'blog_post.published', 'blog_posts', p_id, jsonb_build_object('slug', v_slug));
end;
$$;

-- 6. Blog search (bs5). SECURITY INVOKER, like search_books: it reads
-- only what the caller can already read (published posts under the
-- public RLS policy and the public column grant), so nothing is
-- bypassed; status = 'published' is also stated here so staff (who can
-- read drafts) never get drafts in public results. Returns only ids;
-- the app reads the rows back through its normal select.
--
-- Words: split on spaces, at most 5, each folded the same way as the
-- text (extensions.unaccent: ë->e, ç->c; ILIKE: capitals; hyphens
-- removed: "vetebotim" finds "vetë-botim"). LIKE wildcards in a word
-- are escaped, so a word only ever matches itself. Every word must
-- match somewhere in title + excerpt + keywords. No words -> no rows.
-- Only the first 200 characters of search_term are read (audit L1).
-- result_limit is clamped to 1-50 (the page asks for 30).
create function public.search_blog_posts(search_term text, result_limit integer default 30)
returns table (post_id uuid)
language sql
security invoker
set search_path = ''
stable
as $$
  with raw_words as (
    select w
    from pg_catalog.regexp_split_to_table(pg_catalog.btrim(pg_catalog.left(coalesce(search_term, ''), 200)), '\s+') as w
    where w <> ''
    limit 5
  ),
  words as (
    select pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(
             pg_catalog.replace(extensions.unaccent(w), '-', ''),
             '\', '\\'), '%', '\%'), '_', '\_') as pattern
    from raw_words
  ),
  usable as (
    select pattern from words where pattern <> ''
  )
  select p.id as post_id
  from public.blog_posts p
  where p.status = 'published'
    and exists (select 1 from usable)
    and not exists (
      select 1
      from usable u
      where not (
        pg_catalog.replace(
          extensions.unaccent(p.title || ' ' || p.excerpt || ' ' || pg_catalog.array_to_string(p.keywords, ' ')),
          '-', ''
        ) ilike '%' || u.pattern || '%'
      )
    )
  order by p.published_at desc nulls last, p.id
  limit least(greatest(coalesce(result_limit, 30), 1), 50);
$$;

revoke all on function public.search_blog_posts(text, integer) from public;
grant execute on function public.search_blog_posts(text, integer) to anon, authenticated, service_role;

commit;
