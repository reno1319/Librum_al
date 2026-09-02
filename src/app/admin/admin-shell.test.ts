import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement, ReactNode } from "react";

// ADMIN-1A.5 "Navigation" test bullets: the exhaustive per-role matrix is
// already covered by src/app/admin/admin-nav.test.ts (the pure resolver
// this component calls) -- this file only proves AdminShell itself is
// correctly wired to that resolver and actually passes the resulting
// items down to its nav components, for a couple of representative
// roles, plus that identity/Sign out are present.
//
// Nav item LABELS themselves live inside NavLinks'/AdminMobileNav's own
// rendering, which a plain "walk element.props.children" traversal never
// reaches (those are separate component functions, never invoked by
// simply holding a <Component .../> element descriptor) -- collectItems()
// below instead reads the `items` prop straight off any element that
// carries one, which is exactly what AdminShell hands to both.
const mockSingle = vi.fn(() =>
  Promise.resolve({ data: { display_name: "Renato Kalemi" } as { display_name: string } | null }),
);
const mockEq = vi.fn(() => ({ single: mockSingle }));
const mockSelect = vi.fn(() => ({ eq: mockEq }));
const mockFrom = vi.fn(() => ({ select: mockSelect }));
const mockCreateClient = vi.fn(() => Promise.resolve({ from: mockFrom }));
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));

vi.mock("@/app/auth/actions", () => ({ logout: vi.fn() }));

const { AdminShell } = await import("./admin-shell");

function collectText(node: ReactNode): string[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [String(node)];
  if (Array.isArray(node)) return node.flatMap(collectText);
  if (typeof node !== "object") return [];
  const element = node as ReactElement<{ children?: ReactNode }>;
  return "props" in element ? collectText(element.props.children) : [];
}

type NavItemLike = { href: string; label: string };

function collectItems(node: ReactNode): NavItemLike[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [];
  if (Array.isArray(node)) return node.flatMap(collectItems);
  if (typeof node !== "object") return [];
  const element = node as ReactElement<{ children?: ReactNode; items?: NavItemLike[] }>;
  if (!("props" in element)) return [];
  const own = Array.isArray(element.props.items) ? element.props.items : [];
  return [...own, ...collectItems(element.props.children)];
}

// MOBILE ADMIN SHELL CORRECTION: unlike NavLinks/AdminMobileNav (separate
// component functions, never invoked by an inert <Component .../>
// descriptor -- see this file's own header comment), a DOM-tag element
// like <header> has a plain string `.type`, so its actual className IS
// directly inspectable here without rendering anything.
function findFirstByTagName(node: ReactNode, tagName: string): ReactElement<{ className?: string; children?: ReactNode }> | null {
  if (node === null || node === undefined || typeof node === "boolean") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findFirstByTagName(child, tagName);
      if (found) return found;
    }
    return null;
  }
  if (typeof node !== "object") return null;
  const element = node as ReactElement<{ className?: string; children?: ReactNode }>;
  if (!("props" in element)) return null;
  if (element.type === tagName) return element;
  return findFirstByTagName(element.props.children, tagName);
}

describe("AdminShell", () => {
  beforeEach(() => {
    mockSingle.mockClear();
  });

  it("owner: passes Dashboard/Book reports/Refund requests/Staff/Audit log/Finance to its nav components, plus identity and Sign out", async () => {
    const shell = await AdminShell({ userId: "user-1", role: "owner", children: "content" });
    const text = collectText(shell).join(" | ");
    const labels = collectItems(shell).map((i) => i.label);

    expect(text).toContain("Librum Administration");
    expect(text).toContain("Renato Kalemi");
    expect(text).toContain("Owner");
    expect(text).toContain("Sign out");
    expect(text).toContain("content");
    expect(labels).toContain("Dashboard");
    expect(labels).toContain("Book reports");
    expect(labels).toContain("Refund requests");
    expect(labels).toContain("Staff");
    expect(labels).toContain("Audit log");
    expect(labels).toContain("Finance");
  });

  it("admin: Audit log is passed to nav (ADMIN-1C Part C)", async () => {
    const shell = await AdminShell({ userId: "user-5", role: "admin", children: "content" });
    const labels = collectItems(shell).map((i) => i.label);

    expect(labels).toContain("Audit log");
  });

  it("admin: Finance is passed to nav (ADMIN-1D Part C)", async () => {
    const shell = await AdminShell({ userId: "user-5", role: "admin", children: "content" });
    const labels = collectItems(shell).map((i) => i.label);

    expect(labels).toContain("Finance");
  });

  it("moderator: Book reports is passed to nav, Refund requests/Staff/Audit log/Finance are not", async () => {
    const shell = await AdminShell({ userId: "user-2", role: "moderator", children: "content" });
    const labels = collectItems(shell).map((i) => i.label);
    const text = collectText(shell).join(" | ");

    expect(labels).toContain("Book reports");
    expect(labels).not.toContain("Refund requests");
    expect(labels).not.toContain("Staff");
    expect(labels).not.toContain("Audit log");
    expect(labels).not.toContain("Finance");
    expect(text).toContain("Moderator");
  });

  it("support: Refund requests is passed to nav, Book reports/Staff/Audit log/Finance are not", async () => {
    const shell = await AdminShell({ userId: "user-3", role: "support", children: "content" });
    const labels = collectItems(shell).map((i) => i.label);
    const text = collectText(shell).join(" | ");

    expect(labels).toContain("Refund requests");
    expect(labels).not.toContain("Book reports");
    expect(labels).not.toContain("Staff");
    expect(labels).not.toContain("Audit log");
    expect(labels).not.toContain("Finance");
    expect(text).toContain("Support");
  });

  it("falls back to a generic label when no display name is available", async () => {
    mockSingle.mockResolvedValueOnce({ data: null });

    const shell = await AdminShell({ userId: "user-4", role: "admin", children: "content" });
    const text = collectText(shell).join(" | ");

    expect(text).toContain("Staff member");
  });

  // MOBILE ADMIN SHELL CORRECTION: root-cause regression guard. The
  // reported bug (X visible, no usable nav on a real phone) traced to
  // this <header> missing `relative` -- AdminMobileNav's open drawer is
  // `absolute inset-x-0 top-full`, which without a positioned ancestor
  // anchors against the viewport instead of the header, rendering the
  // drawer roughly a screen-height below where it visually belongs. This
  // asserts the actual returned element carries the fix, not just that
  // the source file happens to contain the string "relative" somewhere.
  it("header carries `relative` so AdminMobileNav's absolute drawer anchors under it, not the viewport", async () => {
    const shell = await AdminShell({ userId: "user-1", role: "owner", children: "content" });
    const header = findFirstByTagName(shell, "header");

    expect(header).not.toBeNull();
    expect(header?.props.className?.split(/\s+/)).toContain("relative");
  });
});
