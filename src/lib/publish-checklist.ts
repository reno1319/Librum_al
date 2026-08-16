import type { Book } from "@/lib/types";

export type ChecklistItem = { label: string; done: boolean };

type ChecklistBook = Pick<
  Book,
  "description" | "keywords" | "preview_text" | "price_cents" | "cover_path"
>;

// Purely informational, never blocks publishing — a $0 price or a short
// description can be entirely intentional (a free book, a short story).
// This just nudges authors toward a more complete listing.
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
    {
      label: "Add a \"Look inside\" preview excerpt",
      done: book.preview_text.trim().length > 0,
    },
    {
      label: "Set a price (or keep $0 if this book is meant to be free)",
      done: book.price_cents > 0,
    },
  ];
}
