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
// Walkthrough F1+F2: the .eq() filters each read names.
const eqs: { table: string; column: string; value: unknown }[] = [];
const mockAdminFrom = vi.fn((table: string) => {
  // ADMIN-3-REVIEW: a `.in()` read (the review deciders' names) answers
  // from "<table>:in" when a test sets one.
  let key = table;
  const done = () => Promise.resolve(rows[key] ?? rows[table] ?? { data: null, error: null });
  const chain = {
    select: (columns?: string) => (selects.push({ table, columns: columns ?? "" }), chain),
    eq: (column: string, value: unknown) => (eqs.push({ table, column, value }), chain),
    is: () => chain,
    in: () => ((key = `${table}:in`), chain),
    order: () => chain,
    limit: () => chain,
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
  setPdEditionAsStaff: vi.fn(),
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

  // BD15 follow-up (F1 audit N3): the Unpublish panel says when it
  // couldn't read the bundles, instead of dropping the line.
  it("the Unpublish panel says so when the bundle list can't be read", async () => {
    rows.bundle_books = { data: null, error: { message: "boom" } };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const html = await render("moderator");
    expect(html).toContain("Unpublish now");
    expect(html).toContain("Couldn’t check which bundles this also unpublishes. Please reload the page.");
    expect(html).not.toContain("This also unpublishes:");
    expect(html).not.toContain("boom");
    errorSpy.mockRestore();
  });

  it("the Unpublish panel has no bundle line when the book is in no bundle", async () => {
    rows.bundle_books = { data: [], error: null };
    const html = await render("moderator");
    expect(html).toContain("Unpublish now");
    expect(html).not.toContain("This also unpublishes");
    expect(html).not.toContain("Couldn’t check which bundles");
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

    // BD15 P7: the Public-domain edition box shows only for a PD book.
    it("BD15 P7: no public-domain box or pd_works read for an ordinary book", async () => {
      const html = await render("admin");
      expect(html).not.toContain("Public-domain edition");
      expect(mockAdminFrom.mock.calls.some(([table]) => table === "pd_works")).toBe(false);
    });

    it("BD15 P7: an unlinked public-domain draft gets the box and a note by Approve (the database refuses LB498)", async () => {
      rows.book_rights_declarations = {
        data: [{ declared_at: "2026-09-01T09:00:00Z", author_public_name: "Ana Kola", pen_name: "Ana Pena", statement_text: "x", basis: "public_domain" }],
        error: null,
      };
      rows.pd_works = { data: [{ id: OTHER_ID, title: "Lahuta", original_author: "Gjergj Fishta", picked_book_id: null }], error: null };
      const html = await render("admin");
      expect(html).toContain("Public-domain edition");
      expect(html).toContain("Link it to a work in the Public-domain edition box first.");
      expect(html).toContain(`value="${OTHER_ID}"`);
      expect(html).toContain('name="editorCredit"');
    });

    it("books.review staff get the panel: file link, cover, three checks, Approve and Send back", async () => {
      const html = await render("admin");
      expect(html).toContain("Review this book");
      expect(html).toContain("In review");
      expect(html).toContain(`href="/admin/books/${BOOK_ID}/file?review=${REVIEW_ID}"`);
      expect(html).toContain("Open the book file");
      expect(html).toContain(`src="https://cdn.test/${COVER}"`);
      for (const label of [
        "The cover is fine",
        "The book file opens",
        // BD15 P5b-3a (Renato 11-04, b): one box for the rights.
        "The author declared their rights and it isn't someone else's work",
      ]) {
        expect(html.replace(/&#x27;/g, "'")).toContain(label);
      }
      expect(html.match(/type="checkbox"[^>]*required=""/g) ?? []).toHaveLength(3);
      expect(html).toContain('name="rights_ok"');
      expect(html).not.toContain('name="not_someone_elses_work"');
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

    it("a live book with nothing waiting shows no review panel, whatever its history", async () => {
      rows.books.data = { ...(rows.books.data as object), status: "published" };
      rows.book_reviews = { data: [{ ...pending, status: "approved", decided_at: "2026-10-18T10:00:00Z" }], error: null };
      const html = await render("admin");
      expect(html).not.toContain("Approve and publish");
      expect(html).not.toContain("Approve changes");
      expect(html).not.toContain("Review this book");
    });

    // BD15 P5b-2 (Renato 11-04, Q2 a): a live book's changes in review,
    // only what changed, live beside new.
    describe("a live book's changes", () => {
      const NEW_COVER = "1a2b3c4d-5e6f-4a0b-9c1d-2e3f4a5b6c7d/cover.png";
      const NEW_FILE = "author-1/22222222-2222-4222-8222-222222222222/1a2b3c4d-5e6f-4a0b-9c1d-2e3f4a5b6c7d.epub";
      const sent = { ...pending, file_path: NEW_FILE, cover_path: NEW_COVER, description: "New text", is_adult: false };
      beforeEach(() => {
        rows.books.data = {
          ...(rows.books.data as object),
          status: "published",
          file_path: FILE,
          cover_path: COVER,
          description: "Live text",
          is_adult: false,
          original_author: null,
        };
        rows.book_reviews = { data: [sent], error: null };
        rows.book_pending_changes = {
          data: { file_path: NEW_FILE, cover_path: NEW_COVER, description: "New text", is_adult: false, original_author: null },
          error: null,
        };
      });

      it("shows only what changed, live beside new, and Approve changes", async () => {
        const html = await render("admin");
        expect(html).toContain("What changed");
        expect(html).toContain(`src="https://cdn.test/${COVER}"`);
        expect(html).toContain(`src="https://cdn.test/${NEW_COVER}"`);
        expect(html).toContain("Open the new book file");
        expect(html).toContain("Live text");
        expect(html).toContain("New text");
        expect(html).not.toContain("18+ label");
        expect(html).not.toContain("Original author</p>");
        expect(html).toContain("Approve changes");
        expect(html).toContain(`name="filePath" value="${NEW_FILE}"`);
        expect(html).toContain(`name="coverPath" value="${NEW_COVER}"`);
        expect(selects.some((s) => s.table === "book_pending_changes")).toBe(true);
      });

      it.each<[string, () => void]>([
        ["the waiting row changed since it was sent", () => {
          (rows.book_pending_changes.data as Record<string, unknown>).description = "Edited again";
        }],
        ["there is no waiting row", () => (rows.book_pending_changes = { data: null, error: null })],
        ["the waiting row is unreadable", () => (rows.book_pending_changes = { data: null, error: { message: "boom" } })],
      ])("no Approve when %s", async (_label, arrange) => {
        arrange();
        const html = await render("admin");
        expect(html).not.toContain("Approve changes");
        expect(html).not.toContain("boom");
      });
    });

    // BD15 F1 (Renato 11-05, D1 b): a book in a published bundle may
    // change; the review box names the bundle(s), read at page load.
    describe("a book in a published bundle", () => {
      const NOTE = "This book is in a published bundle:";
      const BUNDLE_2 = "44444444-4444-4444-8444-444444444444";
      beforeEach(() => {
        rows.books.data = { ...(rows.books.data as object), status: "published", description: null, is_adult: false };
        rows.book_reviews = { data: [{ ...pending, description: null, is_adult: false }], error: null };
        rows.book_pending_changes = {
          data: { file_path: FILE, cover_path: COVER, description: null, is_adult: false, original_author: null },
          error: null,
        };
      });

      it("a live book's changes: names the bundle with a link, Approve still offered", async () => {
        const html = await render("admin");
        expect(html).toContain(NOTE);
        expect(html).toMatch(/href="\/paketa\/bundle-1"[^>]*>Set A<\/a>/);
        expect(html).toContain("Approved changes reach its buyers too.");
        expect(html).toContain("Approve changes");
        expect(
          selects.some((s) => s.table === "bundle_books" && s.columns.includes("bundle_id") && s.columns.includes("bundles!inner(title, status)")),
        ).toBe(true);
      });

      it("names every published bundle", async () => {
        rows.bundle_books = {
          data: [
            { bundle_id: "bundle-1", bundles: { title: "Set A", status: "published" } },
            { bundle_id: BUNDLE_2, bundles: { title: "Set B", status: "published" } },
          ],
          error: null,
        };
        const html = await render("admin");
        expect(html).toMatch(/>Set A<\/a><\/span><span>, <a[^>]*href="\/paketa\/44444444-4444-4444-8444-444444444444"[^>]*>Set B<\/a>/);
      });

      it("staff without books.review see the note too", async () => {
        const html = await render("moderator");
        expect(html).toContain(NOTE);
        expect(html).not.toContain("Approve changes");
      });

      it("a first review (draft) in a published bundle shows it as well", async () => {
        rows.books.data = { ...(rows.books.data as object), status: "draft" };
        rows.book_reviews = { data: [pending], error: null };
        const html = await render("admin");
        expect(html).toContain(NOTE);
        expect(html).toContain("Approve and publish");
      });

      it.each<[string, Result]>([
        ["in no bundle", { data: [], error: null }],
        ["only in a draft bundle", { data: [{ bundle_id: "bundle-1", bundles: { title: "Set A", status: "draft" } }], error: null }],
      ])("no note when the book is %s", async (_label, result) => {
        rows.bundle_books = result;
        const html = await render("admin");
        expect(html).not.toContain(NOTE);
        expect(html).not.toContain("Couldn’t check whether this book is in a published bundle.");
        expect(html).toContain("Approve changes");
      });

      it("no note without a waiting review", async () => {
        rows.book_reviews = { data: [], error: null };
        expect(await render("admin")).not.toContain(NOTE);
      });

      it("an unreadable membership says so, never shows as no bundle", async () => {
        rows.bundle_books = { data: null, error: { message: "boom" } };
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const html = await render("admin");
        expect(html).toContain("Couldn’t check whether this book is in a published bundle. Please reload the page.");
        expect(html).not.toContain(NOTE);
        expect(html).not.toContain("boom");
        expect(errorSpy).toHaveBeenCalledWith("admin book: the published bundles read failed", expect.anything());
        errorSpy.mockRestore();
      });
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

  // ============================================================
  // Walkthrough F1+F2 (Renato 11-05, a): the read-only Book details box,
  // on every staff book page, for every staff role.
  // ============================================================
  describe("book details (walkthrough F1+F2)", () => {
    const SERIES_ID = "44444444-4444-4444-8444-444444444444";
    beforeEach(() => {
      selects.length = 0;
      eqs.length = 0;
    });
    const full = () => {
      rows.books.data = {
        ...(rows.books.data as object),
        description: "**Një** histori e gjatë.",
        is_adult: true,
        categories: ["Romancë", "Thriller"],
        genre: "Romancë",
        reading_age_min: 18,
        edition_number: 2,
        edition: null,
        series_id: SERIES_ID,
        series_position: 3,
        keywords: "dashuri, Tiranë, dashuri",
        publisher: "Shtëpia Test",
        isbn: "9780000000002",
      };
      rows.series = { data: { title: "Trilogjia" }, error: null };
      rows.book_contributors = {
        data: [
          { name: "Bora Test", role: "Illustrator" },
          { name: "Dritë Test", role: "Translator" },
        ],
        error: null,
      };
      rows.book_ai_disclosures = { data: { ai_used: true }, error: null };
    };

    it("shows every detail and the AI answer, even to a role that may only look", async () => {
      full();
      for (const role of ["moderator", "viewer"]) {
        const html = await render(role);
        expect(html).toContain(">Book details<");
        expect(html).toContain("<dt class=\"font-semibold\">AI used</dt><dd class=\"break-words\">Yes, AI was used</dd>");
        expect(html).toContain("Romancë, Thriller");
        expect(html).toContain("<dt class=\"font-semibold\">18+</dt><dd class=\"break-words\">Yes</dd>");
        expect(html).toContain("<dt class=\"font-semibold\">Reading age</dt><dd class=\"break-words\">18+</dd>");
        expect(html).toContain("Trilogjia, book 3");
        expect(html).toContain("<dt class=\"font-semibold\">Edition</dt><dd class=\"break-words\">2</dd>");
        expect(html).toContain("Bora Test (Illustrator), Dritë Test (Translator)");
        expect(html).toContain("dashuri, Tiranë</dd>");
        expect(html).toContain("Shtëpia Test");
        expect(html).toContain("9780000000002");
        // Plain text: no "**" marks.
        expect(html).toContain("Një histori e gjatë.");
        expect(html).not.toContain("**Një**");
      }
      // The AI answer is read by book id from the staff-only table.
      expect(selects).toContainEqual({ table: "book_ai_disclosures", columns: "ai_used" });
      expect(selects).toContainEqual({ table: "book_contributors", columns: "name, role" });
      expect(selects).toContainEqual({ table: "series", columns: "title" });
      expect(eqs).toContainEqual({ table: "book_ai_disclosures", column: "book_id", value: BOOK_ID });
      expect(eqs).toContainEqual({ table: "book_contributors", column: "book_id", value: BOOK_ID });
      expect(eqs).toContainEqual({ table: "series", column: "id", value: SERIES_ID });
      const bookRead = selects.find((s) => s.table === "books")?.columns ?? "";
      for (const column of ["categories", "genre", "reading_age_min", "edition_number", "edition", "series_id", "series_position", "keywords", "publisher", "isbn"]) {
        expect(bookRead.split(", ")).toContain(column);
      }
      // Not waiting for review: no "waiting changes" note.
      expect(await render("moderator")).not.toContain("The waiting changes are under What changed.");
    });

    it("says No and Not answered, and None / Not set for empty values", async () => {
      rows.book_ai_disclosures = { data: { ai_used: false }, error: null };
      let html = await render("moderator");
      expect(html).toContain("AI used</dt><dd class=\"break-words\">No</dd>");
      rows.book_ai_disclosures = { data: null, error: null };
      html = await render("moderator");
      expect(html).toContain("AI used</dt><dd class=\"break-words\">Not answered</dd>");
      expect(html).toContain("Series</dt><dd class=\"break-words\">None</dd>");
      expect(html).toContain("Contributors</dt><dd class=\"break-words\">None</dd>");
      expect(html).toContain("ISBN</dt><dd class=\"break-words\">Not set</dd>");
      expect(html).toContain("Description</dt><dd class=\"max-h-48 overflow-y-auto whitespace-pre-wrap break-words\">None</dd>");
      // No series id: the series is never read.
      expect(selects.some((s) => s.table === "series")).toBe(false);
    });

    it("says when the AI answer, series or contributors can't be read, never None", async () => {
      full();
      rows.book_ai_disclosures = { data: null, error: { message: "boom" } };
      rows.series = { data: null, error: { message: "boom" } };
      rows.book_contributors = { data: null, error: { message: "boom" } };
      const html = await render("moderator");
      expect(html).toContain("<dd class=\"break-words text-red-700\">Couldn’t load the AI answer.</dd>");
      expect(html).toContain("<dd class=\"break-words text-red-700\">Couldn’t load the series.</dd>");
      expect(html).toContain("<dd class=\"break-words text-red-700\">Couldn’t load the contributors.</dd>");
      expect(html).not.toContain("Not answered");
      expect(html).not.toContain("boom");
    });
  });

  // ============================================================
  // BD16 P3: pre-orders (listing, final file, after a lift).
  // ============================================================
  describe("BD16 P3: pre-orders", () => {
    const REVIEW_ID = "55555555-5555-4555-8555-555555555555";
    const FILE = "author-1/22222222-2222-4222-8222-222222222222/0f0e0d0c-0b0a-4908-8706-050403020100.epub";
    const COVER = "0f0e0d0c-0b0a-4908-8706-050403020100/cover.png";
    const review = (fields: Record<string, unknown>) => ({
      id: REVIEW_ID,
      status: "pending",
      grandfathered: false,
      buyer_file_only: false,
      submitted_at: new Date(Date.now() - 3_600_000).toISOString(),
      decided_at: null,
      decided_by: null,
      reason: null,
      file_path: null,
      cover_path: COVER,
      original_author: null,
      description: "Text",
      is_adult: false,
      release_date: null,
      ...fields,
    });
    const setBook = (fields: Record<string, unknown>) => {
      rows.books.data = {
        ...(rows.books.data as object),
        published_at: null,
        file_path: null,
        cover_path: COVER,
        description: "Text",
        is_adult: false,
        original_author: null,
        preorder_count: 1,
        preorder_slip_used: false,
        ...fields,
      };
    };

    it("a listing without a file, in time: two boxes, no file link, Approve the pre-order", async () => {
      setBook({ status: "draft", release_date: "2099-01-10" });
      rows.book_reviews = { data: [review({ release_date: "2099-01-10" })], error: null };
      const html = await render("admin");
      expect(html).toContain("This is a pre-order listing.");
      expect(html).toContain("No file yet: the author must send the final file by 7 Jan 2099.");
      expect(html).toContain("Approve the pre-order");
      expect(html).not.toContain('name="file_opens"');
      expect(html).toContain('name="cover_is_fine"');
      expect(html).not.toContain("Open the book file");
    });

    it("a listing too late (LB506): no Approve, only Send back", async () => {
      setBook({ status: "draft", release_date: "2020-01-10" });
      rows.book_reviews = { data: [review({ release_date: "2020-01-10" })], error: null };
      const html = await render("admin");
      expect(html).toContain("Too late to approve");
      expect(html).not.toContain("Approve the pre-order");
      expect(html).toContain("Send back to the author");
    });

    it("a listing whose date changed after sending is not approvable", async () => {
      setBook({ status: "draft", release_date: "2099-02-10" });
      rows.book_reviews = { data: [review({ release_date: "2099-01-10" })], error: null };
      const html = await render("admin");
      expect(html).not.toContain("Approve the pre-order");
    });

    it("a pre-order's final file after its day: Approve and release now, the send-back deadline, the Pre-order box", async () => {
      setBook({ status: "preorder", release_date: "2020-01-10" });
      rows.book_reviews = { data: [review({ file_path: FILE })], error: null };
      rows.book_pending_changes = {
        data: { file_path: FILE, cover_path: COVER, description: "Text", is_adult: false, original_author: null },
        error: null,
      };
      const html = await render("admin");
      expect(html).toContain("Pre-order · comes out 10 Jan 2020");
      expect(html).toContain("approving releases the book at once");
      expect(html).toContain("Approve and release now");
      expect(html).toContain("Final book file");
      expect(html).toContain("If you send the final file back, the author has until");
      expect(html).toContain("Final file waiting for review. The release day has passed");
      expect(html).toContain("Pre-order 1 of 2 for this book.");
      expect(html).toContain("Unpublishing cancels the pre-order");
      expect(html).toContain('href="/libra/22222222-2222-4222-8222-222222222222"');
    });

    // Audit r1 N4: any pre-order review with a file releases once the day has passed.
    it("a pre-order with its file already approved, changes waiting after its day: Approve and release now", async () => {
      setBook({ status: "preorder", file_path: FILE, release_date: "2020-01-10" });
      rows.book_reviews = { data: [review({ file_path: FILE, description: "New" })], error: null };
      rows.book_pending_changes = {
        data: { file_path: FILE, cover_path: COVER, description: "New", is_adult: false, original_author: null },
        error: null,
      };
      const html = await render("admin");
      expect(html).toContain("Approve and release now");
    });

    it("after a lifted suspension (a saved, unsent final file): staff are told the author must send it again", async () => {
      setBook({ status: "preorder", release_date: "2099-01-10" });
      rows.book_reviews = { data: [], error: null };
      rows.book_pending_changes = {
        data: { file_path: FILE, cover_path: COVER, description: "Text", is_adult: false, original_author: null },
        error: null,
      };
      const html = await render("admin");
      expect(html).toContain("After a suspension is lifted, the author must send the final file again.");
      expect(html).not.toContain("Review this book");
    });
  });
});
