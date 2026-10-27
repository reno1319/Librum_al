import { createAdminClient } from "@/lib/supabase/admin";
import { escapeEmailHtml, sendEmail } from "@/lib/email";
import { REPORT_REASONS } from "@/lib/report-reasons";
import { resolveSiteOrigin } from "@/lib/site-url";
import { ROLE_PERMISSIONS, roleHasPermission } from "@/lib/staff-permissions";
import type { Permission, StaffRole } from "@/lib/types";

// ADMIN-ALERTS-1: email staff when work lands in their queue, so the
// 48-hour publish promise does not depend on someone opening the admin.
// Renato's answers (2026-10-27): recipients are the staff whose role has
// the permission for the job (1a) -- books.review for a review request,
// reports.resolve for a report -- read fresh from staff_members on every
// event; one email per event, no throttle (3a); the person who triggered
// it is skipped (5a); a report email names the book and the chosen
// reason only, never the reporter or their free-text details (4a).
//
// Caps (audit F1, Renato's a): so a loop cannot flood staff inboxes or
// use up the email quota, a report emails staff only when it is the
// reader's ONLY report in the last 24 hours, and a review request only
// when it is the book's ONLY review request in the last hour. Both are
// counted from rows that already exist (book_reports.created_at,
// book_reviews.submitted_at), so no new table: every report and every
// request is still saved and shows in admin. Two reports saved at the
// same instant can both see a count of 2 and send nothing -- the safe
// side for a loop. A count that cannot be read sends nothing (logged).
//
// Best effort, like every email (6a): each function catches everything,
// logs without any address, and never throws, so the author's or
// reader's action always succeeds. The admin Today page is what always
// works. No address is ever logged.

type StaffRow = { user_id: string; role: string };

function isStaffRole(role: string): role is StaffRole {
  return Object.prototype.hasOwnProperty.call(ROLE_PERMISSIONS, role);
}

// Subjects are plain text; a title never carries line breaks into one.
function subjectText(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

async function staffEmailsWith(
  admin: ReturnType<typeof createAdminClient>,
  permission: Permission,
  excludeUserId: string,
): Promise<string[]> {
  const { data, error } = await admin.from("staff_members").select("user_id, role").returns<StaffRow[]>();
  if (error || !data) {
    console.error("staff alert: could not read staff", { code: error?.code ?? null });
    return [];
  }
  const ids = data
    .filter((row) => row.user_id !== excludeUserId && isStaffRole(row.role) && roleHasPermission(row.role, permission))
    .map((row) => row.user_id);

  // One at a time, like the other address lookups: a handful of staff.
  const emails: string[] = [];
  for (const id of ids) {
    const { data: user } = await admin.auth.admin.getUserById(id);
    const email = user?.user?.email;
    if (email) emails.push(email);
  }
  return emails;
}

export const REVIEW_EMAIL_WINDOW_MS = 60 * 60 * 1000;
export const REPORT_EMAIL_WINDOW_MS = 24 * 60 * 60 * 1000;

// True when the row just saved is the only one in the window.
async function isOnlyRecentRow(
  admin: ReturnType<typeof createAdminClient>,
  { table, column, value, since }: { table: "book_reviews" | "book_reports"; column: string; value: string; since: string },
): Promise<boolean> {
  const timeColumn = table === "book_reviews" ? "submitted_at" : "created_at";
  const { count, error } = await admin
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq(column, value)
    .gte(timeColumn, since);
  if (error || count === null) {
    console.error("staff alert: could not count recent rows", { table, code: error?.code ?? null });
    return false;
  }
  return count <= 1;
}

async function readBookTitle(admin: ReturnType<typeof createAdminClient>, bookId: string): Promise<string | null> {
  const { data } = await admin.from("books").select("title").eq("id", bookId).maybeSingle<{ title: string }>();
  return data?.title ?? null;
}

// Called after request_book_review() succeeded: a first "Send for
// review", or a live or waiting book whose file or cover changed (2a).
export async function sendReviewRequestedStaffEmail({ bookId, authorId }: { bookId: string; authorId: string }) {
  try {
    const admin = createAdminClient();
    const since = new Date(Date.now() - REVIEW_EMAIL_WINDOW_MS).toISOString();
    if (!(await isOnlyRecentRow(admin, { table: "book_reviews", column: "book_id", value: bookId, since }))) return;
    const title = await readBookTitle(admin, bookId);
    if (title === null) return;
    const recipients = await staffEmailsWith(admin, "books.review", authorId);
    const origin = resolveSiteOrigin();
    for (const to of recipients) {
      await sendEmail(
        to,
        `Review needed: “${subjectText(title)}”`,
        `<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h1 style="font-size: 20px;">A book is waiting for review</h1>
        <p><strong>${escapeEmailHtml(title)}</strong></p>
        <p><a href="${origin}/admin/books/${encodeURIComponent(bookId)}">Open it in admin</a></p>
      </div>`,
      );
    }
  } catch (error) {
    console.error("sendReviewRequestedStaffEmail failed", {
      bookId,
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}

// Called after a reader's report was saved.
export async function sendBookReportedStaffEmail({
  bookId,
  reporterId,
  reason,
}: {
  bookId: string;
  reporterId: string;
  reason: string;
}) {
  try {
    if (!REPORT_REASONS.includes(reason as (typeof REPORT_REASONS)[number])) return;
    const admin = createAdminClient();
    const since = new Date(Date.now() - REPORT_EMAIL_WINDOW_MS).toISOString();
    if (!(await isOnlyRecentRow(admin, { table: "book_reports", column: "reporter_id", value: reporterId, since }))) {
      return;
    }
    const title = await readBookTitle(admin, bookId);
    if (title === null) return;
    const recipients = await staffEmailsWith(admin, "reports.resolve", reporterId);
    const origin = resolveSiteOrigin();
    for (const to of recipients) {
      await sendEmail(
        to,
        `Book reported: “${subjectText(title)}”`,
        `<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h1 style="font-size: 20px;">A book was reported</h1>
        <p><strong>${escapeEmailHtml(title)}</strong>. Reason: ${escapeEmailHtml(reason)}</p>
        <p><a href="${origin}/admin/reports">Open Reports in admin</a></p>
      </div>`,
      );
    }
  } catch (error) {
    console.error("sendBookReportedStaffEmail failed", {
      bookId,
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}
