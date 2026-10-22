import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// ADMIN-2-TAKEDOWN (G, M4): the Dashboard row of a book Librum took
// down -- the TAKEN DOWN tag and the notice in place of the draft's
// missing-items list, and "Edit" rather than "Continue setup".
vi.mock("@/app/(public)/dashboard/books/actions", () => ({ deleteBook: { bind: () => async () => undefined } }));

const { AuthorBookRow } = await import("./author-book-row");

const BOOK = {
  id: "c3d4e5f6-2222-4222-8222-abcdef222222",
  title: "Kënga e fundit",
  status: "draft" as const,
  price_all: 0,
  genre: "Fiction",
  published_at: "2026-09-01T10:00:00Z",
};

function render(props: Partial<Parameters<typeof AuthorBookRow>[0]> = {}): string {
  return renderToStaticMarkup(createElement(AuthorBookRow, { book: BOOK, coverUrl: null, missing: ["Cover"], ...props }));
}

describe("AuthorBookRow: a book Librum took down", () => {
  it("shows the tag and the notice instead of the missing list", () => {
    const html = render({
      takedown: {
        takenDownAt: "2026-10-19T10:00:00Z",
        reason: "content_rules",
        message: "This breaks the rules",
        bundleTitles: ["Set A"],
      },
    });
    expect(html).toContain(">TAKEN DOWN<");
    expect(html).not.toContain(">DRAFT<");
    expect(html).toContain('role="status"');
    expect(html).toMatch(/Taken down by Librum on [^<]+\. Reason: Breaks content rules\./);
    expect(html).toContain("This breaks the rules.");
    expect(html).toContain("We also unpublished: Set A.");
    expect(html).toContain("Questions? Write to support@librum.al");
    expect(html).not.toContain("Missing:");
    expect(html).not.toContain("Continue setup");
    expect(html).toContain(">Edit<");
  });

  it("is an ordinary draft without one", () => {
    const html = render();
    expect(html).toContain(">DRAFT<");
    expect(html).toContain("Missing: Cover");
    expect(html).toContain("Continue setup");
    expect(html).not.toContain("TAKEN DOWN");
  });
});
