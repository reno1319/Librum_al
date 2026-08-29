import { resolveSafeInternalPath } from "@/lib/safe-redirect";

// ADMIN-1A.5 FINAL PRE-COMMIT ADMIN LAYOUT CORRECTION: the single
// source of truth for the staff login route's own path, used by every
// place that needs to either redirect TO it (src/lib/staff.ts,
// src/app/admin/login/actions.ts) or recognize that it IS the current
// route in order to bypass the requireStaff()/AdminShell gate
// (src/app/admin/layout.tsx). Before this constant existed, those were
// three independent literal "/admin/login" strings that had to be kept
// in sync by hand -- a real, if narrow, risk of a redirect loop if any
// one of them ever drifted (e.g. requireStaff() redirecting to a typo'd
// path admin/layout.tsx's own bypass check no longer recognizes, which
// would redirect right back into requireStaff() again). One constant
// makes that class of bug structurally impossible rather than merely
// unlikely.
export const ADMIN_LOGIN_PATH = "/admin/login";

// ADMIN-1A.5: narrower than resolveSafeInternalPath -- only accepts
// destinations under /admin itself. Reuses that function's own
// same-origin URL-parsing/rejection logic entirely (protocol-relative
// "//evil.com", backslash-host "/\\evil.com", full external URLs,
// javascript:/data: schemes are all already rejected there -- see that
// file's own comment for why only real URL-origin comparison, never a
// substring check, is a sound boundary) -- this adds exactly one further
// restriction on top: the resolved internal path must be exactly
// "/admin" or start with "/admin/", so a crafted next=/dashboard,
// next=/books/123, or next=/auth/callback can never be used to send the
// staff login flow somewhere this boundary was never designed to send
// it, even though each of those IS a legitimate same-site destination
// for OTHER parts of this app (see resolveSafeInternalPath's own tests).
export function resolveSafeAdminPath(candidate: string | null | undefined): string | null {
  const safe = resolveSafeInternalPath(candidate);
  if (!safe) return null;
  return safe === "/admin" || safe.startsWith("/admin/") ? safe : null;
}
