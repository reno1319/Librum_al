import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { roleHasPermission } from "@/lib/staff-permissions";
import { parseAdminFeedbackRows } from "@/lib/reader-feedback";
import type { StaffRole } from "@/lib/types";

// G4 batch 3 (Renato g4q8 a): a count bubble on five menu items, the
// same numbers as the Today tiles, hidden at zero, and only for staff
// who can open that page. The Books bubble counts books waiting for
// review, so it needs books.review (Owner, Admin), not the menu item's
// own reports.view: a Moderator sees Books but cannot review a book.
// A failed read shows no bubble (the page itself shows its own error).
//
// The bubbles live in the admin layout, which Next.js does not re-render
// on a client-side link click: they are as fresh as the last full page
// load or the last staff action (every action revalidates its page).
export type AdminNavCounts = Readonly<Record<string, number>>;

export const NAV_COUNT_HREFS = {
  readerReviews: "/admin/reader-reviews",
  reports: "/admin/reports",
  feedback: "/admin/feedback",
  refunds: "/admin/refunds",
  books: "/admin/books",
} as const;

export function resolveNavCountVisibility(role: StaffRole) {
  return {
    readerReviews: roleHasPermission(role, "reports.resolve"),
    reports: roleHasPermission(role, "reports.view"),
    feedback: roleHasPermission(role, "reports.view"),
    refunds: roleHasPermission(role, "refunds.view"),
    books: roleHasPermission(role, "books.review"),
  };
}

// Keeps only real, positive counts: zero and failed reads show nothing.
export function buildNavCounts(
  entries: ReadonlyArray<readonly [href: string, count: number | null]>,
): AdminNavCounts {
  const counts: Record<string, number> = {};
  for (const [href, count] of entries) {
    if (typeof count === "number" && Number.isInteger(count) && count > 0) counts[href] = count;
  }
  return counts;
}

async function safeCount(label: string, read: () => PromiseLike<number | null>): Promise<number | null> {
  try {
    return await read();
  } catch (error) {
    console.error(`admin nav counts: ${label} failed`, { error: error instanceof Error ? error.name : "unknown" });
    return null;
  }
}

// The same filters as the Today tiles (src/app/admin/(protected)/page.tsx).
export async function loadAdminNavCounts(role: StaffRole): Promise<AdminNavCounts> {
  const show = resolveNavCountVisibility(role);
  if (!Object.values(show).some(Boolean)) return {};
  const supabase = await createClient();

  const [readerReviews, reports, feedback, refunds, books] = await Promise.all([
    show.readerReviews
      ? safeCount("reader reviews", async () => {
          const { data, error } = await supabase.rpc("staff_list_pending_reader_reviews");
          return error || !Array.isArray(data) ? null : data.length;
        })
      : null,
    show.reports
      ? safeCount("reports", async () => {
          const { count, error } = await supabase
            .from("book_reports")
            .select("id", { count: "exact", head: true })
            .eq("status", "open");
          return error ? null : count;
        })
      : null,
    show.feedback
      ? safeCount("feedback", async () => {
          const { data, error } = await supabase.rpc("staff_list_reader_feedback", { p_status: "open" });
          return error ? null : parseAdminFeedbackRows(data).length;
        })
      : null,
    show.refunds
      ? safeCount("refunds", async () => {
          const { count, error } = await supabase
            .from("refund_requests")
            .select("id", { count: "exact", head: true })
            .eq("status", "requested");
          return error ? null : count;
        })
      : null,
    // Staff sessions cannot read review rows: the service-role client,
    // only after the books.review check above (the layout's
    // requireStaff has already run), as readPendingReviewsForStaff does.
    show.books
      ? safeCount("books", async () => {
          const { count, error } = await createAdminClient()
            .from("book_reviews")
            .select("id", { count: "exact", head: true })
            .eq("status", "pending")
            .not("book_id", "is", null);
          return error ? null : count;
        })
      : null,
  ]);

  return buildNavCounts([
    [NAV_COUNT_HREFS.readerReviews, readerReviews],
    [NAV_COUNT_HREFS.reports, reports],
    [NAV_COUNT_HREFS.feedback, feedback],
    [NAV_COUNT_HREFS.refunds, refunds],
    [NAV_COUNT_HREFS.books, books],
  ]);
}
