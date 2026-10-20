import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

// ADMIN-1A pre-finalize correction: proves this page itself calls
// requireStaff("reports.view") and that a denial stops execution before
// any Supabase query runs. Mirrors src/app/admin/reports/page.test.ts.
class RedirectSignal extends Error {
  constructor(public target: string) {
    super(`REDIRECT:${target}`);
  }
}

const mockRequireStaff = vi.fn((permission: string): Promise<{ userId: string; role: string }> => {
  throw new RedirectSignal(`/?denied=${permission}`);
});
vi.mock("@/lib/staff", () => ({ requireStaff: (permission: string) => mockRequireStaff(permission) }));

// ADMIN-2-TAKEDOWN (M2, D): the report and the profiles come from the
// staff session; the book and its active takedown from the service-role
// client, after requireStaff.
type Result = { data: unknown; error: { message: string } | null };
let sessionRows: Record<string, Result> = {};
let adminRows: Record<string, Result> = {};
const adminSelects: { table: string; select: string }[] = [];

function chainFor(rows: () => Result, onSelect?: (cols: string) => void) {
  const chain = {
    select(cols: string) {
      onSelect?.(cols);
      return chain;
    },
    eq: () => chain,
    is: () => chain,
    in: () => Promise.resolve(rows()),
    maybeSingle: () => Promise.resolve(rows()),
  };
  return chain;
}

const mockFrom = vi.fn((table: string) => chainFor(() => sessionRows[table] ?? { data: null, error: null }));
const mockCreateClient = vi.fn(() => Promise.resolve({ from: mockFrom }));
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));

const mockAdminFrom = vi.fn((table: string) =>
  chainFor(
    () => adminRows[table] ?? { data: null, error: null },
    (cols) => adminSelects.push({ table, select: cols }),
  ),
);
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: mockAdminFrom }) }));

vi.mock("next/navigation", () => ({ notFound: vi.fn() }));

const { default: AdminBookReportDetailPage } = await import("./page");

const REPORT = {
  id: "11111111-1111-4111-8111-111111111111",
  book_id: "22222222-2222-4222-8222-222222222222",
  reporter_id: "reader-1",
  reason: "Copyright infringement",
  details: "",
  status: "open",
  created_at: "2026-10-17T08:00:00Z",
  reviewed_at: null,
  reviewed_by: null,
  admin_notes: null,
};

async function render(): Promise<string> {
  mockRequireStaff.mockResolvedValueOnce({ userId: "staff-1", role: "moderator" });
  const element = await AdminBookReportDetailPage({
    params: Promise.resolve({ id: REPORT.id }),
    searchParams: Promise.resolve({}),
  });
  return renderToStaticMarkup(element as ReactElement);
}

describe("AdminBookReportDetailPage", () => {
  beforeEach(() => {
    mockFrom.mockClear();
    mockAdminFrom.mockClear();
    adminSelects.length = 0;
    sessionRows = {
      book_reports: { data: REPORT, error: null },
      profiles: { data: [{ id: "author-1", display_name: "Ana", public_author_name: "Ana" }], error: null },
    };
    adminRows = {
      books: { data: { title: "Kënga e fundit", author_id: "author-1", status: "draft" }, error: null },
      book_takedowns: { data: null, error: null },
    };
  });

  it("calls requireStaff('reports.view') and never queries Supabase when denied", async () => {
    await expect(
      AdminBookReportDetailPage({
        params: Promise.resolve({ id: "report-1" }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRequireStaff).toHaveBeenCalledWith("reports.view");
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockAdminFrom).not.toHaveBeenCalled();
  });

  it("names a draft book through the staff read and links an open report to Unpublish", async () => {
    const html = await render();
    expect(html).toContain("Kënga e fundit");
    expect(html).toContain("Not currently published");
    expect(html).toContain(`href="/admin/books/${REPORT.book_id}?report=${REPORT.id}"`);
    expect(html).toContain("Unpublish this book");
    expect(adminSelects).toContainEqual({ table: "books", select: "title, author_id, status" });
  });

  it("shows Taken down, and no Unpublish link, for a book Librum took down", async () => {
    adminRows.book_takedowns = { data: { id: "td-1" }, error: null };
    const html = await render();
    expect(html).toContain("Taken down");
    expect(html).not.toContain("Not currently published");
    expect(html).not.toContain("Unpublish this book");
  });

  it("offers no Unpublish link once the report is resolved", async () => {
    sessionRows.book_reports = { data: { ...REPORT, status: "resolved" }, error: null };
    const html = await render();
    expect(html).not.toContain("Unpublish this book");
  });

  it("offers no Unpublish link when the book no longer exists", async () => {
    adminRows.books = { data: null, error: null };
    const html = await render();
    expect(html).toContain("Book unavailable");
    expect(html).not.toContain("Unpublish this book");
  });
});
