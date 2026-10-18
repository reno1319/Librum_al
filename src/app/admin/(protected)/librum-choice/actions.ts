"use server";

import { createAdminClient } from "@/lib/supabase/admin";
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
