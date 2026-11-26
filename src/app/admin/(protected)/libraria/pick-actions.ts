"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff";
import { parsePickForm, type PickFormProblem } from "@/lib/libraria-picks";

// LR1 patch 4 (lb2 a, lb6 a, lb8 a, lr4-1 a, lr4-4 a): staff publish,
// edit and delete the "Çfarë po lexojmë" picks. requireStaff
// ("catalog.feature", owner and admin) runs first; the database
// functions check the permission again, refuse a book Libraria does not
// list (LB540) and write the audit rows. Saving a new pick publishes it,
// so it becomes the pick on Libraria (lr4-1 a); editing keeps its date.
const PAGE_PATH = "/admin/libraria";
const ANCHOR = "#reading-picks";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const PICK_PUBLISHED = "Pick published.";
const PICK_SAVED = "Pick saved.";
const PICK_DELETED = "Pick deleted.";
const NO_PICK = "That pick no longer exists.";
const CHOOSE_BOOK = "Choose a book.";
const BADGE_LINES = "Keep the badge on one line.";
const BADGE_LONG = "The badge can be at most 24 characters.";
const NOTE_EMPTY = "Write the note.";
const NOTE_LINES = "Keep the note as one paragraph.";
const NOTE_LONG = "The note can be at most 400 characters.";
const QUOTE_EMPTY = "Write the quote.";
const QUOTE_LINES = "Keep the quote as one paragraph.";
const QUOTE_LONG = "The quote can be at most 240 characters.";
const QUOTE_FROM = "Choose whether the quote is from the book or from the author.";
const BOOK_NOT_LISTED = "That book is not on Libraria now.";
const SAVE_FAILED = "Couldn’t save the pick. Please try again.";
const DELETE_FAILED = "Couldn’t delete the pick. Please try again.";

function problemMessage(problem: PickFormProblem): string {
  switch (problem) {
    case "pick":
      return NO_PICK;
    case "book":
      return CHOOSE_BOOK;
    case "badge_lines":
      return BADGE_LINES;
    case "badge_long":
      return BADGE_LONG;
    case "note_empty":
      return NOTE_EMPTY;
    case "note_lines":
      return NOTE_LINES;
    case "note_long":
      return NOTE_LONG;
    case "quote_empty":
      return QUOTE_EMPTY;
    case "quote_lines":
      return QUOTE_LINES;
    case "quote_long":
      return QUOTE_LONG;
    case "quote_from":
      return QUOTE_FROM;
  }
}

function withQuery(path: string, key: "error" | "success", message: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(message)}`;
}

// Back to the form that was open: the edit form keeps its ?pick=.
function formPath(pickId: string | null): string {
  return pickId ? `${PAGE_PATH}?pick=${pickId}` : PAGE_PATH;
}

function revalidate(): void {
  revalidatePath(PAGE_PATH);
  revalidatePath("/librari");
  revalidatePath("/librari/cfare-po-lexojme");
}

export async function saveReadingPick(formData: FormData) {
  await requireStaff("catalog.feature");

  const parsed = parsePickForm(formData);
  if (!parsed.ok) {
    const rawId = String(formData.get("pickId") ?? "");
    redirect(`${withQuery(formPath(UUID.test(rawId) ? rawId : null), "error", problemMessage(parsed.reason))}${ANCHOR}`);
  }
  const { pickId } = parsed;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("staff_save_libraria_reading_pick", {
    p_id: pickId,
    p_book_id: parsed.bookId,
    p_badge: parsed.badge,
    p_note: parsed.note,
    p_quote: parsed.quote,
    p_quote_from: parsed.quoteFrom,
  });
  if (error || !data) {
    if (error?.code === "LB540") redirect(`${withQuery(formPath(pickId), "error", BOOK_NOT_LISTED)}${ANCHOR}`);
    if (!error) redirect(`${withQuery(PAGE_PATH, "error", NO_PICK)}${ANCHOR}`);
    console.error("saveReadingPick: staff_save_libraria_reading_pick failed:", error);
    redirect(`${withQuery(formPath(pickId), "error", SAVE_FAILED)}${ANCHOR}`);
  }

  revalidate();
  redirect(`${withQuery(PAGE_PATH, "success", pickId ? PICK_SAVED : PICK_PUBLISHED)}${ANCHOR}`);
}

export async function deleteReadingPick(formData: FormData) {
  await requireStaff("catalog.feature");

  const pickId = String(formData.get("pickId") ?? "");
  if (!UUID.test(pickId)) redirect(`${withQuery(PAGE_PATH, "error", NO_PICK)}${ANCHOR}`);

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("staff_delete_libraria_reading_pick", { p_id: pickId });
  if (error) {
    console.error("deleteReadingPick: staff_delete_libraria_reading_pick failed:", error);
    redirect(`${withQuery(PAGE_PATH, "error", DELETE_FAILED)}${ANCHOR}`);
  }
  if (data !== true) redirect(`${withQuery(PAGE_PATH, "error", NO_PICK)}${ANCHOR}`);

  revalidate();
  redirect(`${withQuery(PAGE_PATH, "success", PICK_DELETED)}${ANCHOR}`);
}
