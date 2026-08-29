-- Committed SQL regression suite for migration 041 (ADMIN-1B Part B:
-- staff-management RPCs, admin_audit_log, hard last-owner trigger).
--
-- Reuses supabase/tests/00_stub_supabase_platform.sql -- no new test
-- infrastructure needed, same as every other suite in this directory.
-- That stub file was extended for this suite specifically (added
-- auth.users.email_confirmed_at, nullable, no default -- see its own
-- comment) -- every OTHER existing test file's auth.users fixtures
-- predate that column and never reference it, so they are unaffected.
--
-- Run manually against a disposable/local Postgres instance, AFTER
-- applying supabase/schema.sql, from the repo root:
--
--   createdb librum_test
--   psql -d librum_test -f supabase/tests/00_stub_supabase_platform.sql
--   psql -d librum_test -f supabase/schema.sql
--   psql -d librum_test -v ON_ERROR_STOP=1 -f supabase/tests/041_staff_management.test.sql
--
-- (schema.sql already includes migration 041's final state -- this
-- suite doesn't separately apply 041_staff_management.sql on top of an
-- older schema.sql.)
--
-- This file was written and reviewed as part of ADMIN-1B Part B's
-- implementation but has NOT been executed in this environment -- no
-- local/CI Postgres was available (same limitation the ADMIN-1B Part A
-- audit and every prior migration's own test file already documents).
-- It is a reviewed contract, not a confirmed-passing result.
--
-- ============================================================
-- CONCURRENCY LIMITATION (required reading before trusting the
-- last-owner protection in production): everything in this file runs
-- inside ONE Postgres connection, in ONE transaction, strictly
-- sequentially (set_config()/set local role simulate different callers
-- one after another, never simultaneously). This harness CANNOT
-- construct two genuinely concurrent transactions racing against each
-- other, so nothing below proves the pg_advisory_xact_lock in
-- staff_members_protect_last_owner() actually serializes concurrent
-- owner-reducing transactions -- it only proves the trigger's LOGIC is
-- correct when there is no real race to resolve. Do not read a passing
-- run of this file as proof the concurrency guarantee holds. The
-- manual, two-connection verification procedure that actually exercises
-- the race is documented in supabase/migrations/041_staff_management.sql's
-- own tail comment ("MANUAL CONCURRENCY VERIFICATION") -- run that
-- procedure by hand, once, before this migration is trusted anywhere
-- real. Advisory-lock correctness is otherwise relied upon via
-- PostgreSQL's own documented guarantees for pg_advisory_xact_lock
-- (transaction-scoped, mutually exclusive per key), the same trust
-- basis this codebase already extends to the identical primitive in
-- migrations 026, 032, and 035 -- none of which have a concurrent test
-- either.
-- ============================================================

begin;

create function pg_temp.assert(condition boolean, message text) returns void
  language plpgsql as $$
begin
  if not condition or condition is null then
    raise exception 'FAIL: %', message;
  end if;
end;
$$;

-- ============================================================
-- Part 1: PERMISSIONS -- list_staff_members() and the mutation RPCs
-- (represented here by change_staff_role(), since authorization is
-- checked before any target lookup, so this exercises the same
-- staff_has_permission('staff.manage') gate every mutation RPC shares).
-- ============================================================
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('e0000000-0000-0000-0000-000000000001', 'p041-owner@test', now(), '{"role":"reader","display_name":"Owner"}'),
  ('e0000000-0000-0000-0000-000000000002', 'p041-admin@test', now(), '{"role":"reader","display_name":"Admin"}'),
  ('e0000000-0000-0000-0000-000000000003', 'p041-moderator@test', now(), '{"role":"reader","display_name":"Moderator"}'),
  ('e0000000-0000-0000-0000-000000000004', 'p041-support@test', now(), '{"role":"reader","display_name":"Support"}'),
  ('e0000000-0000-0000-0000-000000000005', 'p041-editor@test', now(), '{"role":"reader","display_name":"Editor"}'),
  ('e0000000-0000-0000-0000-000000000006', 'p041-support2@test', now(), '{"role":"reader","display_name":"Support Two"}');

insert into public.staff_members (user_id, role) values
  ('e0000000-0000-0000-0000-000000000001', 'owner'),
  ('e0000000-0000-0000-0000-000000000002', 'admin'),
  ('e0000000-0000-0000-0000-000000000003', 'moderator'),
  ('e0000000-0000-0000-0000-000000000004', 'support'),
  ('e0000000-0000-0000-0000-000000000005', 'editor'),
  ('e0000000-0000-0000-0000-000000000006', 'support');

do $$
begin
  -- list_staff_members(): owner and admin (both staff.view) succeed.
  perform set_config('request.jwt.claim.sub', 'e0000000-0000-0000-0000-000000000001', true);
  set local role authenticated;
  perform pg_temp.assert(
    (select count(*) from public.list_staff_members()) = 6,
    'part1: owner (staff.view) must be able to call list_staff_members() and see every row'
  );
  reset role;

  perform set_config('request.jwt.claim.sub', 'e0000000-0000-0000-0000-000000000002', true);
  set local role authenticated;
  perform pg_temp.assert(
    (select count(*) from public.list_staff_members()) = 6,
    'part1: admin (staff.view) must be able to call list_staff_members()'
  );
  reset role;

  -- moderator/support/editor (no staff.view) are rejected.
  perform set_config('request.jwt.claim.sub', 'e0000000-0000-0000-0000-000000000003', true);
  set local role authenticated;
  begin
    perform public.list_staff_members();
    perform pg_temp.assert(false, 'part1: moderator (no staff.view) must not be able to call list_staff_members()');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'not authorized', format('part1: unexpected message: %s', sqlerrm));
  end;
  reset role;

  perform set_config('request.jwt.claim.sub', 'e0000000-0000-0000-0000-000000000004', true);
  set local role authenticated;
  begin
    perform public.list_staff_members();
    perform pg_temp.assert(false, 'part1: support (no staff.view) must not be able to call list_staff_members()');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'not authorized', format('part1: unexpected message: %s', sqlerrm));
  end;
  reset role;

  perform set_config('request.jwt.claim.sub', 'e0000000-0000-0000-0000-000000000005', true);
  set local role authenticated;
  begin
    perform public.list_staff_members();
    perform pg_temp.assert(false, 'part1: editor (no staff.view) must not be able to call list_staff_members()');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'not authorized', format('part1: unexpected message: %s', sqlerrm));
  end;
  reset role;

  -- Mutation gate (staff.manage): owner succeeds; admin/moderator/
  -- support/editor are all rejected, even admin -- staff.manage is
  -- owner-only in the current, unmodified matrix.
  perform set_config('request.jwt.claim.sub', 'e0000000-0000-0000-0000-000000000001', true);
  set local role authenticated;
  perform public.change_staff_role('e0000000-0000-0000-0000-000000000006', 'moderator');
  reset role;
  perform pg_temp.assert(
    (select role from public.staff_members where user_id = 'e0000000-0000-0000-0000-000000000006') = 'moderator',
    'part1: owner (staff.manage) must be able to mutate staff_members via change_staff_role'
  );

  perform set_config('request.jwt.claim.sub', 'e0000000-0000-0000-0000-000000000002', true);
  set local role authenticated;
  begin
    perform public.change_staff_role('e0000000-0000-0000-0000-000000000006', 'support');
    perform pg_temp.assert(false, 'part1: admin (no staff.manage) must not be able to mutate staff_members');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'not authorized', format('part1: unexpected message: %s', sqlerrm));
  end;
  reset role;

  perform set_config('request.jwt.claim.sub', 'e0000000-0000-0000-0000-000000000003', true);
  set local role authenticated;
  begin
    perform public.change_staff_role('e0000000-0000-0000-0000-000000000006', 'support');
    perform pg_temp.assert(false, 'part1: moderator (no staff.manage) must not be able to mutate staff_members');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'not authorized', format('part1: unexpected message: %s', sqlerrm));
  end;
  reset role;

  perform set_config('request.jwt.claim.sub', 'e0000000-0000-0000-0000-000000000004', true);
  set local role authenticated;
  begin
    perform public.change_staff_role('e0000000-0000-0000-0000-000000000006', 'support');
    perform pg_temp.assert(false, 'part1: support (no staff.manage) must not be able to mutate staff_members');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'not authorized', format('part1: unexpected message: %s', sqlerrm));
  end;
  reset role;

  perform set_config('request.jwt.claim.sub', 'e0000000-0000-0000-0000-000000000005', true);
  set local role authenticated;
  begin
    perform public.change_staff_role('e0000000-0000-0000-0000-000000000006', 'support');
    perform pg_temp.assert(false, 'part1: editor (no staff.manage) must not be able to mutate staff_members');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'not authorized', format('part1: unexpected message: %s', sqlerrm));
  end;
  reset role;
end $$;

delete from public.admin_audit_log where target_id like 'e0000000-%';
delete from public.staff_members where user_id like 'e0000000-%';
delete from public.profiles where id like 'e0000000-%';
delete from auth.users where id like 'e0000000-%';

-- ============================================================
-- Part 2: ADD (add_staff_member_by_email)
-- ============================================================
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('f0000000-0000-0000-0000-000000000001', 'p041-owner2@test', now(), '{"role":"reader","display_name":"Owner"}'),
  ('f0000000-0000-0000-0000-000000000002', 'verified@example.test', now(), '{"role":"reader","display_name":"Verified"}'),
  ('f0000000-0000-0000-0000-000000000003', 'unverified@example.test', null, '{"role":"reader","display_name":"Unverified"}'),
  ('f0000000-0000-0000-0000-000000000004', 'owner-role-target@example.test', now(), '{"role":"reader","display_name":"OwnerTarget"}'),
  ('f0000000-0000-0000-0000-000000000005', 'admin-role-target@example.test', now(), '{"role":"reader","display_name":"AdminTarget"}'),
  ('f0000000-0000-0000-0000-000000000006', 'editor-role-target@example.test', now(), '{"role":"reader","display_name":"EditorTarget"}'),
  ('f0000000-0000-0000-0000-000000000007', 'moderator-role-target@example.test', now(), '{"role":"reader","display_name":"ModeratorTarget"}'),
  ('f0000000-0000-0000-0000-000000000008', 'support-role-target@example.test', now(), '{"role":"reader","display_name":"SupportTarget"}');

insert into public.staff_members (user_id, role) values
  ('f0000000-0000-0000-0000-000000000001', 'owner');

do $$
declare
  v_audit_count integer;
begin
  perform set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-000000000001', true);
  set local role authenticated;

  -- 1. A verified existing account, submitted with surrounding
  -- whitespace and mixed case, can be added -- proves normalization
  -- (trim + lowercase) works in the same call as the success path.
  perform public.add_staff_member_by_email('  Verified@Example.test  ', 'support');
  perform pg_temp.assert(
    (select role from public.staff_members where user_id = 'f0000000-0000-0000-0000-000000000002') = 'support',
    'part2: a verified existing account must be added with the requested role'
  );
  perform pg_temp.assert(
    (select created_by from public.staff_members where user_id = 'f0000000-0000-0000-0000-000000000002')
      = 'f0000000-0000-0000-0000-000000000001',
    'part2: created_by must be the actor'
  );

  select count(*) into v_audit_count
  from public.admin_audit_log
  where action = 'staff.added' and target_id = 'f0000000-0000-0000-0000-000000000002';
  perform pg_temp.assert(v_audit_count = 1, 'part2: a successful add must create exactly one staff.added audit row');

  -- 2. Nonexistent email rejected.
  begin
    perform public.add_staff_member_by_email('nobody-here@example.test', 'support');
    perform pg_temp.assert(false, 'part2: a nonexistent email must be rejected');
  exception when others then
    perform pg_temp.assert(
      sqlerrm = 'no verified Librum account was found for that email',
      format('part2: unexpected message for nonexistent email: %s', sqlerrm)
    );
  end;

  -- 3. Unverified email rejected with the exact same message (no
  -- enumeration signal distinguishing "doesn't exist" from "exists but
  -- unconfirmed").
  begin
    perform public.add_staff_member_by_email('unverified@example.test', 'support');
    perform pg_temp.assert(false, 'part2: an unverified email must be rejected');
  exception when others then
    perform pg_temp.assert(
      sqlerrm = 'no verified Librum account was found for that email',
      format('part2: unexpected message for unverified email: %s', sqlerrm)
    );
  end;

  -- 5. Empty (post-normalization) email rejected, with its own distinct
  -- message -- this is a client-input problem, not an account-lookup
  -- problem, so it is not folded into the anti-enumeration message.
  begin
    perform public.add_staff_member_by_email('   ', 'support');
    perform pg_temp.assert(false, 'part2: an empty/whitespace-only email must be rejected');
  exception when others then
    perform pg_temp.assert(
      sqlerrm = 'invalid email',
      format('part2: unexpected message for empty email: %s', sqlerrm)
    );
  end;

  -- 6. Duplicate staff rejected -- the account added in step 1 is
  -- already staff.
  begin
    perform public.add_staff_member_by_email('verified@example.test', 'moderator');
    perform pg_temp.assert(false, 'part2: adding an already-staff account again must be rejected');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'already staff', format('part2: unexpected message: %s', sqlerrm));
  end;

  -- 7. All five canonical roles accepted where otherwise valid.
  perform public.add_staff_member_by_email('owner-role-target@example.test', 'owner');
  perform public.add_staff_member_by_email('admin-role-target@example.test', 'admin');
  perform public.add_staff_member_by_email('editor-role-target@example.test', 'editor');
  perform public.add_staff_member_by_email('moderator-role-target@example.test', 'moderator');
  perform public.add_staff_member_by_email('support-role-target@example.test', 'support');
  perform pg_temp.assert(
    (select role from public.staff_members where user_id = 'f0000000-0000-0000-0000-000000000004') = 'owner',
    'part2: owner role must be accepted'
  );
  perform pg_temp.assert(
    (select role from public.staff_members where user_id = 'f0000000-0000-0000-0000-000000000005') = 'admin',
    'part2: admin role must be accepted'
  );
  perform pg_temp.assert(
    (select role from public.staff_members where user_id = 'f0000000-0000-0000-0000-000000000006') = 'editor',
    'part2: editor role must be accepted'
  );
  perform pg_temp.assert(
    (select role from public.staff_members where user_id = 'f0000000-0000-0000-0000-000000000007') = 'moderator',
    'part2: moderator role must be accepted'
  );
  perform pg_temp.assert(
    (select role from public.staff_members where user_id = 'f0000000-0000-0000-0000-000000000008') = 'support',
    'part2: support role must be accepted'
  );

  -- 8. Forged role rejected.
  begin
    perform public.add_staff_member_by_email('nobody-here@example.test', 'superadmin');
    perform pg_temp.assert(false, 'part2: a forged role must be rejected');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'invalid role', format('part2: unexpected message: %s', sqlerrm));
  end;

  reset role;

  -- 11. Every failed attempt above (2, 3, 5, 6, 8) must have created no
  -- audit event at all.
  select count(*) into v_audit_count
  from public.admin_audit_log
  where action = 'staff.added'
    and target_id not in (
      'f0000000-0000-0000-0000-000000000002', 'f0000000-0000-0000-0000-000000000004',
      'f0000000-0000-0000-0000-000000000005', 'f0000000-0000-0000-0000-000000000006',
      'f0000000-0000-0000-0000-000000000007', 'f0000000-0000-0000-0000-000000000008'
    );
  perform pg_temp.assert(v_audit_count = 0, 'part2: a failed add must never create an audit event');
end $$;

delete from public.admin_audit_log where target_id like 'f0000000-%';
delete from public.staff_members where user_id like 'f0000000-%';
delete from public.profiles where id like 'f0000000-%';
delete from auth.users where id like 'f0000000-%';

-- ============================================================
-- Part 3: ROLE CHANGE (change_staff_role)
-- ============================================================
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('g0000000-0000-0000-0000-000000000001', 'p041-owner3@test', now(), '{"role":"reader","display_name":"Owner"}'),
  ('g0000000-0000-0000-0000-000000000002', 'p041-target3@test', now(), '{"role":"reader","display_name":"Target"}');

insert into public.staff_members (user_id, role) values
  ('g0000000-0000-0000-0000-000000000001', 'owner'),
  ('g0000000-0000-0000-0000-000000000002', 'support');

-- Backdated deliberately: now() is TRANSACTION-scoped in Postgres (the
-- same instant for every call within this whole file's one enclosing
-- transaction), so comparing against a freshly-inserted default now()
-- would trivially "pass" even if the RPC never touched updated_at at
-- all. Backdating this fixture to a provably earlier instant is what
-- makes the "real change bumps updated_at" assertion below actually
-- meaningful.
update public.staff_members
set updated_at = now() - interval '1 day'
where user_id = 'g0000000-0000-0000-0000-000000000002';

do $$
declare
  v_updated_at_before timestamptz;
  v_updated_at_after timestamptz;
  v_audit_count integer;
begin
  perform set_config('request.jwt.claim.sub', 'g0000000-0000-0000-0000-000000000001', true);
  set local role authenticated;

  -- Real change: support -> moderator.
  select updated_at into v_updated_at_before
  from public.staff_members where user_id = 'g0000000-0000-0000-0000-000000000002';

  perform public.change_staff_role('g0000000-0000-0000-0000-000000000002', 'moderator');

  select updated_at into v_updated_at_after
  from public.staff_members where user_id = 'g0000000-0000-0000-0000-000000000002';

  perform pg_temp.assert(
    (select role from public.staff_members where user_id = 'g0000000-0000-0000-0000-000000000002') = 'moderator',
    'part3: a real role change must apply the new role'
  );
  perform pg_temp.assert(
    v_updated_at_after > v_updated_at_before,
    'part3: a real role change must bump updated_at to a later value (the fixture was backdated by 1 day)'
  );

  select count(*) into v_audit_count
  from public.admin_audit_log
  where action = 'staff.role_changed' and target_id = 'g0000000-0000-0000-0000-000000000002';
  perform pg_temp.assert(v_audit_count = 1, 'part3: a real role change must create exactly one staff.role_changed audit row');
  perform pg_temp.assert(
    (select metadata from public.admin_audit_log
       where action = 'staff.role_changed' and target_id = 'g0000000-0000-0000-0000-000000000002')
      = jsonb_build_object('old_role', 'support', 'new_role', 'moderator'),
    'part3: audit metadata must record old_role and new_role'
  );

  -- Same-role change: moderator -> moderator. Idempotent no-op: no
  -- exception, no new audit row, updated_at unchanged.
  select updated_at into v_updated_at_before
  from public.staff_members where user_id = 'g0000000-0000-0000-0000-000000000002';

  perform public.change_staff_role('g0000000-0000-0000-0000-000000000002', 'moderator');

  select updated_at into v_updated_at_after
  from public.staff_members where user_id = 'g0000000-0000-0000-0000-000000000002';

  perform pg_temp.assert(
    v_updated_at_after = v_updated_at_before,
    'part3: a same-role no-op must NOT change updated_at'
  );

  select count(*) into v_audit_count
  from public.admin_audit_log
  where action = 'staff.role_changed' and target_id = 'g0000000-0000-0000-0000-000000000002';
  perform pg_temp.assert(v_audit_count = 1, 'part3: a same-role no-op must NOT create a second audit row');

  -- Self role change rejected.
  begin
    perform public.change_staff_role('g0000000-0000-0000-0000-000000000001', 'admin');
    perform pg_temp.assert(false, 'part3: an actor changing their own role must be rejected');
  exception when others then
    perform pg_temp.assert(
      sqlerrm = 'cannot change your own role',
      format('part3: unexpected message: %s', sqlerrm)
    );
  end;

  -- Forged role rejected.
  begin
    perform public.change_staff_role('g0000000-0000-0000-0000-000000000002', 'superadmin');
    perform pg_temp.assert(false, 'part3: a forged role must be rejected');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'invalid role', format('part3: unexpected message: %s', sqlerrm));
  end;

  reset role;
end $$;

delete from public.admin_audit_log where target_id like 'g0000000-%';
delete from public.staff_members where user_id like 'g0000000-%';
delete from public.profiles where id like 'g0000000-%';
delete from auth.users where id like 'g0000000-%';

-- ============================================================
-- Part 4: REMOVE (remove_staff_member)
-- ============================================================
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('h0000000-0000-0000-0000-000000000001', 'p041-owner4@test', now(), '{"role":"reader","display_name":"Owner"}'),
  ('h0000000-0000-0000-0000-000000000002', 'p041-target4@test', now(), '{"role":"reader","display_name":"Target"}');

insert into public.staff_members (user_id, role) values
  ('h0000000-0000-0000-0000-000000000001', 'owner'),
  ('h0000000-0000-0000-0000-000000000002', 'moderator');

do $$
declare
  v_audit_count integer;
begin
  perform set_config('request.jwt.claim.sub', 'h0000000-0000-0000-0000-000000000001', true);
  set local role authenticated;

  -- Nonexistent target rejected first (before the real removal below
  -- changes what "exists" means for this fixture set).
  begin
    perform public.remove_staff_member('00000000-0000-0000-0000-000000000000');
    perform pg_temp.assert(false, 'part4: removing a nonexistent staff target must be rejected');
  exception when others then
    perform pg_temp.assert(
      sqlerrm = 'staff member not found',
      format('part4: unexpected message: %s', sqlerrm)
    );
  end;

  -- Self-removal rejected.
  begin
    perform public.remove_staff_member('h0000000-0000-0000-0000-000000000001');
    perform pg_temp.assert(false, 'part4: an actor removing themselves must be rejected');
  exception when others then
    perform pg_temp.assert(sqlerrm = 'cannot remove yourself', format('part4: unexpected message: %s', sqlerrm));
  end;

  -- Ordinary staff removable.
  perform public.remove_staff_member('h0000000-0000-0000-0000-000000000002');
  perform pg_temp.assert(
    not exists (select 1 from public.staff_members where user_id = 'h0000000-0000-0000-0000-000000000002'),
    'part4: a successful removal must delete the staff_members row'
  );

  select count(*) into v_audit_count
  from public.admin_audit_log
  where action = 'staff.removed' and target_id = 'h0000000-0000-0000-0000-000000000002';
  perform pg_temp.assert(v_audit_count = 1, 'part4: a successful removal must create exactly one staff.removed audit row');
  perform pg_temp.assert(
    (select metadata from public.admin_audit_log
       where action = 'staff.removed' and target_id = 'h0000000-0000-0000-0000-000000000002')
      = jsonb_build_object('role', 'moderator'),
    'part4: audit metadata must record the removed role'
  );

  -- Removing the same target again must now fail as "not found" --
  -- removal does not silently no-op like same-role change does.
  begin
    perform public.remove_staff_member('h0000000-0000-0000-0000-000000000002');
    perform pg_temp.assert(false, 'part4: removing an already-removed target must be rejected, not silently succeed');
  exception when others then
    perform pg_temp.assert(
      sqlerrm = 'staff member not found',
      format('part4: unexpected message: %s', sqlerrm)
    );
  end;

  reset role;

  -- Target profile and auth account both survive removal.
  perform pg_temp.assert(
    exists (select 1 from public.profiles where id = 'h0000000-0000-0000-0000-000000000002'),
    'part4: removing staff must not delete the target''s profiles row'
  );
  perform pg_temp.assert(
    exists (select 1 from auth.users where id = 'h0000000-0000-0000-0000-000000000002'),
    'part4: removing staff must not delete the target''s auth.users row'
  );
end $$;

delete from public.admin_audit_log where target_id like 'h0000000-%';
delete from public.staff_members where user_id like 'h0000000-%';
delete from public.profiles where id like 'h0000000-%';
delete from auth.users where id like 'h0000000-%';

-- ============================================================
-- Part 5: LAST OWNER -- the hard trigger, exercised directly via
-- privileged SQL (bypassing the RPC layer and its own self-action
-- rule entirely -- see this file's own header note on why "sole Owner
-- cannot be demoted/removed through the RPC" specifically is not
-- separately constructible below: with staff.manage held only by
-- 'owner' in the current matrix, and self-targeting unconditionally
-- rejected by every mutation RPC (Part 3/4 above), there is no
-- reachable call where a DIFFERENT actor with staff.manage exists to
-- target a SOLE owner through the RPC layer -- the only staff.manage
-- holder in that scenario always IS the sole owner, and self-action
-- rejection fires first. The trigger's protection against every OTHER
-- real path (privileged direct SQL, and by extension any future
-- service-role write or matrix change) is what this Part actually
-- proves, directly and unconditionally.
-- ============================================================
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('i0000000-0000-0000-0000-000000000001', 'p041-soleowner@test', now(), '{"role":"reader","display_name":"Sole Owner"}');

insert into public.staff_members (user_id, role) values
  ('i0000000-0000-0000-0000-000000000001', 'owner');

do $$
begin
  -- Direct privileged UPDATE of the sole owner -> non-owner: rejected.
  begin
    update public.staff_members set role = 'admin' where user_id = 'i0000000-0000-0000-0000-000000000001';
    perform pg_temp.assert(false, 'part5: a direct UPDATE demoting the sole owner must be rejected by the trigger');
  exception when others then
    perform pg_temp.assert(
      sqlerrm = 'at least one owner is required',
      format('part5: unexpected message: %s', sqlerrm)
    );
  end;
  perform pg_temp.assert(
    (select role from public.staff_members where user_id = 'i0000000-0000-0000-0000-000000000001') = 'owner',
    'part5: the sole owner''s role must be unchanged after the rejected UPDATE'
  );

  -- Direct privileged DELETE of the sole owner: rejected.
  begin
    delete from public.staff_members where user_id = 'i0000000-0000-0000-0000-000000000001';
    perform pg_temp.assert(false, 'part5: a direct DELETE of the sole owner must be rejected by the trigger');
  exception when others then
    perform pg_temp.assert(
      sqlerrm = 'at least one owner is required',
      format('part5: unexpected message: %s', sqlerrm)
    );
  end;
  perform pg_temp.assert(
    exists (select 1 from public.staff_members where user_id = 'i0000000-0000-0000-0000-000000000001'),
    'part5: the sole owner''s row must still exist after the rejected DELETE'
  );

  -- FK-cascade path: deleting the sole owner's auth.users row cascades
  -- auth.users -> profiles -> staff_members. The trigger fires exactly
  -- as if the DELETE had targeted staff_members directly, and its
  -- exception aborts the WHOLE cascading operation -- proving the
  -- account itself cannot be deleted out from under the sole owner
  -- either, not just the staff_members row in isolation.
  begin
    delete from auth.users where id = 'i0000000-0000-0000-0000-000000000001';
    perform pg_temp.assert(false, 'part5: deleting the sole owner''s auth account must be rejected via the cascade path');
  exception when others then
    perform pg_temp.assert(
      sqlerrm = 'at least one owner is required',
      format('part5: unexpected message via cascade: %s', sqlerrm)
    );
  end;
  perform pg_temp.assert(
    exists (select 1 from auth.users where id = 'i0000000-0000-0000-0000-000000000001'),
    'part5: the sole owner''s auth.users row must survive the rejected cascade'
  );
  perform pg_temp.assert(
    exists (select 1 from public.profiles where id = 'i0000000-0000-0000-0000-000000000001'),
    'part5: the sole owner''s profiles row must survive the rejected cascade'
  );
  perform pg_temp.assert(
    exists (select 1 from public.staff_members where user_id = 'i0000000-0000-0000-0000-000000000001'),
    'part5: the sole owner''s staff_members row must survive the rejected cascade'
  );
end $$;

-- With two owners, one may legitimately cease being owner (via the RPC
-- layer this time, proving the trigger does NOT over-block a safe
-- transition).
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('i0000000-0000-0000-0000-000000000002', 'p041-secondowner@test', now(), '{"role":"reader","display_name":"Second Owner"}');

insert into public.staff_members (user_id, role) values
  ('i0000000-0000-0000-0000-000000000002', 'owner');

do $$
begin
  perform pg_temp.assert(
    (select count(*) from public.staff_members where role = 'owner') = 2,
    'part5: fixture setup must have exactly two owners before this sub-test'
  );

  perform set_config('request.jwt.claim.sub', 'i0000000-0000-0000-0000-000000000001', true);
  set local role authenticated;
  perform public.remove_staff_member('i0000000-0000-0000-0000-000000000002');
  reset role;

  perform pg_temp.assert(
    not exists (select 1 from public.staff_members where user_id = 'i0000000-0000-0000-0000-000000000002'),
    'part5: removing one of two owners must succeed'
  );
  perform pg_temp.assert(
    (select count(*) from public.staff_members where role = 'owner') = 1,
    'part5: exactly one owner must remain after a legitimate two-owner reduction -- never zero'
  );
end $$;

delete from public.admin_audit_log where target_id like 'i0000000-%';
delete from public.staff_members where user_id like 'i0000000-%';
delete from public.profiles where id like 'i0000000-%';
delete from auth.users where id like 'i0000000-%';

-- ============================================================
-- Part 6: AUDIT SECURITY -- admin_audit_log must be completely
-- inaccessible to anon/authenticated, at the grant level (RLS is also
-- enabled, but with zero policies and zero grants, the grant check
-- alone already proves the point -- both layers checked for the same
-- doubly-enforced reason staff_members' own tests check both).
-- ============================================================
do $$
begin
  perform pg_temp.assert(
    not has_table_privilege('authenticated', 'public.admin_audit_log', 'SELECT'),
    'part6: authenticated must NOT have SELECT on admin_audit_log'
  );
  perform pg_temp.assert(
    not has_table_privilege('authenticated', 'public.admin_audit_log', 'INSERT'),
    'part6: authenticated must NOT have INSERT on admin_audit_log'
  );
  perform pg_temp.assert(
    not has_table_privilege('authenticated', 'public.admin_audit_log', 'UPDATE'),
    'part6: authenticated must NOT have UPDATE on admin_audit_log'
  );
  perform pg_temp.assert(
    not has_table_privilege('authenticated', 'public.admin_audit_log', 'DELETE'),
    'part6: authenticated must NOT have DELETE on admin_audit_log'
  );
  perform pg_temp.assert(
    not has_table_privilege('anon', 'public.admin_audit_log', 'SELECT'),
    'part6: anon must have zero privileges on admin_audit_log'
  );
end $$;

-- Behavioral confirmation: a raw SELECT as authenticated is actually
-- rejected at execution time, not merely absent from has_table_privilege.
do $$
begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000000', true);
  set local role authenticated;
  begin
    perform count(*) from public.admin_audit_log;
    perform pg_temp.assert(false, 'part6: a raw authenticated SELECT on admin_audit_log must be rejected');
  exception when insufficient_privilege then
    null; -- expected
  end;
  reset role;
end $$;

-- ============================================================
-- Part 7: DIRECT staff_members MUTATION -- re-verified here (not just
-- trusting migration 040's own suite) specifically to catch migration
-- 041 accidentally introducing a new grant or policy.
-- ============================================================
do $$
begin
  perform pg_temp.assert(
    not has_table_privilege('authenticated', 'public.staff_members', 'INSERT'),
    'part7: authenticated must still NOT have INSERT on staff_members after migration 041'
  );
  perform pg_temp.assert(
    not has_table_privilege('authenticated', 'public.staff_members', 'UPDATE'),
    'part7: authenticated must still NOT have UPDATE on staff_members after migration 041'
  );
  perform pg_temp.assert(
    not has_table_privilege('authenticated', 'public.staff_members', 'DELETE'),
    'part7: authenticated must still NOT have DELETE on staff_members after migration 041'
  );
  perform pg_temp.assert(
    (select count(*) from pg_policy where polrelid = 'public.staff_members'::regclass and polcmd in ('a', 'w', 'd')) = 0,
    'part7: staff_members must still have zero insert/update/delete policies after migration 041'
  );
end $$;

-- ============================================================
-- Part 8: FUNCTION SECURITY -- SECURITY DEFINER / empty search_path /
-- EXECUTE ACL, for every function this migration adds.
-- ============================================================
do $$
declare
  fn record;
  fname text;
  fargs text;
  fq_signature text;
begin
  for fn in
    select f.name, f.args
    from (values
      ('staff_members_protect_last_owner', ''),
      ('list_staff_members', ''),
      ('add_staff_member_by_email', 'text, text'),
      ('change_staff_role', 'uuid, text'),
      ('remove_staff_member', 'uuid')
    ) as f(name, args)
  loop
    fname := fn.name;
    fargs := fn.args;

    perform pg_temp.assert(
      exists (
        select 1 from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = fname
      ),
      format('part8: function %s must exist', fname)
    );

    perform pg_temp.assert(
      (
        select p.prosecdef from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = fname
      ) = true,
      format('part8: %s must be SECURITY DEFINER', fname)
    );

    perform pg_temp.assert(
      exists (
        select 1 from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace,
        unnest(coalesce(p.proconfig, '{}'::text[])) c
        where n.nspname = 'public' and p.proname = fname and c = 'search_path='
      ),
      format('part8: %s must SET search_path = '''' (empty)', fname)
    );

    fq_signature := 'public.' || fname || '(' || fargs || ')';

    perform pg_temp.assert(
      not exists (
        select 1 from information_schema.role_routine_grants
        where routine_schema = 'public' and routine_name = fname and grantee = 'PUBLIC'
      ),
      format('part8: PUBLIC must have zero explicit EXECUTE grant on %s', fname)
    );

    if fname = 'staff_members_protect_last_owner' then
      -- Trigger function: no EXECUTE grant to anyone, including
      -- authenticated -- it is never meant to be called directly.
      perform pg_temp.assert(
        not has_function_privilege('authenticated', fq_signature, 'EXECUTE'),
        format('part8: authenticated must NOT have EXECUTE on trigger function %s', fname)
      );
    else
      perform pg_temp.assert(
        has_function_privilege('authenticated', fq_signature, 'EXECUTE'),
        format('part8: authenticated must have EXECUTE on %s', fname)
      );
    end if;

    perform pg_temp.assert(
      not has_function_privilege('anon', fq_signature, 'EXECUTE'),
      format('part8: anon must NOT have EXECUTE on %s', fname)
    );
  end loop;
end $$;

select 'ALL PASSED: 041_staff_management.test.sql' as result;

rollback;
