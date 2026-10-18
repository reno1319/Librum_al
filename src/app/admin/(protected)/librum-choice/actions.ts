"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff";
import { isSchemaFeatureOffError, logSchemaFeatureOffOnce } from "@/lib/schema-feature-off";

// BOOK-PEN-NAME-RIGHTS-CHOICE-1: pick or clear the Bookstore's "Librum's
// choice" book. Built ahead of the picker UI (F5), so these return a
// result object instead of redirecting, like staff/actions.ts.
//
// requireStaff("catalog.feature") (owner and admin) is the gate: the two
// database functions are EXECUTE-able by service_role only and do not
// check staff themselves, so these actions call them with the
// service-role client only after that check. set_librum_choice locks,
// refuses a missing or unpublished book without changing anything, and
// moves the single pick; a refusal here leaves the current pick in place.

const FEATURE = "Librum's choice";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type LibrumChoiceResult =
  | { ok: true }
  | { ok: false; reason: "not_published" | "feature_off" | "error" };

export async function setLibrumChoice(bookId: string): Promise<LibrumChoiceResult> {
  await requireStaff("catalog.feature");

  if (typeof bookId !== "string" || !UUID.test(bookId)) return { ok: false, reason: "not_published" };

  const { data, error } = await createAdminClient().rpc("set_librum_choice", { p_book_id: bookId });
  if (error) {
    if (isSchemaFeatureOffError(error)) {
      logSchemaFeatureOffOnce(FEATURE, error);
      return { ok: false, reason: "feature_off" };
    }
    // The function's advisory lock serializes picks, so the one-pick
    // index should never fire; if it ever does, it is the same clean
    // refusal, and the transaction rolled back.
    if (error.code === "23505") return { ok: false, reason: "not_published" };
    console.error("setLibrumChoice: set_librum_choice failed:", error);
    return { ok: false, reason: "error" };
  }
  if (data !== true) return { ok: false, reason: "not_published" };
  return { ok: true };
}

export async function clearLibrumChoice(): Promise<LibrumChoiceResult> {
  await requireStaff("catalog.feature");

  const { error } = await createAdminClient().rpc("clear_librum_choice");
  if (error) {
    if (isSchemaFeatureOffError(error)) {
      logSchemaFeatureOffOnce(FEATURE, error);
      return { ok: false, reason: "feature_off" };
    }
    console.error("clearLibrumChoice: clear_librum_choice failed:", error);
    return { ok: false, reason: "error" };
  }
  return { ok: true };
}

// F5 (C1): the admin page's two forms. Each wrapper checks
// catalog.feature ITSELF first (no read happens for a caller without it),
// then calls the gated action above, which checks again and is the only
// place a service-role client is created. redirect() runs outside any
// try/catch (there is none here), so requireStaff's own redirect is never
// swallowed. The ?q search is dropped on the way back.
const PAGE_PATH = "/admin/librum-choice";
const SAVED = "Saved.";
const CANT_BE_PICKED = "That book can't be picked.";
const SOMETHING_WENT_WRONG = "Something went wrong. Please try again.";

function resultTarget(result: LibrumChoiceResult): string {
  if (result.ok) return `${PAGE_PATH}?success=${encodeURIComponent(SAVED)}`;
  if (result.reason === "not_published") return `${PAGE_PATH}?error=${encodeURIComponent(CANT_BE_PICKED)}`;
  return `${PAGE_PATH}?error=${encodeURIComponent(SOMETHING_WENT_WRONG)}`;
}

function revalidateAfterChange(): void {
  revalidatePath("/");
  revalidatePath("/bookstore");
  revalidatePath(PAGE_PATH);
}

export async function pickLibrumChoiceFromForm(formData: FormData): Promise<void> {
  await requireStaff("catalog.feature");

  const bookId = formData.get("bookId");
  let target: string;
  if (typeof bookId !== "string" || !UUID.test(bookId)) {
    target = `${PAGE_PATH}?error=${encodeURIComponent(CANT_BE_PICKED)}`;
  } else {
    // The Bookstore lists only priced books, so an unpriced book is
    // refused here, before set_librum_choice (which checks only that the
    // book exists and is published). Read with the request client:
    // published books are public, so a draft reads as not found.
    const supabase = await createClient();
    const { data: book, error } = await supabase
      .from("books")
      .select("id, price_all")
      .eq("id", bookId)
      .maybeSingle();
    if (error) {
      console.error("pickLibrumChoiceFromForm: book read failed:", error);
      target = `${PAGE_PATH}?error=${encodeURIComponent(SOMETHING_WENT_WRONG)}`;
    } else if (!book || book.price_all == null) {
      target = `${PAGE_PATH}?error=${encodeURIComponent(CANT_BE_PICKED)}`;
    } else {
      const result = await setLibrumChoice(bookId);
      if (result.ok) revalidateAfterChange();
      target = resultTarget(result);
    }
  }
  redirect(target);
}

export async function removeLibrumChoiceFromForm(): Promise<void> {
  await requireStaff("catalog.feature");

  const result = await clearLibrumChoice();
  if (result.ok) revalidateAfterChange();
  redirect(resultTarget(result));
}
