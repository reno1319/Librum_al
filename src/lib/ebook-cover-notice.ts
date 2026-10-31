// W7 r2 (Renato 10-31, Q1 b-lite): when Librum could not put the cover
// inside a Librum-made (Word) ebook, the save still succeeds and the
// author sees one more line under the success message. It travels as
// `?ebook_cover=0` -- a fixed flag, never text -- so the success/error
// allowlists in page-messages.ts stay exactly as they are and a crafted
// link can only ever show this one Librum sentence.
// The page reads it as `ebook_cover` (literal here so the B16 guard in
// page-messages.sources.test.ts can see the key is not error/success).
const EBOOK_COVER_NOTICE_VALUE = "0";

export const EBOOK_COVER_NOT_INSIDE_MESSAGE =
  "Kopertina u ruajt, por nuk u vendos dot brenda librit elektronik. Provoni ta ngarkoni kopertinën edhe një herë.";

// Adds the flag to a post-save redirect when the swap failed; otherwise
// the URL is returned unchanged.
export function withEbookCoverWarning(url: string, warn: boolean): string {
  if (!warn) return url;
  return `${url}${url.includes("?") ? "&" : "?"}ebook_cover=0`;
}

// The page side: the sentence for the exact flag, null for anything else.
export function ebookCoverNotice(raw: string | string[] | undefined): string | null {
  return raw === EBOOK_COVER_NOTICE_VALUE ? EBOOK_COVER_NOT_INSIDE_MESSAGE : null;
}
