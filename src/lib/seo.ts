import { resolveSiteOrigin } from "@/lib/site-url";
import { isSupportedLanguage } from "@/lib/languages";
import { isValidIsbn } from "@/lib/book-identifiers";
import { authorPagePath } from "@/lib/pen-names";
import type { PublicBook } from "@/lib/types";

// P2 (Renato 10-29): canonical links, the sitemap's per-item entries and
// the book page's schema.org data all build their addresses here, from
// the same Albanian paths the pages themselves live at.

export function bookPagePath(bookId: string): string {
  return `/libra/${bookId}`;
}

export function seriesPagePath(seriesId: string): string {
  return `/seri/${seriesId}`;
}

export function bundlePagePath(bundleId: string): string {
  return `/paketa/${bundleId}`;
}

// The site origin, or null when it can't be resolved (resolveSiteOrigin()
// throws in production without NEXT_PUBLIC_SITE_URL). A page's canonical
// link or schema.org data is optional; it must never take the page
// itself down, so callers simply leave it out on null.
export function siteOriginOrNull(): string | null {
  try {
    return resolveSiteOrigin();
  } catch {
    return null;
  }
}

// P2 (Renato 4b): a page's canonical link as Metadata, `{}` when the
// origin can't be resolved. Always the bare address, so the notice
// variants (?error=, ?success=, ?purchase=, ...) never compete with it.
export function canonicalMetadata(path: string): { alternates?: { canonical: string } } {
  const origin = siteOriginOrNull();
  return origin ? { alternates: { canonical: `${origin}${path}` } } : {};
}

type BookJsonLdInput = Pick<
  PublicBook,
  | "id"
  | "title"
  | "subtitle"
  | "description"
  | "isbn"
  | "language"
  | "publisher"
  | "genre"
  | "published_at"
  | "price_all"
>;

// schema.org Book data for a PUBLISHED book's public page. The author is
// the book's pen name and links to its /autore/<pen name id> page --
// never an account. The price is included only while paid checkout is
// actually on (P2 1a): until then nobody can pay it, and a free book
// never carries one.
export function buildBookJsonLd(
  book: BookJsonLdInput,
  {
    origin,
    coverUrl,
    pen,
    paidCheckoutOn,
  }: {
    origin: string;
    coverUrl: string | null;
    pen: { id: string; name: string } | null;
    paidCheckoutOn: boolean;
  },
): Record<string, unknown> {
  const url = `${origin}${bookPagePath(book.id)}`;
  const data: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Book",
    "@id": url,
    url,
    name: book.title,
    bookFormat: "https://schema.org/EBook",
  };
  if (book.subtitle) data.alternativeHeadline = book.subtitle;
  if (book.description) data.description = book.description;
  if (coverUrl) data.image = coverUrl;
  if (pen) {
    data.author = { "@type": "Person", name: pen.name, url: `${origin}${authorPagePath(pen.id)}` };
  }
  if (book.language && isSupportedLanguage(book.language)) data.inLanguage = book.language;
  if (book.isbn && isValidIsbn(book.isbn)) data.isbn = book.isbn.replace(/[\s-]/g, "");
  if (book.publisher) data.publisher = { "@type": "Organization", name: book.publisher };
  if (book.genre) data.genre = book.genre;
  if (book.published_at) data.datePublished = book.published_at.slice(0, 10);
  if (paidCheckoutOn && book.price_all !== null && book.price_all > 0) {
    data.offers = {
      "@type": "Offer",
      url,
      price: book.price_all,
      priceCurrency: "ALL",
      availability: "https://schema.org/InStock",
    };
  }
  return data;
}

// JSON for an inline <script type="application/ld+json">. Every "<", ">"
// and "&" is escaped (an author-written title can't close the script
// tag), and so are U+2028/U+2029.
export function serializeJsonLd(data: Record<string, unknown>): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
