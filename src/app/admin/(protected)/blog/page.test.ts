import { describe, expect, it, vi, beforeEach } from "vitest";
import Link from "next/link";
import type { ReactElement } from "react";

// Mirrors reports/page.test.ts's own RedirectSignal technique.
class RedirectSignal extends Error {
  constructor(public target: string) {
    super(`REDIRECT:${target}`);
  }
}

// Walks EVERY prop value, not just `children` -- this page's "New
// article" link is passed through PageHeader's own `actions` prop (a
// sibling prop, not children), which a children-only traversal (the
// shape reports/page.test.ts's own helper uses, sufficient for ITS
// simpler tree) would silently never reach.
function collectLinkHrefs(node: unknown): string[] {
  if (node === null || node === undefined || typeof node === "boolean" || typeof node === "string" || typeof node === "number") {
    return [];
  }
  if (Array.isArray(node)) return node.flatMap(collectLinkHrefs);
  if (typeof node !== "object") return [];
  const element = node as ReactElement<Record<string, unknown>>;
  if (!("props" in element)) return [];
  const ownHref = element.type === Link && typeof element.props.href === "string" ? [element.props.href] : [];
  const propHrefs = Object.values(element.props).flatMap((value) => collectLinkHrefs(value));
  return [...ownHref, ...propHrefs];
}

const mockRequireStaff = vi.fn();
const mockHasPermission = vi.fn();
vi.mock("@/lib/staff", () => ({
  requireStaff: (permission: string) => mockRequireStaff(permission),
  hasPermission: (permission: string) => mockHasPermission(permission),
}));

const mockReturns = vi.fn((): Promise<{ data: unknown[] }> => Promise.resolve({ data: [] }));
const mockOrder = vi.fn((_column: string, _opts: { ascending: boolean }) => ({ returns: mockReturns }));
const mockSelect = vi.fn((_columns: string) => ({ order: mockOrder }));
const mockFrom = vi.fn((_table: string) => ({ select: mockSelect }));
const mockCreateClient = vi.fn(() => Promise.resolve({ from: mockFrom }));
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));

const { default: AdminBlogListPage } = await import("./page");

describe("AdminBlogListPage", () => {
  beforeEach(() => {
    mockRequireStaff.mockReset().mockResolvedValue({ userId: "staff-1", role: "editor" });
    mockHasPermission.mockReset().mockResolvedValue(false);
    mockFrom.mockClear();
    mockSelect.mockClear();
    mockOrder.mockClear();
    mockReturns.mockReset().mockResolvedValue({ data: [] });
  });

  it("gates on requireStaff('blog.view')", async () => {
    mockRequireStaff.mockResolvedValueOnce({ userId: "staff-1", role: "editor" });
    await AdminBlogListPage({ searchParams: Promise.resolve({}) });
    expect(mockRequireStaff).toHaveBeenCalledWith("blog.view");
  });

  it("a denied requireStaff('blog.view') propagates its own redirect before any query runs", async () => {
    mockRequireStaff.mockImplementationOnce(() => {
      throw new RedirectSignal("/");
    });

    await expect(AdminBlogListPage({ searchParams: Promise.resolve({}) })).rejects.toBeInstanceOf(
      RedirectSignal,
    );
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("blog.view without blog.manage: shows neither 'New article' nor any 'Edit' link, but does show 'Preview'", async () => {
    mockRequireStaff.mockResolvedValueOnce({ userId: "staff-1", role: "editor" });
    mockHasPermission.mockResolvedValueOnce(false);
    mockReturns.mockResolvedValueOnce({
      data: [
        {
          id: "post-1",
          title: "A Post",
          slug: "a-post",
          status: "draft",
          category: "writing",
          published_at: null,
          updated_at: new Date().toISOString(),
        },
      ],
    });

    const page = await AdminBlogListPage({ searchParams: Promise.resolve({}) });
    const hrefs = collectLinkHrefs(page);

    expect(hrefs).not.toContain("/admin/blog/new");
    expect(hrefs).not.toContain("/admin/blog/post-1/edit");
    expect(hrefs).toContain("/admin/blog/post-1/preview");
  });

  it("blog.manage: shows both 'New article' and 'Edit' links", async () => {
    mockRequireStaff.mockResolvedValueOnce({ userId: "staff-1", role: "editor" });
    mockHasPermission.mockResolvedValueOnce(true);
    mockReturns.mockResolvedValueOnce({
      data: [
        {
          id: "post-1",
          title: "A Post",
          slug: "a-post",
          status: "draft",
          category: "writing",
          published_at: null,
          updated_at: new Date().toISOString(),
        },
      ],
    });

    const page = await AdminBlogListPage({ searchParams: Promise.resolve({}) });
    const hrefs = collectLinkHrefs(page);

    expect(hrefs).toContain("/admin/blog/new");
    expect(hrefs).toContain("/admin/blog/post-1/edit");
  });

  it("orders by updated_at descending -- latest updated first", async () => {
    mockRequireStaff.mockResolvedValueOnce({ userId: "staff-1", role: "editor" });
    mockHasPermission.mockResolvedValueOnce(false);
    mockReturns.mockResolvedValueOnce({ data: [] });

    await AdminBlogListPage({ searchParams: Promise.resolve({}) });

    expect(mockOrder).toHaveBeenCalledWith("updated_at", { ascending: false });
  });

  it("never selects *, only explicit columns needed by this list", async () => {
    mockRequireStaff.mockResolvedValueOnce({ userId: "staff-1", role: "editor" });
    mockHasPermission.mockResolvedValueOnce(false);
    mockReturns.mockResolvedValueOnce({ data: [] });

    await AdminBlogListPage({ searchParams: Promise.resolve({}) });

    const selectArg = mockSelect.mock.calls[0][0] as string;
    expect(selectArg).not.toContain("*");
    expect(selectArg).toContain("id");
    expect(selectArg).toContain("status");
  });
});
