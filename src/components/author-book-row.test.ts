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

// ADMIN-3-REVIEW (F, 4a): the IN REVIEW tag (no timing promise, no
// "Continue setup"), and the send-back notice while it is the newest
// review. The takedown notice keeps priority.
describe("AuthorBookRow: In review and sent back (ADMIN-3)", () => {
  const SENT_BACK = { sentBackAt: "2026-10-19T10:00:00Z", reason: "broken_file", message: "The file does not open" };
  const TAKEDOWN = { takenDownAt: "2026-10-19T10:00:00Z", reason: "copyright", message: "Proof please", bundleTitles: [] };

  it("in review: the IN REVIEW tag instead of DRAFT, no missing list, no Continue setup", () => {
    const html = render({ review: { inReview: true, sentBack: null } });
    expect(html).toContain(">IN REVIEW<");
    expect(html).not.toContain(">DRAFT<");
    expect(html).not.toContain("Missing:");
    expect(html).not.toContain("Continue setup");
    expect(html).not.toMatch(/\b(hours?|days?|within|soon)\b/i);
  });

  it("sent back: the notice, in reading order, and the draft's own controls", () => {
    const html = render({ review: { inReview: false, sentBack: SENT_BACK } });
    expect(html).toContain(">DRAFT<");
    expect(html).toMatch(/Librum sent this book back on [^<]+\. Reason: Wrong or broken file\./);
    const order = ["Librum sent this book back", "The file does not open.", "Fix it and send it for review again.", "Questions? Write to support@librum.al"];
    const at = order.map((text) => html.indexOf(text));
    expect(at.every((i) => i > -1)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(html).toContain("Continue setup");
  });

  it("a takedown replaces both", () => {
    for (const review of [{ inReview: true, sentBack: null }, { inReview: false, sentBack: SENT_BACK }]) {
      const html = render({ takedown: TAKEDOWN, review });
      expect(html).toContain(">TAKEN DOWN<");
      expect(html).not.toContain(">IN REVIEW<");
      expect(html).not.toContain("Librum sent this book back");
    }
  });

  it("a live book shows neither", () => {
    const html = render({ book: { ...BOOK, status: "published" }, review: { inReview: true, sentBack: SENT_BACK } });
    expect(html).toContain(">LIVE<");
    expect(html).not.toContain(">IN REVIEW<");
    expect(html).not.toContain("Librum sent this book back");
  });

  it("the notice escapes Librum's message", () => {
    const html = render({ review: { inReview: false, sentBack: { ...SENT_BACK, message: "<b>x</b>" } } });
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
});
