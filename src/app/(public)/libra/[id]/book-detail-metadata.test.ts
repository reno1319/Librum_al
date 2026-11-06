import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";

// LIBRUM 2.0 PUBLISHING-UX-1 PART D: public Book Detail's new
// bibliographic metadata rows (Subtitle near the title; Language,
// Publisher, Edition, Botuar për herë të parë, and Botuar në Librum in
// the metadata dl). Same source-level regression convention this
// codebase already established for the Edit page and the New Book
// wizard (no DOM-rendering harness exists here) -- these assert
// directly on the real page.tsx text.
const source = readFileSync(path.join(__dirname, "page.tsx"), "utf8");

function block(startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("Book Detail: Subtitle near the Title", () => {
  it("renders directly after the <h1>, as its own element -- never joined into the title string", () => {
    const heroBlock = source.match(/<h1[\s\S]*?<\/h1>[\s\S]{0,900}/)![0];
    expect(heroBlock).toContain("{book.subtitle &&");
    expect(heroBlock).not.toContain("book.title}{book.subtitle");
    expect(heroBlock).not.toContain("${book.subtitle}");
  });

  // REDESIGN STEP 3 (brief P2): the subtitle is now a muted italic
  // serif line, as in the A2 mockup -- still visually secondary: muted,
  // italic and smaller, never the h1's own green upright display size.
  it("is visually secondary (muted italic, not the h1's own treatment)", () => {
    const subtitleLine = source.match(/\{book\.subtitle && \([\s\S]*?\)\)?\}/)![0];
    expect(subtitleLine).toContain("text-muted");
    expect(subtitleLine).toContain("italic");
    expect(subtitleLine).not.toContain("text-primary");
    expect(subtitleLine).not.toMatch(/text-(4xl|5xl)|font-(semibold|bold)/);
  });
});

describe("Book Detail: metadata dl row order and conditional rendering", () => {
  const dlBlock = block('<dl className="mt-4 grid', "</dl>");

  it("Format remains always visible, unconditional", () => {
    expect(dlBlock).toContain("<dd className={DETAIL_VALUE_CLASSES}>EPUB</dd>");
    expect(dlBlock).not.toContain("E-libër");
    // Format's <div> is the only one with no preceding {book.x && (
    // guard -- confirmed by it appearing before the first conditional.
    const formatIndex = dlBlock.indexOf(">EPUB<");
    const firstConditionalIndex = dlBlock.indexOf("&&");
    expect(formatIndex).toBeLessThan(firstConditionalIndex);
  });

  // BD15 P8 (Q3 a): Zhanri/Zhanret, then Përmbajtja (18+) and Mosha,
  // after Gjuha; Botimi reads EDITION_LABEL.
  it("renders rows in the exact order: Formati, Gjuha, Zhanri/Zhanret, Përmbajtja, Mosha, Seria, Botuesi, Botimi, Botuar për herë të parë, Botuar në Librum, ISBN", () => {
    const labels = ["Formati", "Gjuha", "categoriesLabel(", "ADULT_DETAIL_LABEL", "READING_AGE_LABEL", "Seria", "Botuesi", "EDITION_LABEL", "Botuar për herë të parë", "Botuar në Librum", "ISBN"];
    const positions = labels.map((label) => {
      const idx = dlBlock.indexOf(label);
      expect(idx, `expected to find label "${label}"`).toBeGreaterThan(-1);
      return idx;
    });
    const sorted = [...positions].sort((a, b) => a - b);
    expect(positions).toEqual(sorted);
  });

  it("Language uses getLanguageLabel() (human label, or a safe raw-code fallback for an unrecognized code), never a raw code rendered directly", () => {
    const languageRow = dlBlock.match(/\{book\.language && \([\s\S]*?\)\)?\}/)![0];
    expect(languageRow).toContain("getLanguageLabel(book.language)");
    expect(languageRow).not.toMatch(/\{book\.language\}/);
  });

  it("Language row is omitted entirely when language is null", () => {
    const languageRow = dlBlock.match(/\{book\.language && \([\s\S]*?\)\)?\}/)![0];
    expect(languageRow.startsWith("{book.language &&")).toBe(true);
  });

  it("Publisher renders only book.publisher itself -- never a substituted 'Librum' or author name", () => {
    const publisherRow = dlBlock.match(/\{book\.publisher && \([\s\S]*?\)\)?\}/)![0];
    expect(publisherRow).toContain("{book.publisher}");
    expect(publisherRow).not.toContain("Librum");
    expect(publisherRow).not.toContain("profiles?.display_name");
  });

  it("Edition renders only when present (BD15 P8: number, else the old text)", () => {
    const editionRow = dlBlock.match(/\{editionValue\(book\) && \([\s\S]*?\)\)?\}/)![0];
    expect(editionRow).toContain("{editionValue(book)}");
  });

  it("BD15 P8: every category is a link to that category in Libraria", () => {
    const row = dlBlock.match(/\{bookCategories\(book\)\.length > 0 && \([\s\S]*?<\/div>/)![0];
    expect(row).toContain("bookCategories(book).map(");
    expect(row).toContain("buildBookstoreHref({}, { genre: category })");
  });

  it("BD15 P8: 18+ shows only for an adult book, the reading age only through readingAgeValue", () => {
    expect(dlBlock).toMatch(/\{book\.is_adult && \([\s\S]*?\{ADULT_DETAIL_VALUE\}/);
    expect(dlBlock).toMatch(/\{readingAgeValue\(book\) && \([\s\S]*?\{readingAgeValue\(book\)\}/);
  });

  it("Botuar për herë të parë uses formatDateOnly() (date-only, no timezone noise) and renders only when present", () => {
    const dateRow = dlBlock.match(/\{book\.original_publication_date && \([\s\S]*?\)\)?\}/)![0];
    expect(dateRow).toContain("formatDateOnly(book.original_publication_date)");
  });

  it("Botuar në Librum requires BOTH a published book AND a real published_at -- never created_at/updated_at, never guessed for a legacy null", () => {
    const publishedRow = dlBlock.match(/\{book\.status === "published" && book\.published_at && \([\s\S]*?\)\)?\}/)![0];
    expect(publishedRow).toContain("formatTimestampAsDate(book.published_at)");
    expect(publishedRow).not.toContain("created_at");
    expect(publishedRow).not.toContain("updated_at");
  });

  it("ISBN's existing behavior is preserved unchanged", () => {
    const isbnRow = dlBlock.match(/\{book\.isbn && \([\s\S]*?\)\)?\}/)![0];
    expect(isbnRow).toContain("{book.isbn}");
  });

  it("imports getLanguageLabel and the shared date helpers, no duplicated formatting logic", () => {
    expect(source).toContain('import { getLanguageLabel } from "@/lib/languages";');
    expect(source).toContain(
      'import { formatDateOnly, formatTimestampAsDate } from "@/lib/book-detail-dates";',
    );
  });
});

describe("Book Detail: no exposure of internal/private fields", () => {
  it("never renders a storage path, only public-URL-derived image src or plain text metadata", () => {
    const dlBlock2 = block('<dl className="mt-4 grid', "</dl>");
    expect(dlBlock2).not.toContain("file_path");
    expect(dlBlock2).not.toContain("cover_path");
  });
});

// REVIEW-DATE (Renato 11-05): each public review shows the day it was
// first written, from public_reviews.created_at, via the shared Tirana
// date helper -- never a raw ISO string or the runtime's own locale.
describe("Book Detail: review date", () => {
  const reviewItem = block("{allReviews.map((review) => (", "</li>");

  it("renders the review's created_at through formatTimestampAsDate inside a <time>", () => {
    expect(reviewItem).toContain("<time");
    expect(reviewItem).toContain("dateTime={review.created_at}");
    expect(reviewItem).toContain("{formatTimestampAsDate(review.created_at)}");
    expect(reviewItem).not.toContain("toLocaleDateString");
    // never the raw ISO string as visible text
    expect(reviewItem).not.toMatch(/>\s*\{review\.created_at\}/);
  });

  it("the public reviews read still selects created_at from public_reviews", () => {
    expect(source).toMatch(
      /from\("public_reviews"\)\s*\.select\("[^"]*\bcreated_at\b[^"]*"\)/,
    );
  });
});

// Upload notes 3a (Enkelejd 11-06): no "E-libër" on the book page; the
// eyebrow is the genre alone and shows nothing without one.
describe("Book Detail: format wording", () => {
  it("never says E-libër", () => {
    expect(source).not.toMatch(/E-lib[eë]r/i);
  });

  it("the eyebrow is the genre only, and only when there is one", () => {
    expect(source).toContain(
      '{book.genre && (\n            <p className="text-xs font-bold uppercase tracking-[0.12em] text-[#806510]">{book.genre}</p>',
    );
  });
});
