import { describe, expect, it, vi, beforeEach } from "vitest";
import Link from "next/link";
import type { ReactElement, ReactNode } from "react";
import type { StaffRole } from "@/lib/types";

// ADMIN-1A final pre-commit correction: AdminPage no longer calls
// hasPermission() separately -- it derives link visibility from the role
// requireStaff("admin.access") already returned, via the pure
// roleHasPermission() helper (src/lib/staff-permissions.ts, exhaustively
// tested on its own). This file checks two things: (1) the page is still
// gated by requireStaff("admin.access"), and (2) for a representative
// role, the actual rendered links match that role's real permissions --
// walking the returned React element tree directly (no DOM/render
// harness needed; an async Server Component's return value is already a
// plain element tree) rather than re-asserting mock call counts, since
// there's no longer a second auth call to count.
function collectLinkHrefs(node: ReactNode): string[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (Array.isArray(node)) return node.flatMap(collectLinkHrefs);
  if (typeof node !== "object") return [];

  const element = node as ReactElement<{ href?: string; children?: ReactNode }>;
  const ownHref = element.type === Link && typeof element.props.href === "string" ? [element.props.href] : [];
  const childHrefs = "props" in element ? collectLinkHrefs(element.props.children) : [];
  return [...ownHref, ...childHrefs];
}

const mockRequireStaff = vi.fn((permission: string): Promise<{ userId: string; role: StaffRole }> => {
  void permission;
  return Promise.resolve({ userId: "staff-1", role: "admin" });
});
vi.mock("@/lib/staff", () => ({ requireStaff: (permission: string) => mockRequireStaff(permission) }));

const mockSingle = vi.fn(() => Promise.resolve({ data: { display_name: "Test Staff" } }));
const mockEq = vi.fn(() => ({ single: mockSingle }));
const mockSelect = vi.fn(() => ({ eq: mockEq }));
const mockFrom = vi.fn(() => ({ select: mockSelect }));
const mockCreateClient = vi.fn(() => Promise.resolve({ from: mockFrom }));
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));

const { default: AdminPage } = await import("./page");

describe("AdminPage", () => {
  beforeEach(() => {
    mockRequireStaff.mockClear();
  });

  it("gates on requireStaff('admin.access')", async () => {
    mockRequireStaff.mockResolvedValueOnce({ userId: "staff-1", role: "admin" });
    await AdminPage();
    expect(mockRequireStaff).toHaveBeenCalledWith("admin.access");
  });

  it("moderator: shows only the Book reports link", async () => {
    mockRequireStaff.mockResolvedValueOnce({ userId: "staff-1", role: "moderator" });
    const page = await AdminPage();
    const hrefs = collectLinkHrefs(page);
    expect(hrefs).toContain("/admin/reports");
    expect(hrefs).not.toContain("/admin/refunds");
  });

  it("support: shows only the Refund requests link", async () => {
    mockRequireStaff.mockResolvedValueOnce({ userId: "staff-1", role: "support" });
    const page = await AdminPage();
    const hrefs = collectLinkHrefs(page);
    expect(hrefs).toContain("/admin/refunds");
    expect(hrefs).not.toContain("/admin/reports");
  });

  it("admin: shows both links", async () => {
    mockRequireStaff.mockResolvedValueOnce({ userId: "staff-1", role: "admin" });
    const page = await AdminPage();
    const hrefs = collectLinkHrefs(page);
    expect(hrefs).toContain("/admin/reports");
    expect(hrefs).toContain("/admin/refunds");
  });

  it("owner: shows both links", async () => {
    mockRequireStaff.mockResolvedValueOnce({ userId: "staff-1", role: "owner" });
    const page = await AdminPage();
    const hrefs = collectLinkHrefs(page);
    expect(hrefs).toContain("/admin/reports");
    expect(hrefs).toContain("/admin/refunds");
  });
});
