import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { isRecoverySessionActive } from "@/lib/recovery-session";

// LAUNCH-1 P1-11: defense-in-depth guard for browser-oriented Server
// Actions that move money or grant entitlements (buyBook, buyBundle,
// admin refund issuance). Deliberately kept in its own file, separate
// from src/lib/recovery-session.ts -- that module is imported by Proxy
// (src/lib/supabase/middleware.ts), which cannot safely pull in
// next/navigation's redirect() (meaningless outside a Server render)
// or next/headers's cookies() (request-scoped, not available to
// Proxy's own request/response objects).
//
// Proxy is the PRIMARY boundary and already blocks the page each of
// these actions is normally invoked from before it ever renders (see
// shouldRedirectForRecovery in recovery-session.ts) -- this guard exists
// because Next.js's own docs (node_modules/next/dist/docs/01-app/
// 03-api-reference/03-file-conventions/proxy.md) explicitly warn that a
// Proxy matcher change or route refactor can silently stop covering a
// route, and recommend verifying authorization inside each Server
// Function rather than relying on Proxy alone. A crafted direct POST to
// one of these actions, bypassing the UI entirely, is exactly the
// scenario this second layer exists for.
//
// Centralizes the "read the cookie, decide, redirect" glue exactly
// once -- every guarded action calls this one function rather than
// re-reading cookies() itself, so the redirect destination and cookie
// name stay in exactly one place each (recovery-session.ts owns the
// cookie name/predicate; this function owns where an active recovery
// session gets redirected to from a blocked action).
export async function redirectIfRecoverySessionActive(): Promise<void> {
  const cookieStore = await cookies();
  if (isRecoverySessionActive(cookieStore)) {
    redirect("/reset-password");
  }
}
