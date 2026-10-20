-- PEN-NAMES-2 EXPAND (PEN-2, PR B of 2, migration 1 of 2): add the
-- account-free read paths the PR B code uses, before anything is taken
-- away. Owner decisions 9a, 13a, 3a, 4a/12a, 17a-22a and 23b (owner answer 2026-10-19 22:30Z).
--
-- PROMISE AND RELEASE RULE. Readers and signed-out visitors must never
-- learn the account behind a pen name, nor that two pen names share an
-- account (site, data API, image URLs). The promise holds in an
-- environment only AFTER ROLLOUT STEP 4 (the contract migration
-- 20261019222600_pen_names_private_reads_contract.sql) has run there.
-- PEN-1 (20261019184512_pen_names.sql) never reaches Production without
-- PEN-2, including step 4.
--
-- ROLLOUT ORDER (staging now, Production later):
--   1. THIS expand migration (DB flow). It only adds views and a
--      function, tightens grants nothing uses and adds checks; the
--      running PEN-1 code keeps working (075 harness, old-code section).
--   2. The PR B code is deployed. It reads only the new views and the
--      new function, writes covers under random keys with the service
--      role, and handles both old and new storage keys.
--   3. The storage script (scripts/pen-names-storage/move.mts; run plan
--      and typed approval) copies existing covers and pen-name photos to
--      random keys and repoints the rows.
--   4. The contract migration (DB flow). It removes public reads of the
--      base tables and the old paths, and refuses to run while step 3 is
--      incomplete.
--   5. Old-file deletion (move.mts delete-old; 19a/20a).
--      Its run plan notes that deleted public objects can stay cached
--      at the CDN for the bucket's cache-control period (O16).
-- The contract cannot run before steps 2-3: the PEN-1 code reads books,
-- series, bundles, reviews and public_author_profiles directly, and the
-- contract's checks refuse the old storage keys step 3 replaces.
--
-- WHAT CHANGES:
--   E1  views, each with an explicit column list and definer rights
--       (owner postgres, like public_pen_names); the row-filtering ones
--       are security_barrier: public_books, public_series,
--       public_bundles, public_reviews (anon + authenticated);
--       reader_bundle_purchases, reader_refund_requests (authenticated).
--       [23b] author_book_purchases, author_bundle_sales (authenticated).
--   E1a user_owns_book(uuid): EXECUTE also for anon. public_books calls
--       it, and a view's function calls are checked against the CALLER.
--       It reads auth.uid(), which is null for anon, so it always
--       returns false there.
--   E2  blog_posts: column SELECT without created_by.
--   E3  profiles: authenticated UPDATE is (display_name,
--       public_author_name); bio is no longer written (18a).
--   E4  pen_names.bio <= 5000 characters.
--   E5  authenticated loses INSERT on books (no code uses it; closes the
--       books-INSERT error oracle, MF1).
--   E5b authenticated loses INSERT on bundles too, and
--       bundles_enforce_pen_name gets the r5 guard (audit PEN-2 r1 F1:
--       the same error oracle told whether an account is an author).
--   E6  staff_profile_display_names(uuid[]) for support (refunds.view).
--   E7  partial unique indexes on books.cover_path and
--       pen_names.avatar_path.
--
-- NOTHING here removes a privilege or object the PEN-1 code uses.
--
-- The declarative equivalent is in supabase/schema.sql; see
-- supabase/tests/075_pen_names_private_reads.test.sql and
-- supabase/tests/075_pen_names_private_reads_catalog_equivalence.sh.

-- ------------------------------------------------------------
-- Guards (E4, E7): refuse to run over data the new checks reject.
-- PEN-2-PRECHECK-EXPAND-r1.sql counts the same rows first.
-- ------------------------------------------------------------
do $$
declare
  v_long_bios integer;
  v_dup_covers integer;
  v_dup_avatars integer;
begin
  select pg_catalog.count(*) into v_long_bios
    from public.pen_names pn
   where pg_catalog.char_length(pn.bio) > 5000;
  if v_long_bios > 0 then
    raise exception 'pen names expand: % pen name bio(s) are longer than 5000 characters', v_long_bios;
  end if;

  select pg_catalog.count(*) into v_dup_covers
    from (select b.cover_path
            from public.books b
           where b.cover_path is not null
           group by b.cover_path
          having pg_catalog.count(*) > 1) d;
  if v_dup_covers > 0 then
    raise exception 'pen names expand: % cover_path value(s) are shared by more than one book', v_dup_covers;
  end if;

  select pg_catalog.count(*) into v_dup_avatars
    from (select pn.avatar_path
            from public.pen_names pn
           where pn.avatar_path is not null
           group by pn.avatar_path
          having pg_catalog.count(*) > 1) d;
  if v_dup_avatars > 0 then
    raise exception 'pen names expand: % avatar_path value(s) are shared by more than one pen name', v_dup_avatars;
  end if;
end;
$$;

-- ------------------------------------------------------------
-- E4, E7
-- ------------------------------------------------------------
alter table public.pen_names
  add constraint pen_names_bio_check
  check (bio is null or char_length(bio) <= 5000);

create unique index books_cover_path_key
  on public.books (cover_path)
  where cover_path is not null;

create unique index pen_names_avatar_path_key
  on public.pen_names (avatar_path)
  where avatar_path is not null;

-- ------------------------------------------------------------
-- E1a
-- ------------------------------------------------------------
grant execute on function public.user_owns_book(uuid) to anon;

-- ------------------------------------------------------------
-- E1. Public views (anon + authenticated)
-- ------------------------------------------------------------

-- Every books column except author_id, file_path and pen_name. Rows:
-- exactly today's three SELECT policies (published; the caller's own;
-- acquired by the caller).
create view public.public_books
  with (security_barrier)
as
  select b.id, b.title, b.subtitle, b.description, b.preview_text, b.keywords,
         b.isbn, b.language, b.publisher, b.edition, b.original_publication_date,
         b.genre, b.series_id, b.series_position, b.price_cents, b.cover_path,
         b.status, b.published_at, b.created_at, b.updated_at, b.price_all,
         b.librum_choice_at, b.pen_name_id
  from public.books b
  where b.status = 'published'
     or b.author_id = auth.uid()
     or public.user_owns_book(b.id);

revoke insert, update, delete, truncate, references, trigger, maintain
  on table public.public_books
  from anon, authenticated;

grant select
  on table public.public_books
  to anon, authenticated;

-- Every series is listed, as today, without the account.
create view public.public_series as
  select s.id, s.title, s.pen_name_id, s.created_at
  from public.series s;

revoke insert, update, delete, truncate, references, trigger, maintain
  on table public.public_series
  from anon, authenticated;

grant select
  on table public.public_series
  to anon, authenticated;

-- Every bundles column except author_id.
create view public.public_bundles
  with (security_barrier)
as
  select bu.id, bu.title, bu.description, bu.price_cents, bu.status,
         bu.created_at, bu.updated_at, bu.price_all, bu.pen_name_id
  from public.bundles bu
  where bu.status = 'published'
     or bu.author_id = auth.uid();

revoke insert, update, delete, truncate, references, trigger, maintain
  on table public.public_bundles
  from anon, authenticated;

grant select
  on table public.public_bundles
  to anon, authenticated;

-- No reader_id. reviewer_name is the reviewer's default pen name when
-- the reviewer is an author with at least one book (today's
-- public_author_profiles rule, 20261019154308; 22a), else null.
create view public.public_reviews
  with (security_barrier)
as
  select r.id, r.book_id, r.rating, r.body, r.created_at,
         (select pn.name
            from public.profiles p
            join public.pen_names pn on pn.author_id = p.id and pn.is_default
           where p.id = r.reader_id
             and p.role = 'author'
             and exists (select 1 from public.books b where b.author_id = p.id)) as reviewer_name
  from public.reviews r
  where exists (select 1 from public.public_books pb where pb.id = r.book_id);

revoke insert, update, delete, truncate, references, trigger, maintain
  on table public.public_reviews
  from anon, authenticated;

grant select
  on table public.public_reviews
  to anon, authenticated;

-- ------------------------------------------------------------
-- E1. Reader views (authenticated only)
-- ------------------------------------------------------------

-- Every bundle_checkout_snapshots column except author_id; the
-- reader's own fulfilled rows (today's reader policy).
create view public.reader_bundle_purchases
  with (security_barrier)
as
  select s.id, s.stripe_checkout_session_id, s.stripe_payment_intent_id,
         s.bundle_id, s.bundle_title, s.reader_id,
         s.bundle_price_cents_at_checkout, s.total_amount_cents, s.items,
         s.protection_expires_at, s.fulfilled_at, s.refunded_at, s.created_at,
         s.regime, s.currency, s.royalty_rate_bps
  from public.bundle_checkout_snapshots s
  where s.reader_id = auth.uid()
    and s.fulfilled_at is not null;

revoke all on table public.reader_bundle_purchases from public, anon;

revoke insert, update, delete, truncate, references, trigger, maintain
  on table public.reader_bundle_purchases
  from authenticated;

grant select
  on table public.reader_bundle_purchases
  to authenticated;

-- Every refund_requests column except reviewed_by (O3); the reader's
-- own rows (today's reader policy). admin_notes stays, as readers see
-- it today (O-e).
create view public.reader_refund_requests
  with (security_barrier)
as
  select rr.id, rr.reader_id, rr.stripe_payment_intent_id,
         rr.bundle_checkout_snapshot_id, rr.amount_cents, rr.reason, rr.status,
         rr.requested_at, rr.reviewed_at, rr.admin_notes, rr.refunded_at,
         rr.created_at
  from public.refund_requests rr
  where rr.reader_id = auth.uid();

revoke all on table public.reader_refund_requests from public, anon;

revoke insert, update, delete, truncate, references, trigger, maintain
  on table public.reader_refund_requests
  from authenticated;

grant select
  on table public.reader_refund_requests
  to authenticated;

-- ------------------------------------------------------------
-- [23b] Author sales views (authenticated only): no buyer account id.
-- ------------------------------------------------------------

-- Every purchases column except reader_id; purchases of the caller's own
-- books (today's author policy).
create view public.author_book_purchases
  with (security_barrier)
as
  select p.id, p.book_id, p.stripe_checkout_session_id,
         p.stripe_payment_intent_id, p.amount_cents, p.discount_code_id,
         p.bundle_id, p.refunded_at, p.created_at, p.regime, p.payment_id
  from public.purchases p
  where exists (select 1 from public.books b
                 where b.id = p.book_id
                   and b.author_id = auth.uid());

revoke all on table public.author_book_purchases from public, anon;

revoke insert, update, delete, truncate, references, trigger, maintain
  on table public.author_book_purchases
  from authenticated;

grant select
  on table public.author_book_purchases
  to authenticated;

-- Every bundle_checkout_snapshots column except reader_id; the caller's
-- own fulfilled sales (today's author policy).
create view public.author_bundle_sales
  with (security_barrier)
as
  select s.id, s.stripe_checkout_session_id, s.stripe_payment_intent_id,
         s.bundle_id, s.bundle_title, s.author_id,
         s.bundle_price_cents_at_checkout, s.total_amount_cents, s.items,
         s.protection_expires_at, s.fulfilled_at, s.refunded_at, s.created_at,
         s.regime, s.currency, s.royalty_rate_bps
  from public.bundle_checkout_snapshots s
  where s.author_id = auth.uid()
    and s.fulfilled_at is not null;

revoke all on table public.author_bundle_sales from public, anon;

revoke insert, update, delete, truncate, references, trigger, maintain
  on table public.author_bundle_sales
  from authenticated;

grant select
  on table public.author_bundle_sales
  to authenticated;

-- ------------------------------------------------------------
-- E2. blog_posts: created_by (a staff account id) is not readable.
-- ------------------------------------------------------------
revoke select on public.blog_posts from anon, authenticated;

grant select (
    id, title, slug, excerpt, content_markdown, cover_image_path, category,
    status, featured, seo_title, seo_description, published_at, created_at,
    updated_at
  )
  on public.blog_posts
  to anon, authenticated;

-- ------------------------------------------------------------
-- E3. profiles: bio is no longer written by the app (18a).
-- ------------------------------------------------------------
revoke update on public.profiles from authenticated;

grant update (display_name, public_author_name)
  on public.profiles
  to authenticated;

-- ------------------------------------------------------------
-- E5. books: no INSERT for authenticated (createBook writes through the
-- service-role catalog writer). select, delete and update (series_id,
-- series_position) stay.
-- ------------------------------------------------------------
revoke insert on public.books from authenticated;

-- ------------------------------------------------------------
-- E5b. bundles (audit PEN-2 r1 F1). A signed-in caller inserting
-- bundles(author_id = X) used to get RLS's 42501 when X is an author and
-- LB454 ("no default pen name") when X is a reader or no account: the
-- BEFORE trigger ran resolve_author_pen_name before RLS's WITH CHECK.
-- No code inserts bundles with the request client: createBundle calls
-- create_bundle_with_membership on the service-role catalog writer
-- (dashboard/bundles/actions.ts), and PEN-1's code does the same, so
-- this takes nothing the running code uses. select and delete stay.
-- The trigger also gets the r5 guard, as series_enforce_pen_name has,
-- so a future grant could not reopen the oracle.
-- ------------------------------------------------------------
revoke insert on public.bundles from authenticated;

create or replace function public.bundles_enforce_pen_name()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
begin
  -- r5 guard (PEN-NAMES-2 E5b, audit PEN-2 r1 F1): a data-API caller
  -- writing a bundle row for ANOTHER account is refused by RLS anyway.
  -- Return before any pen name lookup, so that refusal is RLS's generic
  -- error whatever the account is. The role GUC is the caller's role
  -- even inside SECURITY DEFINER; service_role and the owner's own rows
  -- are checked as before.
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
    raise exception 'pen names: the pen name does not belong to this bundle''s author' using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke all on function public.bundles_enforce_pen_name() from public, anon, authenticated;

-- ------------------------------------------------------------
-- E6. Support staff (refunds.view) read display names through this
-- function only, and only for refund readers, refund reviewers and
-- staff members -- never an arbitrary account. No size cap: that
-- restriction bounds the result.
-- ------------------------------------------------------------
create function public.staff_profile_display_names(p_ids uuid[])
returns table (id uuid, display_name text)
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  if not public.staff_has_permission('refunds.view') then
    raise exception 'not authorized';
  end if;

  if p_ids is null or pg_catalog.cardinality(p_ids) = 0 then
    return;
  end if;

  return query
    select p.id, p.display_name
      from public.profiles p
     where p.id = any (p_ids)
       and (exists (select 1 from public.refund_requests rr where rr.reader_id = p.id)
            or exists (select 1 from public.refund_requests rr where rr.reviewed_by = p.id)
            or exists (select 1 from public.staff_members sm where sm.user_id = p.id));
end;
$$;

revoke all on function public.staff_profile_display_names(uuid[]) from public, anon, authenticated;
grant execute on function public.staff_profile_display_names(uuid[]) to authenticated;
