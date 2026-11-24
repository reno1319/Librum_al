"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/staff";
import { createClient } from "@/lib/supabase/server";
import { scheduleWaitingReaderEmails } from "@/lib/preorder-emails";
import {
  FAILED_EMAIL_ERROR_MESSAGE,
  FAILED_EMAIL_GONE_MESSAGE,
  isUuid,
} from "@/lib/preorder-email-failures";

// G4 (Renato 11-24, g4q5 a, g4q6 a, g4e2 a): the two buttons on a failed
// pre-order email in the admin Today box. requireStaff("people.view")
// (Owner and Admin) first; the database functions check people.view
// again, lock the row, act only while it still has a failure, and write
// the audit log. They run with the request client, so auth.uid() is the
// staff member. "Send again" then runs the readers' sweep once the page
// has answered (the same sweep the daily job runs). redirect() stays
// outside every try/catch.

type Action = "staff_resend_preorder_email" | "staff_mark_preorder_email_handled";

async function act(fn: Action, formData: FormData): Promise<void> {
  await requireStaff("people.view");
  const bookId = formData.get("book_id");
  const userId = formData.get("user_id");
  if (!isUuid(bookId) || !isUuid(userId)) {
    redirect(`/admin?error=${encodeURIComponent(FAILED_EMAIL_ERROR_MESSAGE)}`);
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc(fn, { p_book_id: bookId, p_user_id: userId });
  if (error) {
    console.error(`failed pre-order email: ${fn} failed`, { code: error.code ?? null });
    redirect(`/admin?error=${encodeURIComponent(FAILED_EMAIL_ERROR_MESSAGE)}`);
  }
  if (data !== true) {
    revalidatePath("/admin");
    redirect(`/admin?error=${encodeURIComponent(FAILED_EMAIL_GONE_MESSAGE)}`);
  }

  if (fn === "staff_resend_preorder_email") scheduleWaitingReaderEmails("sendFailedPreorderEmailAgain");
  revalidatePath("/admin");
  redirect("/admin");
}

export async function sendFailedPreorderEmailAgain(formData: FormData): Promise<void> {
  await act("staff_resend_preorder_email", formData);
}

export async function markFailedPreorderEmailHandled(formData: FormData): Promise<void> {
  await act("staff_mark_preorder_email_handled", formData);
}
