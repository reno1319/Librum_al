import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff";
import type { RefundRequestStatus } from "@/lib/types";
import {
  abbreviatePaymentIntentId,
  compareForTriage,
  resolveProfileDisplayName,
  REVIEW_STATUS_LABELS,
} from "./refund-review-logic";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Refund requests",
};

type AdminRefundRequestRow = {
  id: string;
  reader_id: string | null;
  stripe_payment_intent_id: string;
  amount_cents: number;
  reason: string | null;
  status: RefundRequestStatus;
  requested_at: string;
  reviewed_at: string | null;
  admin_notes: string | null;
};

// A quick, low-contrast-vs-high-contrast visual split -- 'requested' is
// the only state that ever needs an admin's attention, so it's the only
// one styled to stand out; every other (terminal, from this queue's
// perspective) status renders muted. Deliberately reuses this app's
// existing red/green/muted text conventions (see e.g.
// src/app/library/page.tsx's REFUND_STATUS_LABELS rendering) rather than
// introducing a new badge/pill design system.
const STATUS_CLASS: Record<RefundRequestStatus, string> = {
  requested: "font-semibold text-primary",
  approved: "text-green-700",
  rejected: "text-red-600",
  refunded: "text-red-600",
  cancelled: "text-muted",
};

export default async function AdminRefundsPage() {
  // ADMIN-1A pre-finalize correction: src/app/admin/layout.tsx's
  // requireStaff("admin.access") only proves the caller is SOME staff
  // member, not that they hold refunds.view specifically (e.g.
  // 'moderator' has admin.access but not refunds.view) -- this route's
  // own explicit check is the actual gate. The RLS policy "Staff with
  // refunds.view can view all refund requests"
  // (public.staff_has_permission('refunds.view'), migration 040) is
  // defense-in-depth behind it -- and, unlike the reader-facing Library
  // query, there's no .eq("reader_id", ...) here: staff with refunds.view
  // are meant to see every reader's requests, not just their own.
  await requireStaff("refunds.view");

  const supabase = await createClient();

  const { data: requests } = await supabase
    .from("refund_requests")
    .select(
      "id, reader_id, stripe_payment_intent_id, amount_cents, reason, status, requested_at, reviewed_at, admin_notes",
    )
    .order("requested_at", { ascending: false })
    .returns<AdminRefundRequestRow[]>();

  const allRequests = requests ?? [];

  // LIBRUM 2.0 AUTHOR-1C: profiles no longer has a blanket "viewable by
  // everyone" policy -- this read is authorized instead by profiles'
  // own "Staff with an authorized permission can view any profile" RLS
  // policy (migration 045), which this page's own requireStaff("refunds.
  // view") call above already satisfies. reader_id can be null
  // (migration 029: ON DELETE SET NULL on account deletion), so only the
  // non-null ids actually present are looked up.
  const readerIds = Array.from(
    new Set(allRequests.map((r) => r.reader_id).filter((id): id is string => id !== null)),
  );
  const { data: profiles } =
    readerIds.length > 0
      ? await supabase.from("profiles").select("id, display_name").in("id", readerIds)
      : { data: [] };
  const displayNameById = new Map((profiles ?? []).map((p) => [p.id, p.display_name]));

  const sortedRequests = [...allRequests].sort(compareForTriage);

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-10 sm:px-6">
      <Link href="/admin" className="text-sm text-muted hover:underline">
        &larr; Back to admin
      </Link>
      <h1 className="mt-2 font-serif text-3xl font-semibold">Refund requests</h1>
      <p className="mt-1 text-sm text-muted">
        {sortedRequests.filter((r) => r.status === "requested").length} awaiting review
      </p>

      {sortedRequests.length === 0 ? (
        <p className="mt-8 rounded-lg border border-dashed border-border px-6 py-16 text-center text-muted">
          No refund requests yet.
        </p>
      ) : (
        <ul className="mt-6 flex flex-col gap-3">
          {sortedRequests.map((request) => (
            <li key={request.id}>
              <Link
                href={`/admin/refunds/${request.id}`}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface p-4 shadow-sm hover:bg-surface-hover"
              >
                <div>
                  <p className="font-medium">
                    {resolveProfileDisplayName({
                      profileId: request.reader_id,
                      displayNameById,
                      whenNull: "Deleted account",
                      whenMissing: "Unknown reader",
                    })}
                    <span className="ml-2 text-muted">
                      · {abbreviatePaymentIntentId(request.stripe_payment_intent_id)}
                    </span>
                  </p>
                  <p className="text-xs text-muted">
                    Requested{" "}
                    {new Date(request.requested_at).toLocaleDateString(undefined, {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })}{" "}
                    · ${(request.amount_cents / 100).toFixed(2)}
                    {request.reason && ` · "${request.reason}"`}
                  </p>
                </div>
                <span className={`text-sm ${STATUS_CLASS[request.status]}`}>
                  {REVIEW_STATUS_LABELS[request.status]}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
