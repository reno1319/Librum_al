import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import path from "path";

// LIBRUM 2.0 ADMIN-1C PART B: same mocking convention already
// established by src/app/admin/(protected)/staff/actions.test.ts --
// requireStaff() is mocked directly (its own decision logic is already
// covered by src/lib/staff.test.ts). listAdminAuditEvents() never
// redirects -- like listStaffMembers(), it's a plain read primitive, not
// a redirect-driving Server Action -- so "authorization failure" here
// means requireStaff()'s own thrown redirect propagates.
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

const { listAdminAuditEvents } = await import("./actions");

describe("audit list server primitive: source-level guards", () => {
  it("never imports createAdminClient/the service-role client", () => {
    const source = readFileSync(path.join(__dirname, "actions.ts"), "utf8");
    expect(source).not.toMatch(/import\s*\{[^}]*createAdminClient[^}]*\}/);
    expect(source).not.toMatch(/from\s*"@\/lib\/supabase\/admin"/);
  });

  it("uses the normal request-scoped server client, not the admin one", () => {
    const source = readFileSync(path.join(__dirname, "actions.ts"), "utf8");
    expect(source).toMatch(/import\s*\{\s*createClient\s*\}\s*from\s*"@\/lib\/supabase\/server"/);
  });
});

describe("listAdminAuditEvents", () => {
  beforeEach(() => {
    mockRequireStaff.mockReset();
    mockRpc.mockReset();
  });

  it("requires audit.view before calling the RPC", async () => {
    mockRequireStaff.mockImplementation(() => {
      throw new RedirectSignal("/admin/login");
    });

    await expect(listAdminAuditEvents()).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("calls list_admin_audit_events with every param mapped to its exact p_ argument", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "owner-1", role: "owner" });
    mockRpc.mockResolvedValue({ data: [], error: null });

    await listAdminAuditEvents({
      action: "staff.added",
      actorId: "actor-1",
      targetType: "staff_members",
      createdAfter: "2026-01-01T00:00:00.000Z",
      createdBefore: "2026-02-01T00:00:00.000Z",
      cursorCreatedAt: "2026-01-15T00:00:00.000Z",
      cursorId: "cursor-id-1",
      limit: 50,
    });

    expect(mockRpc).toHaveBeenCalledWith("list_admin_audit_events", {
      p_action: "staff.added",
      p_actor_id: "actor-1",
      p_target_type: "staff_members",
      p_created_after: "2026-01-01T00:00:00.000Z",
      p_created_before: "2026-02-01T00:00:00.000Z",
      p_cursor_created_at: "2026-01-15T00:00:00.000Z",
      p_cursor_id: "cursor-id-1",
      p_limit: 50,
    });
  });

  it("defaults every unset param to null, and limit to 25", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "owner-1", role: "owner" });
    mockRpc.mockResolvedValue({ data: [], error: null });

    await listAdminAuditEvents();

    expect(mockRpc).toHaveBeenCalledWith("list_admin_audit_events", {
      p_action: null,
      p_actor_id: null,
      p_target_type: null,
      p_created_after: null,
      p_created_before: null,
      p_cursor_created_at: null,
      p_cursor_id: null,
      p_limit: 25,
    });
  });

  it("returns the RPC's rows on success", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "owner-1", role: "owner" });
    const rows = [
      {
        id: "e1",
        actor_id: "owner-1",
        actor_display_name: "Renato Kalemi",
        action: "staff.added",
        target_type: "staff_members",
        target_id: "target-1",
        metadata: { role: "support" },
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ];
    mockRpc.mockResolvedValue({ data: rows, error: null });

    const result = await listAdminAuditEvents();

    expect(result).toEqual({ ok: true, data: rows });
  });

  it("returns an empty array (not undefined/null) when the RPC returns no data", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "owner-1", role: "owner" });
    mockRpc.mockResolvedValue({ data: null, error: null });

    const result = await listAdminAuditEvents();

    expect(result).toEqual({ ok: true, data: [] });
  });

  it("maps a known RPC error to stable, non-leaking copy", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "owner-1", role: "owner" });
    mockRpc.mockResolvedValue({ data: null, error: { message: "not authorized" } });

    const result = await listAdminAuditEvents();

    expect(result).toEqual({
      ok: false,
      error: "You don't have permission to view the audit log.",
    });
  });

  it("never leaks a raw/unrecognized RPC error message", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "owner-1", role: "owner" });
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'relation "public.admin_audit_log" does not exist' },
    });

    const result = await listAdminAuditEvents();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain("admin_audit_log");
      expect(result.error).not.toContain("relation");
    }
  });
});
