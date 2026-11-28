-- LOCAL/DISPOSABLE DATABASE TEST ONLY.
-- Do not execute against Staging or Production.
--
-- Committed SQL regression suite for Amazon book page P4
-- (supabase/migrations/20261128130000_book_sales_ranks.sql):
--
-- * part1 the rank: in all of Libraria first, then in each of the book's
--   categories in the book's own order; equal sales share a rank; a
--   category with fewer than 3 books with sales is left out (bp6 a); a
--   book under 10 sales gets nothing.
-- * part2 what counts (bp7 a, rk1 b, rk2 a): free downloads, claimed
--   gifts (amount 0), refunded and lost-dispute purchases and sales older
--   than 30 days never count; a payment's paid_at decides the date when
--   there is one; a paid gift row counts as one sale; a book Libraria
--   does not list (draft) is never ranked and never pushes others down.
-- * part3 privacy: only (category, sales_rank, sort_order) come back;
--   anon and authenticated cannot call it, service_role can.
--
-- To reproduce, from the repo root, against a disposable PostgreSQL 17
-- instance:
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/122_book_sales_ranks.test.sql
--
-- Against the BASE schema it fails at part1 (no function): the negative
-- control. Everything runs inside one transaction and is rolled back.

begin;

set local client_min_messages = warning;

create table pg_temp.assertions_run (n integer not null);
insert into pg_temp.assertions_run values (0);

create function pg_temp.assert(condition boolean, message text) returns void
  language plpgsql as $$
begin
  update pg_temp.assertions_run set n = n + 1;
  if not condition or condition is null then
    raise exception 'FAIL: %', message;
  end if;
end;
$$;

-- The ranks of one book as 'Libraria:1,Romancë:1' (null category =
-- Libraria), or '<none>'.
create function pg_temp.ranks(p_book text) returns text language sql as $$
  select coalesce(string_agg(coalesce(r.category, 'Libraria') || ':' || r.sales_rank, ',' order by r.sort_order), '<none>')
  from public.book_sales_ranks(p_book::uuid) r $$;

-- Gives a book p_n paid sales from new readers, p_days days ago.
create function pg_temp.sell(p_book text, p_n int, p_tag text, p_days int default 1, p_amount int default 29900)
returns void language plpgsql as $$
declare i int; v_uid uuid;
begin
  for i in 1..p_n loop
    v_uid := gen_random_uuid();
    insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data)
      values (v_uid, 'r122-' || p_tag || '-' || i || '@test', now(), '{"role":"reader","display_name":"R122"}');
    insert into public.purchases (book_id, reader_id, amount_cents, stripe_checkout_session_id, stripe_payment_intent_id, created_at)
      values (p_book::uuid, v_uid, p_amount, 'cs_' || p_tag || '_' || i, 'pi_' || p_tag || '_' || i, now() - make_interval(days => p_days));
  end loop;
end;
$$;

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e1220000-0000-4000-8000-00000000000a', 'r122-a@test', now(), '{"role":"author","display_name":"R122 Autor"}');

-- R1 Romancë+Histori, R2 Romancë, R3 Romancë, H4 Histori, F5 free Romancë,
-- D6 draft Romancë, P7 pre-order Histori.
insert into public.books (id, author_id, title, description, keywords, status, price_all, published_at, file_path, cover_path,
                          categories, release_date, preorder_listed_at, preorder_count, is_adult) values
  ('e1221000-0000-4000-8000-0000000000b1', 'e1220000-0000-4000-8000-00000000000a', 'R122 R1', 'x', '', 'published', 299, now(),
   'a/r1/v1.epub', 'e122100c-0000-4000-8000-0000000000b1/cover.jpg', array['Romancë', 'Histori'], null, null, 0, false),
  ('e1221000-0000-4000-8000-0000000000b2', 'e1220000-0000-4000-8000-00000000000a', 'R122 R2', 'x', '', 'published', 299, now(),
   'a/r2/v1.epub', 'e122100c-0000-4000-8000-0000000000b2/cover.jpg', array['Romancë'], null, null, 0, false),
  ('e1221000-0000-4000-8000-0000000000b3', 'e1220000-0000-4000-8000-00000000000a', 'R122 R3', 'x', '', 'published', 299, now(),
   'a/r3/v1.epub', 'e122100c-0000-4000-8000-0000000000b3/cover.jpg', array['Romancë'], null, null, 0, false),
  ('e1221000-0000-4000-8000-0000000000b4', 'e1220000-0000-4000-8000-00000000000a', 'R122 H4', 'x', '', 'published', 299, now(),
   'a/h4/v1.epub', 'e122100c-0000-4000-8000-0000000000b4/cover.jpg', array['Histori'], null, null, 0, false),
  ('e1221000-0000-4000-8000-0000000000b5', 'e1220000-0000-4000-8000-00000000000a', 'R122 F5', 'x', '', 'published', 0, now(),
   'a/f5/v1.epub', 'e122100c-0000-4000-8000-0000000000b5/cover.jpg', array['Romancë'], null, null, 0, false),
  ('e1221000-0000-4000-8000-0000000000b6', 'e1220000-0000-4000-8000-00000000000a', 'R122 D6', 'x', '', 'draft', 299, null,
   null, null, array['Romancë'], null, null, 0, false),
  ('e1221000-0000-4000-8000-0000000000b7', 'e1220000-0000-4000-8000-00000000000a', 'R122 P7', 'x', '', 'preorder', 399, null,
   'a/p7/v1.epub', 'e122100c-0000-4000-8000-0000000000b7/cover.jpg', array['Histori'], current_date + 30, now(), 1, false);

-- part1 the rank.
select pg_temp.assert(pg_temp.ranks('e1221000-0000-4000-8000-0000000000b1') = '<none>', 'part1: no sales, no rank');

select pg_temp.sell('e1221000-0000-4000-8000-0000000000b1', 12, 'r1');
select pg_temp.sell('e1221000-0000-4000-8000-0000000000b2', 11, 'r2');
select pg_temp.sell('e1221000-0000-4000-8000-0000000000b3', 12, 'r3');
select pg_temp.sell('e1221000-0000-4000-8000-0000000000b4', 2, 'h4');

select pg_temp.assert(pg_temp.ranks('e1221000-0000-4000-8000-0000000000b1') = 'Libraria:1,Romancë:1',
  'part1: R1 is first in Libraria and Romancë; Histori has only 2 books with sales, so it is left out');
select pg_temp.assert(pg_temp.ranks('e1221000-0000-4000-8000-0000000000b3') = 'Libraria:1,Romancë:1',
  'part1: R3 has as many sales as R1, so it shares rank 1');
select pg_temp.assert(pg_temp.ranks('e1221000-0000-4000-8000-0000000000b2') = 'Libraria:3,Romancë:3',
  'part1: R2 comes after two books sharing rank 1');
select pg_temp.assert(pg_temp.ranks('e1221000-0000-4000-8000-0000000000b4') = '<none>',
  'part1: H4 has fewer than 10 sales');

select pg_temp.sell('e1221000-0000-4000-8000-0000000000b7', 1, 'p7');
select pg_temp.assert(pg_temp.ranks('e1221000-0000-4000-8000-0000000000b1') = 'Libraria:1,Romancë:1,Histori:1',
  'part1: a third Histori book with a sale (a pre-order counts as listed) adds Histori, in the book''s own category order');
update public.books set categories = array['Histori', 'Romancë'] where id = 'e1221000-0000-4000-8000-0000000000b1';
select pg_temp.assert(pg_temp.ranks('e1221000-0000-4000-8000-0000000000b1') = 'Libraria:1,Histori:1,Romancë:1',
  'part1: categories follow the book''s order');
update public.books set categories = array['Romancë', 'Histori'] where id = 'e1221000-0000-4000-8000-0000000000b1';
select pg_temp.assert(pg_temp.ranks('e1221000-0000-4000-8000-0000000000b4') = '<none>',
  'part1: still nothing for H4');

-- part2 what counts.
-- Free: F5 gets 15 free downloads; it gets no rank, R2 stays third.
do $$
declare i int; v_uid uuid;
begin
  for i in 1..15 loop
    v_uid := gen_random_uuid();
    insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data)
      values (v_uid, 'r122-f5-' || i || '@test', now(), '{"role":"reader","display_name":"R122"}');
    insert into public.purchases (book_id, reader_id, amount_cents, stripe_checkout_session_id)
      values ('e1221000-0000-4000-8000-0000000000b5', v_uid, 0, 'free_' || gen_random_uuid());
  end loop;
end $$;
select pg_temp.assert(pg_temp.ranks('e1221000-0000-4000-8000-0000000000b5') = '<none>', 'part2: free downloads never count');
select pg_temp.assert(pg_temp.ranks('e1221000-0000-4000-8000-0000000000b2') = 'Libraria:3,Romancë:3', 'part2: free downloads push nobody down');

-- Claimed gift copies (amount 0, 'gift_...'): 15 for H4, nothing changes.
do $$
declare i int; v_uid uuid;
begin
  for i in 1..15 loop
    v_uid := gen_random_uuid();
    insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data)
      values (v_uid, 'r122-g4-' || i || '@test', now(), '{"role":"reader","display_name":"R122"}');
    insert into public.purchases (book_id, reader_id, amount_cents, stripe_checkout_session_id)
      values ('e1221000-0000-4000-8000-0000000000b4', v_uid, 0, 'gift_' || gen_random_uuid());
  end loop;
end $$;
select pg_temp.assert(pg_temp.ranks('e1221000-0000-4000-8000-0000000000b4') = '<none>', 'part2: a friend''s claimed gift copy never counts');

-- Draft: D6 with 30 paid sales is not ranked and does not push R1 down.
select pg_temp.sell('e1221000-0000-4000-8000-0000000000b6', 30, 'd6');
select pg_temp.assert(pg_temp.ranks('e1221000-0000-4000-8000-0000000000b6') = '<none>', 'part2: a draft is never ranked');
select pg_temp.assert(pg_temp.ranks('e1221000-0000-4000-8000-0000000000b1') = 'Libraria:1,Romancë:1,Histori:1', 'part2: a draft pushes nobody down');

-- Older than 30 days: H4 gets 20 sales from 31 days ago, still nothing.
select pg_temp.sell('e1221000-0000-4000-8000-0000000000b4', 20, 'h4old', 31);
select pg_temp.assert(pg_temp.ranks('e1221000-0000-4000-8000-0000000000b4') = '<none>', 'part2: sales older than 30 days never count');
-- 29 days ago counts: 8 more makes H4 10 sales.
select pg_temp.sell('e1221000-0000-4000-8000-0000000000b4', 8, 'h4new', 29);
select pg_temp.assert(pg_temp.ranks('e1221000-0000-4000-8000-0000000000b4') = 'Libraria:4,Histori:2',
  'part2: 10 sales within 30 days rank H4');

-- A payment's paid_at decides: an old row bought again today counts, a
-- new row whose payment was 40 days ago does not.
insert into public.payments (id, provider, provider_payment_id, buyer_id, amount_minor, currency, status, paid_at)
  values ('e1222000-0000-4000-8000-000000000001', 'pok', 'pok_old', null, 29900, 'ALL', 'succeeded', now() - interval '40 days');
update public.purchases set payment_id = 'e1222000-0000-4000-8000-000000000001'
  where stripe_checkout_session_id = 'cs_h4new_1';
select pg_temp.assert(pg_temp.ranks('e1221000-0000-4000-8000-0000000000b4') = '<none>',
  'part2: a payment paid 40 days ago does not count, even on a newer row');
insert into public.payments (id, provider, provider_payment_id, buyer_id, amount_minor, currency, status, paid_at)
  values ('e1222000-0000-4000-8000-000000000002', 'pok', 'pok_new', null, 29900, 'ALL', 'succeeded', now() - interval '1 day');
update public.purchases set payment_id = 'e1222000-0000-4000-8000-000000000002'
  where stripe_checkout_session_id in ('cs_h4old_1', 'cs_h4old_2');
select pg_temp.assert(pg_temp.ranks('e1221000-0000-4000-8000-0000000000b4') = 'Libraria:3,Histori:2',
  'part2: an older row whose payment was yesterday counts (11 sales, level with R2)');

-- Refunded: two of R2's sales refunded, 9 left.
update public.purchases set refunded_at = now()
  where stripe_checkout_session_id in ('cs_r2_1', 'cs_r2_2');
select pg_temp.assert(pg_temp.ranks('e1221000-0000-4000-8000-0000000000b2') = '<none>', 'part2: refunded sales never count');

-- A paid gift counts as one sale (rk2 a): back to 10.
insert into public.gifts (buyer_id, book_id, recipient_email, token_hash)
  values (null, 'e1221000-0000-4000-8000-0000000000b2', 'mik@test.example', repeat('a', 64));
select pg_temp.assert(pg_temp.ranks('e1221000-0000-4000-8000-0000000000b2') = 'Libraria:4,Romancë:3',
  'part2: a paid gift counts as one sale');
-- An old gift does not.
update public.gifts set created_at = now() - interval '31 days' where book_id = 'e1221000-0000-4000-8000-0000000000b2';
select pg_temp.assert(pg_temp.ranks('e1221000-0000-4000-8000-0000000000b2') = '<none>', 'part2: a gift older than 30 days does not count');
update public.gifts set created_at = now() where book_id = 'e1221000-0000-4000-8000-0000000000b2';

-- Lost dispute: one of R2's sales lost a dispute, 9 left.
insert into public.payment_disputes (stripe_dispute_id, stripe_payment_intent_id, status, reason, amount_cents)
  values ('dp_r122', 'pi_r2_3', 'lost', 'fraudulent', 29900);
select pg_temp.assert(pg_temp.ranks('e1221000-0000-4000-8000-0000000000b2') = '<none>', 'part2: a lost dispute does not count');
update public.payment_disputes set status = 'won' where stripe_dispute_id = 'dp_r122';
select pg_temp.assert(pg_temp.ranks('e1221000-0000-4000-8000-0000000000b2') = 'Libraria:4,Romancë:3', 'part2: a won dispute counts again');

-- A book that stops being listed (no price) drops out and others move up.
update public.books set price_all = null where id = 'e1221000-0000-4000-8000-0000000000b3';
select pg_temp.assert(pg_temp.ranks('e1221000-0000-4000-8000-0000000000b2') = 'Libraria:3',
  'part2: an unlisted book drops out of every scope (Romancë now has only R1 and R2 with sales)');
select pg_temp.assert(pg_temp.ranks('e1221000-0000-4000-8000-0000000000b3') = '<none>', 'part2: and gets no rank itself');
-- Romancë now has R1, R2 (F5 has no paid sales): 2 books, so Romancë is left out for both.
select pg_temp.assert(pg_temp.ranks('e1221000-0000-4000-8000-0000000000b1') = 'Libraria:1,Histori:1',
  'part2: Romancë with only 2 books with sales is left out');
update public.books set price_all = 299 where id = 'e1221000-0000-4000-8000-0000000000b3';

-- A missing book.
select pg_temp.assert(pg_temp.ranks('00000000-0000-4000-8000-000000000999') = '<none>', 'part2: a missing book has no rank');

-- part3 privacy and grants.
select pg_temp.assert(
  (select pg_catalog.pg_get_function_result('public.book_sales_ranks(uuid)'::regprocedure))
  = 'TABLE(category text, sales_rank integer, sort_order integer)',
  'part3: only category, rank and order come back (no count, no reader, no other book)');
select pg_temp.assert((select prosecdef from pg_catalog.pg_proc where oid = 'public.book_sales_ranks(uuid)'::regprocedure),
  'part3: security definer');
select pg_temp.assert(
  (select proconfig from pg_catalog.pg_proc where oid = 'public.book_sales_ranks(uuid)'::regprocedure) = array['search_path=""'],
  'part3: empty search_path');
select pg_temp.assert(not has_function_privilege('anon', 'public.book_sales_ranks(uuid)', 'execute'), 'part3: anon cannot call it');
select pg_temp.assert(not has_function_privilege('authenticated', 'public.book_sales_ranks(uuid)', 'execute'), 'part3: authenticated cannot call it');
select pg_temp.assert(not has_function_privilege('public', 'public.book_sales_ranks(uuid)', 'execute'), 'part3: public cannot call it');
select pg_temp.assert(has_function_privilege('service_role', 'public.book_sales_ranks(uuid)', 'execute'), 'part3: service_role can');
set local role service_role;
select set_config('r122.n', (select count(*) from public.book_sales_ranks('e1221000-0000-4000-8000-0000000000b1'))::text, true);
reset role;
select pg_temp.assert(current_setting('r122.n') = '3', 'part3: service_role gets the rows');
-- bestselling_books() is unchanged: it still counts every non-refunded row.
select pg_temp.assert(
  (select purchase_count from public.bestselling_books(array['e1221000-0000-4000-8000-0000000000b5'::uuid], 10)) = 15,
  'part3: bestselling_books() not changed');

select pg_temp.assert((select n from pg_temp.assertions_run) = 35, 'all 35 assertions ran');

rollback;
