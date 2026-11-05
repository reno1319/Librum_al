"use server";

import { redirect } from "next/navigation";
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireStaff } from "@/lib/staff";
import {
  sendBookApprovedEmail,
  sendBookChangesApprovedEmail,
  sendBookSentBackEmail,
  sendBookTakedownEmail,
  sendNewBookEmails,
} from "@/lib/email";
import { BOOK_COVERS_BUCKET, classifyBookCoverPath } from "@/lib/book-storage-path";
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
  validatePdEditionForm,
  PD_EDITION_SAVED_MESSAGE,
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
    "/librari",
    `/libra/${bookId}`,
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
    for (const id of bundleIds) paths.add(`/paketa/${id}`);

    const [{ data: bundles }, { data: book }] = await Promise.all([
      bundleIds.length > 0
        ? admin.from("bundles").select("id, title").in("id", bundleIds).returns<{ id: string; title: string }[]>()
        : Promise.resolve({ data: [] as { id: string; title: string }[] }),
      admin.from("books").select("pen_name_id").eq("id", bookId).maybeSingle<{ pen_name_id: string | null }>(),
    ]);
    if (book?.pen_name_id) paths.add(`/autore/${book.pen_name_id}`);

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
  cover_path: string | null;
  // BD15 P7: a linked book is approved as its work's edition.
  pd_work_id: string | null;
  pd_editor_credit: boolean;
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
    .select("id, title, author_id, status, price_all, description, pen_name_id, cover_path, pd_work_id, pd_editor_credit")
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
  // BD15 P7 (Q3 a): a book linked to a public-domain work is approved
  // as that work's edition -- picked, and the previous edition back to
  // draft (a swap) -- in one transaction. Otherwise the plain approval,
  // which the database refuses for an unlinked public-domain book (LB498).
  const approveRpc = book.pd_work_id ? "admin_approve_pd_edition" : "admin_approve_book_review";
  const { data: firstPublication, error } = await supabase.rpc(approveRpc, {
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
      console.error(`approveBookReviewAsStaff: ${approveRpc} failed`, {
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
    // BD15 P5b-2: a live book's approved changes get their own email.
    if (email) {
      if (book.status === "published") await sendBookChangesApprovedEmail(email, { title: book.title, bookId: book.id });
      else await sendBookApprovedEmail(email, { title: book.title, bookId: book.id });
    }
  } catch (followUpError) {
    console.error("approveBookReviewAsStaff: the author email failed after a successful approval", {
      bookId: book.id,
      error: followUpError,
    });
  }
  // J: followers hear only about a FIRST publication (unchanged rule).
  // B6: their emails go out after the page has answered (Next's after()),
  // so a long follower list can't slow down or time out Approve. Logged,
  // never rethrown, whether scheduling or sending fails.
  // BD15 P7: never for a public-domain edition without the editor
  // mention -- its uploader's followers would learn whose it is.
  const uploaderHidden = Boolean(book.pd_work_id) && !book.pd_editor_credit;
  if (firstPublication === true && !uploaderHidden) {
    const logFollowersFailure = (followUpError: unknown) =>
      console.error("approveBookReviewAsStaff: the followers email failed after a successful approval", {
        bookId: book.id,
        error: followUpError,
      });
    try {
      after(async () => {
        try {
          await sendNewBookEmails(admin, { bookId: book.id, authorId: book.author_id });
        } catch (followUpError) {
          logFollowersFailure(followUpError);
        }
      });
    } catch (followUpError) {
      logFollowersFailure(followUpError);
    }
  }

  // N3: the previously approved file is no longer the buyers' file.
  await removeUnretainedManuscripts(admin, admin, {
    authorId: book.author_id,
    bookId: book.id,
    caller: "approveBookReviewAsStaff",
  });
  // BD15 P5b-2: a live book's approved new ballinë replaced the one
  // readers saw; that one is removed once the book is proven to name the
  // new one (best effort; never another book's key).
  if (book.status === "published" && book.cover_path !== null && book.cover_path !== validation.coverPath) {
    try {
      const { data: now } = await admin
        .from("books")
        .select("cover_path")
        .eq("id", book.id)
        .maybeSingle<{ cover_path: string | null }>();
      if (
        now &&
        now.cover_path === validation.coverPath &&
        classifyBookCoverPath(book.cover_path, book.author_id, book.id) !== "unsafe"
      ) {
        const { error: removeError } = await admin.storage.from(BOOK_COVERS_BUCKET).remove([book.cover_path]);
        if (removeError) console.error("approveBookReviewAsStaff: replaced cover not removed", { bookId: book.id });
      }
    } catch {
      console.error("approveBookReviewAsStaff: replaced cover not removed", { bookId: book.id });
    }
  }

  revalidateAll(
    [
      "/",
      "/librari",
      `/libra/${book.id}`,
      ...(book.pen_name_id ? [`/autore/${book.pen_name_id}`] : []),
      "/admin",
      "/admin/books",
      "/admin/books/public-domain",
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
        // BD15 P5b-2: a live book's changes were sent back; it stays live.
        const { data: sentBackBook } = await admin
          .from("books")
          .select("status")
          .eq("id", validation.bookId)
          .maybeSingle<{ status: string }>();
        await sendBookSentBackEmail(email, {
          title: review.book_title,
          reasonLabel: authorTakedownReasonLabel(review.reason),
          message: review.message_to_author,
          live: sentBackBook?.status === "published",
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

// BD15 P7: the Public-domain edition box -- link the book to a work
// (existing or new), unlink a draft, or change the editor mention.
// staff_set_pd_edition is the authority (books.review, the rights
// choice, a live edition keeping its work); errors are mapped.
export async function setPdEditionAsStaff(formData: FormData) {
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    redirectForMaintenance("/admin/books");
  }

  await requireStaff("books.review");

  const validation = validatePdEditionForm(formData);
  if (!validation.ok) {
    const rawBook = formData.get("bookId");
    redirect(withQuery(isUuid(rawBook) ? `/admin/books/${rawBook}` : "/admin/books", "error", validation.error));
  }
  const bookPath = `/admin/books/${validation.bookId}`;

  const supabase = await createClient();
  const { error } = await supabase.rpc("staff_set_pd_edition", {
    p_book_id: validation.bookId,
    p_work_id: validation.workId,
    p_work_title: validation.workTitle,
    p_work_original_author: validation.workOriginalAuthor,
    p_editor_credit: validation.editorCredit,
  });

  if (error) {
    if (error.message === TAKEDOWN_RPC_NOT_AUTHENTICATED_MESSAGE) {
      redirect(`/login?next=${encodeURIComponent(bookPath)}`);
    }
    if (error.code !== "40P01") {
      console.error("setPdEditionAsStaff: staff_set_pd_edition failed", { bookId: validation.bookId, code: error.code });
    }
    redirect(withQuery(bookPath, "error", mapReviewRpcError(error)));
  }

  // The mention changes what a live edition's page shows.
  revalidateAll(
    ["/", "/librari", `/libra/${validation.bookId}`, "/admin/books/public-domain", bookPath, "/dashboard"],
    "setPdEditionAsStaff",
  );

  redirect(withQuery(bookPath, "success", PD_EDITION_SAVED_MESSAGE));
}
