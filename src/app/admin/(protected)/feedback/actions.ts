"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/staff";
import { createClient } from "@/lib/supabase/server";

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
