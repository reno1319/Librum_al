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

// P1 (design B, 2026-11-10): the details are now two lists -- a row of
// tiles (Faqe, Kohë leximi, Gjuha, Botuar, Formati) and plain
// "Label: value" lines for the rest. Every rule below is the old one.
describe("Book Detail: metadata tiles and rows, order and conditional rendering", () => {
  const tiles = block('<dl data-detail-tiles=""', "</dl>");
  const rows = block('<dl data-detail-rows=""', "</dl>");

  it("Format remains always visible, unconditional (the last tile)", () => {
    expect(tiles).toMatch(/\)\}\s*<DetailTile label="Formati"[\s\S]*?\/>\}>\s*<Acronym>EPUB<\/Acronym>\s*<\/DetailTile>\s*$/);
    expect(tiles).not.toContain("E-libër");
  });

  it("tiles in the exact order: Faqe, Kohë leximi, Gjuha, Botuar, Formati", () => {
    const labels = ["PAGE_ESTIMATE_LABEL", "READING_TIME_LABEL", 'label="Gjuha"', 'label="Botuar"', 'label="Formati"'];
    const positions = labels.map((label) => {
      const idx = tiles.indexOf(label);
      expect(idx, `expected to find tile "${label}"`).toBeGreaterThan(-1);
      return idx;
    });
    expect(positions).toEqual([...positions].sort((x, y) => x - y));
  });

  // BD15 P8 (Q3 a): Zhanri/Zhanret, then Përmbajtja (18+) and Mosha;
  // Botimi reads EDITION_LABEL.
  it("rows in the exact order: Lloji, Zhanri/Zhanret, Përmbajtja, Mosha, Seria, Botuesi, Botimi, Botuar për herë të parë, Parapublikim, ISBN", () => {
    const labels = ["BOOK_TYPE_LABEL", "categoriesLabel(", "ADULT_DETAIL_LABEL", "READING_AGE_LABEL", 'label="Seria"', 'label="Botuesi"', "EDITION_LABEL", 'label="Botuar për herë të parë"', 'label="Parapublikim"', 'label="ISBN"'];
    const positions = labels.map((label) => {
      const idx = rows.indexOf(label);
      expect(idx, `expected to find row "${label}"`).toBeGreaterThan(-1);
      return idx;
    });
    expect(positions).toEqual([...positions].sort((x, y) => x - y));
  });

  it("no capital-letter labels any more", () => {
    expect(source).not.toContain("uppercase tracking-wide");
    expect(source).not.toContain("DETAIL_LABEL_CLASSES");
  });

  it("Language uses getLanguageLabel() (human label, or a safe raw-code fallback for an unrecognized code), never a raw code rendered directly", () => {
    const languageRow = tiles.match(/\{book\.language && \([\s\S]*?\)\}/)![0];
    expect(languageRow).toContain("getLanguageLabel(book.language)");
    expect(languageRow).not.toMatch(/\{book\.language\}/);
  });

  it("Language tile is omitted entirely when language is null", () => {
    const languageRow = tiles.match(/\{book\.language && \([\s\S]*?\)\}/)![0];
    expect(languageRow.startsWith("{book.language &&")).toBe(true);
  });

  it("Publisher renders only book.publisher itself -- never a substituted 'Librum' or author name", () => {
    const publisherRow = rows.match(/\{book\.publisher && \([\s\S]*?\)\}/)![0];
    expect(publisherRow).toContain("{book.publisher}");
    expect(publisherRow).not.toContain("Librum");
    expect(publisherRow).not.toContain("profiles?.display_name");
  });

  it("Edition renders only when present (BD15 P8: number, else the old text)", () => {
    const editionRow = rows.match(/\{editionValue\(book\) && \([\s\S]*?\)\}/)![0];
    expect(editionRow).toContain("{editionValue(book)}");
  });

  it("BD15 P8: every category is a link to that category in Libraria", () => {
    const row = rows.match(/\{bookCategories\(book\)\.length > 0 && \([\s\S]*?<\/DetailRow>/)![0];
    expect(row).toContain("bookCategories(book).map(");
    expect(row).toContain("buildBookstoreHref({}, { genre: category })");
  });

  it("BD15 P8: 18+ shows only for an adult book, the reading age only through readingAgeValue", () => {
    expect(rows).toMatch(/\{book\.is_adult && \([\s\S]*?\{ADULT_DETAIL_VALUE\}/);
    expect(rows).toMatch(/\{readingAgeValue\(book\) && \([\s\S]*?\{readingAgeValue\(book\)\}/);
  });

  it("Botuar për herë të parë uses formatDateOnly() (date-only, no timezone noise) and renders only when present", () => {
    const dateRow = rows.match(/\{book\.original_publication_date && \([\s\S]*?\)\}/)![0];
    expect(dateRow).toContain("formatDateOnly(book.original_publication_date)");
  });

  it("Botuar (on Librum) requires BOTH a published book AND a real published_at -- never created_at/updated_at, never guessed for a legacy null", () => {
    expect(source).toContain(
      'book.status === "published" && book.published_at ? formatTimestampAsDate(book.published_at) : null;',
    );
    const publishedTile = tiles.match(/\{publishedOnLibrum && \([\s\S]*?\)\}/)![0];
    expect(publishedTile).toContain("{publishedOnLibrum}");
    expect(publishedTile).not.toContain("created_at");
    expect(publishedTile).not.toContain("updated_at");
  });

  it("ISBN's existing behavior is preserved unchanged", () => {
    const isbnRow = rows.match(/\{book\.isbn && \([\s\S]*?\)\}/)![0];
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
    for (const dl of [block('<dl data-detail-tiles=""', "</dl>"), block('<dl data-detail-rows=""', "</dl>")]) {
      expect(dl).not.toContain("file_path");
      expect(dl).not.toContain("cover_path");
    }
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

// Upload notes 3a (Enkelejd 11-06): no "E-libër" on the book page.
// Upload notes C: the eyebrow is bookEyebrow() (type, then genre; tested
// in src/lib/book-types.test.ts), shown only when it has something.
describe("Book Detail: format wording", () => {
  it("never says E-libër", () => {
    expect(source).not.toMatch(/E-lib[eë]r/i);
  });

  // P1 (design B): plain words under the byline, no capitals.
  it("the eyebrow is the type and genre, and only when there is one", () => {
    expect(source).toContain(
      '{bookEyebrow(book) && (\n            <p className="mt-1 text-[0.8125rem] text-muted">{bookEyebrow(book)}</p>',
    );
  });

  it("Të dhënat e librit shows the type before the genres", () => {
    const rows = block('<dl data-detail-rows=""', "</dl>");
    const typeAt = rows.indexOf("<DetailRow label={BOOK_TYPE_LABEL}>{bookTypeOf(book)}</DetailRow>");
    expect(typeAt).toBeGreaterThan(0);
    expect(typeAt).toBeLessThan(rows.indexOf("categoriesLabel(bookCategories(book).length)"));
    expect(rows).toContain("{bookTypeOf(book) && (");
  });
});

// Upload notes D (Renato 11-07): "Faqe: N" (D2: bare number), only once
// the current file is counted (Q4 a: hidden without). P1: the first tile;
// Kohë leximi (Renato 11-10 a) comes from the same count.
describe("Book Detail: page estimate and reading time", () => {
  it("shows the Faqe tile first, and only with a count", () => {
    const tiles = block('<dl data-detail-tiles=""', "</dl>");
    expect(source).toContain("const pagesText = pageEstimateText(book.word_count);");
    expect(source).toContain("const readingTime = readingTimeText(book.word_count);");
    expect(tiles.indexOf("{pagesText && (")).toBeGreaterThan(0);
    expect(tiles.indexOf("{pagesText && (")).toBeLessThan(tiles.indexOf("{readingTime && ("));
    expect(tiles.indexOf("{readingTime && (")).toBeLessThan(tiles.indexOf("{book.language && ("));
  });

  it("reads the count from public_books, never the manuscript", () => {
    expect(source).not.toMatch(/countEpubWords|recordManuscriptWords|book_file_words/);
  });
});
