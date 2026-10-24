-- SECURITY-9A (pipeline item 9, part a; Renato's answers 2026-10-24,
-- all "a"): two database changes, nothing else.
--
--   1. handle_new_user(): every new account is a reader. The "role"
--      a sign-up sends in its user metadata is ignored from now on:
--      anyone can call Supabase Auth's signUp directly with the public
--      key, send role=author, and so skip the site's Terms and
--      "I'm 18 or older" ticks. The site's sign-up now switches a new
--      account to author on the server, after recording the Terms and
--      18+ ticks (src/app/(public)/auth/actions.ts), the same reader ->
--      author write "Become an author" uses (which now also asks for the
--      Terms tick, application only). Existing accounts are untouched:
--      the trigger only runs for new auth.users rows.
--
--   2. admin_lift_suspension(): signs the account out everywhere when
--      a suspension is lifted, in the same transaction and before the
--      site removes the ban: deletes its auth.refresh_tokens (by user)
--      and then its auth.sessions (which also ends refresh tokens kept
--      on the session row), so no device resumes after Lift. Suspending
--      deletes nothing (r2 audit F3, Renato "1. a"): while suspended the
--      ban makes Supabase Auth answer "user is banned" to every refresh
--      and Auth call, so the site's "This account is suspended" cut-off
--      shows for active and idle devices alike. admin_suspend_account()
--      is not changed by this migration. The lift audit row records
--      'sessions_deleted' and 'refresh_tokens_deleted'. Everything else
--      in the function is unchanged. Residual (accepted, answer 4a): an
--      access token already issued keeps working until it expires.
--
-- Both are CREATE OR REPLACE with the same signatures, so owners and
-- every grant stay as they are (handle_new_user: no EXECUTE for public,
-- anon, authenticated; admin_lift_suspension: EXECUTE for authenticated
-- only). The function's owner must be able to delete from
-- auth.refresh_tokens and auth.sessions (USAGE on schema auth, DELETE on
-- both tables, and row security not in the way); the staging plan
-- checks that, read-only, before this runs, and the applying role must
-- be that owner.
--
-- ROLLOUT ORDER. Either order is safe; nothing breaks for existing
-- accounts. The new application no longer sends a role to signUp and
-- always does the server-side switch itself, so it works on the
-- database before and after this migration. The OLD application on the
-- NEW database: an author sign-up in that gap ends as a reader (its 18+
-- date is still recorded) and can use "Become an author". Keep the gap
-- short (project flow: apply on staging, then merge). Production gets
-- it only at a release, through the authorized route.

create or replace function public.handle_new_user()
returns trigger as $$
declare
  v_display_name text;
begin
  -- SECURITY-9A: every new account is a reader. The role a sign-up
  -- sends in its metadata is ignored, because anyone can call Supabase
  -- Auth's signUp directly with the public key and send anything there.
  -- An author is made only on the server: the site's sign-up switches
  -- the new account to author after its "I'm 18 or older" tick is
  -- recorded, and "Become an author" does the same for an existing
  -- reader (both through src/lib/author-role-write-client.ts).
  v_display_name := coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1));

  insert into public.profiles (id, role, display_name, public_author_name)
  values (new.id, 'reader', v_display_name, null);
  return new;
end;
$$ language plpgsql security definer set search_path = '';

create or replace function public.admin_lift_suspension(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_suspension public.account_suspensions%rowtype;
  v_book_id uuid;
  v_bundle_id uuid;
  v_restored_books uuid[] := '{}';
  v_draft_books uuid[] := '{}';
  v_restored_bundles uuid[] := '{}';
  v_draft_bundles uuid[] := '{}';
  v_sessions_deleted integer;
  v_refresh_tokens_deleted integer;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'not authenticated';
  end if;

  if not public.staff_has_permission('people.manage') then
    raise exception 'not authorized';
  end if;

  -- The profile first, as admin_suspend_account locks it.
  perform 1 from public.profiles p where p.id = p_user_id for update;

  select * into v_suspension
    from public.account_suspensions s
   where s.user_id = p_user_id and s.lifted_at is null
     for update;

  if v_suspension.id is null then
    raise exception 'this account is not suspended';
  end if;

  update public.account_suspensions
     set lifted_at = pg_catalog.now(),
         lifted_by = v_actor_id
   where id = v_suspension.id;

  -- SECURITY-9A: sign the account out everywhere before it can sign in
  -- again (r2 audit F3, Renato "1. a"). While suspended nothing is
  -- deleted: the ban makes Supabase Auth answer "user is banned" to
  -- every refresh and Auth call, for active and idle devices alike, so
  -- the site's "This account is suspended" cut-off always shows. Here,
  -- in the same transaction as the lift and before the site removes the
  -- ban (src/app/admin/(protected)/people/[id]/actions.ts), every
  -- refresh token of the account goes (by user, so tokens without a
  -- session go too) and then every session (which also ends refresh
  -- tokens kept on the session row itself), so no device resumes after
  -- Lift; an old device finds itself signed out. An access token
  -- already issued stays valid until it expires (at most the JWT
  -- lifetime). auth.refresh_tokens.user_id is text in Supabase Auth.
  delete from auth.refresh_tokens rt where rt.user_id = p_user_id::text;
  get diagnostics v_refresh_tokens_deleted = row_count;
  delete from auth.sessions se where se.user_id = p_user_id;
  get diagnostics v_sessions_deleted = row_count;

  perform 1 from public.bundles bu where bu.author_id = p_user_id order by bu.id for update;
  perform 1 from public.books bo where bo.author_id = p_user_id order by bo.id for update;

  foreach v_book_id in array v_suspension.book_ids loop
    if exists (
         select 1 from public.books bo
          where bo.id = v_book_id
            and bo.author_id = p_user_id
            and bo.status = 'draft'
       )
       and not exists (
         select 1 from public.book_takedowns t
          where t.book_id = v_book_id and t.lifted_at is null
       )
    then
      begin
        update public.books set status = 'published' where id = v_book_id;
        v_restored_books := v_restored_books || v_book_id;
      exception when sqlstate 'LB462' then
        v_draft_books := v_draft_books || v_book_id;
      end;
    else
      v_draft_books := v_draft_books || v_book_id;
    end if;
  end loop;

  foreach v_bundle_id in array v_suspension.bundle_ids loop
    if exists (
         select 1 from public.bundles bu
          where bu.id = v_bundle_id
            and bu.author_id = p_user_id
            and bu.status = 'draft'
       )
       and exists (select 1 from public.bundle_books bb where bb.bundle_id = v_bundle_id)
       and not exists (
         select 1
           from public.bundle_books bb
           join public.books bo on bo.id = bb.book_id
          where bb.bundle_id = v_bundle_id
            and bo.status <> 'published'
       )
    then
      update public.bundles set status = 'published' where id = v_bundle_id;
      v_restored_bundles := v_restored_bundles || v_bundle_id;
    else
      v_draft_bundles := v_draft_bundles || v_bundle_id;
    end if;
  end loop;

  insert into public.admin_audit_log (actor_id, action, target_type, target_id, metadata)
  values (
    v_actor_id,
    'account.suspension_lifted',
    'profiles',
    p_user_id,
    pg_catalog.jsonb_build_object(
      'books_restored', pg_catalog.cardinality(v_restored_books),
      'books_kept_draft', pg_catalog.cardinality(v_draft_books),
      'bundles_restored', pg_catalog.cardinality(v_restored_bundles),
      'bundles_kept_draft', pg_catalog.cardinality(v_draft_bundles),
      'sessions_deleted', v_sessions_deleted,
      'refresh_tokens_deleted', v_refresh_tokens_deleted
    )
  );

  return pg_catalog.jsonb_build_object(
    'restored_book_ids', pg_catalog.to_jsonb(v_restored_books),
    'draft_book_ids', pg_catalog.to_jsonb(v_draft_books),
    'restored_bundle_ids', pg_catalog.to_jsonb(v_restored_bundles),
    'draft_bundle_ids', pg_catalog.to_jsonb(v_draft_bundles)
  );
end;
$$;
