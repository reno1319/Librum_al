-- BUNDLE-MEMBERSHIP-AUTH-1 (Patch 13), migration 1 of 2: the trusted,
-- atomic writers for public.bundle_books. ADDITIVE ONLY.
--
-- ROLLOUT ORDER -- BINDING. Three separate steps, in this order:
--
--   1. THIS migration (20260926061034). It creates three functions and
--      changes nothing else: no table, row, policy, grant or existing
--      function is touched. The application deployed before Patch 13
--      never calls any of them, so it keeps working unchanged.
--   2. The Patch 13 application, deployed and READY. createBundle and
--      updateBundle write ONLY by calling create_bundle_with_membership
--      and update_bundle_with_membership through the server-only
--      service-role client, so the application needs this migration to
--      exist and does not care whether step 3 has run.
--   3. 20260926061037_bundle_membership_write_authorization, which
--      removes the direct INSERT/DELETE (and every other write) that
--      anon and authenticated still hold on public.bundle_books.
--
-- Deploying the application before THIS migration breaks bundle
-- creation and editing (the functions do not exist yet); applying step 3
-- while the pre-Patch 13 application is live breaks them too (that
-- application writes membership with the author's own session). The two
-- migrations are separate precisely so that neither broken state is
-- ever reachable when the order above is followed.
--
-- WHY THESE FUNCTIONS EXIST. PostgREST runs each request in its own
-- transaction, so the application cannot write a bundle's details and
-- its membership atomically: its old updateBundle saved the details,
-- then deleted and re-inserted the membership in two more requests
-- whose results it never checked -- a failed insert left the bundle
-- EMPTY, and two concurrent edits could leave one edit's details with
-- the other's books. Each function below is ONE statement from the Data
-- API's point of view, so everything it writes commits or none of it
-- does.
--
-- WHAT THEY ENFORCE, every time, inside that one transaction:
--   * the bundle exists and belongs to p_author_id, and its row is
--     locked FOR UPDATE, so two writes to the same bundle are serialized
--     rather than interleaved;
--   * update_bundle_with_membership re-checks PAID-REPRICING-1's
--     compare-and-set (expected status, expected price_all) on that
--     LOCKED row before writing anything, and raises LB409 if the bundle
--     changed since the application read it;
--   * p_book_ids is a one-dimensional array of at least two DISTINCT,
--     non-null ids;
--   * every id names a book that still exists, belongs to p_author_id
--     and is published, each locked FOR SHARE so it cannot be
--     unpublished or deleted between this check and the commit (a
--     concurrent change that committed first is re-checked and refused);
--   * after the old membership is deleted and the new one inserted, the
--     rows the INSERT stored and the rows the bundle now holds must both
--     equal the requested distinct set exactly; a missing, extra,
--     duplicated, substituted or wrong-bundle row raises 23000 INSIDE
--     the transaction, so it rolls back -- the database, not the
--     caller's response check, is what protects committed state;
--   * update_bundle_with_membership also re-reads the bundle's details
--     and raises 23000 unless they equal what was submitted, and returns
--     the complete resulting state (every member plus the persisted
--     details) so the caller can prove it.
-- Any violation raises; the transaction rolls back and the previous
-- details and membership (or, for create, the absence of the bundle)
-- are untouched.
--
-- WHO MAY CALL THEM. SECURITY INVOKER with an empty search_path, every
-- object schema-qualified. EXECUTE is revoked from PUBLIC, anon and
-- authenticated and granted to service_role only, so none of them is
-- reachable through the Data API as an ordinary signed-in user. They do
-- NOT bypass anything by themselves: they run with the caller's own
-- privileges, and service_role already holds every privilege they use.
-- p_author_id is a parameter, not auth.uid(), because the trusted caller
-- is the service role; the Server Action passes the id it got from
-- auth.getUser() and nothing the client supplied.
-- replace_bundle_membership is the shared membership step of the other
-- two; the application never calls it directly, but service_role needs
-- EXECUTE on it because the callers are SECURITY INVOKER.
--
-- create_bundle_with_membership inserts the bundle with exactly the
-- columns createBundle has always named (author_id, title, description,
-- price_all) plus a server-generated id; `status`, `price_cents`,
-- `published_at` and the timestamps take their column defaults, so a new
-- bundle is always a draft. update_bundle_with_membership writes exactly
-- the columns updateBundle has always written (title, description,
-- price_all); `status` and `price_cents` are never named.
--
-- The declarative equivalent is in supabase/schema.sql next to
-- public.bundle_books; 069_bundle_membership_write_authorization_
-- catalog_equivalence.sh proves both build paths agree and
-- 069_bundle_membership_write_authorization.test.sql proves the
-- behaviour.

create function public.replace_bundle_membership(
  p_bundle_id uuid,
  p_author_id uuid,
  p_book_ids uuid[]
)
returns table (member_bundle_id uuid, member_book_id uuid)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_requested integer;
  v_valid integer;
  v_inserted integer;
  v_inserted_exact integer;
  v_stored integer;
  v_stored_exact integer;
begin
  if p_bundle_id is null or p_author_id is null or p_book_ids is null then
    raise exception 'bundle membership: bundle, author and books are required'
      using errcode = '22023';
  end if;

  if pg_catalog.array_ndims(p_book_ids) is distinct from 1
    or pg_catalog.array_position(p_book_ids, null) is not null
  then
    raise exception 'bundle membership: book ids must be a flat list without nulls'
      using errcode = '22023';
  end if;

  v_requested := pg_catalog.cardinality(p_book_ids);

  if v_requested < 2 then
    raise exception 'bundle membership: at least two books are required'
      using errcode = '22023';
  end if;

  if (select pg_catalog.count(distinct u.id) from pg_catalog.unnest(p_book_ids) as u(id)) <> v_requested then
    raise exception 'bundle membership: duplicate book ids'
      using errcode = '22023';
  end if;

  perform 1
    from public.bundles b
   where b.id = p_bundle_id
     and b.author_id = p_author_id
     for update of b;

  if not found then
    raise exception 'bundle membership: bundle not found for this author'
      using errcode = '42501';
  end if;

  select pg_catalog.count(*)
    into v_valid
    from (
      select bo.id
        from public.books bo
       where bo.id = any (p_book_ids)
         and bo.author_id = p_author_id
         and bo.status = 'published'
         for share of bo
    ) as locked;

  if v_valid <> v_requested then
    raise exception 'bundle membership: every book must be the author''s own published book'
      using errcode = '42501';
  end if;

  delete from public.bundle_books bb
   where bb.bundle_id = p_bundle_id;

  -- What the INSERT actually stored, as RETURNING reports it after every
  -- BEFORE trigger: a suppressed row is missing here, an altered one
  -- carries its altered bundle or book.
  with inserted as (
    insert into public.bundle_books (bundle_id, book_id)
    select p_bundle_id, u.id
      from pg_catalog.unnest(p_book_ids) as u(id)
    returning bundle_id, book_id
  )
  select pg_catalog.count(*),
         pg_catalog.count(distinct i.book_id) filter (where i.bundle_id = p_bundle_id and i.book_id = any (p_book_ids))
    into v_inserted, v_inserted_exact
    from inserted i;

  -- The membership as it now stands in the table.
  select pg_catalog.count(*),
         pg_catalog.count(distinct bb.book_id) filter (where bb.book_id = any (p_book_ids))
    into v_stored, v_stored_exact
    from public.bundle_books bb
   where bb.bundle_id = p_bundle_id;

  -- THE INVARIANT, enforced inside this transaction: exactly the
  -- requested distinct set was inserted, every inserted row belongs to
  -- this bundle, and the bundle now holds exactly that set -- nothing
  -- missing, extra, duplicated, substituted or written to another
  -- bundle. Anything else raises, and the whole transaction (the delete
  -- above, and for create/update the bundle row as well) rolls back.
  if v_inserted <> v_requested or v_inserted_exact <> v_requested
    or v_stored <> v_requested or v_stored_exact <> v_requested
  then
    raise exception 'bundle membership: stored membership does not equal the requested set'
      using errcode = '23000';
  end if;

  return query
    select bb.bundle_id, bb.book_id
      from public.bundle_books bb
     where bb.bundle_id = p_bundle_id
     order by bb.book_id;
end;
$$;

create function public.create_bundle_with_membership(
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
begin
  if p_bundle_id is null or p_author_id is null then
    raise exception 'bundle membership: bundle and author are required'
      using errcode = '22023';
  end if;

  insert into public.bundles (id, author_id, title, description, price_all)
  values (p_bundle_id, p_author_id, p_title, p_description, p_price_all);

  return query
    select r.member_bundle_id, r.member_book_id
      from public.replace_bundle_membership(p_bundle_id, p_author_id, p_book_ids) as r;
end;
$$;

create function public.update_bundle_with_membership(
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

  -- 3. The details. price_cents and status are never named.
  update public.bundles b
     set title = p_title,
         description = p_description,
         price_all = p_price_all
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

-- Reset from a known state: the platform's default privileges grant
-- EXECUTE on every new public function to anon, authenticated and
-- service_role, and PostgreSQL grants it to PUBLIC.
revoke all on function public.replace_bundle_membership(uuid, uuid, uuid[])
  from public, anon, authenticated, service_role;
revoke all on function public.create_bundle_with_membership(uuid, uuid, text, text, integer, uuid[])
  from public, anon, authenticated, service_role;
revoke all on function public.update_bundle_with_membership(uuid, uuid, text, boolean, integer, text, text, integer, uuid[])
  from public, anon, authenticated, service_role;
grant execute on function public.replace_bundle_membership(uuid, uuid, uuid[])
  to service_role;
grant execute on function public.create_bundle_with_membership(uuid, uuid, text, text, integer, uuid[])
  to service_role;
grant execute on function public.update_bundle_with_membership(uuid, uuid, text, boolean, integer, text, text, integer, uuid[])
  to service_role;
