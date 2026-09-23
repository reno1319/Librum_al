-- ALL-DISCOUNT-3 (Patch 3 of the ALL application-wiring sequence): close
-- authenticated write access to the legacy USD column
-- `discount_codes.amount_off_cents`.
--
-- WHY. Before this migration `authenticated` held a TABLE-level INSERT
-- on public.discount_codes, which covers every column. An author could
-- therefore still create a USD-semantic `amount_off_cents` code through
-- PostgREST directly, bypassing the application, which from Patch 3
-- onward creates fixed discounts only in whole ALL (`amount_off_all`).
-- UPDATE was already closed: the only UPDATE grant is `update (active)`.
--
-- WHAT CHANGES, and nothing else:
--
--   1. The table-level INSERT is replaced by a COLUMN-level INSERT on
--      exactly the columns the application's create path names:
--      id, author_id, book_id, code, percent_off, amount_off_all,
--      expires_at. `amount_off_cents` is not among them. `active` and
--      `created_at` have defaults and are not insertable.
--   2. `update (active)` is re-granted unchanged. It has to be: revoking
--      a table-level privilege also revokes that role's column-level
--      privileges of the same type, so the revoke below removes it.
--   3. The revoke names PUBLIC as well as anon and authenticated.
--      Whether PUBLIC holds an ambient privilege on this table in a
--      live project cannot be read from tracked source; this repository
--      has never granted it one, and the revoke makes the outcome
--      independent of that fact. anon had no privilege here before and
--      has none after.
--
-- UNCHANGED: authenticated SELECT and DELETE (table-level); every
-- privilege of service_role and of the table owner; the RLS policies,
-- including the insert/update `with check` that re-verifies the author
-- owns the book; every existing row, including legacy amount_off_cents
-- rows, which stay readable by their author and by service_role.
--
-- ROLLOUT NOTE, stated plainly because it is NOT behaviour-free for the
-- application currently deployed before Patch 3. That build sends
-- `amount_off_cents: null` in EVERY discount insert, percentage codes
-- included, and PostgREST names every key it receives in the INSERT's
-- column list. Once this migration is applied, that build's discount
-- creation fails with a permission error for BOTH types until the
-- Patch 3 application is deployed. The Patch 3 application names only
-- permitted columns and works against the ACL before and after this
-- migration, so deploying the application first leaves no such window.
--
-- The declarative equivalent is in supabase/schema.sql, next to the
-- table's other grants; 064_all_discount_codes_acl_catalog_equivalence.sh
-- proves the two build paths produce the same catalog.

revoke insert, update on public.discount_codes from public, anon, authenticated;

grant insert (id, author_id, book_id, code, percent_off, amount_off_all, expires_at)
  on public.discount_codes
  to authenticated;

grant update (active)
  on public.discount_codes
  to authenticated;
