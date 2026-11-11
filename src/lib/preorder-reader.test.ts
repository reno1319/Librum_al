import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BookCard } from "@/components/book-card";
import {
  LISTED_BOOK_STATUSES,
  NOTIFY_HELP,
  PREORDER_SOON_LABEL,
  isPreorder,
  isWaitingNotice,
  preorderReleaseLabel,
  readNotifyStatus,
  tiranaToday,
} from "./preorder-reader";

// BD16 P4: the reader-side words for a pre-order.

describe("tiranaToday", () => {
  it("is the Tirana day, not the UTC day (winter, UTC+1)", () => {
    expect(tiranaToday(new Date("2026-12-11T22:59:59Z"))).toBe("2026-12-11");
    expect(tiranaToday(new Date("2026-12-11T23:00:00Z"))).toBe("2026-12-12");
  });
  it("follows summer time (UTC+2)", () => {
    expect(tiranaToday(new Date("2026-07-01T21:59:59Z"))).toBe("2026-07-01");
    expect(tiranaToday(new Date("2026-07-01T22:00:00Z"))).toBe("2026-07-02");
  });
});

describe("preorderReleaseLabel", () => {
  it("shows the day in Albanian when it is today or later", () => {
    expect(preorderReleaseLabel("2026-12-12", "2026-11-06")).toBe("Del më 12 dhjetor 2026");
    expect(preorderReleaseLabel("2026-11-06", "2026-11-06")).toBe("Del më 6 nëntor 2026");
  });
  it("says 'Del së shpejti' once the day has passed, or with no date", () => {
    expect(preorderReleaseLabel("2026-11-05", "2026-11-06")).toBe(PREORDER_SOON_LABEL);
    expect(preorderReleaseLabel(null, "2026-11-06")).toBe(PREORDER_SOON_LABEL);
  });
});

describe("small rules", () => {
  it("lists published books and pre-orders, never drafts", () => {
    expect([...LISTED_BOOK_STATUSES]).toEqual(["published", "preorder"]);
  });
  it("isPreorder is true only for status 'preorder'", () => {
    expect(isPreorder({ status: "preorder" })).toBe(true);
    expect(isPreorder({ status: "published" })).toBe(false);
    expect(isPreorder({ status: "draft" })).toBe(false);
    expect(isPreorder({})).toBe(false);
    expect(isPreorder(null)).toBe(false);
  });
  it("reads only the three known ?notify= values", () => {
    expect(readNotifyStatus("on")).toBe("on");
    expect(readNotifyStatus("off")).toBe("off");
    expect(readNotifyStatus("error")).toBe("error");
    expect(readNotifyStatus("<b>x</b>")).toBeNull();
    expect(readNotifyStatus(undefined)).toBeNull();
  });
  it("a notice waits only while it is neither sent nor cancelled", () => {
    expect(isWaitingNotice({ notified_at: null, book_cancelled_at: null })).toBe(true);
    expect(isWaitingNotice({ notified_at: "2026-12-12T07:00:00Z", book_cancelled_at: null })).toBe(false);
    expect(isWaitingNotice({ notified_at: null, book_cancelled_at: "2026-12-01T07:00:00Z" })).toBe(false);
  });
});

describe("BookCard badge (D1)", () => {
  const BOOK = {
    id: "c3d4e5f6-2222-4222-8222-abcdef222299",
    title: "Libri që vjen",
    genre: "Roman",
    price_all: 499,
    pen_name_id: undefined,
    original_author: null,
    is_adult: false,
  };
  it("shows 'Del më …' on a pre-order card, with the price", () => {
    const html = renderToStaticMarkup(
      createElement(BookCard, { book: { ...BOOK, status: "preorder", release_date: "2099-12-12" }, coverUrl: null }),
    );
    expect(html).toContain("data-preorder-badge");
    expect(html).toContain("Del më 12 dhjetor 2099");
    expect(html).toContain("499");
  });
  it("shows no badge on a published book or when status is not given", () => {
    for (const book of [{ ...BOOK, status: "published", release_date: null }, BOOK]) {
      const html = renderToStaticMarkup(createElement(BookCard, { book, coverUrl: null }));
      expect(html).not.toContain("data-preorder-badge");
    }
  });
});

// R22 (Renato 11-11 a): the help text names every email a reader can get
// (release, the one new date, cancel), never "një email të vetëm".
describe("R22 Më njofto help text", () => {
  it("names the release, the new date and the cancel", () => {
    expect(NOTIFY_HELP).toBe(
      "Do t'ju dërgojmë email kur të dalë libri, ose nëse ndryshon data apo anulohet parapublikimi.",
    );
    expect(NOTIFY_HELP).not.toContain("vetëm");
  });
});
