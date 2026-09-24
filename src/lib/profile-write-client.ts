import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

// AVATAR-STORAGE-PATH-AUTH-1: the ONE way a Server Action obtains
// authority to write public.profiles.avatar_path, which `authenticated`
// may no longer update directly (migration
// 20260924160846_avatar_storage_path_authorization).
//
// There is exactly one caller, updateProfile
// (src/app/(public)/dashboard/profile/actions.ts), and it follows these
// rules, each pinned by
// src/app/(public)/dashboard/profile/avatar-storage-path-authorization.test.ts:
//
//   1. Authenticate with the session client, validate the input and the
//      image bytes, and upload the object to Storage through the session
//      BEFORE calling this. A request that is going to be refused never
//      creates privileged authority.
//   2. The only column written is avatar_path, and its value is
//      canonicalAvatarPath(<authenticated user id>, <verified extension>)
//      (src/lib/avatar-path.ts). Nothing in it comes from the client.
//   3. The UPDATE is filtered by `id = <the authenticated user's id>`.
//      This client bypasses RLS, so that filter is the ownership boundary.
//   4. The UPDATE returns `.select("id, avatar_path")` and must prove that
//      exactly one row changed and that it is the caller's row holding the
//      derived path. An error, zero rows, several rows or any mismatch
//      fails closed.
//   5. display_name, bio and public_author_name stay on the
//      least-privileged session client.
//
// `server-only` makes any import of this module from a client component
// a build error, so the key can never reach browser code through it.
export function createProfileWriteClient() {
  return createAdminClient();
}
