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
// ADMIN-3 r2: the columns each read names.
const selects: { table: string; columns: string }[] = [];
const mockAdminFrom = vi.fn((table: string) => {
  // ADMIN-3-REVIEW: a `.in()` read (the review deciders' names) answers
  // from "<table>:in" when a test sets one.
  let key = table;
  const done = () => Promise.resolve(rows[key] ?? rows[table] ?? { data: null, error: null });
  const chain = {
    select: (columns?: string) => (selects.push({ table, columns: columns ?? "" }), chain),
    eq: () => chain,
    is: () => chain,
    in: () => ((key = `${table}:in`), chain),
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

vi.mock("../actions", () => ({
  unpublishBookAsStaff: vi.fn(),
  allowBookAgainAsStaff: vi.fn(),
  approveBookReviewAsStaff: vi.fn(),
  sendBackBookReviewAsStaff: vi.fn(),
}));

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
    expect(html).toContain("Live · Paid · 499 lekë");
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

  // SMALL-FIXES-1 (2a): the live-book wording is unchanged.
  it("on a live book, says the book leaves the Bookstore at once", async () => {
    const html = await render("moderator");
    expect(html).toContain("The book leaves the Bookstore at once.");
    expect(html).not.toContain("The book stays out of the Bookstore.");
    expect(html).not.toContain("This also cancels the waiting review.");
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

  // ============================================================
  // ADMIN-3-REVIEW (H, 6): the review panel and the review history.
  // ============================================================
  describe("review (ADMIN-3)", () => {
    const REVIEW_ID = "55555555-5555-4555-8555-555555555555";
    const FILE = "author-1/22222222-2222-4222-8222-222222222222/0f0e0d0c-0b0a-4908-8706-050403020100.epub";
    const COVER = "0f0e0d0c-0b0a-4908-8706-050403020100/cover.png";
    const pending = {
      id: REVIEW_ID,
      status: "pending",
      grandfathered: false,
      buyer_file_only: false,
      submitted_at: new Date(Date.now() - 3 * 3_600_000).toISOString(),
      decided_at: null,
      decided_by: null,
      reason: null,
      file_path: FILE,
      cover_path: COVER,
      original_author: null,
    };

    beforeEach(() => {
      rows.books.data = { ...(rows.books.data as object), status: "draft", file_path: FILE, cover_path: COVER };
      rows.book_reviews = { data: [pending], error: null };
    });

    it("books.review staff get the panel: file link, cover, four checks, Approve and Send back", async () => {
      const html = await render("admin");
      expect(html).toContain("Review this book");
      expect(html).toContain("In review");
      expect(html).toContain(`href="/admin/books/${BOOK_ID}/file?review=${REVIEW_ID}"`);
      expect(html).toContain("Open the book file");
      expect(html).toContain(`src="https://cdn.test/${COVER}"`);
      for (const label of [
        "The cover is fine",
        "The book file opens",
        "It isn't someone else's work",
        "The author declared their rights",
      ]) {
        expect(html.replace(/&#x27;/g, "'")).toContain(label);
      }
      expect(html.match(/type="checkbox"[^>]*required=""/g) ?? []).toHaveLength(4);
      expect(html).toContain(`name="reviewId" value="${REVIEW_ID}"`);
      expect(html).toContain(`name="filePath" value="${FILE}"`);
      expect(html).toContain(`name="coverPath" value="${COVER}"`);
      expect(html).toContain("Approve and publish");
      expect(html).toContain(">Send back</summary>");
    });

    // PEOPLE-2 (N3, Renato's 4b): the book stays in the queue, badged;
    // Approve is still offered (the database refuses it, with a clear line).
    it("a suspended author's book: a Suspended badge linking to the person, a note, Approve still there", async () => {
      rows.account_suspensions = { data: { id: "s1" }, error: null };
      const html = await render("admin");
      expect(html).toContain(">Suspended</span>");
      expect(html).toMatch(/href="\/admin\/people\/author-1"[^>]*>Open the author&#x27;s account<\/a>/);
      expect(html).toContain("Approving is refused until the suspension is lifted. Send back still works.");
      expect(html).toContain("Approve and publish");
      expect(html).toContain(">Send back</summary>");
    });

    it("no badge when the author isn't suspended, or the read fails", async () => {
      expect(await render("admin")).not.toContain(">Suspended</span>");
      rows.account_suspensions = { data: null, error: { message: "boom" } };
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const html = await render("admin");
      expect(html).not.toContain(">Suspended</span>");
      expect(html).toContain("Approve and publish");
      errorSpy.mockRestore();
    });

    it("staff without books.review see that it is in review, read-only", async () => {
      const html = await render("moderator");
      expect(html).toMatch(/>In review<\/h2>/);
      expect(html).toContain("Only owners and admins can approve or send back a book.");
      expect(html).not.toContain("Approve and publish");
      expect(html).not.toContain("Open the book file");
    });

    it("files changed since it was sent: no Approve, says why", async () => {
      rows.books.data = { ...(rows.books.data as object), cover_path: "1a2b3c4d-5e6f-4a0b-9c1d-2e3f4a5b6c7d/cover.png" };
      const html = await render("admin");
      expect(html).toContain("The author changed the file, cover or original author after sending it.");
      expect(html).not.toContain("Approve and publish");
    });

    // BD3 patch 4 (2b, 16:45Z a): the approval binds to the original author.
    it("original author changed since it was sent: no Approve, says why", async () => {
      rows.books.data = { ...(rows.books.data as object), original_author: "Homeri" };
      const html = await render("admin");
      expect(html).toContain("The author changed the file, cover or original author after sending it.");
      expect(html).not.toContain("Approve and publish");
    });

    it("the same original author as sent: Approve is offered", async () => {
      rows.books.data = { ...(rows.books.data as object), original_author: "Homeri" };
      rows.book_reviews = { data: [{ ...pending, original_author: "Homeri" }], error: null };
      const html = await render("admin");
      expect(html).toContain("Approve and publish");
      expect(selects.some((s) => s.table === "book_reviews" && s.columns.includes("original_author"))).toBe(true);
    });

    it("a live book shows no review panel, whatever its history", async () => {
      rows.books.data = { ...(rows.books.data as object), status: "published" };
      const html = await render("admin");
      expect(html).not.toContain("Approve and publish");
      expect(html).not.toContain("Review this book");
    });

    it("an unreadable review state says so, offers nothing", async () => {
      rows.book_reviews = { data: null, error: { message: "boom" } };
      const html = await render("admin");
      expect(html).toContain("Couldn’t check whether this book is waiting for review.");
      expect(html).toContain("Couldn’t load the review history.");
      expect(html).not.toContain("Approve and publish");
      expect(html).not.toContain("boom");
    });

    it("lists the review history newest first, with the decision, reason and who decided", async () => {
      rows.book_reviews = {
        data: [
          pending,
          { ...pending, id: "r2", status: "sent_back", reason: "broken_file", decided_at: "2026-10-18T10:00:00Z", decided_by: "staff-9" },
          { ...pending, id: "r3", status: "approved", grandfathered: true, decided_at: "2026-10-01T10:00:00Z" },
        ],
        error: null,
      };
      rows["profiles:in"] = { data: [{ id: "staff-9", display_name: "Renato" }], error: null };
      const html = await render("admin");
      const history = html.slice(html.indexOf("Review history"));
      expect(history).toContain("Waiting");
      expect(history).toContain("Sent back · Wrong or broken file · by Renato");
      expect(history).toContain("Live before reviews began");
      expect(history.indexOf("Waiting")).toBeLessThan(history.indexOf("Sent back"));
    });

    it("a backfilled readers' copy row (buyer_file_only) gets its own label, not 'Live before reviews began' (R5/U1)", async () => {
      rows.book_reviews = {
        data: [{ ...pending, id: "r4", status: "approved", grandfathered: true, buyer_file_only: true, decided_at: "2026-10-01T10:00:00Z" }],
        error: null,
      };
      const html = await render("admin");
      const history = html.slice(html.indexOf("Review history")).replace(/&#x27;/g, "'");
      expect(history).toContain("Readers' copy from before reviews began (needs review to go live)");
      expect(history).not.toContain("Live before reviews began");
      expect(history).not.toContain("Approved");
    });

    it("the history read names buyer_file_only", async () => {
      rows.book_reviews = { data: [], error: null };
      await render("admin");
      expect(selects.some((s) => s.table === "book_reviews" && s.columns.includes("buyer_file_only"))).toBe(true);
    });

    // SMALL-FIXES-1 (2a, audit A5): a draft is not in the Bookstore.
    it("the Unpublish panel on an in-review draft: stays out of the Bookstore, and cancels the waiting review", async () => {
      const html = await render("admin");
      expect(html).toContain("Unpublish now");
      expect(html).toContain("The book stays out of the Bookstore.");
      expect(html).toContain("The author can&#x27;t publish it until you allow it.");
      expect(html).toContain("This also cancels the waiting review.");
      expect(html).not.toContain("leaves the Bookstore at once");
    });

    it("the Unpublish panel on a draft with no waiting review: no cancel line", async () => {
      rows.book_reviews = { data: [], error: null };
      const html = await render("admin");
      expect(html).toContain("The book stays out of the Bookstore.");
      expect(html).not.toContain("This also cancels the waiting review.");
      expect(html).not.toContain("leaves the Bookstore at once");
    });

    it("a book never sent for review says so", async () => {
      rows.book_reviews = { data: [], error: null };
      expect(await render("admin")).toContain("Never sent for review.");
    });
  });
});
