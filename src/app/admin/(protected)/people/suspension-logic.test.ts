import { describe, expect, it } from "vitest";
import {
  accessFixNeeded,
  mapLiftRpcError,
  mapSuspendRpcError,
  readUserId,
  trimReason,
  validateSuspendForm,
} from "./suspension-logic";

// PEOPLE-2: the Suspend form rules (the database's), the RPC error
// mapping, and when the sign-in step needs "Try again".
const ANA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOW = new Date("2026-10-23T09:00:00Z");

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

describe("trimReason", () => {
  it("trims exactly space, tab, CR and LF, as btrim(E' \\t\\r\\n') does", () => {
    expect(trimReason(" \t\r\nSpam\n\t ")).toBe("Spam");
    expect(trimReason(" Spam ")).toBe(" Spam ");
    expect(trimReason("a  b")).toBe("a  b");
  });
});

describe("validateSuspendForm", () => {
  it("accepts a trimmed reason of 1 to 2000 code points", () => {
    expect(validateSuspendForm(form({ userId: ANA, reason: "  x " }))).toEqual({ ok: true, userId: ANA, reason: "x" });
    expect(validateSuspendForm(form({ userId: ANA, reason: "a".repeat(2000) })).ok).toBe(true);
    // 2000 emoji are 4000 UTF-16 units but 2000 characters to Postgres.
    expect(validateSuspendForm(form({ userId: ANA, reason: "📚".repeat(2000) })).ok).toBe(true);
  });

  it("refuses an empty or too long reason, and a bad id", () => {
    expect(validateSuspendForm(form({ userId: ANA, reason: " \n " }))).toEqual({
      ok: false,
      error: "Write the reason for the suspension.",
    });
    expect(validateSuspendForm(form({ userId: ANA }))).toMatchObject({ ok: false });
    expect(validateSuspendForm(form({ userId: ANA, reason: "a".repeat(2001) }))).toEqual({
      ok: false,
      error: "Keep the reason under 2000 characters.",
    });
    expect(validateSuspendForm(form({ userId: "nope", reason: "Spam" }))).toEqual({
      ok: false,
      error: "Couldn't suspend the account. Nothing was changed. Try again.",
    });
  });
});

describe("readUserId", () => {
  it("returns only a uuid", () => {
    expect(readUserId(form({ userId: ANA }))).toBe(ANA);
    expect(readUserId(form({ userId: "x" }))).toBeNull();
    expect(readUserId(form({}))).toBeNull();
  });
});

describe("the RPC error maps", () => {
  it("map known refusals and hide everything else", () => {
    expect(mapSuspendRpcError({ message: "staff cannot be suspended" })).toBe(
      "Staff can't be suspended. Remove them from Staff first.",
    );
    expect(mapSuspendRpcError({ message: "invalid reason" })).toBe("Write the reason for the suspension.");
    expect(mapSuspendRpcError({ code: "40P01", message: "deadlock detected" })).toBe("Please try again.");
    expect(mapSuspendRpcError({ message: "relation does not exist" })).toBe(
      "Couldn't suspend the account. Nothing was changed. Try again.",
    );
    expect(mapSuspendRpcError(null)).toBe("Couldn't suspend the account. Nothing was changed. Try again.");
    expect(mapLiftRpcError({ message: "this account is not suspended" })).toBe(
      "This account isn't suspended. Reload to see what changed.",
    );
    expect(mapLiftRpcError({ message: "not authorized" })).toBe("You don't have permission to lift suspensions.");
    expect(mapLiftRpcError({ message: "anything else" })).toBe(
      "Couldn't lift the suspension. Nothing was changed. Try again.",
    );
  });
});

describe("accessFixNeeded", () => {
  const FUTURE = "2126-10-23T09:00:00Z";
  it("follows the suspension row", () => {
    expect(accessFixNeeded({ activeSuspension: true, bannedUntil: null, now: NOW })).toBe("ban");
    expect(accessFixNeeded({ activeSuspension: true, bannedUntil: "2026-01-01T00:00:00Z", now: NOW })).toBe("ban");
    expect(accessFixNeeded({ activeSuspension: false, bannedUntil: FUTURE, now: NOW })).toBe("unban");
    expect(accessFixNeeded({ activeSuspension: true, bannedUntil: FUTURE, now: NOW })).toBeNull();
    expect(accessFixNeeded({ activeSuspension: false, bannedUntil: undefined, now: NOW })).toBeNull();
  });
});
