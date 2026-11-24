import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff";
import { roleHasPermission } from "@/lib/staff-permissions";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { feedbackStatusFilter, isCleanFeedbackPath, parseAdminFeedbackRows, type FeedbackStatusFilter } from "@/lib/reader-feedback";
import { markFeedbackDone, markSelectedFeedbackDone } from "./actions";
import { Alert } from "@/components/ui/alert";
import { BulkSelectBar } from "../../bulk-select-bar";
import { BULK_PICK_FIELD, feedbackBulkLines, parseFeedbackBulk } from "../../bulk-select-logic";
import type { Metadata } from "next";

// K4 feedback d a (Renato 2026-11-15): the "Na tregoni" messages, under
// Daily. Newest first; Open / Done / All; "Mark done"; the sender's
// email for owner and admin only (mod a). No email is sent
// for a message: the open count shows on Today instead.
export const metadata: Metadata = { title: "Feedback" };

const FILTERS: { value: FeedbackStatusFilter; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "done", label: "Done" },
  { value: "all", label: "All" },
];

const BULK_FORM_ID = "bulk-feedback-done";

const KIND_LABEL = { problem: "Problem", idea: "Idea" } as const;

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Tirane",
  });
}

export default async function AdminFeedbackPage({ searchParams }: { searchParams: Promise<{ status?: string; bulk?: string }> }) {
  const { role } = await requireStaff("reports.view");
  const canResolve = roleHasPermission(role, "reports.resolve");
  // Audit r1 F2 (Renato 11-15, mod a): the reader's email only for staff
  // who may see people; the database sends none to anyone else.
  const canSeeSender = roleHasPermission(role, "people.view");
  const { status, bulk: rawBulk } = await searchParams;
  const active = feedbackStatusFilter(status);
  // G4 batch 3 (b3e1 a): after "Mark selected done", built from digits only.
  const bulk = parseFeedbackBulk(rawBulk);
  const bulkLines = bulk ? feedbackBulkLines(bulk) : null;

  const supabase = await createClient();
  const [listResult, openResult] = await Promise.all([
    supabase.rpc("staff_list_reader_feedback", { p_status: active }),
    active === "open" ? Promise.resolve(null) : supabase.rpc("staff_list_reader_feedback", { p_status: "open" }),
  ]);
  const failed = Boolean(listResult.error) || Boolean(openResult?.error);
  const rows = parseAdminFeedbackRows(listResult.data);
  const openCount = active === "open" ? rows.length : parseAdminFeedbackRows(openResult?.data).length;
  const canBulk = canResolve && rows.some((r) => !r.doneAt);

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-10 sm:px-6">
      <Link href="/admin" className="text-sm text-muted underline underline-offset-2 hover:decoration-2">
        &larr; Back to admin
      </Link>
      <div className="mt-2">
        <PageHeader
          title="Feedback"
          description={failed ? "Couldn’t load. Reload the page to try again." : `${openCount} open message${openCount === 1 ? "" : "s"} from readers`}
        />
      </div>
      <div className="mt-6 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Link
            key={f.value}
            href={f.value === "open" ? "/admin/feedback" : `/admin/feedback?status=${f.value}`}
            aria-current={f.value === active ? "true" : undefined}
            className={`rounded-full border px-3 py-1 text-sm ${
              f.value === active ? "border-primary bg-primary text-primary-foreground" : "border-border bg-surface text-foreground hover:bg-surface-hover"
            }`}
          >
            {f.label}
          </Link>
        ))}
      </div>
      {bulkLines?.success && (
        <Alert variant="success" className="mt-6">
          {bulkLines.success}
        </Alert>
      )}
      {bulkLines?.error && (
        <Alert variant="error" className="mt-6">
          {bulkLines.error}
        </Alert>
      )}
      {rows.length === 0 ? (
        <EmptyState className="mt-6" title="No messages here." description="Messages sent with the Na tregoni button appear here." />
      ) : (
        <>
        {canBulk && (
          <BulkSelectBar
            formId={BULK_FORM_ID}
            action={markSelectedFeedbackDone}
            actionLabel="Mark selected done"
            hidden={{ status: active }}
            className="mt-6"
          />
        )}
        <ul className={`${canBulk ? "mt-3" : "mt-6"} flex flex-col gap-3`}>
          {rows.map((r) => (
            <li key={r.id} className="rounded-card border border-border bg-surface p-4 shadow-sm">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.8125rem]">
                {!r.doneAt && canResolve && (
                  <input
                    type="checkbox"
                    form={BULK_FORM_ID}
                    name={BULK_PICK_FIELD}
                    value={r.id}
                    aria-label="Select this message"
                    className="size-5 accent-[#1E3A32]"
                  />
                )}
                <span
                  className={`rounded-full px-2.5 py-0.5 font-semibold ${
                    r.kind === "problem" ? "bg-[#f6e3df] text-[#8E2A1E]" : "bg-author-tint text-primary"
                  }`}
                >
                  {KIND_LABEL[r.kind]}
                </span>
                <span className="text-muted">{formatWhen(r.createdAt)}</span>
                {r.doneAt && <span className="text-green-700">Done</span>}
              </div>
              <p className="mt-2 whitespace-pre-line break-words text-[0.9375rem] text-foreground">{r.body}</p>
              <dl className="mt-3 grid gap-1 text-[0.8125rem] sm:grid-cols-2">
                <div className="min-w-0">
                  <dt className="inline text-muted">Page: </dt>
                  <dd className="inline break-all">
                    {/* Audit r1 F1: a link only for a clean site path. */}
                    {isCleanFeedbackPath(r.pagePath) ? (
                      <Link href={r.pagePath} className="underline underline-offset-2">
                        {r.pagePath}
                      </Link>
                    ) : (
                      <span data-unsafe-path="">{r.pagePath}</span>
                    )}
                  </dd>
                </div>
                {canSeeSender && (
                  <div className="min-w-0">
                    <dt className="inline text-muted">From: </dt>
                    <dd className="inline break-all">
                      {r.senderEmail ? (
                        <a href={`mailto:${r.senderEmail}`} className="underline underline-offset-2">
                          {r.senderEmail}
                        </a>
                      ) : (
                        "a deleted account"
                      )}
                    </dd>
                  </div>
                )}
              </dl>
              {!r.doneAt && canResolve && (
                <form action={markFeedbackDone}>
                  <input type="hidden" name="id" value={r.id} />
                  <button
                    type="submit"
                    className="focus-ring mt-3 inline-flex min-h-10 items-center rounded-full border border-control px-4 text-sm font-semibold hover:bg-surface-hover"
                  >
                    Mark done
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>
        </>
      )}
    </main>
  );
}
