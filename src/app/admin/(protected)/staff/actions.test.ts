import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import path from "path";

// LIBRUM 2.0 ADMIN-1B PART B: same mocking convention already
// established by src/app/admin/(protected)/reports/actions.test.ts --
// requireStaff() is mocked directly (its own decision logic is already
// covered by src/lib/staff.test.ts). Unlike reviewBookReport(), these
// actions never redirect() -- there is no page to redirect back to yet
// (Part C's own scope) -- so "authorization failure" here means
// requireStaff()'s own thrown redirect propagates, and the action never
// reaches the RPC or returns a `{ok: true}` result.
class RedirectSignal extends Error {
  constructor(public target: string) {
    super(`REDIRECT:${target}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));

const mockRequireStaff = vi.fn();
vi.mock("@/lib/staff", () => ({ requireStaff: (permission: string) => mockRequireStaff(permission) }));

const mockRpc = vi.fn();
const mockCreateClient = vi.fn(() => Promise.resolve({ rpc: mockRpc }));
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));

const { listStaffMembers, addStaffMemberByEmail, changeStaffRole, removeStaffMember } =
  await import("./actions");

describe("staff management server primitives: source-level guards", () => {
  it("never imports createAdminClient/the service-role client", () => {
    // Scoped to an actual import statement, not any mention of the name
    // -- this file's own comment legitimately explains, by name, why
    // createAdminClient is deliberately absent.
    const source = readFileSync(path.join(__dirname, "actions.ts"), "utf8");
    expect(source).not.toMatch(/import\s*\{[^}]*createAdminClient[^}]*\}/);
    expect(source).not.toMatch(/from\s*"@\/lib\/supabase\/admin"/);
  });

  it("uses the normal request-scoped server client, not the admin one", () => {
    const source = readFileSync(path.join(__dirname, "actions.ts"), "utf8");
    expect(source).toMatch(/import\s*\{\s*createClient\s*\}\s*from\s*"@\/lib\/supabase\/server"/);
  });
});

describe("listStaffMembers", () => {
  beforeEach(() => {
    mockRequireStaff.mockReset();
    mockRpc.mockReset();
  });

  it("requires staff.view before calling the RPC", async () => {
    mockRequireStaff.mockImplementation(() => {
      throw new RedirectSignal("/admin/login");
    });

    await expect(listStaffMembers()).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("calls list_staff_members with no arguments and returns its rows on success", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "owner-1", role: "owner" });
    const rows = [
      { user_id: "u1", display_name: "Owner", email: "owner@test", role: "owner", created_at: "now" },
    ];
    mockRpc.mockResolvedValue({ data: rows, error: null });

    const result = await listStaffMembers();

    expect(mockRequireStaff).toHaveBeenCalledWith("staff.view");
    expect(mockRpc).toHaveBeenCalledWith("list_staff_members");
    expect(result).toEqual({ ok: true, data: rows });
  });

  it("a null data result maps to an empty array, never null/undefined", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "owner-1", role: "owner" });
    mockRpc.mockResolvedValue({ data: null, error: null });

    const result = await listStaffMembers();

    expect(result).toEqual({ ok: true, data: [] });
  });

  it("an authorization failure from the RPC itself maps to a stable message, never {ok: true}", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "moderator-1", role: "moderator" });
    mockRpc.mockResolvedValue({ data: null, error: { message: "not authorized" } });

    const result = await listStaffMembers();

    expect(result).toEqual({ ok: false, error: "You don't have permission to manage staff." });
  });

  it("a raw DB error never leaks through", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "owner-1", role: "owner" });
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'relation "public.staff_members" does not exist' },
    });

    const result = await listStaffMembers();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain("relation");
      expect(result.error).not.toContain("staff_members");
    }
  });
});

describe("addStaffMemberByEmail", () => {
  beforeEach(() => {
    mockRequireStaff.mockReset();
    mockRpc.mockReset();
  });

  it("requires staff.manage before calling the RPC", async () => {
    mockRequireStaff.mockImplementation(() => {
      throw new RedirectSignal("/admin/login");
    });

    await expect(addStaffMemberByEmail("a@test.com", "support")).rejects.toBeInstanceOf(
      RedirectSignal,
    );
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("normalizes the email (trim + lowercase) before calling the RPC", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "owner-1", role: "owner" });
    mockRpc.mockResolvedValue({ error: null });

    await addStaffMemberByEmail("  Someone@Example.Test  ", "support");

    expect(mockRpc).toHaveBeenCalledWith("add_staff_member_by_email", {
      target_email: "someone@example.test",
      new_role: "support",
    });
  });

  it("rejects an empty email before ever calling the RPC", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "owner-1", role: "owner" });

    const result = await addStaffMemberByEmail("   ", "support");

    expect(result).toEqual({ ok: false, error: "Enter an email address." });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("rejects a forged role before ever calling the RPC", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "owner-1", role: "owner" });

    const result = await addStaffMemberByEmail("a@test.com", "superadmin" as never);

    expect(result).toEqual({ ok: false, error: "That's not a valid staff role." });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("a verified-account-not-found RPC failure maps to a stable message", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "owner-1", role: "owner" });
    mockRpc.mockResolvedValue({
      error: { message: "no verified Librum account was found for that email" },
    });

    const result = await addStaffMemberByEmail("nobody@test.com", "support");

    expect(result).toEqual({
      ok: false,
      error: "No verified Librum account was found for that email.",
    });
  });

  it("succeeds when the RPC reports no error", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "owner-1", role: "owner" });
    mockRpc.mockResolvedValue({ error: null });

    const result = await addStaffMemberByEmail("a@test.com", "support");

    expect(result).toEqual({ ok: true });
  });
});

describe("changeStaffRole", () => {
  beforeEach(() => {
    mockRequireStaff.mockReset();
    mockRpc.mockReset();
  });

  it("requires staff.manage before calling the RPC", async () => {
    mockRequireStaff.mockImplementation(() => {
      throw new RedirectSignal("/admin/login");
    });

    await expect(changeStaffRole("target-1", "admin")).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("calls change_staff_role with the exact target and role", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "owner-1", role: "owner" });
    mockRpc.mockResolvedValue({ error: null });

    await changeStaffRole("target-1", "admin");

    expect(mockRpc).toHaveBeenCalledWith("change_staff_role", {
      target_user_id: "target-1",
      new_role: "admin",
    });
  });

  it("rejects a forged role before ever calling the RPC", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "owner-1", role: "owner" });

    const result = await changeStaffRole("target-1", "superadmin" as never);

    expect(result).toEqual({ ok: false, error: "That's not a valid staff role." });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("a self-role-change RPC rejection maps to a stable message", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "owner-1", role: "owner" });
    mockRpc.mockResolvedValue({ error: { message: "cannot change your own role" } });

    const result = await changeStaffRole("owner-1", "admin");

    expect(result).toEqual({ ok: false, error: "You can't change your own role." });
  });

  it("a last-owner RPC rejection maps to a stable, non-leaking message", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "owner-1", role: "owner" });
    mockRpc.mockResolvedValue({ error: { message: "at least one owner is required" } });

    const result = await changeStaffRole("owner-1", "admin");

    expect(result).toEqual({
      ok: false,
      error: "Librum must always have at least one owner.",
    });
  });

  it("succeeds (including the RPC's own idempotent same-role no-op) when the RPC reports no error", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "owner-1", role: "owner" });
    mockRpc.mockResolvedValue({ error: null });

    const result = await changeStaffRole("target-1", "moderator");

    expect(result).toEqual({ ok: true });
  });
});

describe("removeStaffMember", () => {
  beforeEach(() => {
    mockRequireStaff.mockReset();
    mockRpc.mockReset();
  });

  it("requires staff.manage before calling the RPC", async () => {
    mockRequireStaff.mockImplementation(() => {
      throw new RedirectSignal("/admin/login");
    });

    await expect(removeStaffMember("target-1")).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("calls remove_staff_member with the exact target", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "owner-1", role: "owner" });
    mockRpc.mockResolvedValue({ error: null });

    await removeStaffMember("target-1");

    expect(mockRpc).toHaveBeenCalledWith("remove_staff_member", {
      target_user_id: "target-1",
    });
  });

  it("a stale/already-removed target maps to a stable message, not silent success", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "owner-1", role: "owner" });
    mockRpc.mockResolvedValue({ error: { message: "staff member not found" } });

    const result = await removeStaffMember("already-gone");

    expect(result).toEqual({ ok: false, error: "This staff member no longer exists." });
  });

  it("a self-removal RPC rejection maps to a stable message", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "owner-1", role: "owner" });
    mockRpc.mockResolvedValue({ error: { message: "cannot remove yourself" } });

    const result = await removeStaffMember("owner-1");

    expect(result).toEqual({ ok: false, error: "You can't remove yourself from staff." });
  });

  it("a last-owner RPC rejection maps to a stable, non-leaking message", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "owner-1", role: "owner" });
    mockRpc.mockResolvedValue({ error: { message: "at least one owner is required" } });

    const result = await removeStaffMember("owner-1");

    expect(result).toEqual({
      ok: false,
      error: "Librum must always have at least one owner.",
    });
  });

  it("succeeds when the RPC reports no error", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "owner-1", role: "owner" });
    mockRpc.mockResolvedValue({ error: null });

    const result = await removeStaffMember("target-1");

    expect(result).toEqual({ ok: true });
  });
});
