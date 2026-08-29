import { describe, expect, it, vi } from "vitest";
import {
  isValidStaffRole,
  normalizeEmail,
  mapStaffRpcError,
  GENERIC_STAFF_ERROR_MESSAGE,
  STAFF_RPC_NOT_AUTHENTICATED_MESSAGE,
  STAFF_ROLES,
  STAFF_ROLE_LABELS,
  STAFF_ROLE_OPTIONS,
  canManageStaffRow,
  getAddStaffConfirmationMessage,
  getRoleChangeConfirmationMessage,
  getRemoveStaffConfirmationMessage,
  formatStaffAddedDate,
  isRoleChangeSubmittable,
  handleConfirmGatedSubmit,
} from "./staff-management-logic";
import type { StaffRole } from "@/lib/types";

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

// ============================================================
// ADMIN-1B PART C: pure UI-support helpers for /admin/staff.
// ============================================================

describe("STAFF_ROLE_OPTIONS", () => {
  it("lists all five roles, in the design brief's own dropdown order", () => {
    expect(STAFF_ROLE_OPTIONS.map((o) => o.value)).toEqual([
      "owner",
      "admin",
      "moderator",
      "support",
      "editor",
    ]);
  });

  it("every option's label matches STAFF_ROLE_LABELS", () => {
    for (const option of STAFF_ROLE_OPTIONS) {
      expect(option.label).toBe(STAFF_ROLE_LABELS[option.value]);
    }
  });

  it("uses human labels, not raw role identifiers", () => {
    expect(STAFF_ROLE_LABELS.owner).toBe("Owner");
    expect(STAFF_ROLE_LABELS.admin).toBe("Admin");
    expect(STAFF_ROLE_LABELS.moderator).toBe("Moderator");
    expect(STAFF_ROLE_LABELS.support).toBe("Support");
    expect(STAFF_ROLE_LABELS.editor).toBe("Editor");
  });
});

describe("canManageStaffRow", () => {
  it("true when the viewer can manage and the row is not their own", () => {
    expect(canManageStaffRow("target-1", "viewer-1", true)).toBe(true);
  });

  it("false for the viewer's own row, even when they can manage", () => {
    expect(canManageStaffRow("viewer-1", "viewer-1", true)).toBe(false);
  });

  it("false when the viewer cannot manage at all, regardless of whose row it is", () => {
    expect(canManageStaffRow("target-1", "viewer-1", false)).toBe(false);
    expect(canManageStaffRow("viewer-1", "viewer-1", false)).toBe(false);
  });
});

describe("getAddStaffConfirmationMessage", () => {
  it("returns null for every role except owner -- no confirmation needed", () => {
    const nonOwnerRoles: StaffRole[] = ["admin", "moderator", "support", "editor"];
    for (const role of nonOwnerRoles) {
      expect(getAddStaffConfirmationMessage(role)).toBeNull();
    }
  });

  it("returns the strong owner-grant confirmation for role === 'owner'", () => {
    const message = getAddStaffConfirmationMessage("owner");
    expect(message).toContain("Grant Owner access");
    expect(message).toContain("full administrative authority");
    expect(message).toContain("staff management");
  });
});

describe("getRoleChangeConfirmationMessage", () => {
  it("plain, factual copy for an ordinary role change", () => {
    expect(getRoleChangeConfirmationMessage("Alice", "support", "moderator")).toBe(
      "Change Alice's role from Support to Moderator?",
    );
  });

  it("the strong owner-grant confirmation when promoting to owner", () => {
    const message = getRoleChangeConfirmationMessage("Alice", "admin", "owner");
    expect(message).toContain("Grant Owner access to Alice?");
    expect(message).toContain("full administrative authority");
  });

  it("the dedicated demote-owner confirmation when demoting an existing owner -- PART C CORRECTION: distinct from both the plain template and the promote-to-owner copy", () => {
    const message = getRoleChangeConfirmationMessage("Alice", "owner", "admin");
    expect(message).toContain("Remove Owner access from Alice?");
    expect(message).toContain("They will lose staff-management authority.");
    expect(message).toContain("Librum must retain at least one Owner.");
    expect(message).not.toBe("Change Alice's role from Owner to Admin?");
    expect(message).not.toContain("full administrative authority");
  });

  it("demote-owner copy never claims the operation is safe and never surfaces an owner count", () => {
    const message = getRoleChangeConfirmationMessage("Alice", "owner", "support");
    expect(message.toLowerCase()).not.toContain("safe");
    expect(message).not.toMatch(/\d+ owner/i);
  });

  it("demotion applies regardless of which non-owner role is the target", () => {
    for (const newRole of ["admin", "moderator", "support", "editor"] as const) {
      const message = getRoleChangeConfirmationMessage("Alice", "owner", newRole);
      expect(message).toContain("Remove Owner access from Alice?");
    }
  });
});

describe("isRoleChangeSubmittable", () => {
  it("false when the selected role matches the current role -- Save stays disabled", () => {
    expect(isRoleChangeSubmittable("support", "support")).toBe(false);
    expect(isRoleChangeSubmittable("owner", "owner")).toBe(false);
  });

  it("true when the selected role differs from the current role -- Save becomes enabled", () => {
    expect(isRoleChangeSubmittable("admin", "support")).toBe(true);
    expect(isRoleChangeSubmittable("owner", "admin")).toBe(true);
  });
});

describe("handleConfirmGatedSubmit", () => {
  // Extracted from the three submit buttons' onClick handlers so these
  // interactions are provable without a DOM (this codebase's vitest runs
  // with `environment: "node"` -- no jsdom/RTL, see vitest.config.mts).
  // `confirm` and `event` are the same shapes window.confirm/a real click
  // event provide, just faked here.
  function fakeEvent() {
    return { preventDefault: vi.fn() };
  }

  describe("ADD STAFF", () => {
    it("adding as owner calls the confirmation with the owner-grant message", () => {
      const confirmMessage = getAddStaffConfirmationMessage("owner");
      const confirm = vi.fn(() => true);
      const event = fakeEvent();

      handleConfirmGatedSubmit(confirmMessage, confirm, event);

      expect(confirm).toHaveBeenCalledWith(confirmMessage);
    });

    it("if confirmation returns false, submission does not proceed", () => {
      const confirmMessage = getAddStaffConfirmationMessage("owner");
      const event = fakeEvent();

      handleConfirmGatedSubmit(confirmMessage, () => false, event);

      expect(event.preventDefault).toHaveBeenCalled();
    });

    it("if confirmation returns true, submission proceeds", () => {
      const confirmMessage = getAddStaffConfirmationMessage("owner");
      const event = fakeEvent();

      handleConfirmGatedSubmit(confirmMessage, () => true, event);

      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it("non-owner add does not use the owner-specific confirmation unnecessarily -- confirm is never even called", () => {
      const confirmMessage = getAddStaffConfirmationMessage("support");
      const confirm = vi.fn(() => false);
      const event = fakeEvent();

      handleConfirmGatedSubmit(confirmMessage, confirm, event);

      expect(confirmMessage).toBeNull();
      expect(confirm).not.toHaveBeenCalled();
      expect(event.preventDefault).not.toHaveBeenCalled();
    });
  });

  describe("ROLE CHANGE", () => {
    it("promotion to owner requires the strong confirmation, and cancelling prevents submission", () => {
      const confirmMessage = getRoleChangeConfirmationMessage("Alice", "admin", "owner");
      const event = fakeEvent();

      handleConfirmGatedSubmit(confirmMessage, () => false, event);

      expect(confirmMessage).toContain("Grant Owner access to Alice?");
      expect(event.preventDefault).toHaveBeenCalled();
    });

    it("ordinary role change requires its standard confirmation, and confirming permits submission", () => {
      const confirmMessage = getRoleChangeConfirmationMessage("Alice", "support", "moderator");
      const confirm = vi.fn(() => true);
      const event = fakeEvent();

      handleConfirmGatedSubmit(confirmMessage, confirm, event);

      expect(confirm).toHaveBeenCalledWith(confirmMessage);
      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it("owner demotion uses the dedicated stronger confirmation, and cancelling prevents submission", () => {
      const confirmMessage = getRoleChangeConfirmationMessage("Alice", "owner", "admin");
      const event = fakeEvent();

      handleConfirmGatedSubmit(confirmMessage, () => false, event);

      expect(confirmMessage).toContain("Remove Owner access from Alice?");
      expect(event.preventDefault).toHaveBeenCalled();
    });
  });

  describe("REMOVE", () => {
    it("remove requires confirmation", () => {
      const confirmMessage = getRemoveStaffConfirmationMessage("Alice");
      const confirm = vi.fn(() => true);
      const event = fakeEvent();

      handleConfirmGatedSubmit(confirmMessage, confirm, event);

      expect(confirm).toHaveBeenCalledWith(confirmMessage);
    });

    it("cancelling prevents submission", () => {
      const confirmMessage = getRemoveStaffConfirmationMessage("Alice");
      const event = fakeEvent();

      handleConfirmGatedSubmit(confirmMessage, () => false, event);

      expect(event.preventDefault).toHaveBeenCalled();
    });

    it("confirming permits submission", () => {
      const confirmMessage = getRemoveStaffConfirmationMessage("Alice");
      const event = fakeEvent();

      handleConfirmGatedSubmit(confirmMessage, () => true, event);

      expect(event.preventDefault).not.toHaveBeenCalled();
    });
  });
});

// ============================================================
// PART C CORRECTION: pending-state behavior (useFormStatus -- "Adding…"/
// "Saving…"/"Removing…" and disabled while pending) is NOT covered here.
// It is not a pure-logic decision like the ones above; it is React-DOM's
// own useFormStatus hook reacting to a real <form> submission lifecycle,
// which requires an actual DOM (jsdom) and a real render pass to
// observe. This project's vitest config (vitest.config.mts) runs with
// `environment: "node"` and includes only "src/**/*.test.ts" -- no
// jsdom, no @testing-library/react, no react-dom/test-utils act(). Any
// test claiming to prove pending-state behavior without one of those
// would just be asserting against a hardcoded ternary
// (`pending ? "Adding…" : "..."`) and calling that "coverage" without
// ever exercising useFormStatus itself -- exactly the fabricated
// coverage this correction pass was told not to produce. Adding jsdom +
// RTL solely to cover three buttons' pending copy would also be the
// disproportionate new testing stack this pass was told to avoid. Left
// unautomated; reported as a known, deliberate limitation.
// ============================================================

describe("getRemoveStaffConfirmationMessage", () => {
  it("names the person and states the consequence, never mentions account deletion", () => {
    const message = getRemoveStaffConfirmationMessage("Alice");
    expect(message).toContain("Remove Alice from Librum staff?");
    expect(message).toContain("They will immediately lose access to staff-only areas.");
    expect(message.toLowerCase()).not.toContain("delete");
    expect(message.toLowerCase()).not.toContain("account");
  });
});

describe("formatStaffAddedDate", () => {
  it("formats an ISO timestamp as a short, readable date", () => {
    const formatted = formatStaffAddedDate("2026-03-15T10:00:00.000Z");
    expect(formatted).toContain("2026");
    expect(formatted).not.toContain("T10:00");
  });
});
