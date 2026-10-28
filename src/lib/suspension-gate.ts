// PEOPLE-2: the per-request suspension decision Proxy makes for every
// signed-in request (src/lib/supabase/middleware.ts). Pure, so every
// branch is unit tested here; the middleware only does the plumbing.
//
// Like recovery-session.ts, this imports nothing from next/navigation or
// next/headers: it is part of Proxy's module graph.
//
// Three signals, any one is enough:
//   * getUser() refused with user_banned -- current Supabase Auth
//     (v2.195+) rejects a banned user's access token on every
//     authenticated endpoint, so this is the normal path once the
//     Suspend action's ban step succeeded (isUserBannedError);
//   * the auth user's banned_until in the future (older Supabase Auth,
//     which still returned a banned user from /user); and
//   * my_account_is_suspended() -- the account_suspensions row is the
//     source of truth, so this still works when the ban step failed.
// If the RPC errors for a signed-in user, we cannot tell, so we fail
// CLOSED for that user (503, session kept, nothing signed out).
// Anonymous requests never reach this.

export const SUSPENDED_LOGIN_PATH = "/login?suspended=1";
export const SUSPENDED_MESSAGE = "Kjo llogari është pezulluar. Shkruani te support@librum.al.";
export const SUSPENSION_CHECK_FAILED_MESSAGE = "Diçka shkoi keq. Provoni përsëri.";

export type SuspensionDecision = "allow" | "suspended" | "check_failed";

export function isBannedNow(bannedUntil: string | null | undefined, now: Date = new Date()): boolean {
  if (!bannedUntil) return false;
  const until = Date.parse(bannedUntil);
  if (Number.isNaN(until)) return false;
  return until > now.getTime();
}

// The error getUser() returns for a banned user's token: 403 with code
// user_banned (supabase/auth requireAuthentication). The message is a
// fallback in case a response ever arrives without the code.
export function isUserBannedError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return code === "user_banned" || message === "User is banned";
}

export function decideSuspension(input: {
  bannedUntil: string | null | undefined;
  rpc: { data: unknown; error: unknown };
  now?: Date;
}): SuspensionDecision {
  if (isBannedNow(input.bannedUntil, input.now)) return "suspended";
  if (input.rpc.error) return "check_failed";
  if (input.rpc.data === true) return "suspended";
  if (input.rpc.data === false) return "allow";
  // Anything else (null, a string, an object) is not an answer.
  return "check_failed";
}

// A request that cannot follow a page redirect: a Server Action (Next
// sends the Next-Action header), a Route Handler under /api, or any
// non-GET/HEAD request. These get a plain status code instead.
export function wantsStatusInsteadOfRedirect(request: {
  method: string;
  headers: { get(name: string): string | null };
  nextUrl: { pathname: string };
}): boolean {
  if (request.headers.get("next-action")) return true;
  if (request.nextUrl.pathname === "/api" || request.nextUrl.pathname.startsWith("/api/")) return true;
  return request.method !== "GET" && request.method !== "HEAD";
}
