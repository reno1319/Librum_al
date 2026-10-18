import type { RightsBasis } from "@/lib/types";

// BOOK-PEN-NAME-RIGHTS-CHOICE-1: the two rights sentences an author
// chooses between before publishing, word for word as Renato decided
// them (2026-10-17 22:02Z, "1. a 2. a"). No full stop; the apostrophe is
// the straight U+0027 (rights-statements.test.ts pins every code point).
// The server copies the sentence from here into
// book_rights_declarations.statement_text -- never from the client -- and
// the UI renders `{RIGHTS_STATEMENTS[basis].text}`, never a retyped copy.
//
// Changing a sentence means a new RIGHTS_STATEMENT_VERSION, so every
// stored row still says which wording the author saw. Both sentences are
// to be checked by a lawyer before launch.
export const RIGHTS_STATEMENT_VERSION = "rights-v1";

export const RIGHTS_STATEMENTS: Readonly<Record<RightsBasis, { readonly text: string }>> = {
  own_rights: {
    text: "I own the rights to this book, or I have the rights holder's permission to publish and sell it",
  },
  public_domain: {
    text: "This book is in the public domain, including any translation I upload",
  },
};

export const RIGHTS_BASES: readonly RightsBasis[] = ["own_rights", "public_domain"];

export function isRightsBasis(value: unknown): value is RightsBasis {
  return typeof value === "string" && (RIGHTS_BASES as readonly string[]).includes(value);
}
