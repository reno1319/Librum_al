import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/staff";
import { roleHasPermission } from "@/lib/staff-permissions";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolvePublicAuthorName } from "@/lib/author-name";
import { formatTimestampAsDate } from "@/lib/book-detail-dates";
import { takedownReasonForReport, takedownReasonLabel } from "@/lib/takedown-reasons";
import { Alert } from "@/components/ui/alert";
import { CoverPlaceholder } from "@/components/cover-placeholder";
import type { Metadata } from "next";
import { formatActivityTime, formatRelativeTime, formatTodayDate } from "../../../admin-landing-logic";
import { describeBookEyebrow, isUuid, resolveTakedownReport } from "../book-admin-logic";
import { allowBookAgainAsStaff, unpublishBookAsStaff } from "../actions";
import { UnpublishForm } from "./unpublish-form";

export const metadata: Metadata = {
  title: "Book",
};

// Reads the book's live state on every request.
export const dynamic = "force-dynamic";

// ADMIN-2-TAKEDOWN (C), per the mockup's "Book page with Unpublish": the
// book (cover, state, title, author, published date -- no sales count:
// free downloads create purchase rows too), its open reports, its rights
// history, and the Unpublish panel. requireStaff("reports.view") is the
// gate; every read then uses the service-role client, because a staff
// session cannot see drafts (M2). The panel, and both of its actions,
// need reports.resolve. Opened from a report (?report=<id>), the form
// carries that report only when it is an OPEN report of this book.

type AdminBook = {
  id: string;
  title: string;
  status: string;
  price_all: number | null;
  published_at: string | null;
  cover_path: string | null;
  author_id: string;
  pen_name_id: string | null;
  pen: { name: string } | null;
};

type OpenReport = { id: string; reason: string; details: string; created_at: string };

type RightsRow = {
  declared_at: string;
  author_public_name: string;
  pen_name: string | null;
  statement_text: string;
};

type ActiveTakedown = {
  reason: string;
  message_to_author: string;
  bundle_ids: string[];
  taken_down_by: string | null;
  taken_down_at: string;
};

const SECTION_CLASSES = "rounded-card border border-border bg-surface p-5";
const SECTION_HEADING_CLASSES = "mb-2.5 font-serif text-[1.375rem] font-bold text-primary";

export default async function AdminBookPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ report?: string | string[]; error?: string; success?: string }>;
}) {
  const { role } = await requireStaff("reports.view");
  const canResolve = roleHasPermission(role, "reports.resolve");

  const { id } = await params;
  const { report: reportParam, error, success } = await searchParams;
  if (!isUuid(id)) notFound();

  const admin = createAdminClient();
  const { data: book } = await admin
    .from("books")
    .select("id, title, status, price_all, published_at, cover_path, author_id, pen_name_id, pen:pen_names(name)")
    .eq("id", id)
    .maybeSingle<AdminBook>();
  if (!book) notFound();

  const [profileResult, reportsResult, rightsResult, takedownResult, bundlesResult] = await Promise.all([
    admin
      .from("profiles")
      .select("display_name, public_author_name")
      .eq("id", book.author_id)
      .maybeSingle<{ display_name: string | null; public_author_name: string | null }>(),
    admin
      .from("book_reports")
      .select("id, reason, details, created_at")
      .eq("book_id", book.id)
      .eq("status", "open")
      .order("created_at", { ascending: true })
      .returns<OpenReport[]>(),
    admin
      .from("book_rights_declarations")
      .select("declared_at, author_public_name, pen_name, statement_text")
      .eq("book_id", book.id)
      .order("declared_at", { ascending: false })
      .returns<RightsRow[]>(),
    admin
      .from("book_takedowns")
      .select("reason, message_to_author, bundle_ids, taken_down_by, taken_down_at")
      .eq("book_id", book.id)
      .is("lifted_at", null)
      .maybeSingle<ActiveTakedown>(),
    admin
      .from("bundle_books")
      .select("bundle_id, bundles!inner(title, status)")
      .eq("book_id", book.id)
      .eq("bundles.status", "published")
      .returns<{ bundle_id: string; bundles: { title: string; status: string } }[]>(),
  ]);

  const openReports = reportsResult.data ?? [];
  const rights = rightsResult.data ?? [];
  const takedown = takedownResult.data;
  // Fail closed: when the takedown state cannot be read, neither panel
  // is offered (the RPCs would decide on their own anyway).
  const takedownUnknown = Boolean(takedownResult.error);
  const publishedBundleTitles = (bundlesResult.data ?? []).map((row) => row.bundles.title);

  const [takenByResult, takenDownBundlesResult] = takedown
    ? await Promise.all([
        takedown.taken_down_by
          ? admin
              .from("profiles")
              .select("display_name")
              .eq("id", takedown.taken_down_by)
              .maybeSingle<{ display_name: string | null }>()
          : Promise.resolve({ data: null }),
        takedown.bundle_ids.length > 0
          ? admin.from("bundles").select("id, title").in("id", takedown.bundle_ids).returns<{ id: string; title: string }[]>()
          : Promise.resolve({ data: [] as { id: string; title: string }[] }),
      ])
    : [null, null];
  const takenByName = takenByResult?.data?.display_name ?? "a former staff member";
  const takenDownBundleTitles = (() => {
    const titleById = new Map((takenDownBundlesResult?.data ?? []).map((b) => [b.id, b.title]));
    return (takedown?.bundle_ids ?? []).map((bundleId) => titleById.get(bundleId)).filter((t): t is string => !!t);
  })();

  // As reports/[id] does: the public name the book carries (its pen
  // name), and the account's own name when it differs.
  const profile = profileResult.data;
  const publicName = book.pen?.name ?? resolvePublicAuthorName(profile) ?? "Unknown author";
  const accountName = profile?.display_name ?? null;

  const formReport = resolveTakedownReport(reportParam, openReports);
  const coverUrl = book.cover_path ? admin.storage.from("covers").getPublicUrl(book.cover_path).data.publicUrl : null;
  const now = new Date();

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-wrap items-start gap-6 px-4 py-6 sm:px-6 md:px-10 md:py-9">
      <div className="flex min-w-0 flex-[3_1_420px] flex-col gap-5">
        <Link
          href="/admin/books"
          className="focus-ring inline-flex min-h-11 items-center self-start rounded-sm text-sm text-primary underline underline-offset-2 hover:decoration-2"
        >
          &larr; All books
        </Link>

        {error && <Alert variant="error">{error}</Alert>}
        {success && <Alert variant="success">{success}</Alert>}

        <div className="flex gap-4 sm:gap-5">
          {coverUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={coverUrl} alt="" className="h-[120px] w-20 shrink-0 rounded-[3px] object-cover sm:h-36 sm:w-24" />
          ) : (
            <CoverPlaceholder title={book.title} authorName={publicName} className="h-[120px] w-20 shrink-0 rounded-[3px] sm:h-36 sm:w-24" />
          )}
          <div className="min-w-0">
            <p className="text-xs font-semibold tracking-[0.14em] text-[#806510] uppercase md:text-[0.8125rem]">
              {describeBookEyebrow(book, Boolean(takedown))}
            </p>
            <h1 className="mt-1.5 mb-1 font-serif text-[1.75rem] leading-tight font-bold break-words text-primary md:text-[2.125rem]">
              {book.title}
            </h1>
            <p className="text-[0.9375rem]">
              by {publicName}
              {book.published_at && ` · published ${formatTimestampAsDate(book.published_at)}`}
            </p>
            {accountName && accountName !== publicName && (
              <p className="mt-0.5 text-sm text-muted">Account name: {accountName}</p>
            )}
            {book.status === "published" && (
              <Link href={`/books/${book.id}`} className="mt-1 inline-flex min-h-11 items-center text-sm text-primary underline">
                View public book page
              </Link>
            )}
          </div>
        </div>

        <section aria-labelledby="book-open-reports" className={SECTION_CLASSES}>
          <h2 id="book-open-reports" className={SECTION_HEADING_CLASSES}>
            {openReports.length === 1 ? "Open report" : "Open reports"}
          </h2>
          {reportsResult.error ? (
            <p className="text-sm text-red-700">Couldn’t load the reports.</p>
          ) : openReports.length === 0 ? (
            <p className="text-sm text-muted">No open reports.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {openReports.map((report) => (
                <li key={report.id} className="border-t border-border pt-3 first:border-t-0 first:pt-0">
                  <p className="text-[0.9375rem] break-words">
                    <strong>{report.reason}:</strong>{" "}
                    {report.details ? `“${report.details}”` : <span className="text-muted">No details given.</span>}
                  </p>
                  <p className="mt-1 text-sm text-muted">From a reader · {formatTodayDate(report.created_at)}</p>
                  <Link
                    href={`/admin/reports/${report.id}`}
                    className="mt-1 inline-flex min-h-11 items-center text-sm font-semibold text-primary underline underline-offset-2"
                  >
                    Open report
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="book-rights-history" className={SECTION_CLASSES}>
          <h2 id="book-rights-history" className={SECTION_HEADING_CLASSES}>
            Rights history
          </h2>
          {rightsResult.error ? (
            <p className="text-sm text-red-700">Couldn’t load the rights history.</p>
          ) : rights.length === 0 ? (
            <p className="text-sm text-muted">No rights statement on record.</p>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {rights.map((row, index) => (
                <li key={`${row.declared_at}-${index}`} className="break-words">
                  {formatActivityTime(row.declared_at)} · {row.pen_name ?? row.author_public_name} chose “{row.statement_text}”
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section
        aria-labelledby="book-unpublish"
        className="flex min-w-0 flex-[2_1_340px] flex-col gap-4 rounded-card border-2 border-primary bg-surface p-5 md:p-6"
      >
        {takedownUnknown ? (
          <>
            <h2 id="book-unpublish" className="font-serif text-2xl font-bold text-primary">
              Unpublish this book
            </h2>
            <p className="text-sm text-red-700">Couldn’t check whether this book is taken down. Please reload the page.</p>
          </>
        ) : takedown ? (
          <>
            <h2 id="book-unpublish" className="font-serif text-2xl font-bold text-primary">
              Taken down
            </h2>
            <p className="text-[0.9375rem]">
              Taken down {formatRelativeTime(takedown.taken_down_at, now)} by {takenByName}.
            </p>
            <dl className="flex flex-col gap-3 text-sm">
              <div>
                <dt className="font-semibold">Reason</dt>
                <dd>{takedownReasonLabel(takedown.reason)}</dd>
              </div>
              <div>
                <dt className="font-semibold">Message sent to the author</dt>
                <dd className="whitespace-pre-wrap break-words">{takedown.message_to_author}</dd>
              </div>
              <div>
                <dt className="font-semibold">Bundles unpublished</dt>
                <dd>{takenDownBundleTitles.length > 0 ? takenDownBundleTitles.join(", ") : "None"}</dd>
              </div>
            </dl>
            <p className="text-sm text-muted">
              The author can&apos;t publish it again until you allow it. Readers who already bought it keep it.
            </p>
            {canResolve && (
              <form action={allowBookAgainAsStaff.bind(null, book.id)}>
                <button
                  type="submit"
                  className="focus-ring inline-flex min-h-11 items-center justify-center rounded-[3px] border border-primary bg-surface px-[1.125rem] text-[0.9375rem] font-semibold text-primary hover:bg-surface-hover"
                >
                  Allow the author to publish again
                </button>
              </form>
            )}
          </>
        ) : canResolve ? (
          <>
            <h2 id="book-unpublish" className="font-serif text-2xl font-bold text-primary">
              Unpublish this book
            </h2>
            <p className="text-sm text-muted">
              The book leaves the Bookstore at once. The author can&apos;t publish it again until you allow it.
              Readers who already bought it keep it.
            </p>
            {publishedBundleTitles.length > 0 && (
              <p className="text-sm font-semibold">This also unpublishes: {publishedBundleTitles.join(", ")}.</p>
            )}
            <UnpublishForm
              action={unpublishBookAsStaff}
              bookId={book.id}
              reportId={formReport?.id ?? null}
              defaultReason={takedownReasonForReport(formReport?.reason)}
            />
            <p className="text-[0.8125rem] text-muted">Saved in the Audit log with your name, the time and the reason.</p>
          </>
        ) : (
          <>
            <h2 id="book-unpublish" className="font-serif text-2xl font-bold text-primary">
              Unpublish this book
            </h2>
            <p className="text-sm text-muted">Only staff who can resolve reports can unpublish a book.</p>
          </>
        )}
      </section>
    </main>
  );
}
