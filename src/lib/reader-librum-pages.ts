import {
  frontPageBody,
  MAX_MORE_BOOKS,
  MORE_BOOKS_HEADING,
  REVIEW_LINE,
  THANKS_LINE,
  type LibrumFrontPage,
  type LibrumLastPage,
} from "@/lib/epub-librum-pages";

// Online reader = the downloaded book (Renato 11-24, lbnp2: "we show the
// whole book as it is when you download it"). Librum's own copyright
// page and last page, in the page-turning reader's markup: each is its
// own <section class="lb-sec lb-lp">, so each starts on a new page (the
// reader shows the cover itself as page 1, then this copyright page).
// lb-lp is the frame's tighter spacing for these two pages, so the
// copyright page fits one phone screen (reader-frame-doc.ts).
//
// Only the reader's own tags and classes are used (reader-content.ts),
// and the text is escaped by frontPageBody / here. The pages are added
// after the book went through the server cleaner, like the buyer line
// before them. The reader frame has no links, so the last page's book
// titles and review line are text, not links.

const XML_ESCAPE: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => XML_ESCAPE[c]);
}
function clean(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "").trim();
}

/** The download's copyright page (buyer line included), as a reader page. */
export function readerFrontPageHtml(p: LibrumFrontPage): string {
  // frontPageBody writes only <h1>, <p>, <p class="sub|author|gap|gap small">
  // and <br/>, with every text already escaped: only the tags change.
  const body = frontPageBody(p)
    .replace(/<p class="gap small">([\s\S]*?)<\/p>/g, '<p class="lb-gap"></p><p class="lb-c"><small>$1</small></p>')
    .replace(/<p class="gap">/g, '<p class="lb-gap"></p><p class="lb-c">')
    .replace(/<p class="sub">/g, '<p class="lb-c lb-i">')
    .replace(/<p class="author">/g, '<p class="lb-c">')
    .replace(/<p>/g, '<p class="lb-c">')
    .replace(/<br\/>/g, "<br>");
  return `<section class="lb-sec lb-lp">${body}</section>`;
}

/** The download's last page ("Faleminderit që lexuat!"), as a reader page. */
export function readerLastPageHtml(p: LibrumLastPage): string {
  const out: string[] = [`<h1>${esc(THANKS_LINE)}</h1>`];
  const books = p.books.slice(0, MAX_MORE_BOOKS);
  if (books.length > 0) {
    out.push(`<h2>${esc(`${MORE_BOOKS_HEADING} ${clean(p.penName)}`)}</h2>`);
    for (const b of books) out.push(`<p class="lb-c">${esc(clean(b.title))}</p>`);
  }
  out.push(`<p class="lb-gap"></p><p class="lb-c"><strong>${esc(REVIEW_LINE)}</strong></p>`);
  return `<section class="lb-sec lb-lp">${out.join("")}</section>`;
}
