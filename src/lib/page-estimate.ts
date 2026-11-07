import { countEpubWords } from "@/lib/epub-sample";

// Upload notes D (SIZING-r1 note 3b): an EPUB reflows, so a book has no
// true page count. The estimate is words / 250 (a printed page), shown
// as the row "Faqe: rreth N" on the book page only (Renato 11-07: Q1 a, Q3 b exact
// number, minimum 1). The words are counted when the manuscript is saved
// and, for a file saved before this change, when staff press the button
// on the admin book page (Q2 a) -- never on a public request.

export const WORDS_PER_PAGE = 250;
export const PAGE_ESTIMATE_LABEL = "Faqe";
export const BOOK_FILE_WORDS_TABLE = "book_file_words";

// null (no row shown, Q4 a) for a missing, non-integer or negative count.
export function pageEstimateFromWords(words: unknown): number | null {
  if (typeof words !== "number" || !Number.isInteger(words) || words < 0) return null;
  return Math.max(1, Math.round(words / WORDS_PER_PAGE));
}

export function pageEstimateText(words: unknown): string | null {
  const pages = pageEstimateFromWords(words);
  return pages === null ? null : `rreth ${pages}`;
}

type WordsWriter = {
  from: (table: string) => {
    upsert: (
      row: { book_id: string; file_path: string; word_count: number },
      options: { onConflict: string },
    ) => PromiseLike<{ error: { code?: string } | null }>;
  };
};

// Counts the EPUB's words and stores them for that exact file (book id +
// storage key). Best effort: never throws and never fails the caller's
// save; a failure is logged (ids only) and the row simply stays hidden.
export async function recordManuscriptWords(
  client: WordsWriter,
  params: { bookId: string; filePath: string; bytes: Buffer; caller: string },
): Promise<"recorded" | "unreadable" | "failed"> {
  try {
    const words = await countEpubWords(params.bytes);
    if (words === null) {
      console.warn(`${params.caller}: manuscript words not counted (no readable text)`, { bookId: params.bookId });
      return "unreadable";
    }
    const { error } = await client
      .from(BOOK_FILE_WORDS_TABLE)
      .upsert({ book_id: params.bookId, file_path: params.filePath, word_count: words }, { onConflict: "book_id,file_path" });
    if (error) {
      console.error(`${params.caller}: manuscript words not stored`, { bookId: params.bookId, code: error.code ?? null });
      return "failed";
    }
    return "recorded";
  } catch {
    console.error(`${params.caller}: manuscript words not counted`, { bookId: params.bookId });
    return "failed";
  }
}

// The staff button's results (fixed text: page-messages.ts lists them).
export const PAGES_COUNTED_MESSAGE = "Pages counted.";
export const NO_FILE_TO_COUNT_MESSAGE = "This book has no file to count.";
export const PAGES_NOT_COUNTED_MESSAGE = "Couldn't count this book's pages. Try again.";
