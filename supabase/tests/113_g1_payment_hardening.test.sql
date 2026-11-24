-- LOCAL/DISPOSABLE DATABASE TEST ONLY.
-- Do not execute against Staging or Production.
--
-- Committed SQL regression suite for the G1 security pass
-- (supabase/migrations/20261124150000_g1_payment_hardening.sql):
--
--   Part 1  shape: SECURITY DEFINER + empty search_path, grants, and
--           iban_country_length() (97 codes, known lengths).
--   Part 2  authors only: a reader and a signed-out caller cannot save
--           tax details or a bank account; an author can.
--   Part 3  exact IBAN length per country: right length passes, a
--           checksum-valid IBAN of the wrong length or a country
--           without IBANs is refused; Albania unchanged.
--   Part 4  request_book_review(): a PAID draft needs both halves of
--           Payment & tax (LB527); a free draft never asks.
--   Part 5  the real files: rollback twice (old behaviour back), the
--           migration again.
--
-- Made-up names and numbers only (textbook example IBANs). NOT one
-- rolled-back transaction: Part 5 runs the real files with \i.
-- Run from the repo root:
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/113_g1_payment_hardening.test.sql
--
-- Against the BASE schema it fails in Part 1 (no iban_country_length):
-- the negative control.

set client_min_messages = warning;

create function pg_temp.assert(condition boolean, message text) returns void
  language plpgsql as $$
begin
  if not condition or condition is null then
    raise exception 'FAIL: %', message;
  end if;
end;
$$;

-- Runs one statement as the given role (and user id); 'OK' or the error.
create function pg_temp.run_as(p_role text, p_uid text, p_sql text) returns text
  language plpgsql as $$
declare
  v_out text;
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_uid, ''), false);
  execute format('set role %I', p_role);
  begin
    execute p_sql;
    v_out := 'OK';
  exception when others then
    v_out := sqlerrm;
  end;
  reset role;
  perform set_config('request.jwt.claim.sub', '', false);
  return v_out;
end;
$$;

-- One text value read as the given role (and user id); or the error.
create function pg_temp.value_as(p_role text, p_uid text, p_sql text) returns text
  language plpgsql as $$
declare
  v_out text;
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_uid, ''), false);
  execute format('set role %I', p_role);
  begin
    execute p_sql into v_out;
  exception when others then
    v_out := sqlerrm;
  end;
  reset role;
  perform set_config('request.jwt.claim.sub', '', false);
  return coalesce(v_out, '<null>');
end;
$$;

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('11300000-0000-4000-8000-000000000001', 'p113-author-a@test', now(), '{"role":"author","display_name":"P113 A"}'),
  ('11300000-0000-4000-8000-000000000002', 'p113-reader-r@test', now(), '{"role":"reader","display_name":"P113 R"}'),
  ('11300000-0000-4000-8000-000000000003', 'p113-author-b@test', now(), '{"role":"author","display_name":"P113 B"}');

-- handle_new_user() makes readers; the authors are switched here.
update public.profiles set role = 'author', public_author_name = display_name
 where id in ('11300000-0000-4000-8000-000000000001', '11300000-0000-4000-8000-000000000003');

-- Part 4's books: ready drafts (manuscript, cover, AI answer).
insert into public.books (id, author_id, title, description, status, price_all, published_at, file_path, cover_path) values
  ('11310000-0000-4000-8000-0000000000a1', '11300000-0000-4000-8000-000000000003', 'P113 Paid', 'About it.', 'draft', 299, null,
   '11300000-0000-4000-8000-000000000003/11310000-0000-4000-8000-0000000000a1/f0000000-0000-4000-8000-000000000001.epub',
   '1131c0de-0000-4000-8000-0000000000a1/cover.png'),
  ('11310000-0000-4000-8000-0000000000a2', '11300000-0000-4000-8000-000000000003', 'P113 Free', 'About it.', 'draft', 0, null,
   '11300000-0000-4000-8000-000000000003/11310000-0000-4000-8000-0000000000a2/f0000000-0000-4000-8000-000000000002.epub',
   '1131c0de-0000-4000-8000-0000000000a2/cover.png');
insert into public.book_ai_disclosures (book_id, ai_used)
select id, false from public.books where title like 'P113%';

-- ============================================================
-- Part 1: shape.
-- ============================================================
do $$
begin
  perform pg_temp.assert(to_regprocedure('public.iban_country_length(text)') is not null, 'part1: iban_country_length exists');
  perform pg_temp.assert(
    (select bool_and(p.prosecdef and p.proconfig = array['search_path=""'])
       from pg_proc p
      where p.oid in (
        'public.set_author_tax_details(text,text,text)'::regprocedure,
        'public.set_author_payout_destination(text,text,text)'::regprocedure,
        'public.request_book_review(uuid)'::regprocedure)),
    'part1: the three replaced functions stay SECURITY DEFINER with an empty search_path');
  perform pg_temp.assert(
    (select p.proconfig = array['search_path=""'] and p.provolatile = 'i' and not p.prosecdef
       from pg_proc p where p.oid = 'public.iban_country_length(text)'::regprocedure),
    'part1: iban_country_length is IMMUTABLE, INVOKER, empty search_path');
  perform pg_temp.assert(
    has_function_privilege('authenticated', 'public.set_author_tax_details(text,text,text)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.set_author_tax_details(text,text,text)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.set_author_tax_details(text,text,text)', 'EXECUTE')
    and has_function_privilege('authenticated', 'public.set_author_payout_destination(text,text,text)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.set_author_payout_destination(text,text,text)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.set_author_payout_destination(text,text,text)', 'EXECUTE')
    and has_function_privilege('authenticated', 'public.request_book_review(uuid)', 'EXECUTE')
    and not has_function_privilege('service_role', 'public.request_book_review(uuid)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.request_book_review(uuid)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.iban_country_length(text)', 'EXECUTE'),
    'part1: grants unchanged; anon has none');

  perform pg_temp.assert(public.iban_country_length('AL') = 28, 'part1: Albania 28');
  perform pg_temp.assert(public.iban_country_length('XK') = 20, 'part1: Kosovo 20');
  perform pg_temp.assert(public.iban_country_length('DE') = 22, 'part1: Germany 22');
  perform pg_temp.assert(public.iban_country_length('IT') = 27, 'part1: Italy 27');
  perform pg_temp.assert(public.iban_country_length('GB') = 22, 'part1: UK 22');
  perform pg_temp.assert(public.iban_country_length('CH') = 21, 'part1: Switzerland 21');
  perform pg_temp.assert(public.iban_country_length('NO') = 15, 'part1: Norway 15 (shortest)');
  perform pg_temp.assert(public.iban_country_length('RU') = 33, 'part1: Russia 33 (longest)');
  perform pg_temp.assert(public.iban_country_length('US') is null, 'part1: the US has no IBANs');
  perform pg_temp.assert(public.iban_country_length('ZZ') is null and public.iban_country_length(null) is null,
    'part1: unknown or null is null');
end $$;

-- ============================================================
-- Part 2: authors only.
-- ============================================================
do $$
declare
  a constant text := '11300000-0000-4000-8000-000000000001';
  r constant text := '11300000-0000-4000-8000-000000000002';
  v text;
begin
  v := pg_temp.run_as('authenticated', r, $q$select public.set_author_tax_details('AL', 'Reader Person', 'J12345678A')$q$);
  perform pg_temp.assert(v = 'set_author_tax_details: only authors can save tax details',
    format('part2: a reader cannot save tax details -- got %s', v));
  v := pg_temp.run_as('authenticated', r,
    $q$select * from public.set_author_payout_destination('ALL', 'Reader Person', 'AL47212110090000000235698741')$q$);
  perform pg_temp.assert(v = 'set_author_payout_destination: only authors can save a bank account',
    format('part2: a reader cannot save a bank account -- got %s', v));
  perform pg_temp.assert(
    not exists (select 1 from public.author_tax_details where author_id = r::uuid)
    and not exists (select 1 from public.author_payout_destinations where author_id = r::uuid),
    'part2: nothing was written for the reader');

  v := pg_temp.run_as('authenticated', null, $q$select public.set_author_tax_details('AL', 'X', 'J12345678A')$q$);
  perform pg_temp.assert(v = 'set_author_tax_details: not authenticated', format('part2: signed out, tax -- got %s', v));
  v := pg_temp.run_as('authenticated', null,
    $q$select * from public.set_author_payout_destination('ALL', 'X', 'AL47212110090000000235698741')$q$);
  perform pg_temp.assert(v = 'set_author_payout_destination: only authors can save a bank account',
    format('part2: signed out, bank -- got %s', v));
  v := pg_temp.run_as('service_role', null,
    $q$select * from public.set_author_payout_destination('ALL', 'X', 'AL47212110090000000235698741')$q$);
  perform pg_temp.assert(v = 'set_author_payout_destination: only authors can save a bank account',
    format('part2: service_role without a user, bank -- got %s', v));

  v := pg_temp.run_as('authenticated', a, $q$select public.set_author_tax_details('AL', 'Author Person', 'J12345678A')$q$);
  perform pg_temp.assert(v = 'OK', format('part2: an author saves tax details -- got %s', v));
  v := pg_temp.run_as('authenticated', a,
    $q$select * from public.set_author_payout_destination('ALL', 'Author Person', 'AL47212110090000000235698741')$q$);
  perform pg_temp.assert(v = 'OK', format('part2: an author saves a bank account -- got %s', v));

  -- An author switched back to reader can no longer save.
  update public.profiles set role = 'reader' where id = a::uuid;
  v := pg_temp.run_as('authenticated', a, $q$select public.set_author_tax_details('AL', 'Author Person', 'J12345678A')$q$);
  perform pg_temp.assert(v like '%only authors%', format('part2: role is read at call time -- got %s', v));
  update public.profiles set role = 'author' where id = a::uuid;
end $$;

-- ============================================================
-- Part 3: exact IBAN length per country.
-- ============================================================
do $$
declare
  a constant text := '11300000-0000-4000-8000-000000000001';
  v text;
  ok_iban text;
begin
  foreach ok_iban in array array[
    'DE89370400440532013000', 'XK051212012345678906', 'GB82WEST12345698765432',
    'IT60X0542811101000000123456', 'AL47212110090000000235698741', 'de89 3704 0044 0532 0130 00'
  ] loop
    v := pg_temp.run_as('authenticated', a,
      format('select * from public.set_author_payout_destination(%L, %L, %L)', 'ALL', 'Author Person', ok_iban));
    perform pg_temp.assert(v = 'OK', format('part3: %s is accepted -- got %s', ok_iban, v));
  end loop;

  -- Checksum-valid, wrong length: Germany 23, Kosovo 19; and the US,
  -- which has no IBANs. All three pass MOD-97.
  perform pg_temp.assert(
    public.iban_mod97_valid('DE543704004405320130001') and public.iban_mod97_valid('XK94121201234567890')
    and public.iban_mod97_valid('US670210000210012345678'),
    'part3: the refused samples really pass the checksum (so the length rule is what refuses them)');
  foreach ok_iban in array array['DE543704004405320130001', 'XK94121201234567890', 'US670210000210012345678'] loop
    v := pg_temp.run_as('authenticated', a,
      format('select * from public.set_author_payout_destination(%L, %L, %L)', 'ALL', 'Author Person', ok_iban));
    perform pg_temp.assert(v = 'set_author_payout_destination: iban does not match the expected IBAN format',
      format('part3: %s is refused with the format message -- got %s', ok_iban, v));
    perform pg_temp.assert(position(ok_iban in v) = 0, 'part3: the error never echoes the IBAN');
  end loop;

  -- Albania keeps its own message; a bad checksum keeps its own.
  v := pg_temp.run_as('authenticated', a,
    $q$select * from public.set_author_payout_destination('ALL', 'Author Person', 'AL4721211009000000023569874')$q$);
  perform pg_temp.assert(v like '%expected Albanian IBAN format%', format('part3: short AL -- got %s', v));
  v := pg_temp.run_as('authenticated', a,
    $q$select * from public.set_author_payout_destination('ALL', 'Author Person', 'DE88370400440532013000')$q$);
  perform pg_temp.assert(v like '%fails checksum validation%', format('part3: bad checksum -- got %s', v));

  perform pg_temp.assert(
    (select iban from public.author_payout_destinations where author_id = a::uuid and currency = 'ALL')
      = 'DE89370400440532013000',
    'part3: the last accepted IBAN is the saved one (refusals wrote nothing)');
end $$;

-- ============================================================
-- Part 4: a paid draft needs Payment & tax before review.
-- ============================================================
do $$
declare
  b constant text := '11300000-0000-4000-8000-000000000003';
  v text;
begin
  v := pg_temp.run_as('authenticated', b, $q$select public.request_book_review('11310000-0000-4000-8000-0000000000a1')$q$);
  perform pg_temp.assert(v = 'a paid book needs the Payment & tax details before review',
    format('part4: paid draft, nothing given -- got %s', v));

  -- The error code is LB527.
  begin
    perform set_config('request.jwt.claim.sub', b, false);
    set role authenticated;
    perform public.request_book_review('11310000-0000-4000-8000-0000000000a1');
    reset role;
    perform pg_temp.assert(false, 'part4: expected LB527');
  exception when sqlstate 'LB527' then
    reset role;
  end;
  perform set_config('request.jwt.claim.sub', '', false);

  -- Tax details only: still refused (both halves are needed).
  v := pg_temp.run_as('authenticated', b, $q$select public.set_author_tax_details('XK', 'Author B', '1234567')$q$);
  perform pg_temp.assert(v = 'OK', format('part4: B saves tax details -- got %s', v));
  v := pg_temp.run_as('authenticated', b, $q$select public.request_book_review('11310000-0000-4000-8000-0000000000a1')$q$);
  perform pg_temp.assert(v like 'a paid book needs%', format('part4: tax only is not enough -- got %s', v));

  -- A free draft never asks.
  v := pg_temp.run_as('authenticated', b, $q$select public.request_book_review('11310000-0000-4000-8000-0000000000a2')$q$);
  perform pg_temp.assert(v = 'OK', format('part4: a free draft is sent -- got %s', v));

  -- Both halves: the paid draft is sent.
  v := pg_temp.run_as('authenticated', b,
    $q$select * from public.set_author_payout_destination('ALL', 'Author B', 'XK051212012345678906')$q$);
  perform pg_temp.assert(v = 'OK', format('part4: B saves a Kosovo IBAN -- got %s', v));
  v := pg_temp.run_as('authenticated', b, $q$select public.request_book_review('11310000-0000-4000-8000-0000000000a1')$q$);
  perform pg_temp.assert(v = 'OK', format('part4: the paid draft is sent once both are given -- got %s', v));
  perform pg_temp.assert(
    (select count(*) from public.book_reviews where book_id = '11310000-0000-4000-8000-0000000000a1' and status = 'pending') = 1,
    'part4: one pending review for the paid draft');
end $$;

-- ============================================================
-- Part 5: the real files.
-- ============================================================
\i supabase/tests/113_g1_payment_hardening.rollback.sql
\i supabase/tests/113_g1_payment_hardening.rollback.sql

do $$
declare
  r constant text := '11300000-0000-4000-8000-000000000002';
  v text;
begin
  perform pg_temp.assert(to_regprocedure('public.iban_country_length(text)') is null, 'part5: rollback drops iban_country_length');
  v := pg_temp.run_as('authenticated', r, $q$select public.set_author_tax_details('AL', 'Reader Person', 'J12345678A')$q$);
  perform pg_temp.assert(v = 'OK', format('part5: after rollback a reader can save again (old behaviour) -- got %s', v));
  delete from public.author_tax_details where author_id = r::uuid;
  perform pg_temp.assert(
    has_function_privilege('authenticated', 'public.request_book_review(uuid)', 'EXECUTE')
    and not has_function_privilege('service_role', 'public.request_book_review(uuid)', 'EXECUTE')
    and has_function_privilege('authenticated', 'public.set_author_payout_destination(text,text,text)', 'EXECUTE'),
    'part5: rollback keeps the grants');
end $$;

\i supabase/migrations/20261124150000_g1_payment_hardening.sql

do $$
declare
  r constant text := '11300000-0000-4000-8000-000000000002';
  v text;
begin
  perform pg_temp.assert(public.iban_country_length('XK') = 20, 'part5: the migration again restores the length table');
  v := pg_temp.run_as('authenticated', r, $q$select public.set_author_tax_details('AL', 'Reader Person', 'J12345678A')$q$);
  perform pg_temp.assert(v like '%only authors%', format('part5: authors only again -- got %s', v));
end $$;

select 'PASS: 113_g1_payment_hardening' as result;
