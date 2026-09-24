-- AVATAR-STORAGE-PATH-AUTH-1 (Patch 9): authenticated can no longer
-- write public.profiles.avatar_path directly.
--
-- ROLLOUT ORDER -- BINDING. Apply this migration ONLY AFTER the Patch 9
-- application is merged and READY on the target environment. The
-- application deployed before Patch 9 saves a new profile photo with ONE
-- session-client UPDATE that names display_name, bio, avatar_path (and
-- public_author_name for an author). Once this migration is applied that
-- whole statement fails with a permission error -- and the old code does
-- not check the error, so the photo, the name and the bio are all
-- silently not saved while the page reports success. The Patch 9
-- application writes avatar_path only through the server-only
-- service-role client and names only display_name, bio and
-- public_author_name through the session, so it works against the ACL
-- both before and after this migration. Deploying the application first
-- leaves no broken window.
--
-- WHY. Migration 033/045 granted authenticated UPDATE on avatar_path
-- because updateProfile wrote it through the session. RLS on profiles
-- checks only `auth.uid() = id`, and nothing checks what the stored path
-- points at. A signed-in user could therefore PATCH their own row,
-- straight through the Data API, with avatar_path naming ANOTHER user's
-- object in the avatars bucket. deleteAccount later reads that value and
-- removes it through the service-role client, which Storage RLS does not
-- constrain -- so deleting the attacker's own account would delete the
-- victim's avatar. Row ownership does not protect a storage reference.
--
-- WHAT CHANGES, and nothing else: the profiles ACL of PUBLIC, anon and
-- authenticated is rewritten from a reset, exactly as migrations 033,
-- 045 and 046 left it except that avatar_path is no longer in
-- authenticated's UPDATE column list:
--   * anon: nothing (unchanged since migration 046);
--   * authenticated: SELECT (RLS still limits it to the caller's own row
--     or a staff-permitted read), and UPDATE on display_name, bio and
--     public_author_name only;
--   * PUBLIC: nothing.
-- updateProfile now writes avatar_path, with a path the server derives
-- from the authenticated user id and the verified image type, through
-- the trusted server-only writer after authentication, validation and a
-- successful Storage upload.
--
-- UNCHANGED: every privilege of service_role and of the table owner; RLS
-- stays enabled with every policy unchanged; the public_author_profiles
-- view and its grants; every constraint, trigger, default and existing
-- row; every Storage bucket, policy and object. This migration issues no
-- DML and rewrites no path: rows created before it keep exactly the
-- avatar_path they have.
--
-- The declarative equivalent is in supabase/schema.sql;
-- 068_avatar_storage_path_authorization_catalog_equivalence.sh proves the
-- two build paths produce the same catalog, and
-- 068_avatar_storage_path_authorization.test.sql proves the behaviour.

revoke all on public.profiles from public, anon, authenticated;
grant select on public.profiles to authenticated;

grant update (display_name, bio, public_author_name)
  on public.profiles
  to authenticated;
