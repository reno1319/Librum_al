// BD3 patch 2 (Renato 1 Nov, 3a): text in a book that points readers
// away from Librum (other stores) or carries contact details (email,
// phone). Librum never changes such text inside the story; the author
// is warned (advice only: Renato dropped the reviewer check on 1 Nov,
// 3c). Authors may still sell elsewhere (no exclusivity): only the
// mention inside the Librum copy is the problem.
//
// Shared by the Word converter (warnings, and the copyright-page
// detection in docx-structure.ts) and the EPUB upload warning
// (epub-outside-mentions.ts).

// Store names as they are written in ebooks. Words that are also common
// words or names on their own ("Apple", "Nook", "Lulu", "Play") are only
// matched together with the word that makes them a store.
const STORES: { name: string; re: RegExp }[] = [
  { name: "Amazon", re: /\bamazon(?:\.[a-z]{2,3}(?:\.[a-z]{2})?)?\b/i },
  { name: "Kindle", re: /\bkindle\b/i },
  { name: "Smashwords", re: /\bsmashwords\b/i },
  { name: "Apple Books", re: /\bapple\s+books\b|\bibooks\b|\bibookstore\b/i },
  { name: "Google Play", re: /\bgoogle\s+play(?:\s+books)?\b/i },
  { name: "Kobo", re: /\bkobo\b/i },
  { name: "Draft2Digital", re: /\bdraft2digital\b|\bd2d\b/i },
  { name: "Barnes & Noble", re: /\bbarnes\s*(?:&|and|&amp;)\s*noble\b/i },
  { name: "Scribd", re: /\bscribd\b/i },
  { name: "Wattpad", re: /\bwattpad\b/i },
  { name: "Lulu", re: /\blulu\.com\b|\blulu\s+press\b/i },
  { name: "Libra24", re: /\blibra\s?24\b/i },
  { name: "Libroteka", re: /\blibroteka\b/i },
];

// An email address; Librum's own addresses are not a problem.
// Every part is bounded: an unbounded pattern took seconds on a long
// run of letters without spaces (audit r1 M1).
const EMAIL_RE = /[a-z0-9._%+-]{1,64}@[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){0,8}\.[a-z]{2,24}/gi;
const OWN_EMAIL_RE = /@librum\.al$/i;

// A phone number: Albanian mobiles (06x... / +355 6x...), Kosovo
// (+383 / 04x), or any number written with an international "+" and
// 8+ digits. Spaces, dots and dashes between groups are allowed.
const PHONE_RE =
  /(?:\+|\b00)\s?\d{2,3}[\s.-]?\(?\d{1,3}\)?(?:[\s.-]?\d{2,4}){2,4}\b|\b0(?:6[789]|4[3-9])[\s.-]?\d{3}[\s.-]?\d{3,4}\b/g;

export type OutsideMentions = { stores: string[]; emails: string[]; phones: string[] };

const MAX_LISTED = 5;

function digits(s: string): number {
  return (s.match(/\d/g) ?? []).length;
}

// Every distinct mention, uncapped (BD3 patch 3: the EPUB scan merges
// these across the book's files before listing at most MAX_LISTED).
export function collectOutsideMentions(text: string): OutsideMentions {
  const stores = STORES.filter((s) => s.re.test(text)).map((s) => s.name);
  const emails = [...new Set((text.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase()))].filter((e) => !OWN_EMAIL_RE.test(e));
  const phones = [...new Set((text.match(PHONE_RE) ?? []).map((p) => p.trim()))].filter((p) => digits(p) >= 9 && digits(p) <= 15);
  return { stores, emails, phones };
}

export function capOutsideMentions(m: OutsideMentions): OutsideMentions {
  return { stores: m.stores.slice(0, MAX_LISTED), emails: m.emails.slice(0, MAX_LISTED), phones: m.phones.slice(0, MAX_LISTED) };
}

export function findOutsideMentions(text: string): OutsideMentions {
  return capOutsideMentions(collectOutsideMentions(text));
}

export function hasOutsideMention(text: string): boolean {
  const m = findOutsideMentions(text);
  return m.stores.length > 0 || m.emails.length > 0 || m.phones.length > 0;
}

// The author-facing warnings (Albanian), one per kind found. "word":
// the Word converter's wording (patch 2, unchanged); "epub" (patch 3):
// the same warning for an EPUB the author uploaded.
export function outsideMentionMessages(
  m: OutsideMentions,
  source: "word" | "epub" = "word",
): { store: string | null; contact: string | null } {
  const fix =
    source === "word" ? "hiqeni këtë tekst në Word dhe ngarkojeni dokumentin sërish" : "hiqeni këtë tekst nga skedari EPUB dhe ngarkojeni sërish";
  const fixContact = source === "word" ? "hiqeni në Word dhe ngarkojeni dokumentin sërish" : "hiqeni nga skedari EPUB dhe ngarkojeni sërish";
  const store =
    m.stores.length > 0
      ? `Libri përmend një dyqan tjetër (${m.stores.join(", ")}). Në Librum libri shitet vetëm nga Librum: ${fix}.`
      : null;
  const found = [...m.emails, ...m.phones];
  const contact =
    found.length > 0
      ? `Libri ka një adresë email ose numër telefoni (${found.join(", ")}). Çdo lexues që e blen librin do ta shohë. Nëse nuk e doni këtë, ${fixContact}.`
      : null;
  return { store, contact };
}
