import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { RefundRequestStatus } from "@/lib/types";
import {
  abbreviatePaymentIntentId,
  canIssueRefund,
  canReview,
  resolveProfileDisplayName,
  resolveSuccessBannerMessage,
  REVIEW_STATUS_LABELS,
} from "../refund-review-logic";
import { reviewRefundRequest, issueStripeRefund } from "../actions";
import { ReviewButtons } from "./review-buttons";
import { IssueRefundButton } from "./issue-refund-button";

type AdminRefundRequestDetail = {
  id: string;
  reader_id: string | null;
  reviewed_by: string | null;
  stripe_payment_intent_id: string;
  amount_cents: number;
  reason: string | null;
  status: RefundRequestStatus;
  requested_at: string;
  reviewed_at: string | null;
  admin_notes: string | null;
};

// books comes back null for a line item whenever the book row isn't
// visible to this admin under the current RLS model -- see the Phase
// REFUND-1B Step 3 audit: books' own SELECT policy only covers
// published books, the book's own author, or a reader who owns it, with
// no admin-wide policy. An admin reviewing a request for a book its
// author has since unpublished (and that the admin didn't buy/write
// themselves) is the one case this can happen in practice. Handled as a
// plain, honest "Book unavailable" fallback below -- never a crash, and
// no new migration was added to widen this for Step 3's narrow purpose
// (see the audit for why that's a reasonable, deliberate scope
// decision rather than an oversight).
type AdminRefundRequestItem = {
  id: string;
  purchase_id: string | null;
  book_id: string;
  amount_cents: number;
  books: { title: string } | null;
};

export default async function AdminRefundRequestDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  const { id } = await params;
  const { error, success } = await searchParams;

  // src/app/admin/layout.tsx already gates this whole route.
  const supabase = await createClient();

  const { data: request } = await supabase
    .from("refund_requests")
    .select(
      "id, reader_id, reviewed_by, stripe_payment_intent_id, amount_cents, reason, status, requested_at, reviewed_at, admin_notes",
    )
    .eq("id", id)
    .maybeSingle<AdminRefundRequestDetail>();

  // Either the id doesn't exist, or (defense in depth -- shouldn't
  // happen given the admin-scoped RLS policy already grants visibility
  // into every row) RLS denied it. Either way, a 404 is the correct,
  // honest response -- not a crash.
  if (!request) {
    notFound();
  }

  // refund_requests has TWO separate foreign keys into profiles
  // (reader_id and reviewed_by) -- a PostgREST embed on this table would
  // be ambiguous about which one "profiles(...)" refers to, so this
  // deliberately does one flat, explicit lookup instead (same technique
  // already used for the reader-only lookup on the Library page and on
  // this feature's own list page) and resolves both ids from it in JS,
  // rather than assuming relationship inference would pick the right FK.
  const profileIds = Array.from(
    new Set([request.reader_id, request.reviewed_by].filter((v): v is string => v !== null)),
  );
  const { data: profiles } =
    profileIds.length > 0
      ? await supabase.from("profiles").select("id, display_name").in("id", profileIds)
      : { data: [] };
  const displayNameById = new Map((profiles ?? []).map((p) => [p.id, p.display_name]));

  const readerDisplayName = resolveProfileDisplayName({
    profileId: request.reader_id,
    displayNameById,
    whenNull: "Deleted account",
    whenMissing: "Unknown reader",
  });
  const reviewerDisplayName = resolveProfileDisplayName({
    profileId: request.reviewed_by,
    displayNameById,
    whenNull: "Not yet reviewed",
    whenMissing: "Unknown reviewer (account no longer available)",
  });

  // book_id is the only foreign key from refund_request_items to books,
  // so this embed is unambiguous -- same technique already used for
  // purchases.book_id -> books(*) in src/app/library/page.tsx.
  const { data: items } = await supabase
    .from("refund_request_items")
    .select("id, purchase_id, book_id, amount_cents, books(title)")
    .eq("refund_request_id", id)
    .returns<AdminRefundRequestItem[]>();

  const allItems = items ?? [];
  const reviewable = canReview(request.status);
  // Fixes the observed stale-banner defect: issueStripeRefund()'s
  // redirect always carries the "waiting for confirmation" message, but
  // the webhook can finalize the request before this page ever renders
  // that redirect -- see resolveSuccessBannerMessage's own docs.
  const successMessage = resolveSuccessBannerMessage(request.status, success);

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10 sm:px-6">
      <Link href="/admin/refunds" className="text-sm text-muted hover:underline">
        &larr; Back to refund requests
      </Link>
      <h1 className="mt-2 font-serif text-3xl font-semibold">Refund request</h1>

      {error && (
        <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      )}
      {successMessage && (
        <p className="mt-4 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">
          {successMessage}
        </p>
      )}

      <div className="mt-6 rounded-lg border border-border bg-surface p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-medium">{readerDisplayName}</p>
            <p className="text-xs text-muted">
              {abbreviatePaymentIntentId(request.stripe_payment_intent_id)}
            </p>
          </div>
          <span className="text-sm font-semibold">{REVIEW_STATUS_LABELS[request.status]}</span>
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted">Requested amount</dt>
          <dd className="font-medium">${(request.amount_cents / 100).toFixed(2)}</dd>

          <dt className="text-muted">Requested</dt>
          <dd>
            {new Date(request.requested_at).toLocaleString(undefined, {
              year: "numeric",
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}
          </dd>

          <dt className="text-muted">Reviewed</dt>
          <dd>
            {request.reviewed_at
              ? new Date(request.reviewed_at).toLocaleString(undefined, {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })
              : "Not yet reviewed"}
          </dd>

          {request.reviewed_at && (
            <>
              <dt className="text-muted">Reviewed by</dt>
              <dd>{reviewerDisplayName}</dd>
            </>
          )}
        </dl>

        {request.reason && (
          <div className="mt-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">
              Reader&apos;s reason
            </p>
            <p className="mt-1 text-sm">{request.reason}</p>
          </div>
        )}

        {request.admin_notes && (
          <div className="mt-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">Admin notes</p>
            <p className="mt-1 text-sm">{request.admin_notes}</p>
          </div>
        )}
      </div>

      <div className="mt-6">
        <h2 className="font-serif text-lg font-semibold">Books in this transaction</h2>
        {allItems.length === 0 ? (
          <p className="mt-2 text-sm text-muted">
            No line items on record for this request (the underlying transaction had no
            eligible purchases at the time it was made).
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {allItems.map((item) => (
              <li
                key={item.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface px-4 py-2 text-sm"
              >
                <span>{item.books?.title ?? "Book unavailable"}</span>
                <span className="text-muted">${(item.amount_cents / 100).toFixed(2)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {reviewable && (
        <form className="mt-6 rounded-lg border border-border bg-surface p-4 shadow-sm">
          <label className="flex flex-col gap-1 text-sm">
            Admin notes (optional)
            <textarea
              name="adminNotes"
              rows={3}
              maxLength={2000}
              className="rounded-lg border border-border bg-surface px-3 py-2"
            />
          </label>
          <ReviewButtons
            onApprove={reviewRefundRequest.bind(null, request.id, "approved")}
            onReject={reviewRefundRequest.bind(null, request.id, "rejected")}
          />
        </form>
      )}

      {canIssueRefund(request.status) && (
        <form
          action={issueStripeRefund.bind(null, request.id)}
          className="mt-6 rounded-lg border border-border bg-surface p-4 shadow-sm"
        >
          <p className="text-sm text-muted">
            This request has been approved. Issuing the refund submits it to Stripe --
            Librum&apos;s own records update automatically once Stripe confirms it, not
            immediately on submission.
          </p>
          <div className="mt-3">
            <IssueRefundButton amountCents={request.amount_cents} />
          </div>
        </form>
      )}
    </main>
  );
}
