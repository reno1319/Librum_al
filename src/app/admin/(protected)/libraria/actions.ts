"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff";
import { MAX_CATEGORY_BUTTONS, parseCategoryButtonSlots } from "@/lib/libraria-store";

// LR1 patch 2 (lb5 a, lr2-3 a): staff choose and order the category
// buttons under "Më të rinjtë në Librum". requireStaff("catalog.feature")
// (owner and admin) keeps everyone else away; the database function
// checks the permission again, replaces the whole row of buttons and
// writes the audit row (libraria.category_buttons_set) in one
// transaction. Empty slots are skipped, so the order closes up; saving
// none brings back the A–Zh rule on the page (lr2-5 b).
const PAGE_PATH = "/admin/libraria";
const SAVED_MESSAGE = "Category buttons saved.";
const REPEAT_MESSAGE = "Choose each category only once.";
const FAILED_MESSAGE = "Couldn’t save the category buttons. Please try again.";

export async function saveCategoryButtons(formData: FormData) {
  await requireStaff("catalog.feature");

  const slots = Array.from({ length: MAX_CATEGORY_BUTTONS }, (_, i) => formData.get(`slot${i + 1}`));
  const parsed = parseCategoryButtonSlots(slots);
  if (!parsed.ok) {
    redirect(`${PAGE_PATH}?error=${encodeURIComponent(parsed.reason === "repeat" ? REPEAT_MESSAGE : FAILED_MESSAGE)}`);
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("staff_set_libraria_category_buttons", { p_categories: parsed.categories });
  if (error) {
    console.error("saveCategoryButtons: staff_set_libraria_category_buttons failed:", error);
    redirect(`${PAGE_PATH}?error=${encodeURIComponent(FAILED_MESSAGE)}`);
  }

  revalidatePath(PAGE_PATH);
  revalidatePath("/librari");
  redirect(`${PAGE_PATH}?success=${encodeURIComponent(SAVED_MESSAGE)}`);
}
