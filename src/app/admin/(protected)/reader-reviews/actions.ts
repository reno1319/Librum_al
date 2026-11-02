"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff";
import {
  READER_REVIEWS_PATH,
  REVIEW_APPROVED_MESSAGE,
  REVIEW_NAME_CLEARED_MESSAGE,
  REVIEW_NAME_SAVED_MESSAGE,
  REVIEW_REJECTED_MESSAGE,
  STAFF_GENERIC_ERROR_MESSAGE,
  approveFailure,
  isSeenTimestamp,
  isUuid,
  rejectFailure,
  setNameFailure,
  validateRejectForm,
  validateReviewName,
} from "./reader-review-logic";

// BD13: approve or reject a reader review, and change or clear a
// reader's public review name. requireStaff("reports.resolve") (owner,
// admin, moderator: Q3a) first; the database functions check the same
// permission themselves, lock the row, refuse a version the reader
// changed since the page was opened, and write the audit log. They run
// with the request client, so auth.uid() is the staff member.
// redirect() stays outside every try/catch.

function withQuery(path: string, key: "error" | "success", message: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(message)}`;
}

function revalidateBook(bookId: unknown): void {
  revalidatePath(READER_REVIEWS_PATH);
  revalidatePath("/admin");
  if (isUuid(bookId)) revalidatePath(`/libra/${bookId}`);
}

export async function approveReaderReviewAsStaff(formData: FormData): Promise<void> {
  await requireStaff("reports.resolve");

  const reviewId = formData.get("review_id");
  const seen = formData.get("seen");
  const bookId = formData.get("book_id");
  if (!isUuid(reviewId) || !isSeenTimestamp(seen)) {
    redirect(withQuery(READER_REVIEWS_PATH, "error", STAFF_GENERIC_ERROR_MESSAGE));
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("staff_approve_reader_review", {
    p_review_id: reviewId,
    p_seen_updated_at: seen,
  });
  if (error) console.error("approveReaderReviewAsStaff: staff_approve_reader_review failed:", error.code);
  const failure = error ? STAFF_GENERIC_ERROR_MESSAGE : approveFailure(data);
  if (failure) {
    redirect(withQuery(READER_REVIEWS_PATH, "error", failure));
  }

  revalidateBook(bookId);
  redirect(withQuery(READER_REVIEWS_PATH, "success", REVIEW_APPROVED_MESSAGE));
}

export async function rejectReaderReviewAsStaff(formData: FormData): Promise<void> {
  await requireStaff("reports.resolve");

  const reviewId = formData.get("review_id");
  const seen = formData.get("seen");
  const bookId = formData.get("book_id");
  const reason = formData.get("reason");
  const note = String(formData.get("note") ?? "").trim();
  if (!isUuid(reviewId) || !isSeenTimestamp(seen)) {
    redirect(withQuery(READER_REVIEWS_PATH, "error", STAFF_GENERIC_ERROR_MESSAGE));
  }
  const invalid = validateRejectForm(reason, note);
  if (invalid) {
    redirect(withQuery(READER_REVIEWS_PATH, "error", invalid));
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("staff_reject_reader_review", {
    p_review_id: reviewId,
    p_seen_updated_at: seen,
    p_reason: reason,
    p_note: note === "" ? null : note,
  });
  if (error) console.error("rejectReaderReviewAsStaff: staff_reject_reader_review failed:", error.code);
  const failure = error ? STAFF_GENERIC_ERROR_MESSAGE : rejectFailure(data);
  if (failure) {
    redirect(withQuery(READER_REVIEWS_PATH, "error", failure));
  }

  revalidateBook(bookId);
  redirect(withQuery(READER_REVIEWS_PATH, "success", REVIEW_REJECTED_MESSAGE));
}

// The person's page (owner and admin reach it: people.view). Q2a: the
// reader asks support; staff type the new name, or leave it empty to
// clear it.
export async function setReviewNameAsStaff(formData: FormData): Promise<void> {
  await requireStaff("people.view");
  await requireStaff("reports.resolve");

  const userId = formData.get("user_id");
  if (!isUuid(userId)) {
    redirect(withQuery("/admin/people", "error", STAFF_GENERIC_ERROR_MESSAGE));
  }
  const back = `/admin/people/${userId}`;
  const name = String(formData.get("review_name") ?? "").trim();
  const invalid = validateReviewName(name);
  if (invalid) {
    redirect(withQuery(back, "error", invalid));
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("staff_set_review_name", {
    p_user_id: userId,
    p_name: name === "" ? null : name,
  });
  if (error) console.error("setReviewNameAsStaff: staff_set_review_name failed:", error.code);
  const failure = error ? STAFF_GENERIC_ERROR_MESSAGE : setNameFailure(data);
  if (failure) {
    redirect(withQuery(back, "error", failure));
  }

  revalidatePath(back);
  redirect(withQuery(back, "success", name === "" ? REVIEW_NAME_CLEARED_MESSAGE : REVIEW_NAME_SAVED_MESSAGE));
}
