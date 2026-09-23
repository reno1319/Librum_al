import { resolveCatalogPriceState } from "@/lib/catalog-price";
import type { Book } from "@/lib/types";

export type ChecklistItem = { label: string; done: boolean };

type ChecklistBook = Pick<Book, "description" | "keywords" | "price_all" | "cover_path">;

// Purely informational, never blocks publishing — a free price or a
// short description can be entirely intentional (a free book, a short
// story). This just nudges authors toward a more complete listing.
//
// LIBRUM 2.0 PRODUCT-1 PRE-COMMIT CORRECTION: the former "Add a 'Look
// inside' preview excerpt" item is removed, not relabeled. Its only
// purpose was ever to nudge authors toward filling in preview_text for
// the old Look Inside accordion on Book Detail; PRODUCT-1 removed that
// public presentation entirely (Read Sample -- an automatically
// generated excerpt from the manuscript itself -- replaced it, needing
// no author input at all). Recommending authors spend time on a field
// with zero remaining reader-facing effect would be actively
// misleading, not just stale wording -- so the item is gone, not
// reworded. preview_text itself is untouched: still a real column,
// still written by createBook()/updateBook(), still editable in the
// Studio (see its own field's updated helper text) -- just no longer
// part of completeness scoring, since it no longer completes anything
// a reader will ever see.
export function getPublishChecklist(book: ChecklistBook): ChecklistItem[] {
  return [
    { label: "Add a cover image", done: !!book.cover_path },
    {
      label: "Write a description (a couple of sentences or more)",
      done: book.description.trim().length >= 50,
    },
    {
      label: "Add keywords so readers can find it by search",
      done: book.keywords.trim().length > 0,
    },
    // ALL-WIRING-2: the item is now "has this book an ALL price at all",
    // which is a genuinely three-way question, not the old
    // `price_cents > 0`. Two things change, both deliberately. The unit
    // is lek, not dollars. And a FREE book now counts as done: 0 is an
    // authored, deliberate ALL price, and the old rule marked every
    // intentionally free book permanently incomplete while this very
    // file's own docstring said a free price was legitimate. The only
    // undone case left is the one that genuinely is incomplete -- a row
    // with no authored ALL price at all, which is exactly the row that
    // cannot be published and does not appear in listings.
    {
      label: "Set your price in lek (0 for a free ebook)",
      done: resolveCatalogPriceState(book.price_all) !== "unavailable",
    },
  ];
}
