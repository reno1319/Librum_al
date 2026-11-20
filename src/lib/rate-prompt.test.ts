import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  RATE_PROMPT_LATER,
  RATE_PROMPT_TEXT,
  initialReviewStars,
  parseRateStars,
  rateBarVisible,
  rateDismissKey,
  readRateDismissed,
  reviewFormHref,
  showRatePrompt,
  writeRateDismissed,
} from "./rate-prompt";
import { RatePromptBar } from "@/components/book-reader";

// K8 rate prompt (Renato 11-20): k8q1 b bar on the last page, k8q2 a star
// opens the review form with the stars chosen, k8q3 a only without an own
// review + "Jo tani" per book in this browser, k8q4 a free and bought.

const BOOK = "b0000000-0000-4000-8000-000000000003";

describe("words (his wording, 11-20)", () => {
  it("is exactly 'Libri mbaroi. Të pëlqeu?' and 'Jo tani'", () => {
    expect(RATE_PROMPT_TEXT).toBe("Libri mbaroi. Të pëlqeu?");
    expect(RATE_PROMPT_LATER).toBe("Jo tani");
  });
});

describe("reviewFormHref / parseRateStars / initialReviewStars", () => {
  it("links to the book page's review form with the stars", () => {
    expect(reviewFormHref(BOOK, 4)).toBe(`/libra/${BOOK}?yje=4#vleresimet`);
  });

  it("reads only a whole 1..5 from the query", () => {
    for (const n of ["1", "2", "3", "4", "5"]) expect(parseRateStars(n)).toBe(Number(n));
    for (const bad of [undefined, "", "0", "6", "4.5", " 4", "4 ", "04", "abc", "-1", "10"]) expect(parseRateStars(bad)).toBeNull();
    expect(parseRateStars(["4", "5"])).toBeNull();
  });

  it("an own review's stars win over the link; nothing chosen is empty", () => {
    expect(initialReviewStars(2, 5)).toBe(2);
    expect(initialReviewStars(null, 5)).toBe(5);
    expect(initialReviewStars(undefined, 3)).toBe(3);
    expect(initialReviewStars(null, null)).toBe("");
  });
});

describe("showRatePrompt (Library, k8q3 a + audit r1 L1)", () => {
  const noBooks = { data: [], error: null };
  it("shows only for a book without an own review", () => {
    const ownReviews = { data: [{ book_id: "other" }], error: null };
    expect(showRatePrompt(BOOK, ownReviews, noBooks)).toBe(true);
    expect(showRatePrompt(BOOK, { data: [{ book_id: BOOK }], error: null }, noBooks)).toBe(false);
    expect(showRatePrompt(BOOK, { data: [], error: null }, noBooks)).toBe(true);
  });

  it("never for the reader's own book (author)", () => {
    expect(showRatePrompt(BOOK, { data: [], error: null }, { data: [{ id: BOOK }], error: null })).toBe(false);
    expect(showRatePrompt(BOOK, { data: [], error: null }, { data: [{ id: "other" }], error: null })).toBe(true);
  });

  it("a failed read shows no bar", () => {
    expect(showRatePrompt(BOOK, { data: null, error: { code: "x" } }, noBooks)).toBe(false);
    expect(showRatePrompt(BOOK, { data: [], error: { code: "x" } }, noBooks)).toBe(false);
    expect(showRatePrompt(BOOK, { data: null, error: null }, noBooks)).toBe(false);
    expect(showRatePrompt(BOOK, { data: [], error: null }, { data: null, error: { code: "x" } })).toBe(false);
    expect(showRatePrompt(BOOK, { data: [], error: null }, { data: [], error: { code: "x" } })).toBe(false);
    expect(showRatePrompt(BOOK, { data: [], error: null }, { data: null, error: null })).toBe(false);
  });
});

describe("rateBarVisible (reader, k8q1 b)", () => {
  const base = { enabled: true, later: false, mode: "owned" as const, onContent: true, view: 9, lastView: 9, busy: false };
  it("shows on the last page of an owned book", () => {
    expect(rateBarVisible(base)).toBe(true);
  });
  it("not before the last page, not on the cover, not before layout", () => {
    expect(rateBarVisible({ ...base, view: 8 })).toBe(false);
    expect(rateBarVisible({ ...base, onContent: false, view: -1 })).toBe(false);
    expect(rateBarVisible({ ...base, lastView: null })).toBe(false);
  });
  it("never for the sample or the author's preview, nor when off or put off", () => {
    expect(rateBarVisible({ ...base, mode: "sample" })).toBe(false);
    expect(rateBarVisible({ ...base, mode: "full" })).toBe(false);
    expect(rateBarVisible({ ...base, enabled: false })).toBe(false);
    expect(rateBarVisible({ ...base, later: true })).toBe(false);
  });
  it("steps aside while a toast, the marking bar or a note is open", () => {
    expect(rateBarVisible({ ...base, busy: true })).toBe(false);
  });
});

describe("'Jo tani' is remembered per book in this browser", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("writes and reads the book's own key", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
    });
    expect(readRateDismissed(BOOK)).toBe(false);
    writeRateDismissed(BOOK);
    expect(store.get(rateDismissKey(BOOK))).toBe("1");
    expect(readRateDismissed(BOOK)).toBe(true);
    expect(readRateDismissed("another-book")).toBe(false);
  });

  it("blocked storage reads as not put off and never throws", () => {
    const boom = () => {
      throw new Error("blocked");
    };
    vi.stubGlobal("window", { localStorage: { getItem: boom, setItem: boom } });
    expect(readRateDismissed(BOOK)).toBe(false);
    expect(() => writeRateDismissed(BOOK)).not.toThrow();
  });
});

describe("RatePromptBar", () => {
  const html = renderToStaticMarkup(createElement(RatePromptBar, { onRate: () => {}, onLater: () => {}, color: "#222" }));
  it("shows the words, five 44 px tall stars with spoken names (44 px wide from tablet), and a 44 px 'Jo tani'", () => {
    expect(html).toContain(RATE_PROMPT_TEXT);
    const stars = html.match(/<button[^>]*aria-label="\d (yll|yje)"[^>]*>/g) ?? [];
    expect(stars).toHaveLength(5);
    for (const s of stars) {
      expect(s).toMatch(/\bh-11\b/);
      expect(s).toMatch(/\bw-10\b/);
      expect(s).toMatch(/\bsm:w-11\b/);
    }
    expect(html).toContain('aria-label="1 yll"');
    expect(html).toContain('aria-label="5 yje"');
    expect(html).toMatch(/<button[^>]*min-h-11[^>]*>Jo tani<\/button>/);
  });
  it("under 360 px (Renato 11-20): 11 px words on two lines, 36 px wide stars, 'Jo tani' on one line, row uses the strip's side margin", () => {
    expect(html).toMatch(/role="group"[^>]*class="[^"]*max-\[359px\]:-inset-x-2[^"]*max-\[359px\]:gap-1/);
    expect(html).toMatch(/<span class="[^"]*max-\[359px\]:w-\[4\.25rem\] max-\[359px\]:text-\[11px\][^"]*">Libri mbaroi/);
    const stars = html.match(/<button[^>]*aria-label="\d (yll|yje)"[^>]*>/g) ?? [];
    for (const s of stars) expect(s).toMatch(/max-\[359px\]:w-9/);
    expect(html).toMatch(/<button[^>]*whitespace-nowrap[^>]*max-\[359px\]:text-\[11px\][^>]*>Jo tani<\/button>/);
  });
});

// Wiring: who gets the bar (k8q3 a, k8q4 a), and where a star goes (k8q2 a).
describe("wiring", () => {
  const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
  it("book page: owners (never the author) with no own review read without error; the form takes the stars", () => {
    const page = src("../app/(public)/libra/[id]/page.tsx");
    expect(page).toContain('ratePrompt={purchaseState === "owned" && !myReviewError && myReview === null}');
    expect(page).toContain("defaultValue={initialReviewStars(myReview?.rating, rateStars)}");
    expect(page).toContain("const rateStars = parseRateStars(rawRateStars);");
  });
  it("Library: per book from the reader's own reviews", () => {
    const lib = src("../app/(public)/library/page.tsx");
    expect(lib).toContain('supabase.from("reviews").select("book_id").eq("reader_id", user.id)');
    expect(lib).toContain('supabase.from("books").select("id").eq("author_id", user.id)');
    expect(lib).toContain("ratePrompt={showRatePrompt(book.id, ownReviews, ownBooks)}");
    expect(src("../components/library-book-card.tsx")).toContain("ratePrompt={ratePrompt}");
  });
  it("a star closes the reader, then opens the review form; owned mode only", () => {
    const r = src("../components/book-sample-reader.tsx");
    expect(r).toContain('mode === "owned" && ratePrompt');
    expect(r).toContain("close(() => window.location.assign(reviewFormHref(bookId, stars)))");
  });
});

// k8f a (audit r1 M1): the prompt lives in the bottom strip, never over the
// page text, and the slider stays in place (invisible) so nothing moves.
describe("placement (k8f a)", () => {
  const reader = readFileSync(new URL("../components/book-reader.tsx", import.meta.url), "utf8");
  it("renders inside the bottom strip, after the page counter, not over the page", () => {
    const strip = reader.indexOf('{/* Bottom: slider + "Faqe x nga y · %" */}');
    const counter = reader.indexOf("Faqe {pageLabel} nga {totalPages} · {percent}%", strip);
    const bar = reader.indexOf("<RatePromptBar", strip);
    expect(strip).toBeGreaterThan(0);
    expect(counter).toBeGreaterThan(strip);
    expect(bar).toBeGreaterThan(counter);
    expect(reader.indexOf("<RatePromptBar")).toBe(bar);
  });
  it("hides the slider with visibility only, so the strip keeps its height", () => {
    expect(reader).toContain('<div className={showRateBar ? "invisible" : undefined}>');
  });
});
