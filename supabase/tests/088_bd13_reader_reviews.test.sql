-- LOCAL/DISPOSABLE DATABASE TEST ONLY.
-- Do not execute against Staging or Production.
--
-- BD13 (migration 20261102120000): reader reviews get a public display
-- name, staff approval before they appear and a verified-purchase badge.
-- Pins:
--   Part 1  grants and shapes: reviews SELECT-only for authenticated,
--           the new functions (definer, empty search_path, authenticated
--           only), public_reviews' columns, profiles.review_name not
--           writable by the reader.
--   Part 2  submit_reader_review(): refusals (rating, length, own book,
--           not owner, refunded, name rules) and the first save (name
--           set once, review pending, hidden from public_reviews).
--   Part 3  staff: the queue (fields), approve (shows, name, badge),
--           role gate (owner/admin/moderator yes; support/editor/reader
--           no), stale decisions refused ('changed'), audit rows.
--   Part 4  edits (Q1a), identical resubmission, rejection (reason +
--           note, 'other' needs a note, 'bad_name' clears the name), the
--           reader reading their own rejection, staff_set_review_name.
--   Part 5  the badge (Q7a): paid > 0 and not refunded only.
--   Part 6  audit r1: a cleared name never shows a pen name, a lost
--           chargeback removes the badge, staff never decide their own
--           review; (Part 4) only owner/admin set names.
--
-- Everything runs inside one transaction and is rolled back at the end.
begin;

set local client_min_messages = warning;

create table pg_temp.assertions_run (n integer not null);
insert into pg_temp.assertions_run values (0);
grant select, update on pg_temp.assertions_run to anon, authenticated;

create function pg_temp.assert(condition boolean, message text) returns void
  language plpgsql as $$
begin
  update pg_temp.assertions_run set n = n + 1;
  if not condition or condition is null then
    raise exception 'FAIL: %', message;
  end if;
end;
$$;

create function pg_temp.run_as(p_role text, p_sub text, p_sql text) returns text
  language plpgsql as $$
declare
  v_state text;
  v_msg text;
  v_rows bigint;
  v_out text;
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_sub, ''), true);
  execute format('set local role %I', p_role);
  begin
    execute p_sql;
    get diagnostics v_rows = row_count;
    v_out := 'OK:' || v_rows;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    v_out := v_state || ':' || v_msg;
  end;
  reset role;
  perform set_config('request.jwt.claim.sub', '', true);
  return v_out;
end;
$$;

create function pg_temp.value_as(p_role text, p_sub text, p_sql text) returns text
  language plpgsql as $$
declare
  v_state text;
  v_msg text;
  v_out text;
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_sub, ''), true);
  execute format('set local role %I', p_role);
  begin
    execute p_sql into v_out;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    v_out := v_state || ':' || v_msg;
  end;
  reset role;
  perform set_config('request.jwt.claim.sub', '', true);
  return v_out;
end;
$$;

create function pg_temp.cols(p_rel text) returns text
  language sql stable as $$
  select string_agg(attname, ',' order by attnum)
    from pg_catalog.pg_attribute
   where attrelid = p_rel::regclass and attnum > 0 and not attisdropped;
$$;

-- Accounts: author A (one book), reader R, reader S (free claim),
-- reader T (refunded), reader U (unconfirmed email), and one staff
-- account per role.
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0880000-0000-4000-8000-00000000000a', 'p088-a@test', now(), '{"role":"author","display_name":"P088 Ana Real"}'),
  ('e0880000-0000-4000-8000-0000000000aa', 'p088-r@test', now(), '{"role":"reader","display_name":"P088 Reader Real"}'),
  ('e0880000-0000-4000-8000-0000000000bb', 'p088-s@test', now(), '{"role":"reader","display_name":"P088 Free"}'),
  ('e0880000-0000-4000-8000-0000000000cc', 'p088-t@test', now(), '{"role":"reader","display_name":"P088 Refunded"}'),
  ('e0880000-0000-4000-8000-0000000000dd', 'p088-u@test', null, '{"role":"reader","display_name":"P088 Unconfirmed"}'),
  ('e0880000-0000-4000-8000-0000000000f1', 'p088-o@test', now(), '{"role":"reader","display_name":"P088 Owner"}'),
  ('e0880000-0000-4000-8000-0000000000f2', 'p088-ad@test', now(), '{"role":"reader","display_name":"P088 Admin"}'),
  ('e0880000-0000-4000-8000-0000000000f3', 'p088-m@test', now(), '{"role":"reader","display_name":"P088 Moderator"}'),
  ('e0880000-0000-4000-8000-0000000000f4', 'p088-su@test', now(), '{"role":"reader","display_name":"P088 Support"}'),
  ('e0880000-0000-4000-8000-0000000000f5', 'p088-e@test', now(), '{"role":"reader","display_name":"P088 Editor"}');

insert into public.staff_members (user_id, role) values
  ('e0880000-0000-4000-8000-0000000000f1', 'owner'),
  ('e0880000-0000-4000-8000-0000000000f2', 'admin'),
  ('e0880000-0000-4000-8000-0000000000f3', 'moderator'),
  ('e0880000-0000-4000-8000-0000000000f4', 'support'),
  ('e0880000-0000-4000-8000-0000000000f5', 'editor');

insert into public.books (id, author_id, title, status, price_all, published_at, pen_name_id) values
  ('e0880001-0000-4000-8000-0000000000a1', 'e0880000-0000-4000-8000-00000000000a', 'P088 Book', 'published', 199, now(), null);

-- R paid 199 lek; S claimed it free (0); T paid and was refunded; U paid;
-- A (the author) holds a purchase row of their own book.
insert into public.purchases (book_id, reader_id, stripe_checkout_session_id, amount_cents, refunded_at) values
  ('e0880001-0000-4000-8000-0000000000a1', 'e0880000-0000-4000-8000-0000000000aa', 'cs_p088_r', 19900, null),
  ('e0880001-0000-4000-8000-0000000000a1', 'e0880000-0000-4000-8000-0000000000bb', 'free_p088_s', 0, null),
  ('e0880001-0000-4000-8000-0000000000a1', 'e0880000-0000-4000-8000-0000000000cc', 'cs_p088_t', 19900, now()),
  ('e0880001-0000-4000-8000-0000000000a1', 'e0880000-0000-4000-8000-0000000000dd', 'cs_p088_u', 19900, null),
  ('e0880001-0000-4000-8000-0000000000a1', 'e0880000-0000-4000-8000-00000000000a', 'free_p088_a', 0, null);

create function pg_temp.submit(p_sub text, p_rating integer, p_body text, p_name text) returns text
  language sql as $$
  select pg_temp.value_as('authenticated', p_sub,
    format('select public.submit_reader_review(%L::uuid, %s, %L, %L)',
           'e0880001-0000-4000-8000-0000000000a1', coalesce(p_rating::text, 'null'), p_body, p_name));
$$;

create function pg_temp.seen(p_reader text) returns text
  language sql stable as $$
  select updated_at::text from public.reviews
   where reader_id = p_reader::uuid and book_id = 'e0880001-0000-4000-8000-0000000000a1';
$$;

create function pg_temp.rid(p_reader text) returns text
  language sql stable as $$
  select id::text from public.reviews
   where reader_id = p_reader::uuid and book_id = 'e0880001-0000-4000-8000-0000000000a1';
$$;

create function pg_temp.approve(p_staff text, p_reader text) returns text
  language sql as $$
  select pg_temp.value_as('authenticated', p_staff,
    format('select public.staff_approve_reader_review(%L::uuid, %L::timestamptz)',
           pg_temp.rid(p_reader), pg_temp.seen(p_reader)));
$$;

create function pg_temp.reject(p_staff text, p_reader text, p_reason text, p_note text) returns text
  language sql as $$
  select pg_temp.value_as('authenticated', p_staff,
    format('select public.staff_reject_reader_review(%L::uuid, %L::timestamptz, %L, %L)',
           pg_temp.rid(p_reader), pg_temp.seen(p_reader), p_reason, p_note));
$$;

create function pg_temp.public_line() returns text
  language sql as $$
  select pg_temp.value_as('anon', null,
    'select coalesce(string_agg(coalesce(reviewer_name, ''<null>'') || ''|'' || rating || ''|'' || body || ''|'' || verified, '';'' order by body), '''')
       from public.public_reviews where book_id = ''e0880001-0000-4000-8000-0000000000a1''');
$$;

-- ============================================================
-- Part 1: grants and shapes.
-- ============================================================
do $$
declare
  v_fn text;
begin
  perform pg_temp.assert(has_table_privilege('authenticated', 'public.reviews', 'SELECT')
    and not has_table_privilege('authenticated', 'public.reviews', 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
    and not has_column_privilege('authenticated', 'public.reviews', 'status', 'UPDATE')
    and not has_column_privilege('authenticated', 'public.reviews', 'body', 'UPDATE')
    and not has_table_privilege('anon', 'public.reviews', 'SELECT, INSERT, UPDATE, DELETE'),
    'part1: reviews are SELECT-only for authenticated, nothing for anon');

  perform pg_temp.assert(not has_column_privilege('authenticated', 'public.profiles', 'review_name', 'UPDATE')
    and not has_column_privilege('authenticated', 'public.profiles', 'review_name', 'INSERT'),
    'part1: a reader cannot write profiles.review_name directly');

  perform pg_temp.assert(pg_temp.cols('public.public_reviews') = 'id,book_id,rating,body,created_at,reviewer_name,verified,reviewer_is_author',
    'part1: public_reviews columns (verified and reviewer_is_author appended, no reader_id)');

  perform pg_temp.assert(
    (select column_default from information_schema.columns
      where table_schema = 'public' and table_name = 'reviews' and column_name = 'status') = '''pending''::text',
    'part1: a new review defaults to pending');

  foreach v_fn in array array[
    'public.submit_reader_review(uuid,integer,text,text)',
    'public.staff_list_pending_reader_reviews()',
    'public.staff_approve_reader_review(uuid,timestamptz)',
    'public.staff_reject_reader_review(uuid,timestamptz,text,text)',
    'public.staff_set_review_name(uuid,text)'] loop
    perform pg_temp.assert(not has_function_privilege('public', v_fn, 'EXECUTE')
      and not has_function_privilege('anon', v_fn, 'EXECUTE')
      and has_function_privilege('authenticated', v_fn, 'EXECUTE')
      and not has_function_privilege('service_role', v_fn, 'EXECUTE')
      and (select prosecdef and proconfig = array['search_path=""'] from pg_catalog.pg_proc
            where oid = v_fn::regprocedure),
      format('part1: %s is definer, empty search_path, authenticated only', v_fn));
  end loop;

  perform pg_temp.assert(pg_temp.run_as('authenticated', 'e0880000-0000-4000-8000-0000000000aa',
      $q$insert into public.reviews (book_id, reader_id, rating, body, status) values ('e0880001-0000-4000-8000-0000000000a1', 'e0880000-0000-4000-8000-0000000000aa', 5, 'x', 'approved')$q$) like '42501:%',
    'part1: a reader cannot insert a review directly (not even as approved)');

  perform pg_temp.assert(pg_temp.run_as('authenticated', 'e0880000-0000-4000-8000-0000000000aa',
      $q$update public.profiles set review_name = 'Sneaky' where id = 'e0880000-0000-4000-8000-0000000000aa'$q$) like '42501:%',
    'part1: a reader cannot set their review_name with a direct update');

  perform pg_temp.assert(pg_temp.value_as('anon', null,
      $q$select public.submit_reader_review('e0880001-0000-4000-8000-0000000000a1', 5, 'x', 'Anon')$q$) like '42501:%',
    'part1: anon cannot call submit_reader_review');
end $$;

-- ============================================================
-- Part 2: submit_reader_review() refusals and the first save.
-- ============================================================
do $$
declare
  r text := 'e0880000-0000-4000-8000-0000000000aa';
begin
  perform pg_temp.assert(pg_temp.submit(r, 0, 'x', 'Lexuesi R') = 'bad_rating', 'part2: rating 0 refused');
  perform pg_temp.assert(pg_temp.submit(r, 6, 'x', 'Lexuesi R') = 'bad_rating', 'part2: rating 6 refused');
  perform pg_temp.assert(pg_temp.submit(r, null, 'x', 'Lexuesi R') = 'bad_rating', 'part2: no rating refused');
  perform pg_temp.assert(pg_temp.submit(r, 5, repeat('a', 4001), 'Lexuesi R') = 'too_long', 'part2: text over 4,000 characters refused');
  perform pg_temp.assert(pg_temp.submit(r, 5, 'x', null) = 'name_required', 'part2: no name on the account and none given');
  perform pg_temp.assert(pg_temp.submit(r, 5, 'x', '   ') = 'name_required', 'part2: a blank name counts as none');
  perform pg_temp.assert(pg_temp.submit(r, 5, 'x', 'A') = 'bad_name', 'part2: a 1-character name refused');
  perform pg_temp.assert(pg_temp.submit(r, 5, 'x', repeat('n', 41)) = 'bad_name', 'part2: a 41-character name refused');
  perform pg_temp.assert(pg_temp.submit(r, 5, 'x', 'Ana' || chr(10) || 'Bot') = 'bad_name', 'part2: a name with a control character refused');
  perform pg_temp.assert(pg_temp.submit('e0880000-0000-4000-8000-00000000000a', 5, 'x', 'Autorja') = 'own_book',
    'part2: the author cannot review their own book, even holding a purchase row');
  perform pg_temp.assert(pg_temp.submit('e0880000-0000-4000-8000-0000000000cc', 5, 'x', 'Kthyer') = 'not_owner',
    'part2: a refunded reader cannot review');
  perform pg_temp.assert(pg_temp.submit('e0880000-0000-4000-8000-0000000000f5', 5, 'x', 'Askush') = 'not_owner',
    'part2: a reader without the book cannot review');
  perform pg_temp.assert((select count(*) from public.reviews) = 0
    and (select count(*) from public.profiles where review_name is not null) = 0,
    'part2: no refusal saved a review or a name');

  -- The first save: the name is trimmed and set once; the review waits.
  perform pg_temp.assert(pg_temp.submit(r, 4, '  Shumë e bukur  ', '  Lexuesi R  ') = 'pending', 'part2: first save is pending');
  perform pg_temp.assert((select review_name from public.profiles where id = r::uuid) = 'Lexuesi R',
    'part2: the name is saved trimmed on the account');
  perform pg_temp.assert((select status || '|' || rating || '|' || body from public.reviews where reader_id = r::uuid) = 'pending|4|Shumë e bukur',
    'part2: the review is saved trimmed and pending');
  perform pg_temp.assert(pg_temp.public_line() = '', 'part2: a pending review is not public');

  -- A second save never changes the name (Q2a: staff only).
  perform pg_temp.assert(pg_temp.submit(r, 4, 'Shumë e bukur', 'Emër tjetër') = 'pending', 'part2: a resave of a pending review stays pending');
  perform pg_temp.assert((select review_name from public.profiles where id = r::uuid) = 'Lexuesi R',
    'part2: a later name is ignored once one is set');

  -- The reader reads their own row; another reader does not.
  perform pg_temp.assert(pg_temp.value_as('authenticated', r, 'select status from public.reviews') = 'pending',
    'part2: the reader sees their own pending review');
  perform pg_temp.assert(pg_temp.value_as('authenticated', 'e0880000-0000-4000-8000-0000000000bb', 'select count(*)::text from public.reviews') = '0',
    'part2: another reader does not see it');
end $$;

-- ============================================================
-- Part 3: the staff queue, approval, the role gate, stale decisions.
-- ============================================================
do $$
declare
  r text := 'e0880000-0000-4000-8000-0000000000aa';
  u text := 'e0880000-0000-4000-8000-0000000000dd';
  v_stale text;
begin
  perform pg_temp.assert(pg_temp.submit(u, 2, 'Nuk më pëlqeu', 'Lexuesi U') = 'pending', 'part3: U saves a 2-star review');

  -- The queue, with the reviewer signals (one transaction: both rows
  -- share updated_at, so the check orders by rating).
  perform pg_temp.assert(pg_temp.value_as('authenticated', 'e0880000-0000-4000-8000-0000000000f3',
      $q$select string_agg(book_title || '|' || rating || '|' || review_name || '|' || email_confirmed || '|' || reviews_total || '|' || reviews_approved || '|' || verified || '|' || reviewer_is_author || '|' || (account_created_at is not null), ';' order by rating desc)
           from public.staff_list_pending_reader_reviews()$q$)
      = 'P088 Book|4|Lexuesi R|true|1|0|true|false|true;P088 Book|2|Lexuesi U|false|1|0|true|false|true',
    'part3: the moderator reads the queue with title, stars, name, email confirmed, counts, badge and author flag');

  -- The role gate: support, editor and a plain reader are refused.
  perform pg_temp.assert(pg_temp.value_as('authenticated', 'e0880000-0000-4000-8000-0000000000f4',
      'select count(*)::text from public.staff_list_pending_reader_reviews()') like 'P0001:not authorized%',
    'part3: support cannot read the queue');
  perform pg_temp.assert(pg_temp.value_as('authenticated', 'e0880000-0000-4000-8000-0000000000f5',
      'select count(*)::text from public.staff_list_pending_reader_reviews()') like 'P0001:not authorized%',
    'part3: an editor cannot read the queue');
  perform pg_temp.assert(pg_temp.approve(r, r) like 'P0001:not authorized%', 'part3: a reader cannot approve');
  perform pg_temp.assert(pg_temp.approve('e0880000-0000-4000-8000-0000000000f4', r) like 'P0001:not authorized%', 'part3: support cannot approve');
  perform pg_temp.assert(pg_temp.reject('e0880000-0000-4000-8000-0000000000f5', r, 'abusive', null) like 'P0001:not authorized%', 'part3: an editor cannot reject');
  perform pg_temp.assert(pg_temp.value_as('authenticated', 'e0880000-0000-4000-8000-0000000000f4',
      $q$select public.staff_set_review_name('e0880000-0000-4000-8000-0000000000aa', 'X Y')$q$) like 'P0001:not authorized%',
    'part3: support cannot change a name');

  -- A stale decision is refused: the staff member saw an older version.
  v_stale := pg_temp.value_as('authenticated', 'e0880000-0000-4000-8000-0000000000f3',
    format('select public.staff_approve_reader_review(%L::uuid, %L::timestamptz)', pg_temp.rid(r), '2000-01-01 00:00:00+00'));
  perform pg_temp.assert(v_stale = 'changed', 'part3: approving a version the reader since changed is refused');
  perform pg_temp.assert(pg_temp.value_as('authenticated', 'e0880000-0000-4000-8000-0000000000f3',
      format('select public.staff_approve_reader_review(%L::uuid, now())', gen_random_uuid())) = 'not_found',
    'part3: an unknown review is not_found');

  -- Approve: moderator for R, admin for U.
  perform pg_temp.assert(pg_temp.approve('e0880000-0000-4000-8000-0000000000f3', r) = 'approved', 'part3: the moderator approves R');
  perform pg_temp.assert(pg_temp.approve('e0880000-0000-4000-8000-0000000000f2', u) = 'approved', 'part3: the admin approves U (a 2-star review)');
  perform pg_temp.assert(pg_temp.approve('e0880000-0000-4000-8000-0000000000f2', u) = 'changed', 'part3: approving twice is refused (no longer pending)');
  perform pg_temp.assert(pg_temp.public_line() = 'Lexuesi U|2|Nuk më pëlqeu|true;Lexuesi R|4|Shumë e bukur|true',
    'part3: approved reviews show with the chosen name and the badge');
  perform pg_temp.assert((select count(*) from public.admin_audit_log
      where action = 'review.approved' and target_type = 'reviews'
        and actor_id in ('e0880000-0000-4000-8000-0000000000f3', 'e0880000-0000-4000-8000-0000000000f2')) = 2,
    'part3: each approval is audited with its actor');
  perform pg_temp.assert(pg_temp.value_as('authenticated', 'e0880000-0000-4000-8000-0000000000f1',
      'select count(*)::text from public.staff_list_pending_reader_reviews()') = '0',
    'part3: the owner sees an empty queue');
end $$;

-- ============================================================
-- Part 4: edits, identical resubmission, rejection, names.
-- ============================================================
do $$
declare
  r text := 'e0880000-0000-4000-8000-0000000000aa';
  u text := 'e0880000-0000-4000-8000-0000000000dd';
begin
  -- Identical resubmission of an approved review changes nothing.
  perform pg_temp.assert(pg_temp.submit(r, 4, 'Shumë e bukur', null) = 'unchanged', 'part4: an identical resubmission is unchanged');
  perform pg_temp.assert((select status from public.reviews where reader_id = r::uuid) = 'approved', 'part4: and stays approved');

  -- An edit takes it off the page until approved again (Q1a).
  perform pg_temp.assert(pg_temp.submit(r, 5, 'Shumë e bukur, e rilexova', null) = 'pending', 'part4: an edit is pending');
  perform pg_temp.assert(pg_temp.public_line() = 'Lexuesi U|2|Nuk më pëlqeu|true', 'part4: the edited review left the page');

  -- Rejection: fixed list, 'other' needs a note, notes are bounded.
  perform pg_temp.assert(pg_temp.reject('e0880000-0000-4000-8000-0000000000f3', r, 'negative', null) = 'bad_reason',
    'part4: "negative" is not a rejection reason');
  perform pg_temp.assert(pg_temp.reject('e0880000-0000-4000-8000-0000000000f3', r, null, null) = 'bad_reason', 'part4: a reason is required');
  perform pg_temp.assert(pg_temp.reject('e0880000-0000-4000-8000-0000000000f3', r, 'other', '  ') = 'note_required', 'part4: other needs a note');
  perform pg_temp.assert(pg_temp.reject('e0880000-0000-4000-8000-0000000000f3', r, 'abusive', repeat('n', 501)) = 'note_too_long', 'part4: a note over 500 characters refused');
  perform pg_temp.assert(pg_temp.reject('e0880000-0000-4000-8000-0000000000f3', r, 'personal_data', '  Hiqni numrin e telefonit.  ') = 'rejected',
    'part4: the moderator rejects with a reason and a note');
  perform pg_temp.assert(pg_temp.value_as('authenticated', r,
      'select status || ''|'' || rejection_reason || ''|'' || rejection_note from public.reviews') = 'rejected|personal_data|Hiqni numrin e telefonit.',
    'part4: the reader reads the reason and the trimmed note on their own review');
  perform pg_temp.assert((select review_name from public.profiles where id = r::uuid) = 'Lexuesi R',
    'part4: a rejection for another reason keeps the name');
  perform pg_temp.assert((select metadata->>'reason' from public.admin_audit_log where action = 'review.rejected') = 'personal_data',
    'part4: the rejection is audited with its reason');

  -- Sending it again clears the reason and waits again.
  perform pg_temp.assert(pg_temp.submit(r, 5, 'Shumë e bukur, e rilexova.', null) = 'pending', 'part4: a fixed review is pending again');
  perform pg_temp.assert((select rejection_reason is null and rejection_note is null from public.reviews where reader_id = r::uuid),
    'part4: the old reason is cleared');

  -- 'bad_name' clears the name, so the reader must pick a new one.
  perform pg_temp.assert(pg_temp.reject('e0880000-0000-4000-8000-0000000000f2', r, 'bad_name', null) = 'rejected', 'part4: rejected for the name');
  perform pg_temp.assert((select review_name from public.profiles where id = r::uuid) is null, 'part4: a bad_name rejection clears the name');
  perform pg_temp.assert(pg_temp.submit(r, 5, 'Shumë e bukur, e rilexova.', null) = 'name_required', 'part4: the reader must choose a new name');
  perform pg_temp.assert(pg_temp.submit(r, 5, 'Shumë e bukur, e rilexova.', 'Rina') = 'pending',
    'part4: the same text with a new name goes back to the queue');
  perform pg_temp.assert((select review_name from public.profiles where id = r::uuid) = 'Rina', 'part4: the new name is saved');

  -- Constraints hold even for a direct write by the owner role.
  begin
    update public.reviews set status = 'rejected', rejection_reason = null where reader_id = r::uuid;
    perform pg_temp.assert(false, 'part4: rejected without a reason must violate the check');
  exception when check_violation then
    perform pg_temp.assert(true, 'part4: rejected without a reason violates the check');
  end;
  begin
    update public.reviews set status = 'rejected', rejection_reason = 'other', rejection_note = null where reader_id = r::uuid;
    perform pg_temp.assert(false, 'part4: other without a note must violate the check');
  exception when check_violation then
    perform pg_temp.assert(true, 'part4: other without a note violates the check');
  end;

  -- Staff change and clear a name (Q2a: the reader asks support).
  perform pg_temp.assert(pg_temp.value_as('authenticated', 'e0880000-0000-4000-8000-0000000000f1',
      format('select public.staff_set_review_name(%L::uuid, %L)', u, 'X')) = 'bad_name', 'part4: staff names follow the same rules');
  perform pg_temp.assert(pg_temp.value_as('authenticated', 'e0880000-0000-4000-8000-0000000000f1',
      format('select public.staff_set_review_name(%L::uuid, %L)', u, ' Uka ')) = 'saved', 'part4: the owner changes U''s name');
  perform pg_temp.assert(pg_temp.public_line() = 'Uka|2|Nuk më pëlqeu|true', 'part4: the approved review shows the new name at once');
  perform pg_temp.assert(pg_temp.value_as('authenticated', 'e0880000-0000-4000-8000-0000000000f3',
      format('select public.staff_set_review_name(%L::uuid, null)', u)) like 'P0001:not authorized%',
    'part4: a moderator cannot change or clear a name (owner and admin only, audit r1 S4)');
  perform pg_temp.assert(pg_temp.value_as('authenticated', 'e0880000-0000-4000-8000-0000000000f2',
      format('select public.staff_set_review_name(%L::uuid, null)', u)) = 'saved', 'part4: the admin clears it');
  perform pg_temp.assert(pg_temp.public_line() = '<null>|2|Nuk më pëlqeu|true', 'part4: a cleared name shows no name (the page says "Një lexues i Librum")');
  perform pg_temp.assert((select string_agg(action, ',' order by created_at, action) from public.admin_audit_log where target_type = 'profiles')
      in ('review_name.changed,review_name.cleared', 'review_name.cleared,review_name.changed'),
    'part4: name changes are audited');
  perform pg_temp.assert(pg_temp.value_as('authenticated', 'e0880000-0000-4000-8000-0000000000f1',
      format('select public.staff_set_review_name(%L::uuid, %L)', gen_random_uuid(), 'Emri')) = 'not_found', 'part4: an unknown account is not_found');
end $$;

-- ============================================================
-- Part 5: the badge (Q7a).
-- ============================================================
do $$
declare
  s text := 'e0880000-0000-4000-8000-0000000000bb';
  u text := 'e0880000-0000-4000-8000-0000000000dd';
begin
  perform pg_temp.assert(pg_temp.submit(s, 5, 'Falas', 'Lexuesi S') = 'pending', 'part5: a free claim may review');
  perform pg_temp.assert(pg_temp.approve('e0880000-0000-4000-8000-0000000000f3', s) = 'approved', 'part5: approved');
  perform pg_temp.assert(pg_temp.value_as('anon', null,
      'select verified::text from public.public_reviews where body = ''Falas''') = 'false',
    'part5: a free claim (0 lek) gets no badge');

  update public.purchases set refunded_at = now() where reader_id = u::uuid;
  perform pg_temp.assert(pg_temp.value_as('anon', null,
      'select verified::text from public.public_reviews where body = ''Nuk më pëlqeu''') = 'false',
    'part5: a refund removes the badge');
end $$;

-- ============================================================
-- Part 6: audit r1 fixes -- a cleared name never falls back to a pen
-- name (R1), a lost chargeback removes the badge (S1), staff never
-- decide their own review (S3).
-- ============================================================
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0880000-0000-4000-8000-00000000000b', 'p088-b@test', now(), '{"role":"author","display_name":"P088 Bora Real"}');
insert into public.books (id, author_id, title, status, price_all, published_at, pen_name_id) values
  ('e0880001-0000-4000-8000-0000000000b1', 'e0880000-0000-4000-8000-00000000000b', 'P088 Book B', 'published', 199, now(), null);
insert into public.pen_names (author_id, name, is_default)
  select 'e0880000-0000-4000-8000-00000000000b', 'P088 Pen Sekret', true
   where not exists (select 1 from public.pen_names
                      where author_id = 'e0880000-0000-4000-8000-00000000000b' and is_default);
insert into public.purchases (book_id, reader_id, stripe_checkout_session_id, stripe_payment_intent_id, amount_cents) values
  ('e0880001-0000-4000-8000-0000000000a1', 'e0880000-0000-4000-8000-00000000000b', 'cs_p088_b', 'pi_p088_b', 19900),
  ('e0880001-0000-4000-8000-0000000000a1', 'e0880000-0000-4000-8000-0000000000f3', 'cs_p088_m', 'pi_p088_m', 19900);

do $$
declare
  b text := 'e0880000-0000-4000-8000-00000000000b';
  m text := 'e0880000-0000-4000-8000-0000000000f3';
  v_pen text := (select name from public.pen_names
                  where author_id = 'e0880000-0000-4000-8000-00000000000b'::uuid and is_default);
  v_line text;
begin
  perform pg_temp.assert(v_pen is not null, 'part6: author B has a default pen name');

  -- R1: author B reviews under a chosen name; staff clear it; the review
  -- shows no name, never B's pen name.
  perform pg_temp.assert(pg_temp.submit(b, 4, 'Nga autori B', 'Lexuesi B') = 'pending', 'part6: author B reviews with a chosen name');
  perform pg_temp.assert(pg_temp.approve('e0880000-0000-4000-8000-0000000000f2', b) = 'approved', 'part6: approved');
  v_line := pg_temp.value_as('anon', null,
    'select coalesce(reviewer_name, ''<null>'') || ''|'' || verified from public.public_reviews where body = ''Nga autori B''');
  perform pg_temp.assert(v_line = 'Lexuesi B|true', 'part6: it shows the chosen name and the badge');

  -- The "Autor në Librum" tag (Renato's a, after audit r2 N1): true for
  -- an author account at approval, false for a reader.
  perform pg_temp.assert(pg_temp.value_as('anon', null,
      'select string_agg(body || ''='' || reviewer_is_author, '','' order by body) from public.public_reviews where body in (''Nga autori B'', ''Falas'')')
      = 'Falas=false,Nga autori B=true', 'part6: an author account is tagged; a reader is not');
  perform pg_temp.assert(pg_temp.value_as('authenticated', 'e0880000-0000-4000-8000-0000000000f1',
      format('select public.staff_set_review_name(%L::uuid, null)', b)) = 'saved', 'part6: the owner clears B''s name');
  v_line := pg_temp.value_as('anon', null,
    'select coalesce(reviewer_name, ''<null>'') from public.public_reviews where body = ''Nga autori B''');
  perform pg_temp.assert(v_line = '<null>', 'part6: a cleared name shows no name ("Një lexues i Librum"), never the pen name');
  perform pg_temp.assert(not exists (select 1 from public.public_reviews where reviewer_name = v_pen),
    'part6: no public review carries B''s pen name');

  -- S1: a lost chargeback removes the badge, in public and in the queue.
  insert into public.payment_disputes (stripe_dispute_id, stripe_payment_intent_id, status, reason, amount_cents)
  values ('dp_p088_b', 'pi_p088_b', 'lost', 'fraudulent', 19900);
  perform pg_temp.assert(pg_temp.value_as('anon', null,
      'select verified::text from public.public_reviews where body = ''Nga autori B''') = 'false',
    'part6: a lost chargeback removes the badge');
  update public.payment_disputes set status = 'won' where stripe_dispute_id = 'dp_p088_b';
  perform pg_temp.assert(pg_temp.value_as('anon', null,
      'select verified::text from public.public_reviews where body = ''Nga autori B''') = 'true',
    'part6: a won dispute keeps it');
  perform pg_temp.assert(pg_temp.submit(b, 5, 'Nga autori B, ndryshuar', 'Lexuesi B2') = 'pending', 'part6: B edits (back in the queue)');
  update public.payment_disputes set status = 'lost' where stripe_dispute_id = 'dp_p088_b';
  perform pg_temp.assert(pg_temp.value_as('authenticated', 'e0880000-0000-4000-8000-0000000000f1',
      format('select verified::text from public.staff_list_pending_reader_reviews() where reader_id = %L::uuid', b)) = 'false',
    'part6: the queue shows no badge after a lost chargeback');

  -- S3: the moderator reviews a book they bought and cannot decide it.
  perform pg_temp.assert(pg_temp.submit(m, 1, 'Nga moderatori', 'Lexuesi M') = 'pending', 'part6: a moderator may review as a reader');
  perform pg_temp.assert(pg_temp.approve(m, m) = 'own_review', 'part6: staff cannot approve their own review');
  perform pg_temp.assert(pg_temp.reject(m, m, 'abusive', null) = 'own_review', 'part6: staff cannot reject their own review');
  perform pg_temp.assert((select status from public.reviews where reader_id = m::uuid) = 'pending', 'part6: it is still pending');

  perform pg_temp.assert(pg_temp.approve('e0880000-0000-4000-8000-0000000000f1', m) = 'approved', 'part6: another staff member approves the moderator''s review');
  perform pg_temp.assert(pg_temp.value_as('anon', null,
      'select reviewer_is_author::text from public.public_reviews where body = ''Nga moderatori''') = 'false',
    'part6: a reader account is not tagged');

  -- Audit r3 F1: the tag is frozen at approval. Nothing that happens to
  -- the account later flips a published review, so there is no public
  -- moment to line up with a pen name.
  update public.profiles set role = 'author', public_author_name = 'P088 Pen M' where id = m::uuid;   -- the reader becomes an author
  perform pg_temp.assert(pg_temp.value_as('anon', null,
      'select reviewer_is_author::text from public.public_reviews where body = ''Nga moderatori''') = 'false',
    'part6: becoming an author does not tag an already-approved review');
  perform pg_temp.assert(pg_temp.approve('e0880000-0000-4000-8000-0000000000f1', b) = 'approved', 'part6: B''s edit approved');
  perform pg_temp.assert(pg_temp.value_as('anon', null,
      'select reviewer_is_author::text from public.public_reviews where body = ''Nga autori B, ndryshuar''') = 'true',
    'part6: an author account is tagged when approved');
  update public.books set status = 'draft' where id = 'e0880001-0000-4000-8000-0000000000b1';
  perform pg_temp.assert(pg_temp.value_as('anon', null,
      'select reviewer_is_author::text from public.public_reviews where body = ''Nga autori B, ndryshuar''') = 'true',
    'part6: unpublishing the author''s only book does not untag it');
  update public.profiles set role = 'reader' where id = b::uuid;
  perform pg_temp.assert(pg_temp.value_as('anon', null,
      'select reviewer_is_author::text from public.public_reviews where body = ''Nga autori B, ndryshuar''') = 'true',
    'part6: a later role change does not untag it either');
  -- A review approved after the change carries the new state.
  perform pg_temp.assert(pg_temp.submit(m, 2, 'Nga moderatori, ndryshuar', null) = 'pending', 'part6: M edits after becoming an author');
  perform pg_temp.assert(pg_temp.approve('e0880000-0000-4000-8000-0000000000f1', m) = 'approved', 'part6: approved again');
  perform pg_temp.assert(pg_temp.value_as('anon', null,
      'select reviewer_is_author::text from public.public_reviews where body = ''Nga moderatori, ndryshuar''') = 'true',
    'part6: a review approved after becoming an author is tagged');
end $$;

do $$
begin
  perform pg_temp.assert((select n from pg_temp.assertions_run) >= 70,
    format('expected at least 70 assertions, ran %s', (select n from pg_temp.assertions_run)));
end $$;

select 'ALL PASSED: 088_bd13_reader_reviews.test.sql (' || (select n from pg_temp.assertions_run) || ' assertions)' as result;

rollback;
