import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatActivityTime } from "../admin-landing-logic";
import {
  FAILED_EMAILS_HEADING,
  FAILED_EMAILS_INTRO,
  FAILED_EMAILS_LOAD_ERROR,
  MARK_HANDLED_BUTTON,
  SEND_AGAIN_BUTTON,
  failureLineStart,
  failureReaderName,
  failureReason,
  parsePreorderEmailFailureRows,
} from "@/lib/preorder-email-failures";
import { markFailedPreorderEmailHandled, sendFailedPreorderEmailAgain } from "./failed-preorder-email-actions";

// G4 (Renato 11-24, g4q2 a, g4p1 a): the "Failed pre-order emails" box
// on the admin Today page, under the waiting tiles. The page renders it
// only for people.view (Owner and Admin, g4q6 a);
// staff_list_preorder_email_failures() checks the same permission. No
// failures: nothing is shown. A failed read shows one line, so a
// failure is never hidden by a read error.
export async function FailedPreorderEmails() {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("staff_list_preorder_email_failures");
  if (error) {
    console.error("failed pre-order emails: list failed", { code: error.code ?? null });
    return (
      <p role="alert" className="rounded-card border border-[#8E2A1E] bg-surface p-3 text-sm text-red-700">
        {FAILED_EMAILS_LOAD_ERROR}
      </p>
    );
  }
  const rows = parsePreorderEmailFailureRows(data);
  if (rows.length === 0) return null;

  return (
    <section
      aria-labelledby="today-failed-emails"
      className="rounded-card border border-[#8E2A1E] bg-surface p-4 md:p-6"
    >
      <h2 id="today-failed-emails" className="font-serif text-[1.375rem] font-bold text-primary md:text-2xl">
        {FAILED_EMAILS_HEADING} <span className="font-sans text-base font-semibold text-[#8E2A1E]">({rows.length})</span>
      </h2>
      <p className="mt-1 mb-4 text-sm text-muted">{FAILED_EMAILS_INTRO}</p>
      <ul className="flex flex-col">
        {rows.map((row) => (
          <li
            key={`${row.bookId}:${row.userId}`}
            className="flex flex-col gap-2.5 border-t border-border py-3.5 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-3"
          >
            <div className="min-w-0 sm:flex-[1_1_320px]">
              <p className="font-semibold break-words">
                {failureLineStart(row)}{" "}
                <Link
                  href={`/admin/people/${row.userId}`}
                  className="focus-ring rounded-sm text-primary underline underline-offset-2 hover:decoration-2"
                >
                  {failureReaderName(row)}
                </Link>{" "}
                failed
              </p>
              <p className="mt-0.5 text-sm text-muted">
                {formatActivityTime(row.failedAt)} · {failureReason(row.failure)}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <form action={sendFailedPreorderEmailAgain}>
                <input type="hidden" name="book_id" value={row.bookId} />
                <input type="hidden" name="user_id" value={row.userId} />
                <button
                  type="submit"
                  className="focus-ring inline-flex min-h-12 items-center justify-center rounded-full bg-primary px-[1.125rem] text-[0.9375rem] font-semibold text-primary-foreground transition-colors hover:bg-primary-hover sm:min-h-11"
                >
                  {SEND_AGAIN_BUTTON}
                </button>
              </form>
              <form action={markFailedPreorderEmailHandled}>
                <input type="hidden" name="book_id" value={row.bookId} />
                <input type="hidden" name="user_id" value={row.userId} />
                <button
                  type="submit"
                  className="focus-ring inline-flex min-h-12 items-center justify-center rounded-full border border-primary px-[1.125rem] text-[0.9375rem] font-semibold text-primary transition-colors hover:bg-surface-hover sm:min-h-11"
                >
                  {MARK_HANDLED_BUTTON}
                </button>
              </form>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
