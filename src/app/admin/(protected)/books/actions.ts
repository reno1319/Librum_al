"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireStaff } from "@/lib/staff";
import { sendBookApprovedEmail, sendBookSentBackEmail, sendBookTakedownEmail, sendNewBookEmails } from "@/lib/email";
import { resolveMaintenanceMode } from "@/lib/maintenance-mode";
import { redirectForMaintenance } from "@/lib/maintenance-response";
import { authorTakedownReasonLabel } from "@/lib/takedown-reasons";
import { canPublishPaidTitle } from "@/lib/paid-readiness";
import { checkPublishGate } from "@/lib/publish-readiness";
import { removeUnretainedManuscripts } from "@/lib/book-reviews";
import { readRightsStateForStaff } from "./admin-book-reads";
import {
  APPROVED_SUCCESS_MESSAGE,
  GENERIC_REVIEW_ERROR_MESSAGE,
  SENT_BACK_SUCCESS_MESSAGE,
  approveReadinessMessage,
  mapReviewRpcError,
  validateApproveForm,
  validateSendBackForm,
  ALLOWED_AGAIN_SUCCESS_MESSAGE,
  GENERIC_TAKEDOWN_ERROR_MESSAGE,
  TAKEDOWN_RPC_NOT_AUTHENTICATED_MESSAGE,
  UNPUBLISHED_SUCCESS_MESSAGE,
  UNPUBLISHED_WITH_REPORT_SUCCESS_MESSAGE,
  isUuid,
  mapTakedownRpcError,
  validateUnpublishForm,
} from "./book-admin-logic";

// ADMIN-2-TAKEDOWN (C): staff Unpublish and "Allow again". Same shape as
// reviewRefundRequest() (refunds/actions.ts): the maintenance gate first,
// then requireStaff("reports.resolve") as defense in depth -- Server
// Actions do not re-run the page that rendered the form -- then the RPC
// through the staff member's OWN session client, so auth.uid() inside
// admin_unpublish_book()/admin_allow_book_again() is that staff member.
// The RPC is the authority: it re-checks reports.resolve, validates the
// reason, message and report, locks, and writes everything in one
// transaction (migration 20261020080000). Errors are mapped, never shown
// raw. Everything after a successful RPC (the author's email, cache
// revalidation) is best effort: logged, never turned into a failure, and
// redirect() stays outside every try/catch.

function bookPagePath(bookId: string, reportId: string | null): string {
  return reportId ? `/admin/books/${bookId}?report=${encodeURIComponent(reportId)}` : `/admin/books/${bookId}`;
}

function withQuery(path: string, key: "error" | "success", message: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(message)}`;
}

export async function unpublishBookAsStaff(formData: FormData) {
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    redirectForMaintenance("/admin/books");
  }

  await requireStaff("reports.resolve");

  const bookId = formData.get("bookId");
  if (!isUuid(bookId)) {
    redirect(withQuery("/admin/books", "error", GENERIC_TAKEDOWN_ERROR_MESSAGE));
  }

  const validation = validateUnpublishForm(formData);
  const rawReport = formData.get("reportId");
  const backTo = bookPagePath(bookId, isUuid(rawReport) ? rawReport : null);
  if (!validation.ok) {
    redirect(withQuery(backTo, "error", validation.error));
  }

  const supabase = await createClient();
  const { data: takedownId, error } = await supabase.rpc("admin_unpublish_book", {
    p_book_id: bookId,
    p_reason: validation.reason,
    p_message: validation.message,
    p_report_id: validation.reportId,
  });

  if (error) {
    if (error.message === TAKEDOWN_RPC_NOT_AUTHENTICATED_MESSAGE) {
      redirect(`/login?next=${encodeURIComponent(`/admin/books/${bookId}`)}`);
    }
    if (error.code !== "40P01") {
      console.error("unpublishBookAsStaff: admin_unpublish_book failed", { bookId, code: error.code });
    }
    redirect(withQuery(backTo, "error", mapTakedownRpcError(error)));
  }

  await notifyAuthorAndRevalidate(
    typeof takedownId === "string" ? takedownId : null,
    bookId,
    validation.reportId,
  );

  redirect(
    withQuery(
      `/admin/books/${bookId}`,
      "success",
      validation.reportId ? UNPUBLISHED_WITH_REPORT_SUCCESS_MESSAGE : UNPUBLISHED_SUCCESS_MESSAGE,
    ),
  );
}

// 2a and S9, after the takedown committed; the report pages too when it
// resolved one. Reads with the service-role
// client (requireStaff has passed): the takedown row the RPC returned,
// the titles of the bundles it unpublished, the book's pen name for its
// author page, and the author's address through the auth admin API. No
// email address is ever logged.
async function notifyAuthorAndRevalidate(
  takedownId: string | null,
  bookId: string,
  reportId: string | null,
): Promise<void> {
  const paths = new Set<string>([
    "/",
    "/bookstore",
    `/books/${bookId}`,
    "/admin/books",
    `/admin/books/${bookId}`,
    "/dashboard",
  ]);
  if (reportId) {
    paths.add(`/admin/reports/${reportId}`);
    paths.add("/admin/reports");
    paths.add("/admin");
  }

  try {
    const admin = createAdminClient();
    const { data: takedown } = takedownId
      ? await admin
          .from("book_takedowns")
          .select("book_title, author_id, reason, message_to_author, bundle_ids")
          .eq("id", takedownId)
          .maybeSingle<{
            book_title: string;
            author_id: string | null;
            reason: string;
            message_to_author: string;
            bundle_ids: string[];
          }>()
      : { data: null };

    const bundleIds = takedown?.bundle_ids ?? [];
    for (const id of bundleIds) paths.add(`/bundles/${id}`);

    const [{ data: bundles }, { data: book }] = await Promise.all([
      bundleIds.length > 0
        ? admin.from("bundles").select("id, title").in("id", bundleIds).returns<{ id: string; title: string }[]>()
        : Promise.resolve({ data: [] as { id: string; title: string }[] }),
      admin.from("books").select("pen_name_id").eq("id", bookId).maybeSingle<{ pen_name_id: string | null }>(),
    ]);
    if (book?.pen_name_id) paths.add(`/authors/${book.pen_name_id}`);

    if (takedown?.author_id) {
      const { data: author } = await admin.auth.admin.getUserById(takedown.author_id);
      const email = author?.user?.email;
      if (email) {
        const titleById = new Map((bundles ?? []).map((b) => [b.id, b.title]));
        await sendBookTakedownEmail(email, {
          title: takedown.book_title,
          reasonLabel: authorTakedownReasonLabel(takedown.reason),
          message: takedown.message_to_author,
          bundleTitles: bundleIds.map((id) => titleById.get(id)).filter((t): t is string => !!t),
        });
      }
    }
  } catch (followUpError) {
    console.error("unpublishBookAsStaff: the author email failed after a successful takedown", {
      bookId,
      error: followUpError,
    });
  }

  for (const path of paths) {
    try {
      revalidatePath(path);
    } catch (revalidateError) {
      console.error("unpublishBookAsStaff: revalidatePath failed", { path, error: revalidateError });
    }
  }
}

export async function allowBookAgainAsStaff(bookId: string) {
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    redirectForMaintenance("/admin/books");
  }

  await requireStaff("reports.resolve");

  if (!isUuid(bookId)) {
    redirect(withQuery("/admin/books", "error", GENERIC_TAKEDOWN_ERROR_MESSAGE));
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_allow_book_again", { p_book_id: bookId });

  if (error) {
    if (error.message === TAKEDOWN_RPC_NOT_AUTHENTICATED_MESSAGE) {
      redirect(`/login?next=${encodeURIComponent(`/admin/books/${bookId}`)}`);
    }
    redirect(withQuery(`/admin/books/${bookId}`, "error", mapTakedownRpcError(error)));
  }

  for (const path of ["/admin/books", `/admin/books/${bookId}`, "/dashboard"]) {
    try {
      revalidatePath(path);
    } catch (revalidateError) {
      console.error("allowBookAgainAsStaff: revalidatePath failed", { path, error: revalidateError });
    }
  }

  redirect(withQuery(`/admin/books/${bookId}`, "success", ALLOWED_AGAIN_SUCCESS_MESSAGE));
}

// ------------------------------------------------------------
// ADMIN-3-REVIEW (H, J): Approve and Send back.
// ------------------------------------------------------------
// Same shape as the takedown actions: the maintenance gate, then
// requireStaff("books.review") as defense in depth, then the RPC through
// the staff member's OWN session client (auth.uid() is that staff
// member; the RPC re-checks books.review, locks, and binds the approval
// to the files the page rendered). Approve first re-runs the author's
// publish gate (M2, the shared checkPublishGate -- price, description,
// rights and, for a paid title, canPublishPaidTitle()) from the book as
// the service-role client reads it now, and passes that price to the
// RPC, which refuses if it changed. Everything after a successful RPC
// (emails, the retention cleanup, cache revalidation) is best effort.

type ReviewedBook = {
  id: string;
  title: string;
  author_id: string;
  status: string;
  price_all: number | null;
  description: string | null;
  pen_name_id: string | null;
};

export async function approveBookReviewAsStaff(formData: FormData) {
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    redirectForMaintenance("/admin/books");
  }

  await requireStaff("books.review");

  const validation = validateApproveForm(formData);
  if (!validation.ok) {
    const rawBook = formData.get("bookId");
    redirect(withQuery(isUuid(rawBook) ? `/admin/books/${rawBook}` : "/admin/books", "error", validation.error));
  }
  const bookPath = `/admin/books/${validation.bookId}`;

  const admin = createAdminClient();
  const { data: book, error: bookError } = await admin
    .from("books")
    .select("id, title, author_id, status, price_all, description, pen_name_id")
    .eq("id", validation.bookId)
    .maybeSingle<ReviewedBook>();
  if (bookError || !book) {
    redirect(withQuery(bookPath, "error", GENERIC_REVIEW_ERROR_MESSAGE));
  }

  const gate = await checkPublishGate({
    priceAll: book.price_all,
    description: book.description,
    readRights: () => readRightsStateForStaff(book.id),
    paidPublishingAvailable: canPublishPaidTitle,
  });
  if (!gate.ok) {
    redirect(withQuery(bookPath, "error", approveReadinessMessage(gate.reason)));
  }

  const supabase = await createClient();
  const { data: firstPublication, error } = await supabase.rpc("admin_approve_book_review", {
    p_review_id: validation.reviewId,
    p_file_path: validation.filePath,
    p_cover_path: validation.coverPath,
    p_price_all: book.price_all,
    p_checklist: validation.checklist,
  });

  if (error) {
    if (error.message === TAKEDOWN_RPC_NOT_AUTHENTICATED_MESSAGE) {
      redirect(`/login?next=${encodeURIComponent(bookPath)}`);
    }
    if (error.code !== "40P01") {
      console.error("approveBookReviewAsStaff: admin_approve_book_review failed", {
        bookId: book.id,
        code: error.code,
      });
    }
    redirect(withQuery(bookPath, "error", mapReviewRpcError(error)));
  }

  // ALBANIAN-12: the author's own email goes first, so the follower
  // batches (which pause between batches) can't hold it up.
  try {
    const { data: author } = await admin.auth.admin.getUserById(book.author_id);
    const email = author?.user?.email;
    if (email) await sendBookApprovedEmail(email, { title: book.title, bookId: book.id });
  } catch (followUpError) {
    console.error("approveBookReviewAsStaff: the author email failed after a successful approval", {
      bookId: book.id,
      error: followUpError,
    });
  }
  try {
    // J: followers hear only about a FIRST publication (unchanged rule).
    if (firstPublication === true) {
      await sendNewBookEmails(admin, { bookId: book.id, authorId: book.author_id });
    }
  } catch (followUpError) {
    console.error("approveBookReviewAsStaff: the followers email failed after a successful approval", {
      bookId: book.id,
      error: followUpError,
    });
  }

  // N3: the previously approved file is no longer the buyers' file.
  await removeUnretainedManuscripts(admin, admin, {
    authorId: book.author_id,
    bookId: book.id,
    caller: "approveBookReviewAsStaff",
  });

  revalidateAll(
    [
      "/",
      "/bookstore",
      `/books/${book.id}`,
      ...(book.pen_name_id ? [`/authors/${book.pen_name_id}`] : []),
      "/admin",
      "/admin/books",
      bookPath,
      "/dashboard",
    ],
    "approveBookReviewAsStaff",
  );

  redirect(withQuery(bookPath, "success", APPROVED_SUCCESS_MESSAGE));
}

export async function sendBackBookReviewAsStaff(formData: FormData) {
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    redirectForMaintenance("/admin/books");
  }

  await requireStaff("books.review");

  const validation = validateSendBackForm(formData);
  if (!validation.ok) {
    const rawBook = formData.get("bookId");
    redirect(withQuery(isUuid(rawBook) ? `/admin/books/${rawBook}` : "/admin/books", "error", validation.error));
  }
  const bookPath = `/admin/books/${validation.bookId}`;

  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_send_back_book_review", {
    p_review_id: validation.reviewId,
    p_reason: validation.reason,
    p_message: validation.message,
  });

  if (error) {
    if (error.message === TAKEDOWN_RPC_NOT_AUTHENTICATED_MESSAGE) {
      redirect(`/login?next=${encodeURIComponent(bookPath)}`);
    }
    if (error.code !== "40P01") {
      console.error("sendBackBookReviewAsStaff: admin_send_back_book_review failed", {
        bookId: validation.bookId,
        code: error.code,
      });
    }
    redirect(withQuery(bookPath, "error", mapReviewRpcError(error)));
  }

  const admin = createAdminClient();
  try {
    const { data: review } = await admin
      .from("book_reviews")
      .select("book_title, author_id, reason, message_to_author")
      .eq("id", validation.reviewId)
      .maybeSingle<{ book_title: string; author_id: string | null; reason: string; message_to_author: string }>();
    if (review?.author_id) {
      const { data: author } = await admin.auth.admin.getUserById(review.author_id);
      const email = author?.user?.email;
      if (email) {
        await sendBookSentBackEmail(email, {
          title: review.book_title,
          reasonLabel: authorTakedownReasonLabel(review.reason),
          message: review.message_to_author,
        });
      }
      // N3: nothing the rule keeps is removed (the book's current file
      // and its last approved file stay); a stale snapshot may go.
      await removeUnretainedManuscripts(admin, admin, {
        authorId: review.author_id,
        bookId: validation.bookId,
        caller: "sendBackBookReviewAsStaff",
      });
    }
  } catch (followUpError) {
    console.error("sendBackBookReviewAsStaff: the author email failed after a successful send back", {
      bookId: validation.bookId,
      error: followUpError,
    });
  }

  revalidateAll(["/admin", "/admin/books", bookPath, "/dashboard"], "sendBackBookReviewAsStaff");

  redirect(withQuery(bookPath, "success", SENT_BACK_SUCCESS_MESSAGE));
}

function revalidateAll(paths: string[], caller: string): void {
  for (const path of new Set(paths)) {
    try {
      revalidatePath(path);
    } catch (revalidateError) {
      console.error(`${caller}: revalidatePath failed`, { path, error: revalidateError });
    }
  }
}
