import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import type { BookReportStatus } from "@/lib/types";
import { REPORT_STATUS_LABELS, compareForTriage } from "./report-review-logic";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Book reports",
};

const STATUS_CLASS: Record<BookReportStatus, string> = {
  open: "font-semibold text-primary",
  resolved: "text-green-700",
  dismissed: "text-muted",
};

const FILTERS: { value: BookReportStatus | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "open", label: "Open" },
  { value: "resolved", label: "Resolved" },
  { value: "dismissed", label: "Dismissed" },
];

type AdminBookReportRow = {
  id: string;
  reason: string;
  status: BookReportStatus;
  created_at: string;
  reviewed_at: string | null;
  books: { title: string } | null;
};

export default async function AdminBookReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  // ADMIN-1A pre-finalize correction: src/app/admin/layout.tsx's
  // requireStaff("admin.access") only proves the caller is SOME staff
  // member -- it does not imply reports.view (e.g. 'support' has
  // admin.access but not reports.view). This route's own explicit check
  // is the actual gate; the RLS policy "Staff with reports.view can view
  // all book reports" (public.staff_has_permission('reports.view'),
  // migration 040) is defense-in-depth behind it, same relationship
  // requireAdmin()/is_admin() always had.
  await requireStaff("reports.view");

  const supabase = await createClient();
  const { status: statusParam } = await searchParams;
  const activeFilter: BookReportStatus | "all" =
    statusParam === "open" || statusParam === "resolved" || statusParam === "dismissed"
      ? statusParam
      : "all";

  // book_id is the only foreign key from book_reports to books, so this
  // embed is unambiguous. Fetched unfiltered (same as the refund
  // queue's own admin/refunds/page.tsx) so the "N open" count below
  // always reflects the true total regardless of which filter tab is
  // active, and because MOD-1's brief explicitly calls for no
  // "complex search/filter framework" -- filtering the one bounded
  // fetch client-side is the simplest correct approach for a V1 queue.
  const { data: reports } = await supabase
    .from("book_reports")
    .select("id, reason, status, created_at, reviewed_at, books(title)")
    .order("created_at", { ascending: false })
    .returns<AdminBookReportRow[]>();

  const allReports = reports ?? [];
  const openCount = allReports.filter((r) => r.status === "open").length;
  const sortedReports = [...allReports].sort(compareForTriage);
  const visibleReports =
    activeFilter === "all" ? sortedReports : sortedReports.filter((r) => r.status === activeFilter);

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-10 sm:px-6">
      <Link href="/admin" className="text-sm text-muted hover:underline">
        &larr; Back to admin
      </Link>
      <div className="mt-2">
        <PageHeader
          title="Book reports"
          description={`${openCount} open report${openCount === 1 ? "" : "s"} awaiting review`}
        />
      </div>

      <div className="mt-6 flex flex-wrap gap-2">
        {FILTERS.map((filter) => {
          const href = filter.value === "all" ? "/admin/reports" : `/admin/reports?status=${filter.value}`;
          const isActive = filter.value === activeFilter;
          return (
            <Link
              key={filter.value}
              href={href}
              aria-current={isActive ? "true" : undefined}
              className={`rounded-full border px-3 py-1 text-sm ${
                isActive
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-surface text-foreground hover:bg-surface-hover"
              }`}
            >
              {filter.label}
            </Link>
          );
        })}
      </div>

      {visibleReports.length === 0 ? (
        <EmptyState
          className="mt-6"
          title="No reports to review."
          description="Submitted book reports will appear here."
        />
      ) : (
        <ul className="mt-6 flex flex-col gap-3">
          {visibleReports.map((report) => (
            <li key={report.id}>
              <Link
                href={`/admin/reports/${report.id}`}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface p-4 shadow-sm hover:bg-surface-hover"
              >
                <div>
                  <p className="font-medium">{report.books?.title ?? "Book unavailable"}</p>
                  <p className="text-xs text-muted">
                    &ldquo;{report.reason}&rdquo; ·{" "}
                    {new Date(report.created_at).toLocaleDateString(undefined, {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })}
                  </p>
                </div>
                <span className={`text-sm ${STATUS_CLASS[report.status]}`}>
                  {REPORT_STATUS_LABELS[report.status]}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
