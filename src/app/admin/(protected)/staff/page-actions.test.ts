import { describe, expect, it, vi, beforeEach } from "vitest";

// LIBRUM 2.0 ADMIN-1B PART C: boundary tests for the redirect-driving
// wrapper actions, mirroring src/app/admin/(protected)/reports/actions.test.ts's
// own mocking convention exactly. Part B's committed primitives
// (addStaffMemberByEmail/changeStaffRole/removeStaffMember) are mocked
// directly here -- their own internal RPC-call/error-mapping behavior
// is already covered by src/app/admin/(protected)/staff/actions.test.ts
// and the SQL suite; this file only proves the FormData-parsing and
// redirect/revalidate wiring this pass adds on top of them.
class RedirectSignal extends Error {
  constructor(public target: string) {
    super(`REDIRECT:${target}`);
  }
}
const mockRedirect = vi.fn((url: string) => {
  throw new RedirectSignal(url);
});
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));

const mockRevalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));

const mockAddStaffMemberByEmail = vi.fn();
const mockChangeStaffRole = vi.fn();
const mockRemoveStaffMember = vi.fn();
vi.mock("./actions", () => ({
  addStaffMemberByEmail: (email: string, role: string) => mockAddStaffMemberByEmail(email, role),
  changeStaffRole: (targetUserId: string, role: string) => mockChangeStaffRole(targetUserId, role),
  removeStaffMember: (targetUserId: string) => mockRemoveStaffMember(targetUserId),
}));

const {
  addStaffMemberByEmailFormAction,
  changeStaffRoleFormAction,
  removeStaffMemberFormAction,
} = await import("./page-actions");

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

describe("addStaffMemberByEmailFormAction", () => {
  beforeEach(() => {
    mockRedirect.mockClear();
    mockRevalidatePath.mockClear();
    mockAddStaffMemberByEmail.mockReset();
  });

  it("valid email + support role: calls the Part B primitive with the exact values, revalidates, redirects with success", async () => {
    mockAddStaffMemberByEmail.mockResolvedValue({ ok: true });

    await expect(
      addStaffMemberByEmailFormAction(formData({ email: "a@test.com", role: "support" })),
    ).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockAddStaffMemberByEmail).toHaveBeenCalledWith("a@test.com", "support");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/admin/staff");
    expect(mockRedirect).toHaveBeenCalledWith(
      `/admin/staff?success=${encodeURIComponent("Staff member added.")}`,
    );
  });

  it("valid email + owner role: still just calls the primitive -- the Owner confirmation itself is a client-side (pre-submission) concern, not this action's", async () => {
    mockAddStaffMemberByEmail.mockResolvedValue({ ok: true });

    await expect(
      addStaffMemberByEmailFormAction(formData({ email: "a@test.com", role: "owner" })),
    ).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockAddStaffMemberByEmail).toHaveBeenCalledWith("a@test.com", "owner");
  });

  it("invalid role: rejected before ever calling the primitive", async () => {
    await expect(
      addStaffMemberByEmailFormAction(formData({ email: "a@test.com", role: "superadmin" })),
    ).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockAddStaffMemberByEmail).not.toHaveBeenCalled();
    expect(mockRedirect).toHaveBeenCalledWith(
      `/admin/staff?error=${encodeURIComponent("That's not a valid staff role.")}`,
    );
  });

  it("empty email: the Part B primitive's own validation error is surfaced, not leaked raw", async () => {
    mockAddStaffMemberByEmail.mockResolvedValue({ ok: false, error: "Enter an email address." });

    await expect(
      addStaffMemberByEmailFormAction(formData({ email: "   ", role: "support" })),
    ).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      `/admin/staff?error=${encodeURIComponent("Enter an email address.")}`,
    );
  });

  it("already staff: stable mapped message surfaced", async () => {
    mockAddStaffMemberByEmail.mockResolvedValue({ ok: false, error: "That account is already staff." });

    await expect(
      addStaffMemberByEmailFormAction(formData({ email: "a@test.com", role: "support" })),
    ).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      `/admin/staff?error=${encodeURIComponent("That account is already staff.")}`,
    );
  });

  it("no verified account found: stable mapped message surfaced", async () => {
    mockAddStaffMemberByEmail.mockResolvedValue({
      ok: false,
      error: "No verified Librum account was found for that email.",
    });

    await expect(
      addStaffMemberByEmailFormAction(formData({ email: "nobody@test.com", role: "support" })),
    ).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      `/admin/staff?error=${encodeURIComponent("No verified Librum account was found for that email.")}`,
    );
  });

  it("a stable generic failure never leaks anything beyond the mapped message", async () => {
    mockAddStaffMemberByEmail.mockResolvedValue({
      ok: false,
      error: "Something went wrong. Please try again.",
    });

    await expect(
      addStaffMemberByEmailFormAction(formData({ email: "a@test.com", role: "support" })),
    ).rejects.toBeInstanceOf(RedirectSignal);

    const redirectedTo = mockRedirect.mock.calls[0][0] as string;
    expect(redirectedTo).toContain(encodeURIComponent("Something went wrong. Please try again."));
  });

  it("failure never revalidates the page", async () => {
    mockAddStaffMemberByEmail.mockResolvedValue({ ok: false, error: "already staff" });

    await expect(
      addStaffMemberByEmailFormAction(formData({ email: "a@test.com", role: "support" })),
    ).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});

describe("changeStaffRoleFormAction", () => {
  beforeEach(() => {
    mockRedirect.mockClear();
    mockRevalidatePath.mockClear();
    mockChangeStaffRole.mockReset();
  });

  it("calls change_staff_role with the exact target and role, revalidates, redirects with success", async () => {
    mockChangeStaffRole.mockResolvedValue({ ok: true });

    await expect(
      changeStaffRoleFormAction(formData({ targetUserId: "target-1", role: "admin" })),
    ).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockChangeStaffRole).toHaveBeenCalledWith("target-1", "admin");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/admin/staff");
    expect(mockRedirect).toHaveBeenCalledWith(
      `/admin/staff?success=${encodeURIComponent("Role updated.")}`,
    );
  });

  it("invalid role: rejected before ever calling the primitive", async () => {
    await expect(
      changeStaffRoleFormAction(formData({ targetUserId: "target-1", role: "superadmin" })),
    ).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockChangeStaffRole).not.toHaveBeenCalled();
  });

  it("last-owner failure maps to the stable message, never a raw trigger/SQL error", async () => {
    mockChangeStaffRole.mockResolvedValue({
      ok: false,
      error: "Librum must always have at least one owner.",
    });

    await expect(
      changeStaffRoleFormAction(formData({ targetUserId: "target-1", role: "admin" })),
    ).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      `/admin/staff?error=${encodeURIComponent("Librum must always have at least one owner.")}`,
    );
  });

  it("stale target (already removed) maps to the stable message", async () => {
    mockChangeStaffRole.mockResolvedValue({
      ok: false,
      error: "This staff member no longer exists.",
    });

    await expect(
      changeStaffRoleFormAction(formData({ targetUserId: "gone", role: "admin" })),
    ).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      `/admin/staff?error=${encodeURIComponent("This staff member no longer exists.")}`,
    );
  });

  it("generic error no-leak", async () => {
    mockChangeStaffRole.mockResolvedValue({
      ok: false,
      error: "Something went wrong. Please try again.",
    });

    await expect(
      changeStaffRoleFormAction(formData({ targetUserId: "target-1", role: "admin" })),
    ).rejects.toBeInstanceOf(RedirectSignal);

    const redirectedTo = mockRedirect.mock.calls[0][0] as string;
    expect(redirectedTo).not.toContain("SQLSTATE");
    expect(redirectedTo).not.toContain("relation");
  });
});

describe("removeStaffMemberFormAction", () => {
  beforeEach(() => {
    mockRedirect.mockClear();
    mockRevalidatePath.mockClear();
    mockRemoveStaffMember.mockReset();
  });

  it("calls remove_staff_member with the exact target, revalidates, redirects with success", async () => {
    mockRemoveStaffMember.mockResolvedValue({ ok: true });

    await expect(
      removeStaffMemberFormAction(formData({ targetUserId: "target-1" })),
    ).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRemoveStaffMember).toHaveBeenCalledWith("target-1");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/admin/staff");
    expect(mockRedirect).toHaveBeenCalledWith(
      `/admin/staff?success=${encodeURIComponent("Staff member removed.")}`,
    );
  });

  it("stale target error mapping", async () => {
    mockRemoveStaffMember.mockResolvedValue({
      ok: false,
      error: "This staff member no longer exists.",
    });

    await expect(
      removeStaffMemberFormAction(formData({ targetUserId: "gone" })),
    ).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      `/admin/staff?error=${encodeURIComponent("This staff member no longer exists.")}`,
    );
  });

  it("last-owner error mapping", async () => {
    mockRemoveStaffMember.mockResolvedValue({
      ok: false,
      error: "Librum must always have at least one owner.",
    });

    await expect(
      removeStaffMemberFormAction(formData({ targetUserId: "sole-owner" })),
    ).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      `/admin/staff?error=${encodeURIComponent("Librum must always have at least one owner.")}`,
    );
  });

  it("generic error no-leak", async () => {
    mockRemoveStaffMember.mockResolvedValue({
      ok: false,
      error: "Something went wrong. Please try again.",
    });

    await expect(
      removeStaffMemberFormAction(formData({ targetUserId: "target-1" })),
    ).rejects.toBeInstanceOf(RedirectSignal);

    const redirectedTo = mockRedirect.mock.calls[0][0] as string;
    expect(redirectedTo).not.toContain("policy");
    expect(redirectedTo).not.toContain("staff_members");
  });

  it("failure never revalidates the page", async () => {
    mockRemoveStaffMember.mockResolvedValue({ ok: false, error: "cannot remove yourself" });

    await expect(
      removeStaffMemberFormAction(formData({ targetUserId: "target-1" })),
    ).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});
