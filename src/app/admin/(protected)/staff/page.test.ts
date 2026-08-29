import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement, ReactNode } from "react";

// LIBRUM 2.0 ADMIN-1B PART C: same "call the async Server Component
// directly, walk the returned element tree" technique already
// established this session (src/app/admin/(protected)/page.test.ts,
// src/app/admin/login/page.test.ts, src/app/admin/admin-shell.test.ts).
// Interactive Client Components (AddStaffForm/RoleChangeRow/
// RemoveStaffButton) are mocked here, matching src/app/admin/
// layout.test.ts's own AdminShell-mocking precedent -- their INTERNAL
// behavior (useState/useFormStatus/window.confirm) cannot be exercised
// outside a real DOM render, which this codebase has no harness for
// (no React Testing Library -- see src/app/error.test.ts's own comment
// on why). What IS proven here, and is exactly what the design brief's
// "access matrix"/"self row"/"view-only vs manage" requirements are
// actually about, is: which permission gates the page, and WHICH
// elements it decides to render for a given role/self-row combination
// -- proven via each mock's `.type`/`.props`, not its internal render
// output.
class RedirectSignal extends Error {
  constructor(public target: string) {
    super(`REDIRECT:${target}`);
  }
}
const mockRequireStaff = vi.fn();
vi.mock("@/lib/staff", () => ({ requireStaff: (permission: string) => mockRequireStaff(permission) }));

const mockListStaffMembers = vi.fn();
vi.mock("./actions", () => ({ listStaffMembers: () => mockListStaffMembers() }));

// NOTE: each mocked module exports the mock function ITSELF as the
// component -- not a wrapper arrow function. page.tsx renders these as
// JSX (`<AddStaffForm .../>`), which only ever creates an inert element
// descriptor (`{ type, props }`); it never actually calls `.type`. A
// wrapper here (`(props) => mockAddStaffForm(props)`) would itself just
// become that inert `.type` and would never be invoked either, leaving
// the mock permanently uncalled regardless of what the page renders.
// Exporting the mock directly lets the assertions below walk the tree
// and compare `element.type === mockAddStaffForm` instead of relying on
// `mock.calls`/`toHaveBeenCalled()`.
const mockAddStaffForm = vi.fn(() => null);
vi.mock("./add-staff-form", () => ({ AddStaffForm: mockAddStaffForm }));

const mockRoleChangeRow = vi.fn(() => null);
vi.mock("./role-change-row", () => ({ RoleChangeRow: mockRoleChangeRow }));

const mockRemoveStaffButton = vi.fn(() => null);
vi.mock("./remove-staff-button", () => ({ RemoveStaffButton: mockRemoveStaffButton }));

const { default: AdminStaffPage } = await import("./page");

function collectText(node: ReactNode): string[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [String(node)];
  if (Array.isArray(node)) return node.flatMap(collectText);
  if (typeof node !== "object") return [];
  const element = node as ReactElement<{ children?: ReactNode }>;
  return "props" in element ? collectText(element.props.children) : [];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function collectByType(node: ReactNode, type: unknown): ReactElement<any>[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (Array.isArray(node)) return node.flatMap((child) => collectByType(child, type));
  if (typeof node !== "object") return [];
  const element = node as ReactElement<{ children?: ReactNode }>;
  if (!("props" in element)) return [];
  const matchesHere = element.type === type ? [element] : [];
  const childMatches = collectByType(element.props?.children, type);
  return [...matchesHere, ...childMatches];
}

const STAFF_ROSTER = [
  { user_id: "owner-1", display_name: "Renato Kalemi", email: "owner@test.com", role: "owner" as const, created_at: "2026-01-01T00:00:00.000Z" },
  { user_id: "admin-1", display_name: "Alice Admin", email: "alice@test.com", role: "admin" as const, created_at: "2026-01-02T00:00:00.000Z" },
];

describe("AdminStaffPage: access matrix", () => {
  beforeEach(() => {
    mockRequireStaff.mockReset();
    mockListStaffMembers.mockReset();
    mockListStaffMembers.mockResolvedValue({ ok: true, data: STAFF_ROSTER });
    mockAddStaffForm.mockClear();
    mockRoleChangeRow.mockClear();
    mockRemoveStaffButton.mockClear();
  });

  it("gates on staff.view, not admin.access -- the route's own explicit requireStaff call", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "owner-1", role: "owner" });

    await AdminStaffPage({ searchParams: Promise.resolve({}) });

    expect(mockRequireStaff).toHaveBeenCalledWith("staff.view");
  });

  it("owner: can enter, sees the roster, sees manage controls (Add staff form present)", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "owner-1", role: "owner" });

    const page = await AdminStaffPage({ searchParams: Promise.resolve({}) });
    const text = collectText(page).join(" | ");

    expect(text).toContain("Renato Kalemi");
    expect(text).toContain("Alice Admin");
    expect(collectByType(page, mockAddStaffForm)).toHaveLength(1);
  });

  it("admin: can enter, sees the roster, does NOT see manage controls (no Add staff form)", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "admin-1", role: "admin" });

    const page = await AdminStaffPage({ searchParams: Promise.resolve({}) });
    const text = collectText(page).join(" | ");

    expect(text).toContain("Renato Kalemi");
    expect(text).toContain("Alice Admin");
    expect(collectByType(page, mockAddStaffForm)).toHaveLength(0);
    expect(collectByType(page, mockRoleChangeRow)).toHaveLength(0);
    expect(collectByType(page, mockRemoveStaffButton)).toHaveLength(0);
  });

  it("admin (view-only): the read-only copy is shown, not the manage copy", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "admin-1", role: "admin" });

    const page = await AdminStaffPage({ searchParams: Promise.resolve({}) });
    const text = collectText(page).join(" | ");

    expect(text).toContain("You have read-only access to staff.");
    expect(text).not.toContain("Manage who has administrative access");
  });

  it("owner: the manage copy is shown, not the read-only copy", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "owner-1", role: "owner" });

    const page = await AdminStaffPage({ searchParams: Promise.resolve({}) });
    const text = collectText(page).join(" | ");

    expect(text).toContain("Manage who has administrative access");
    expect(text).not.toContain("You have read-only access to staff.");
  });

  it.each([["moderator"], ["support"], ["editor"]])(
    "%s: denied -- requireStaff('staff.view') itself redirects, the roster is never fetched",
    async (role) => {
      mockRequireStaff.mockImplementation(() => {
        throw new RedirectSignal(role === "editor" ? "/" : "/admin/login");
      });

      await expect(AdminStaffPage({ searchParams: Promise.resolve({}) })).rejects.toBeInstanceOf(
        RedirectSignal,
      );
      expect(mockListStaffMembers).not.toHaveBeenCalled();
    },
  );
});

describe("AdminStaffPage: self row", () => {
  beforeEach(() => {
    mockRequireStaff.mockReset();
    mockListStaffMembers.mockReset();
    mockListStaffMembers.mockResolvedValue({ ok: true, data: STAFF_ROSTER });
    mockAddStaffForm.mockClear();
    mockRoleChangeRow.mockClear();
    mockRemoveStaffButton.mockClear();
  });

  it("owner viewing their own row: no role-edit control and no remove control for themselves, but the other row still gets both", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "owner-1", role: "owner" });

    const page = await AdminStaffPage({ searchParams: Promise.resolve({}) });

    const roleChangeTargets = collectByType(page, mockRoleChangeRow).map(
      (el) => (el.props as { targetUserId: string }).targetUserId,
    );
    const removeTargets = collectByType(page, mockRemoveStaffButton).map(
      (el) => (el.props as { targetUserId: string }).targetUserId,
    );

    expect(roleChangeTargets).not.toContain("owner-1");
    expect(removeTargets).not.toContain("owner-1");
    expect(roleChangeTargets).toContain("admin-1");
    expect(removeTargets).toContain("admin-1");
  });

  it("shows '(You)' next to the signed-in staff member's own row", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "owner-1", role: "owner" });

    const page = await AdminStaffPage({ searchParams: Promise.resolve({}) });
    const text = collectText(page).join(" | ");

    expect(text).toContain("(You)");
  });
});

describe("AdminStaffPage: load failure / empty roster", () => {
  beforeEach(() => {
    mockRequireStaff.mockReset();
    mockRequireStaff.mockResolvedValue({ userId: "owner-1", role: "owner" });
    mockListStaffMembers.mockReset();
  });

  it("load failure: shows the fixed, safe copy -- never the underlying RPC error text", async () => {
    mockListStaffMembers.mockResolvedValue({
      ok: false,
      error: 'relation "public.staff_members" does not exist',
    });

    const page = await AdminStaffPage({ searchParams: Promise.resolve({}) });
    const text = collectText(page).join(" | ");

    expect(text).toContain("Unable to load staff members.");
    expect(text).not.toContain("relation");
    expect(text).not.toContain("staff_members");
  });

  it("impossible empty roster: renders a restrained safe state, does not crash", async () => {
    mockListStaffMembers.mockResolvedValue({ ok: true, data: [] });

    const page = await AdminStaffPage({ searchParams: Promise.resolve({}) });
    const text = collectText(page).join(" | ");

    expect(text).toContain("No staff members found.");
  });
});

describe("AdminStaffPage: error/success feedback", () => {
  beforeEach(() => {
    mockRequireStaff.mockReset();
    mockRequireStaff.mockResolvedValue({ userId: "owner-1", role: "owner" });
    mockListStaffMembers.mockReset();
    mockListStaffMembers.mockResolvedValue({ ok: true, data: STAFF_ROSTER });
  });

  it("renders an error banner from the error search param", async () => {
    const page = await AdminStaffPage({
      searchParams: Promise.resolve({ error: "That account is already staff." }),
    });
    const text = collectText(page).join(" | ");

    expect(text).toContain("That account is already staff.");
  });

  it("renders a success banner from the success search param", async () => {
    const page = await AdminStaffPage({
      searchParams: Promise.resolve({ success: "Staff member added." }),
    });
    const text = collectText(page).join(" | ");

    expect(text).toContain("Staff member added.");
  });
});
