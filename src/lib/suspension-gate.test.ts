import { describe, expect, it } from "vitest";
import { decideSuspension, isBannedNow, isUserBannedError, wantsStatusInsteadOfRedirect } from "./suspension-gate";

// PEOPLE-2: the per-request suspension decision Proxy makes.
const NOW = new Date("2026-10-23T09:00:00Z");

describe("isBannedNow", () => {
  it("is true only for a parseable time in the future", () => {
    expect(isBannedNow("2126-10-23T09:00:00Z", NOW)).toBe(true);
    expect(isBannedNow("2026-10-23T08:59:59Z", NOW)).toBe(false);
    expect(isBannedNow("2026-10-23T09:00:00Z", NOW)).toBe(false);
    expect(isBannedNow(null, NOW)).toBe(false);
    expect(isBannedNow(undefined, NOW)).toBe(false);
    expect(isBannedNow("", NOW)).toBe(false);
    expect(isBannedNow("not a date", NOW)).toBe(false);
  });
});

describe("isUserBannedError", () => {
  it("matches Supabase's user_banned refusal by code, or by its message as a fallback", () => {
    expect(isUserBannedError({ code: "user_banned", message: "User is banned", status: 403 })).toBe(true);
    expect(isUserBannedError({ message: "User is banned" })).toBe(true);
    expect(isUserBannedError({ code: "bad_jwt", message: "invalid JWT" })).toBe(false);
    expect(isUserBannedError({ name: "AuthSessionMissingError", message: "Auth session missing!" })).toBe(false);
    expect(isUserBannedError(null)).toBe(false);
    expect(isUserBannedError("user_banned")).toBe(false);
  });
});

describe("decideSuspension", () => {
  const ok = (data: unknown) => ({ data, error: null });

  it("a ban in the future is enough, whatever the RPC says", () => {
    for (const rpc of [ok(false), ok(true), { data: null, error: { code: "XX000" } }]) {
      expect(decideSuspension({ bannedUntil: "2126-10-23T09:00:00Z", rpc, now: NOW })).toBe("suspended");
    }
  });

  it("the suspension row is enough when the ban step failed", () => {
    expect(decideSuspension({ bannedUntil: null, rpc: ok(true), now: NOW })).toBe("suspended");
  });

  it("allows only on an explicit false", () => {
    expect(decideSuspension({ bannedUntil: null, rpc: ok(false), now: NOW })).toBe("allow");
    expect(decideSuspension({ bannedUntil: "2026-01-01T00:00:00Z", rpc: ok(false), now: NOW })).toBe("allow");
  });

  it("fails closed on an RPC error or a non-boolean answer", () => {
    expect(decideSuspension({ bannedUntil: null, rpc: { data: false, error: { code: "PGRST000" } }, now: NOW })).toBe(
      "check_failed",
    );
    for (const data of [null, undefined, "true", 1, {}, []]) {
      expect(decideSuspension({ bannedUntil: null, rpc: ok(data), now: NOW })).toBe("check_failed");
    }
  });
});

describe("wantsStatusInsteadOfRedirect", () => {
  const request = (method: string, pathname: string, headers: Record<string, string> = {}) => ({
    method,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    nextUrl: { pathname },
  });

  it("a page GET or HEAD gets the redirect", () => {
    expect(wantsStatusInsteadOfRedirect(request("GET", "/dashboard"))).toBe(false);
    expect(wantsStatusInsteadOfRedirect(request("HEAD", "/"))).toBe(false);
    expect(wantsStatusInsteadOfRedirect(request("GET", "/apiary"))).toBe(false);
  });

  it("server actions, /api and other methods get a status", () => {
    expect(wantsStatusInsteadOfRedirect(request("POST", "/dashboard", { "next-action": "abc" }))).toBe(true);
    expect(wantsStatusInsteadOfRedirect(request("GET", "/dashboard", { "next-action": "abc" }))).toBe(true);
    expect(wantsStatusInsteadOfRedirect(request("GET", "/api"))).toBe(true);
    expect(wantsStatusInsteadOfRedirect(request("GET", "/api/downloads/x"))).toBe(true);
    expect(wantsStatusInsteadOfRedirect(request("POST", "/login"))).toBe(true);
    expect(wantsStatusInsteadOfRedirect(request("DELETE", "/x"))).toBe(true);
  });
});
