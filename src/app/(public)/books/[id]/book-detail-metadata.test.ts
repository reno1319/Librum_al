import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";

// LIBRUM 2.0 PUBLISHING-UX-1 PART D: public Book Detail's new
// bibliographic metadata rows (Subtitle near the title; Language,
// Publisher, Edition, Originally published, and Published on Librum in
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

  it("is visually secondary (not the h1's own bold/serif treatment)", () => {
    const subtitleLine = source.match(/\{book\.subtitle && \([\s\S]*?\)\)?\}/)![0];
    expect(subtitleLine).toContain("text-muted");
    expect(subtitleLine).not.toContain("font-serif");
  });
});

describe("Book Detail: metadata dl row order and conditional rendering", () => {
  const dlBlock = block('<dl className="mt-4 flex flex-wrap', "</dl>");

  it("Format remains always visible, unconditional", () => {
    expect(dlBlock).toContain("Ebook · EPUB");
    // Format's <div> is the only one with no preceding {book.x && (
    // guard -- confirmed by it appearing before the first conditional.
    const formatIndex = dlBlock.indexOf("Ebook · EPUB");
    const firstConditionalIndex = dlBlock.indexOf("&&");
    expect(formatIndex).toBeLessThan(firstConditionalIndex);
  });

  it("renders rows in the exact order: Format, Language, Genre, Series, Publisher, Edition, Originally published, Published on Librum, ISBN", () => {
    const labels = ["Format", "Language", "Genre", "Series", "Publisher", "Edition", "Originally published", "Published on Librum", "ISBN"];
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

  it("Edition renders only when present", () => {
    const editionRow = dlBlock.match(/\{book\.edition && \([\s\S]*?\)\)?\}/)![0];
    expect(editionRow).toContain("{book.edition}");
  });

  it("Originally published uses formatDateOnly() (date-only, no timezone noise) and renders only when present", () => {
    const dateRow = dlBlock.match(/\{book\.original_publication_date && \([\s\S]*?\)\)?\}/)![0];
    expect(dateRow).toContain("formatDateOnly(book.original_publication_date)");
  });

  it("Published on Librum requires BOTH a published book AND a real published_at -- never created_at/updated_at, never guessed for a legacy null", () => {
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
    const dlBlock2 = block('<dl className="mt-4 flex flex-wrap', "</dl>");
    expect(dlBlock2).not.toContain("file_path");
    expect(dlBlock2).not.toContain("cover_path");
  });
});
