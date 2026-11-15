-- Download count + feedback: submit_reader_feedback() in plain ASCII
-- (staging run of 2026-11-15).
--
-- WHY. Applying 20261115200000_download_count_feedback.sql on staging
-- through the database tool turned the six backslash-u escapes in the
-- body trim (no-break and zero-width spaces) into the characters
-- themselves. The function behaved the same, but its stored bytes no
-- longer matched the file. This replaces it with the same logic, the
-- characters built with chr(), so the text sent is plain ASCII and
-- arrives unchanged. 20261115200000 now carries the same body, so a
-- database that gets both (Production) ends identical to staging.
--
-- CHANGES ONLY public.submit_reader_feedback(text, text, text): same
-- signature, result, checks, error codes, limits and grants. No table,
-- row or other function changes. Safe to run more than once.
--
-- Rollback: none needed on its own (the previous body was equivalent);
-- 100_download_count_feedback.rollback.sql drops the function with the
-- rest of the feature.

create or replace function public.submit_reader_feedback(p_kind text, p_body text, p_page_path text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_edge text;
  v_body text;
  v_recent integer;
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  if exists (
    select 1 from public.account_suspensions s
     where s.user_id = v_uid and s.lifted_at is null
  ) then
    raise exception 'submit_reader_feedback: account suspended' using errcode = 'LB510';
  end if;
  if p_kind is null or p_kind not in ('problem', 'idea') then
    raise exception 'submit_reader_feedback: invalid kind' using errcode = 'LB511';
  end if;
  -- Trim spaces, line breaks, no-break and zero-width spaces at both
  -- ends, so a message of only invisible characters is empty. The
  -- characters are built with chr() (U+00A0, U+200B, U+200C, U+200D,
  -- U+2060, U+FEFF) so this text stays plain ASCII: on the staging run
  -- of 15 Nov the tool call turned backslash-u escapes into the
  -- characters themselves, which changed the stored function bytes.
  v_edge := '[[:space:]' || pg_catalog.chr(160) || pg_catalog.chr(8203) || pg_catalog.chr(8204)
            || pg_catalog.chr(8205) || pg_catalog.chr(8288) || pg_catalog.chr(65279) || ']+';
  v_body := pg_catalog.regexp_replace(coalesce(p_body, ''), '^' || v_edge || '|' || v_edge || '$', '', 'g');
  if pg_catalog.char_length(v_body) < 1 or pg_catalog.char_length(v_body) > 1000 then
    raise exception 'submit_reader_feedback: invalid text' using errcode = 'LB512';
  end if;
  if p_page_path is null
     or pg_catalog.char_length(p_page_path) not between 1 and 300
     or p_page_path not like '/%'
     or p_page_path like '//%'
     or p_page_path ~ '[\\[:cntrl:]]' then
    raise exception 'submit_reader_feedback: invalid page' using errcode = 'LB513';
  end if;

  -- One lock per sender, so two quick sends cannot both slip under the limit.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('reader_feedback'),
    pg_catalog.hashtext(v_uid::text)
  );
  select pg_catalog.count(*) into v_recent
    from public.reader_feedback f
   where f.reader_id = v_uid
     and f.created_at > pg_catalog.now() - interval '1 hour';
  if v_recent >= 10 then
    raise exception 'submit_reader_feedback: too many messages' using errcode = 'LB514';
  end if;

  insert into public.reader_feedback (reader_id, kind, body, page_path)
  values (v_uid, p_kind, v_body, p_page_path)
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.submit_reader_feedback(text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.submit_reader_feedback(text, text, text) to authenticated;
