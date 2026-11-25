"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireStaff } from "@/lib/staff";
import { isSchemaFeatureOffError, logSchemaFeatureOffOnce } from "@/lib/schema-feature-off";
import { parseHomeSlot, type HomeSlot } from "@/lib/home-picks-logic";

// LR1 patch 3 (lr3-6 a, lr3-6b a): the "Librum's choice" pick and its
// two actions are gone with the Libraria strip they fed; the Libraria
// banner replaced it. This page keeps only the three home page cover
// slots below.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The ?q search is dropped on the way back.
const PAGE_PATH = "/admin/librum-choice";
const SAVED = "Saved.";
const SOMETHING_WENT_WRONG = "Something went wrong. Please try again.";

function revalidateAfterChange(): void {
  revalidatePath("/");
  revalidatePath("/librari");
  revalidatePath(PAGE_PATH);
}

// HOME-PICKS-1 (Renato 2026-10-25): the three home page cover slots,
// behind catalog.feature (owner and admin).
// set_home_featured_slot / clear_home_featured_slot (migration
// 20261025100000) are EXECUTE-able by service_role only and do not check
// staff themselves; these check catalog.feature first and only then
// create the service-role client. The database refuses a book that is not
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
