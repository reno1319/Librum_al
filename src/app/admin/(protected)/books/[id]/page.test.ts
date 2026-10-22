import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

// ADMIN-2-TAKEDOWN (C): the admin book page. Rendered to static HTML per
// permission and state: who sees the Unpublish panel, the taken-down
// panel and its "Allow again" button, and that ?report= is carried only
// for an OPEN report of this book.
class RedirectSignal extends Error {
  constructor(public target: string) {
    super(`REDIRECT:${target}`);
  }
}
class NotFoundSignal extends Error {}

const mockRequireStaff = vi.fn(
  (permission: string): Promise<{ userId: string; role: string }> => {
    void permission;
    return Promise.resolve({ userId: "staff-1", role: "moderator" });
  },
);
vi.mock("@/lib/staff", () => ({ requireStaff: (permission: string) => mockRequireStaff(permission) }));

// Every role that holds reports.view holds reports.resolve today; a
// made-up "viewer" role stands in for one that may only look.
vi.mock("@/lib/staff-permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/staff-permissions")>();
  return {
    ...actual,
    roleHasPermission: (role: string, permission: string) =>
      role === "viewer" ? permission !== "reports.resolve" : actual.roleHasPermission(role as never, permission as never),
  };
});

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFoundSignal();
  },
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));

type Result = { data: unknown; error: { message: string } | null };
let rows: Record<string, Result> = {};
const mockAdminFrom = vi.fn((table: string) => {
  const done = () => Promise.resolve(rows[table] ?? { data: null, error: null });
  const chain = {
    select: () => chain,
    eq: () => chain,
    is: () => chain,
    in: () => chain,
    order: () => chain,
    maybeSingle: done,
    returns: done,
  };
  return chain;
});
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: mockAdminFrom,
    storage: { from: () => ({ getPublicUrl: (p: string) => ({ data: { publicUrl: `https://cdn.test/${p}` } }) }) },
  }),
}));

vi.mock("../actions", () => ({ unpublishBookAsStaff: vi.fn(), allowBookAgainAsStaff: vi.fn() }));

const { default: AdminBookPage } = await import("./page");

const BOOK_ID = "22222222-2222-4222-8222-222222222222";
const REPORT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "33333333-3333-4333-8333-333333333333";

async function render(role: string, search: Record<string, string> = {}): Promise<string> {
  mockRequireStaff.mockResolvedValueOnce({ userId: "staff-1", role });
  const element = await AdminBookPage({
    params: Promise.resolve({ id: BOOK_ID }),
    searchParams: Promise.resolve(search),
  });
  return renderToStaticMarkup(element as ReactElement);
}

describe("AdminBookPage", () => {
  beforeEach(() => {
    mockAdminFrom.mockClear();
    rows = {
      books: {
        data: {
          id: BOOK_ID,
          title: "Kënga e fundit",
          status: "published",
          price_all: 499,
          published_at: "2026-09-01T10:00:00Z",
          cover_path: null,
          author_id: "author-1",
          pen_name_id: "pen-1",
          pen: { name: "Ana Pena" },
        },
        error: null,
      },
      profiles: { data: { display_name: "Ana Kola", public_author_name: "Ana Kola" }, error: null },
      book_reports: {
        data: [{ id: REPORT_ID, reason: "Copyright infringement", details: "My text", created_at: "2026-10-17T08:00:00Z" }],
        error: null,
      },
      book_rights_declarations: {
        data: [
          {
            declared_at: "2026-09-01T09:00:00Z",
            author_public_name: "Ana Kola",
            pen_name: "Ana Pena",
            statement_text: "I wrote this book",
          },
        ],
        error: null,
      },
      book_takedowns: { data: null, error: null },
      bundle_books: { data: [{ bundle_id: "bundle-1", bundles: { title: "Set A", status: "published" } }], error: null },
    };
  });

  it("gates on requireStaff('reports.view') and reads nothing when denied", async () => {
    mockRequireStaff.mockImplementationOnce(() => {
      throw new RedirectSignal("/?denied");
    });
    await expect(
      AdminBookPage({ params: Promise.resolve({ id: BOOK_ID }), searchParams: Promise.resolve({}) }),
    ).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockRequireStaff).toHaveBeenCalledWith("reports.view");
    expect(mockAdminFrom).not.toHaveBeenCalled();
  });

  it("is a 404 for an id that is not a uuid, or a book that does not exist", async () => {
    mockRequireStaff.mockResolvedValueOnce({ userId: "staff-1", role: "moderator" });
    await expect(
      AdminBookPage({ params: Promise.resolve({ id: "nope" }), searchParams: Promise.resolve({}) }),
    ).rejects.toBeInstanceOf(NotFoundSignal);
    rows.books = { data: null, error: null };
    await expect(render("moderator")).rejects.toBeInstanceOf(NotFoundSignal);
  });

  it("shows the book, its open report and its rights history", async () => {
    const html = await render("moderator");
    expect(html).toContain("Live · Paid · 499 ALL");
    expect(html).toContain("Kënga e fundit");
    expect(html).toContain("by Ana Pena · published");
    expect(html).toContain("Account name: Ana Kola");
    expect(html).toContain("From a reader · 17 Oct 2026");
    expect(html).toContain(`href="/admin/reports/${REPORT_ID}"`);
    expect(html).toContain("Ana Pena chose “I wrote this book”");
    expect(html).not.toMatch(/sold|sales/i);
  });

  it("says so when there is no rights statement", async () => {
    rows.book_rights_declarations = { data: [], error: null };
    expect(await render("moderator")).toContain("No rights statement on record.");
  });

  it("offers the Unpublish panel to reports.resolve, naming the bundles it also unpublishes", async () => {
    const html = await render("moderator");
    expect(html).toContain("Unpublish now");
    expect(html).toContain("This also unpublishes: Set A.");
    expect(html).not.toContain('name="reportId"');
    expect(html).not.toContain("This also resolves the report.");
  });

  it("carries ?report= only for an open report of this book, starting on its reason", async () => {
    const html = await render("moderator", { report: REPORT_ID });
    expect(html).toContain(`name="reportId" value="${REPORT_ID}"`);
    expect(html).toContain("This also resolves the report.");
    expect(html).toMatch(/<option value="copyright" selected="">/);
    const other = await render("moderator", { report: OTHER_ID });
    expect(other).not.toContain('name="reportId"');
  });

  it("shows no form to a role that may only look", async () => {
    const html = await render("viewer");
    expect(html).not.toContain("Unpublish now");
    expect(html).toContain("Only staff who can resolve reports can unpublish a book.");
  });

  it("shows the takedown, and Allow again only for reports.resolve", async () => {
    rows.books.data = { ...(rows.books.data as object), status: "draft" };
    rows.book_takedowns = {
      data: {
        reason: "copyright",
        message_to_author: "Send proof.",
        bundle_ids: ["bundle-1"],
        taken_down_by: "staff-2",
        taken_down_at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      },
      error: null,
    };
    rows.profiles = { data: { display_name: "Renato", public_author_name: null }, error: null };
    rows.bundles = { data: [{ id: "bundle-1", title: "Set A" }], error: null };

    const html = await render("moderator");
    expect(html).toMatch(/>Taken down</);
    expect(html).toContain("Taken down 2 hours ago by Renato.");
    expect(html).toContain("Copyright complaint");
    expect(html).toContain("Send proof.");
    expect(html).toContain("Set A");
    expect(html).toContain("Allow the author to publish again");
    expect(html).not.toContain("Unpublish now");

    const viewer = await render("viewer");
    expect(viewer).not.toContain("Allow the author to publish again");
  });

  it("offers neither panel when the takedown state can't be read", async () => {
    rows.book_takedowns = { data: null, error: { message: "boom" } };
    const html = await render("moderator");
    expect(html).not.toContain("Unpublish now");
    expect(html).not.toContain("Allow the author to publish again");
    expect(html).toContain("Couldn’t check whether this book is taken down.");
    expect(html).not.toContain("boom");
  });
});
