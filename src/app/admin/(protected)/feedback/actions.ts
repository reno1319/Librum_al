"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/staff";
import { createClient } from "@/lib/supabase/server";
import { BULK_PICK_FIELD, encodeFeedbackBulk, parseFeedbackPicks } from "../../bulk-select-logic";
import { feedbackStatusFilter } from "@/lib/reader-feedback";

// K4 feedback d a: "Mark done" on the admin Feedback page. requireStaff
// first; staff_set_reader_feedback_done() checks reports.resolve again
// and records who and when.
export async function markFeedbackDone(formData: FormData): Promise<void> {
  await requireStaff("reports.resolve");
  const id = formData.get("id");
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return;
  const supabase = await createClient();
  const { error } = await supabase.rpc("staff_set_reader_feedback_done", { p_id: id, p_done: true });
  if (error) console.error("Feedback: mark done failed", { code: error.code ?? null });
  revalidatePath("/admin/feedback");
  revalidatePath("/admin");
}

// G4 batch 3 (g4q11 a, b3e1 a): "Mark selected done". The same database
// function as the single Mark done, one message at a time; the ones
// that fail stay in Open and the page shows both counts.
export async function markSelectedFeedbackDone(formData: FormData): Promise<void> {
  await requireStaff("reports.resolve");
  const ids = parseFeedbackPicks(formData.getAll(BULK_PICK_FIELD));
  if (!ids) return;
  const supabase = await createClient();
  const counts = { done: 0, gone: 0, failed: 0 };
  for (const id of ids) {
    const { data, error } = await supabase.rpc("staff_set_reader_feedback_done", { p_id: id, p_done: true });
    if (error) {
      console.error("Feedback: bulk mark done failed", { code: error.code ?? null });
      counts.failed += 1;
    } else if (data === true) counts.done += 1;
    else if (data === false) counts.gone += 1;
    else counts.failed += 1;
  }
  revalidatePath("/admin/feedback");
  revalidatePath("/admin");
  // Back to the same filter (Open or All) the staff member was on.
  const status = feedbackStatusFilter(formData.get("status"));
  const filter = status === "open" ? "" : `status=${status}&`;
  redirect(`/admin/feedback?${filter}bulk=${encodeFeedbackBulk(counts)}`);
}
