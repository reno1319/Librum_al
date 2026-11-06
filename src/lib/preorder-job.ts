import "server-only";
import type { createAdminClient } from "@/lib/supabase/admin";
import type { PreorderRunCounts } from "@/lib/preorder-staff";

// BD16 P3 (PLAN-BD16-r1 §3.5): the daily pre-order job's database step,
// run_preorder_day() (migration 20261106120000; service role only, safe
// to run twice, one book failing never stops the others). Used by the
// owner's "run now" button on the Today page. P5 adds the cron route and
// the emails on top of this same call; until then nothing here sends
// an email (the rows the emails are built from stay in the database).

type AdminClient = ReturnType<typeof createAdminClient>;

export type PreorderDaySummary = {
  today: string;
  releasedBookIds: string[];
  slipped: { bookId: string; releaseDate: string }[];
  cancelledBookIds: string[];
  overdueBookIds: string[];
  failed: { bookId: string; sqlstate: string }[];
};

function ids(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** The function's jsonb answer, read defensively (never trusted blindly). */
export function parsePreorderDaySummary(raw: unknown): PreorderDaySummary | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.today !== "string") return null;
  const slipped = Array.isArray(value.slipped) ? value.slipped : [];
  const failed = Array.isArray(value.failed) ? value.failed : [];
  return {
    today: value.today,
    releasedBookIds: ids(value.released_book_ids),
    slipped: slipped.flatMap((row) => {
      const r = row as Record<string, unknown> | null;
      return r && typeof r.book_id === "string" && typeof r.release_date === "string"
        ? [{ bookId: r.book_id, releaseDate: r.release_date }]
        : [];
    }),
    cancelledBookIds: ids(value.cancelled_book_ids),
    overdueBookIds: ids(value.overdue_book_ids),
    failed: failed.flatMap((row) => {
      const r = row as Record<string, unknown> | null;
      return r && typeof r.book_id === "string" ? [{ bookId: r.book_id, sqlstate: String(r.sqlstate ?? "") }] : [];
    }),
  };
}

/** Runs today's step (p_today null: tirana_today()). Null on any failure. */
export async function runPreorderDay(admin: AdminClient): Promise<PreorderDaySummary | null> {
  try {
    const { data, error } = await admin.rpc("run_preorder_day", { p_today: null });
    if (error) {
      console.error("runPreorderDay: run_preorder_day failed", { code: error.code ?? null });
      return null;
    }
    const summary = parsePreorderDaySummary(data);
    if (!summary) console.error("runPreorderDay: unexpected answer");
    return summary;
  } catch (runError) {
    console.error("runPreorderDay: run_preorder_day threw", { error: runError });
    return null;
  }
}

/** The counts the owner's result line shows (see preorder-staff.ts). */
export function preorderDayCounts(summary: PreorderDaySummary): PreorderRunCounts {
  return {
    released: summary.releasedBookIds.length,
    slipped: summary.slipped.length,
    cancelled: summary.cancelledBookIds.length,
    overdue: summary.overdueBookIds.length,
    failed: summary.failed.length,
  };
}
