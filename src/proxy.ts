import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";
import { siteLockResponse } from "@/lib/site-lock";

export async function proxy(request: NextRequest) {
  // UNDER CONSTRUCTION: first, so a locked visitor never reaches the
  // session refresh (no Supabase call for them). Off unless SITE_LOCK_KEY
  // is set -- see src/lib/site-lock.ts.
  const locked = siteLockResponse(request);
  if (locked) return locked;
  return updateSession(request);
}

// UNDER CONSTRUCTION r2 (audit F1): skip Proxy only for real static
// files -- Next's own build output, the image optimizer, and the files
// actually in public/, each by exact path. The old "any path ending in
// .png/.svg/..." rule let /books/x.png reach pages and Server Actions
// without the lock. A new file in public/ must be added here (and to
// PUBLIC_FILES in proxy.test.ts, which fails until it is); until then it
// answers like any page, locked while the lock is on.
export const config = {
  matcher: [
    "/((?!_next/static/|_next/image$|favicon\\.ico$|images/author-hero\\.jpg$|(?:file|globe|next|vercel|window)\\.svg$).*)",
  ],
};
