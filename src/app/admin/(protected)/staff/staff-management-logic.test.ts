import { describe, expect, it } from "vitest";
import {
  isValidStaffRole,
  normalizeEmail,
  mapStaffRpcError,
  GENERIC_STAFF_ERROR_MESSAGE,
  STAFF_RPC_NOT_AUTHENTICATED_MESSAGE,
  STAFF_ROLES,
} from "./staff-management-logic";

describe("isValidStaffRole", () => {
  it("accepts every one of the five canonical roles", () => {
    for (const role of STAFF_ROLES) {
      expect(isValidStaffRole(role)).toBe(true);
    }
  });

  it("rejects a forged role", () => {
    expect(isValidStaffRole("superadmin")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isValidStaffRole("")).toBe(false);
  });

  it("is case-sensitive -- 'Owner' is not 'owner'", () => {
    expect(isValidStaffRole("Owner")).toBe(false);
  });
});

describe("normalizeEmail", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeEmail("  owner@example.test  ")).toBe("owner@example.test");
  });

  it("lowercases", () => {
    expect(normalizeEmail("Owner@Example.Test")).toBe("owner@example.test");
  });

  it("trims and lowercases together", () => {
    expect(normalizeEmail("  Owner@Example.Test  ")).toBe("owner@example.test");
  });

  it("returns null for an empty string", () => {
    expect(normalizeEmail("")).toBeNull();
  });

  it("returns null for a whitespace-only string", () => {
    expect(normalizeEmail("   ")).toBeNull();
  });
});

describe("mapStaffRpcError", () => {
  it("maps every known RPC error message to stable, non-leaking copy", () => {
    expect(mapStaffRpcError({ message: "not authorized" })).toBe(
      "You don't have permission to manage staff.",
    );
    expect(mapStaffRpcError({ message: "invalid role" })).toBe("That's not a valid staff role.");
    expect(mapStaffRpcError({ message: "invalid email" })).toBe("Enter an email address.");
    expect(
      mapStaffRpcError({ message: "no verified Librum account was found for that email" }),
    ).toBe("No verified Librum account was found for that email.");
    expect(mapStaffRpcError({ message: "already staff" })).toBe("That account is already staff.");
    expect(mapStaffRpcError({ message: "staff member not found" })).toBe(
      "This staff member no longer exists.",
    );
    expect(mapStaffRpcError({ message: "cannot change your own role" })).toBe(
      "You can't change your own role.",
    );
    expect(mapStaffRpcError({ message: "cannot remove yourself" })).toBe(
      "You can't remove yourself from staff.",
    );
    expect(mapStaffRpcError({ message: "at least one owner is required" })).toBe(
      "Librum must always have at least one owner.",
    );
  });

  it("falls back to the generic message for an unrecognized error", () => {
    expect(mapStaffRpcError({ message: 'relation "public.staff_members" does not exist' })).toBe(
      GENERIC_STAFF_ERROR_MESSAGE,
    );
  });

  it("never leaks the raw unrecognized message text", () => {
    const mapped = mapStaffRpcError({ message: "duplicate key value violates unique constraint" });
    expect(mapped).not.toContain("duplicate key");
    expect(mapped).not.toContain("constraint");
  });

  it("falls back to the generic message for a null/undefined/empty error", () => {
    expect(mapStaffRpcError(null)).toBe(GENERIC_STAFF_ERROR_MESSAGE);
    expect(mapStaffRpcError(undefined)).toBe(GENERIC_STAFF_ERROR_MESSAGE);
    expect(mapStaffRpcError({ message: "" })).toBe(GENERIC_STAFF_ERROR_MESSAGE);
    expect(mapStaffRpcError({ message: "   " })).toBe(GENERIC_STAFF_ERROR_MESSAGE);
  });

  it("does not map the 'not authenticated' message -- callers handle that case separately", () => {
    // mapStaffRpcError is only ever called AFTER a caller has already
    // special-cased STAFF_RPC_NOT_AUTHENTICATED_MESSAGE (same convention
    // as report-review-logic.ts's own REVIEW_RPC_NOT_AUTHENTICATED_MESSAGE)
    // -- confirming here that this constant is exactly the string the
    // RPCs raise, so that special-casing actually matches.
    expect(STAFF_RPC_NOT_AUTHENTICATED_MESSAGE).toBe("not authenticated");
  });
});
