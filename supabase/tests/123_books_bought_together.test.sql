-- LOCAL/DISPOSABLE DATABASE TEST ONLY.
-- Do not execute against Staging or Production.
--
-- Committed SQL regression suite for Amazon book page P5
-- (supabase/migrations/20261128150000_books_bought_together.sql):
--
-- * part1 the pairs: a book shows only once 3 different readers bought
--   both; most shared readers first, ties newer book first; never the
--   book itself.
-- * part2 what counts (fb1 a, fb4 a): free downloads, claimed gifts
--   (amount 0), refunded and lost-dispute purchases, deleted accounts
--   and the author's own copies never count; old sales do count (all
--   time); a book Libraria does not list is never shown, and an unlisted
--   book has no pairs.
-- * part3 privacy: only (book_id, sort_order) come back; anon and
--   authenticated cannot call it, service_role can.
--
-- To reproduce, from the repo root, against a disposable PostgreSQL 17
-- instance:
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/123_books_bought_together.test.sql
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

-- The books shown for one book, as 'B2,B3' (titles without 'R123 '), or '<none>'.
create function pg_temp.pairs(p_book text) returns text language sql as $$
  select coalesce(string_agg(replace(b.title, 'R123 ', ''), ',' order by t.sort_order), '<none>')
  from public.books_bought_together(p_book::uuid) t
  join public.books b on b.id = t.book_id $$;

-- p_n new readers each buy every book in p_books (paid, p_days days ago).
create function pg_temp.buy(p_books text[], p_n int, p_tag text, p_days int default 1, p_amount int default 29900)
returns void language plpgsql as $$
declare i int; v_uid uuid; v_book text;
begin
  for i in 1..p_n loop
    v_uid := gen_random_uuid();
    insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data)
      values (v_uid, 'r123-' || p_tag || '-' || i || '@test', now(), '{"role":"reader","display_name":"R123"}');
    foreach v_book in array p_books loop
      insert into public.purchases (book_id, reader_id, amount_cents, stripe_checkout_session_id, stripe_payment_intent_id, created_at)
        values (v_book::uuid, v_uid, p_amount,
                case when p_amount > 0 then 'cs_' else 'free_' end || p_tag || '_' || i || '_' || right(v_book, 2),
                'pi_' || p_tag || '_' || i || '_' || right(v_book, 2),
                now() - make_interval(days => p_days));
    end loop;
  end loop;
end;
$$;

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e1230000-0000-4000-8000-00000000000a', 'r123-a@test', now(), '{"role":"author","display_name":"R123 Autor A"}'),
  ('e1230000-0000-4000-8000-00000000000b', 'r123-b@test', now(), '{"role":"author","display_name":"R123 Autor B"}');

-- B1..B5 published (B5 by author B, the newest), D6 draft, P7 pre-order.
insert into public.books (id, author_id, title, description, keywords, status, price_all, published_at, file_path, cover_path,
                          categories, release_date, preorder_listed_at, preorder_count, is_adult, created_at) values
  ('e1231000-0000-4000-8000-0000000000b1', 'e1230000-0000-4000-8000-00000000000a', 'R123 B1', 'x', '', 'published', 299, now(),
   'a/b1/v1.epub', 'e123100c-0000-4000-8000-0000000000b1/cover.jpg', array['Romancë'], null, null, 0, false, now() - interval '9 days'),
  ('e1231000-0000-4000-8000-0000000000b2', 'e1230000-0000-4000-8000-00000000000a', 'R123 B2', 'x', '', 'published', 299, now(),
   'a/b2/v1.epub', 'e123100c-0000-4000-8000-0000000000b2/cover.jpg', array['Romancë'], null, null, 0, false, now() - interval '8 days'),
  ('e1231000-0000-4000-8000-0000000000b3', 'e1230000-0000-4000-8000-00000000000a', 'R123 B3', 'x', '', 'published', 299, now(),
   'a/b3/v1.epub', 'e123100c-0000-4000-8000-0000000000b3/cover.jpg', array['Histori'], null, null, 0, false, now() - interval '7 days'),
  ('e1231000-0000-4000-8000-0000000000b4', 'e1230000-0000-4000-8000-00000000000a', 'R123 B4', 'x', '', 'published', 0, now(),
   'a/b4/v1.epub', 'e123100c-0000-4000-8000-0000000000b4/cover.jpg', array['Romancë'], null, null, 0, false, now() - interval '6 days'),
  ('e1231000-0000-4000-8000-0000000000b5', 'e1230000-0000-4000-8000-00000000000b', 'R123 B5', 'x', '', 'published', 399, now(),
   'b/b5/v1.epub', 'e123100c-0000-4000-8000-0000000000b5/cover.jpg', array['Histori'], null, null, 0, false, now() - interval '1 day'),
  ('e1231000-0000-4000-8000-0000000000b6', 'e1230000-0000-4000-8000-00000000000a', 'R123 D6', 'x', '', 'draft', 299, null,
   null, null, array['Romancë'], null, null, 0, false, now()),
  ('e1231000-0000-4000-8000-0000000000b7', 'e1230000-0000-4000-8000-00000000000a', 'R123 P7', 'x', '', 'preorder', 399, null,
   'a/p7/v1.epub', 'e123100c-0000-4000-8000-0000000000b7/cover.jpg', array['Histori'], current_date + 30, now(), 1, false, now() - interval '2 days');

-- part1 the pairs.
select pg_temp.assert(pg_temp.pairs('e1231000-0000-4000-8000-0000000000b1') = '<none>', 'part1: no sales, no pairs');

select pg_temp.buy(array['e1231000-0000-4000-8000-0000000000b1', 'e1231000-0000-4000-8000-0000000000b2'], 2, 'p12');
select pg_temp.assert(pg_temp.pairs('e1231000-0000-4000-8000-0000000000b1') = '<none>', 'part1: 2 shared readers are not enough');
select pg_temp.buy(array['e1231000-0000-4000-8000-0000000000b1', 'e1231000-0000-4000-8000-0000000000b2'], 1, 'p12b');
select pg_temp.assert(pg_temp.pairs('e1231000-0000-4000-8000-0000000000b1') = 'B2', 'part1: 3 shared readers make a pair');
select pg_temp.assert(pg_temp.pairs('e1231000-0000-4000-8000-0000000000b2') = 'B1', 'part1: the pair works both ways');

-- B3 with 4 shared readers comes before B2 with 3.
select pg_temp.buy(array['e1231000-0000-4000-8000-0000000000b1', 'e1231000-0000-4000-8000-0000000000b3'], 4, 'p13');
select pg_temp.assert(pg_temp.pairs('e1231000-0000-4000-8000-0000000000b1') = 'B3,B2', 'part1: most shared readers first');
-- B5 (newest) with 3 comes before B2 with 3.
select pg_temp.buy(array['e1231000-0000-4000-8000-0000000000b1', 'e1231000-0000-4000-8000-0000000000b5'], 3, 'p15');
select pg_temp.assert(pg_temp.pairs('e1231000-0000-4000-8000-0000000000b1') = 'B3,B5,B2', 'part1: a tie puts the newer book first');
-- One reader buying B1 alone changes nothing; the book itself never shows.
select pg_temp.buy(array['e1231000-0000-4000-8000-0000000000b1'], 5, 'solo');
select pg_temp.assert(pg_temp.pairs('e1231000-0000-4000-8000-0000000000b1') = 'B3,B5,B2', 'part1: buying one book alone makes no pair, and the book itself never shows');
-- A pre-order is listed, so it can show.
select pg_temp.buy(array['e1231000-0000-4000-8000-0000000000b1', 'e1231000-0000-4000-8000-0000000000b7'], 3, 'p17');
select pg_temp.assert(pg_temp.pairs('e1231000-0000-4000-8000-0000000000b1') = 'B3,B5,P7,B2', 'part1: a listed pre-order shows, newer book first on a tie');

-- part2 what counts.
-- Free downloads: 5 readers get B4 (free) and B1.
select pg_temp.buy(array['e1231000-0000-4000-8000-0000000000b1', 'e1231000-0000-4000-8000-0000000000b4'], 5, 'free', 1, 0);
select pg_temp.assert(pg_temp.pairs('e1231000-0000-4000-8000-0000000000b1') = 'B3,B5,P7,B2', 'part2: free downloads never make a pair');
select pg_temp.assert(pg_temp.pairs('e1231000-0000-4000-8000-0000000000b4') = '<none>', 'part2: a free book has no paid buyers to pair');

-- Claimed gift copies (amount 0, 'gift_...'): 5 friends get B2, already bought B3.
do $$
declare i int; v_uid uuid;
begin
  for i in 1..5 loop
    v_uid := gen_random_uuid();
    insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data)
      values (v_uid, 'r123-g-' || i || '@test', now(), '{"role":"reader","display_name":"R123"}');
    insert into public.purchases (book_id, reader_id, amount_cents, stripe_checkout_session_id)
      values ('e1231000-0000-4000-8000-0000000000b3', v_uid, 29900, 'cs_g3_' || i),
             ('e1231000-0000-4000-8000-0000000000b2', v_uid, 0, 'gift_' || gen_random_uuid());
  end loop;
end $$;
select pg_temp.assert(pg_temp.pairs('e1231000-0000-4000-8000-0000000000b2') = 'B1', 'part2: a friend''s claimed gift copy never counts');

-- Old sales count (fb4 a): 3 readers bought B2 + B3 400 days ago.
select pg_temp.buy(array['e1231000-0000-4000-8000-0000000000b2', 'e1231000-0000-4000-8000-0000000000b3'], 3, 'old', 400);
select pg_temp.assert(pg_temp.pairs('e1231000-0000-4000-8000-0000000000b2') = 'B3,B1', 'part2: sales of any age count (B3 is newer than B1)');

-- Refunded: one of the old B3 copies refunded, 2 left.
update public.purchases set refunded_at = now() where stripe_checkout_session_id = 'cs_old_1_b3';
select pg_temp.assert(pg_temp.pairs('e1231000-0000-4000-8000-0000000000b2') = 'B1', 'part2: a refunded copy does not count');
update public.purchases set refunded_at = null where stripe_checkout_session_id = 'cs_old_1_b3';

-- Lost dispute: one of the old B2 copies, then won.
insert into public.payment_disputes (stripe_dispute_id, stripe_payment_intent_id, status, reason, amount_cents)
  values ('dp_r123', 'pi_old_2_b2', 'lost', 'fraudulent', 29900);
select pg_temp.assert(pg_temp.pairs('e1231000-0000-4000-8000-0000000000b2') = 'B1', 'part2: a lost dispute does not count');
update public.payment_disputes set status = 'won' where stripe_dispute_id = 'dp_r123';
select pg_temp.assert(pg_temp.pairs('e1231000-0000-4000-8000-0000000000b2') = 'B3,B1', 'part2: a won dispute counts again');

-- Deleted account (reader_id set null): one old reader goes.
update public.purchases set reader_id = null where stripe_checkout_session_id in ('cs_old_3_b2', 'cs_old_3_b3');
select pg_temp.assert(pg_temp.pairs('e1231000-0000-4000-8000-0000000000b2') = 'B1', 'part2: a deleted account''s copies do not count');

-- The author's own copies: author B (who wrote B5) buys B5 and B2; their
-- own B5 copy never counts.
insert into public.purchases (book_id, reader_id, amount_cents, stripe_checkout_session_id) values
  ('e1231000-0000-4000-8000-0000000000b5', 'e1230000-0000-4000-8000-00000000000b', 39900, 'cs_authb_b5'),
  ('e1231000-0000-4000-8000-0000000000b2', 'e1230000-0000-4000-8000-00000000000b', 29900, 'cs_authb_b2');
select pg_temp.buy(array['e1231000-0000-4000-8000-0000000000b2', 'e1231000-0000-4000-8000-0000000000b5'], 2, 'p25');
select pg_temp.assert(pg_temp.pairs('e1231000-0000-4000-8000-0000000000b5') = 'B1', 'part2: an author''s own copy of their book never counts (2 readers + the author is not 3)');
-- And the author of the OTHER book: author A buys B5 and their own B2.
insert into public.purchases (book_id, reader_id, amount_cents, stripe_checkout_session_id) values
  ('e1231000-0000-4000-8000-0000000000b5', 'e1230000-0000-4000-8000-00000000000a', 39900, 'cs_autha_b5'),
  ('e1231000-0000-4000-8000-0000000000b2', 'e1230000-0000-4000-8000-00000000000a', 29900, 'cs_autha_b2');
select pg_temp.assert(pg_temp.pairs('e1231000-0000-4000-8000-0000000000b5') = 'B1', 'part2: the other book''s author cannot make a pair with their own copy');
-- A third real reader makes it.
select pg_temp.buy(array['e1231000-0000-4000-8000-0000000000b2', 'e1231000-0000-4000-8000-0000000000b5'], 1, 'p25b');
select pg_temp.assert(pg_temp.pairs('e1231000-0000-4000-8000-0000000000b5') = 'B2,B1', 'part2: a third real reader makes the pair, newer book first');

-- Draft: 5 readers buy B1 + D6 (bought while it was live); never shown.
select pg_temp.buy(array['e1231000-0000-4000-8000-0000000000b1', 'e1231000-0000-4000-8000-0000000000b6'], 5, 'p16');
select pg_temp.assert(pg_temp.pairs('e1231000-0000-4000-8000-0000000000b1') = 'B3,B5,P7,B2', 'part2: a book Libraria does not list never shows');
select pg_temp.assert(pg_temp.pairs('e1231000-0000-4000-8000-0000000000b6') = '<none>', 'part2: an unlisted book has no pairs');
-- A book that loses its price drops out.
update public.books set price_all = null where id = 'e1231000-0000-4000-8000-0000000000b3';
select pg_temp.assert(pg_temp.pairs('e1231000-0000-4000-8000-0000000000b1') = 'B5,P7,B2', 'part2: a book with no price drops out');
update public.books set price_all = 299 where id = 'e1231000-0000-4000-8000-0000000000b3';
-- A missing book.
select pg_temp.assert(pg_temp.pairs('00000000-0000-4000-8000-000000000999') = '<none>', 'part2: a missing book has no pairs');

-- part3 privacy and grants.
select pg_temp.assert(
  (select pg_catalog.pg_get_function_result('public.books_bought_together(uuid)'::regprocedure))
  = 'TABLE(book_id uuid, sort_order integer)',
  'part3: only the other book and its order come back (no count, no reader, no date)');
select pg_temp.assert((select prosecdef from pg_catalog.pg_proc where oid = 'public.books_bought_together(uuid)'::regprocedure),
  'part3: security definer');
select pg_temp.assert(
  (select proconfig from pg_catalog.pg_proc where oid = 'public.books_bought_together(uuid)'::regprocedure) = array['search_path=""'],
  'part3: empty search_path');
select pg_temp.assert(not has_function_privilege('anon', 'public.books_bought_together(uuid)', 'execute'), 'part3: anon cannot call it');
select pg_temp.assert(not has_function_privilege('authenticated', 'public.books_bought_together(uuid)', 'execute'), 'part3: authenticated cannot call it');
select pg_temp.assert(not has_function_privilege('public', 'public.books_bought_together(uuid)', 'execute'), 'part3: public cannot call it');
select pg_temp.assert(has_function_privilege('service_role', 'public.books_bought_together(uuid)', 'execute'), 'part3: service_role can');
set local role service_role;
select set_config('r123.n', (select count(*) from public.books_bought_together('e1231000-0000-4000-8000-0000000000b1'))::text, true);
reset role;
select pg_temp.assert(current_setting('r123.n') = '4', 'part3: service_role gets the rows');
-- book_sales_ranks() is unchanged.
select pg_temp.assert(
  (select pg_catalog.pg_get_function_result('public.book_sales_ranks(uuid)'::regprocedure))
  = 'TABLE(category text, sales_rank integer, sort_order integer)',
  'part3: book_sales_ranks() not changed');

select pg_temp.assert((select n from pg_temp.assertions_run) = 32, 'all 32 assertions ran');

rollback;
