import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type { StaffRole } from "@/lib/types";

// ADMIN-1A.5 "Admin login" test bullets: valid owner/admin/editor/
// moderator/support authentication (BLOG-1B added editor to this list --
// it now holds admin.access), ordinary author/reader denied,
// already-authenticated staff redirects, already-authenticated non-staff
// denied. All of these are decided entirely by this page's own render
// logic (staffLogin() itself never decides staff authorization -- see
// actions.test.ts) -- exercised here per role, without a DOM/render
// harness, using the same "walk the returned React element tree"
// technique already established for src/app/admin/page.test.ts.
class RedirectSignal extends Error {
  constructor(public target: string) {
    super(`REDIRECT:${target}`);
  }
}

const mockRedirect = vi.fn((url: string) => {
  throw new RedirectSignal(url);
});
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));

const mockGetUser = vi.fn(() => Promise.resolve({ data: { user: null as { id: string } | null } }));
const mockCreateClient = vi.fn(() => Promise.resolve({ auth: { getUser: mockGetUser } }));
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));

const mockGetStaffMember = vi.fn(() =>
  Promise.resolve(null as { userId: string; role: StaffRole } | null),
);
vi.mock("@/lib/staff", () => ({ getStaffMember: () => mockGetStaffMember() }));

vi.mock("@/app/auth/actions", () => ({ logout: vi.fn() }));

const { default: AdminLoginPage } = await import("./page");

function collectText(node: ReactNode): string[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [String(node)];
  if (Array.isArray(node)) return node.flatMap(collectText);
  if (typeof node !== "object") return [];
  const element = node as ReactElement<{ children?: ReactNode }>;
  return "props" in element ? collectText(element.props.children) : [];
}

describe("AdminLoginPage: unauthenticated", () => {
  beforeEach(() => {
    mockRedirect.mockClear();
    mockGetUser.mockResolvedValue({ data: { user: null } });
    mockGetStaffMember.mockClear();
  });

  it("renders the sign-in form, never redirects, never checks staff status", async () => {
    const page = await AdminLoginPage({ searchParams: Promise.resolve({}) });
    const text = collectText(page).join(" ");

    expect(mockRedirect).not.toHaveBeenCalled();
    expect(mockGetStaffMember).not.toHaveBeenCalled();
    expect(text).toContain("Librum Administration");
    expect(text).toContain("Sign in with your Librum staff account.");
  });
});

describe("AdminLoginPage: already authenticated", () => {
  beforeEach(() => {
    mockRedirect.mockClear();
    mockGetUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
    mockGetStaffMember.mockReset();
  });

  const staffRolesWithAdminAccess: StaffRole[] = ["owner", "admin", "editor", "moderator", "support"];

  for (const role of staffRolesWithAdminAccess) {
    it(`${role}: redirects to /admin (has admin.access)`, async () => {
      mockGetStaffMember.mockResolvedValue({ userId: "user-1", role });

      await expect(
        AdminLoginPage({ searchParams: Promise.resolve({}) }),
      ).rejects.toBeInstanceOf(RedirectSignal);

      expect(mockRedirect).toHaveBeenCalledWith("/admin");
    });
  }

  it("owner with a safe next: redirects to that next instead of /admin", async () => {
    mockGetStaffMember.mockResolvedValue({ userId: "user-1", role: "owner" });

    await expect(
      AdminLoginPage({ searchParams: Promise.resolve({ next: "/admin/reports" }) }),
    ).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith("/admin/reports");
  });

  it("owner with an unsafe next (/dashboard): falls back to /admin, never redirects off /admin", async () => {
    mockGetStaffMember.mockResolvedValue({ userId: "user-1", role: "owner" });

    await expect(
      AdminLoginPage({ searchParams: Promise.resolve({ next: "/dashboard" }) }),
    ).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith("/admin");
  });

  it("ordinary author/reader (no staff_members row at all): denied, same message, no staff details leaked", async () => {
    mockGetStaffMember.mockResolvedValue(null);

    const page = await AdminLoginPage({ searchParams: Promise.resolve({}) });
    const text = collectText(page).join(" ");

    expect(mockRedirect).not.toHaveBeenCalled();
    expect(text).toContain("This account does not have access to Librum Administration.");
    // No internal permission diagnostics leaked -- the message is
    // identical regardless of WHY (no row at all vs. a role lacking the
    // permission), never mentions "staff_members", a role name, or a
    // permission identifier.
    expect(text).not.toMatch(/staff_members|permission|role/i);
  });
});
