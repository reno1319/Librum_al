"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff";
import { isSchemaFeatureOffError, logSchemaFeatureOffOnce } from "@/lib/schema-feature-off";
import { parseHomeSlot, type HomeSlot } from "@/lib/home-picks-logic";

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
    // PEN-NAMES-2 (MF2): through public_books.
    const { data: book, error } = await supabase
      .from("public_books")
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

// HOME-PICKS-1 (Renato 2026-10-25): the three home page cover slots,
// on the same page and behind the same permission as Librum's choice.
// set_home_featured_slot / clear_home_featured_slot (migration
// 20261025100000) are EXECUTE-able by service_role only and do not check
// staff themselves; these check catalog.feature first, exactly like the
// Librum's choice actions above. The database refuses a book that is not
// published, has no cover or no price (free = 0 counts) and a book that
// already fills another slot, changing nothing. Each pick records Paid
// yes/no for that book (4a): the form always sends the tick.
const HOME_FEATURE = "Home picks";

export type HomeSlotResult =
  | { ok: true }
  | { ok: false; reason: "not_eligible" | "feature_off" | "error" }
  | { ok: false; reason: "in_other_slot"; slot: HomeSlot };

export async function setHomeSlot(slot: HomeSlot, bookId: string, sponsored: boolean): Promise<HomeSlotResult> {
  const { userId } = await requireStaff("catalog.feature");

  if (parseHomeSlot(String(slot)) === null || typeof bookId !== "string" || !UUID.test(bookId)) {
    return { ok: false, reason: "not_eligible" };
  }

  const { data, error } = await createAdminClient().rpc("set_home_featured_slot", {
    p_slot: slot,
    p_book_id: bookId,
    p_sponsored: sponsored === true,
    p_set_by: userId,
  });
  if (error) {
    if (isSchemaFeatureOffError(error)) {
      logSchemaFeatureOffOnce(HOME_FEATURE, error);
      return { ok: false, reason: "feature_off" };
    }
    // The advisory lock serializes slot changes, so the one-row-per-book
    // key (23505) should never fire; if it does, it lands here and the
    // transaction rolled back.
    console.error("setHomeSlot: set_home_featured_slot failed:", error);
    return { ok: false, reason: "error" };
  }
  if (data === "ok") return { ok: true };
  if (data === "not_eligible") return { ok: false, reason: "not_eligible" };
  const inSlot = typeof data === "string" ? /^in_slot_([123])$/.exec(data) : null;
  if (inSlot) return { ok: false, reason: "in_other_slot", slot: Number(inSlot[1]) as HomeSlot };
  console.error("setHomeSlot: unexpected result:", data);
  return { ok: false, reason: "error" };
}

export async function clearHomeSlot(slot: HomeSlot): Promise<HomeSlotResult> {
  await requireStaff("catalog.feature");

  if (parseHomeSlot(String(slot)) === null) return { ok: false, reason: "error" };

  const { error } = await createAdminClient().rpc("clear_home_featured_slot", { p_slot: slot });
  if (error) {
    if (isSchemaFeatureOffError(error)) {
      logSchemaFeatureOffOnce(HOME_FEATURE, error);
      return { ok: false, reason: "feature_off" };
    }
    console.error("clearHomeSlot: clear_home_featured_slot failed:", error);
    return { ok: false, reason: "error" };
  }
  return { ok: true };
}

const CANT_GO_ON_HOME = "That book can't go on the home page.";

function homeResultTarget(result: HomeSlotResult): string {
  if (result.ok) return `${PAGE_PATH}?success=${encodeURIComponent(SAVED)}`;
  if (result.reason === "not_eligible") return `${PAGE_PATH}?error=${encodeURIComponent(CANT_GO_ON_HOME)}`;
  if (result.reason === "in_other_slot") {
    return `${PAGE_PATH}?error=${encodeURIComponent(`That book is already in slot ${result.slot}.`)}`;
  }
  return `${PAGE_PATH}?error=${encodeURIComponent(SOMETHING_WENT_WRONG)}`;
}

// The page's slot forms: "Put on home page" on a book row, and "Save"
// (the Paid tick) on a filled slot, both send slot, bookId and the
// sponsored checkbox (absent = not paid).
export async function setHomeSlotFromForm(formData: FormData): Promise<void> {
  await requireStaff("catalog.feature");

  const slot = parseHomeSlot(formData.get("slot"));
  const bookId = formData.get("bookId");
  let target: string;
  if (slot === null || typeof bookId !== "string" || !UUID.test(bookId)) {
    target = `${PAGE_PATH}?error=${encodeURIComponent(CANT_GO_ON_HOME)}`;
  } else {
    const result = await setHomeSlot(slot, bookId, formData.get("sponsored") === "on");
    if (result.ok) revalidateAfterChange();
    target = homeResultTarget(result);
  }
  redirect(target);
}

export async function removeHomeSlotFromForm(formData: FormData): Promise<void> {
  await requireStaff("catalog.feature");

  const slot = parseHomeSlot(formData.get("slot"));
  let target: string;
  if (slot === null) {
    target = `${PAGE_PATH}?error=${encodeURIComponent(SOMETHING_WENT_WRONG)}`;
  } else {
    const result = await clearHomeSlot(slot);
    if (result.ok) revalidateAfterChange();
    target = homeResultTarget(result);
  }
  redirect(target);
}
