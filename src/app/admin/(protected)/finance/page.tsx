import Link from "next/link";
import { requireStaff } from "@/lib/staff";
import { Alert } from "@/components/ui/alert";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { buttonClasses } from "@/components/ui/button";
import {
  getFinanceSummaryCounts,
  listRefundReconciliationStates,
  listFinanceDisputes,
  listFinanceCheckoutExceptions,
  listFinanceRefundEntitlementMismatches,
} from "./actions";
import {
  REFUND_OPERATIONAL_STATE_LABELS,
  describeRefundOperationalState,
  describeNeedsAttention,
  describeDisputeStatus,
  describeTransferReversalStatus,
  describeCheckoutReconciliationReason,
  describeRefundEntitlementMismatch,
} from "./finance-logic";
import {
  parseFinanceRefundQuery,
  parseFinanceDisputeQuery,
  decodeFinanceCursor,
  attentionFilterToParam,
  buildFinanceHref,
  resolveFinancePage,
  FINANCE_DISPLAY_PAGE_SIZE,
  type FinanceRawSearchParams,
  type AttentionFilterValue,
} from "./finance-query";
import type {
  FinanceRefundReconciliationRow,
  FinanceDisputeRow,
  FinanceCheckoutExceptionRow,
  FinanceRefundEntitlementMismatchRow,
  RefundOperationalState,
} from "@/lib/types";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Finance",
};

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatAmount(amountCents: number): string {
  return `$${(amountCents / 100).toFixed(2)}`;
}

function resolveReaderDisplay(readerId: string | null, displayName: string | null): string {
  if (!readerId) return "Deleted account";
  return displayName ?? "Unknown reader";
}

const controlClass = "focus-ring rounded-md border border-border bg-surface px-3 py-1.5 text-sm";

// A small text badge, never color-only (ADMIN-1D Part C's own explicit
// accessibility requirement) -- "Needs attention" vs "OK" are distinct
// WORDS, not just distinct colors, and this never recomputes needs_
// attention itself; it only renders the boolean the RPC already decided.
function AttentionBadge({ needsAttention }: { needsAttention: boolean }) {
  return (
    <span className={needsAttention ? "text-sm font-semibold text-amber-700" : "text-sm text-muted"}>
      {describeNeedsAttention(needsAttention)}
    </span>
  );
}

// ADMIN-1D Part C: this page reads finance data ONLY through the
// committed Part B server primitives (./actions.ts) -- never a direct
// table query, never createAdminClient()/the service-role client, never
// a Stripe API call. requireStaff("finance.view") below is this route's
// own explicit gate, matching every sibling admin page (audit/page.tsx's
// requireStaff("audit.view"), refunds/page.tsx's requireStaff
// ("refunds.view")) -- the shared admin/(protected)/layout.tsx only
// proves admin.access (SOME staff member), which moderator/support both
// also carry without finance.view. Every wrapper in ./actions.ts
// independently re-derives this exact same check server-side as the
// actual authority; this call exists so a denial redirects BEFORE this
// page ever calls any of them.
//
// Strictly read-only: no form on this page submits anywhere but back to
// this same page's own GET query string. No Server Action is created or
// imported here. Every refund row links to the EXISTING /admin/refunds/
// [id] detail page for context -- that page (unchanged by this task)
// remains the only surface that can actually issue a Stripe refund.
export default async function AdminFinancePage({
  searchParams,
}: {
  searchParams: Promise<FinanceRawSearchParams>;
}) {
  await requireStaff("finance.view");

  const rawParams = await searchParams;

  const refundQuery = parseFinanceRefundQuery(rawParams);
  const disputeQuery = parseFinanceDisputeQuery(rawParams);
  const checkoutCursor = decodeFinanceCursor(rawParams.checkout_cursor);

  const [summaryResult, refundListResult, disputeListResult, checkoutListResult, mismatchListResult] =
    await Promise.all([
      getFinanceSummaryCounts(),
      listRefundReconciliationStates({
        operationalState: refundQuery.operationalState,
        needsAttention: attentionFilterToParam(refundQuery.attention),
        cursorRequestedAt: refundQuery.cursor?.sortValue ?? null,
        cursorId: refundQuery.cursor?.id ?? null,
        limit: FINANCE_DISPLAY_PAGE_SIZE + 1,
      }),
      listFinanceDisputes({
        needsAttention: attentionFilterToParam(disputeQuery.attention),
        cursorCreatedAt: disputeQuery.cursor?.sortValue ?? null,
        cursorId: disputeQuery.cursor?.id ?? null,
        limit: FINANCE_DISPLAY_PAGE_SIZE + 1,
      }),
      listFinanceCheckoutExceptions({
        cursorCompletedAt: checkoutCursor?.sortValue ?? null,
        cursorId: checkoutCursor?.id ?? null,
        limit: FINANCE_DISPLAY_PAGE_SIZE + 1,
      }),
      listFinanceRefundEntitlementMismatches({ limit: FINANCE_DISPLAY_PAGE_SIZE }),
    ]);

  const { rows: refundRows, nextCursor: refundNextCursor } = refundListResult.ok
    ? resolveFinancePage<FinanceRefundReconciliationRow>(refundListResult.data, (r) => ({
        sortValue: r.requested_at,
        id: r.refund_request_id,
      }))
    : { rows: [] as FinanceRefundReconciliationRow[], nextCursor: null };

  const { rows: disputeRows, nextCursor: disputeNextCursor } = disputeListResult.ok
    ? resolveFinancePage<FinanceDisputeRow>(disputeListResult.data, (r) => ({
        sortValue: r.created_at,
        id: r.id,
      }))
    : { rows: [] as FinanceDisputeRow[], nextCursor: null };

  const { rows: checkoutRows, nextCursor: checkoutNextCursor } = checkoutListResult.ok
    ? resolveFinancePage<FinanceCheckoutExceptionRow>(checkoutListResult.data, (r) => ({
        sortValue: r.completed_at,
        id: r.intent_id,
      }))
    : { rows: [] as FinanceCheckoutExceptionRow[], nextCursor: null };

  const mismatchRows: FinanceRefundEntitlementMismatchRow[] = mismatchListResult.ok
    ? mismatchListResult.data
    : [];

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-10 sm:px-6">
      <Link href="/admin" className="text-sm text-muted hover:underline">
        &larr; Back to admin
      </Link>
      <div className="mt-2">
        <PageHeader
          title="Finance"
          description="Review financial operations and items that may require attention. This is not a Stripe Dashboard replacement, and not every Stripe transaction is mirrored here -- it surfaces the specific exceptions Librum can detect on its own."
        />
      </div>

      <SummaryCards result={summaryResult} />

      <RefundSection
        rawParams={rawParams}
        query={refundQuery}
        result={refundListResult}
        rows={refundRows}
        nextCursor={refundNextCursor}
      />

      <DisputeSection
        rawParams={rawParams}
        query={disputeQuery}
        result={disputeListResult}
        rows={disputeRows}
        nextCursor={disputeNextCursor}
      />

      <CheckoutExceptionSection
        rawParams={rawParams}
        result={checkoutListResult}
        rows={checkoutRows}
        nextCursor={checkoutNextCursor}
      />

      <MismatchSection result={mismatchListResult} rows={mismatchRows} />
    </main>
  );
}

// ============================================================
// A. Summary cards
// ============================================================

function SummaryCards({
  result,
}: {
  result: Awaited<ReturnType<typeof getFinanceSummaryCounts>>;
}) {
  if (!result.ok) {
    return (
      <Alert variant="error" className="mt-6">
        {result.error}
      </Alert>
    );
  }

  const { data } = result;
  const cards = [
    { label: "Refunds requiring attention", count: data.refund_needs_attention_count, href: "/admin/finance?refund_attention=true#refunds" },
    { label: "Disputes requiring attention", count: data.dispute_needs_attention_count, href: "/admin/finance?dispute_attention=true#disputes" },
    { label: "Checkout exceptions", count: data.checkout_exception_count, href: "/admin/finance#checkout" },
    { label: "Entitlement mismatches", count: data.refund_entitlement_mismatch_count, href: "/admin/finance#mismatches" },
  ];

  return (
    <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
      {cards.map((card) => (
        <Link
          key={card.label}
          href={card.href}
          className="focus-ring rounded-lg border border-border bg-surface p-4 shadow-sm hover:bg-surface-hover"
        >
          <p className="font-serif text-2xl font-semibold text-foreground">{card.count}</p>
          <p className="mt-1 text-xs text-muted">{card.label}</p>
        </Link>
      ))}
    </div>
  );
}

// ============================================================
// B. Refund operations
// ============================================================

const ATTENTION_FILTER_LABELS: Record<AttentionFilterValue, string> = {
  true: "Needs attention only",
  false: "No attention flag",
  all: "All refunds",
};

const DISPUTE_ATTENTION_FILTER_LABELS: Record<AttentionFilterValue, string> = {
  true: "Needs attention only",
  false: "No attention flag",
  all: "All disputes",
};

const REFUND_STATE_OPTIONS = Object.keys(REFUND_OPERATIONAL_STATE_LABELS) as RefundOperationalState[];

function RefundSection({
  rawParams,
  query,
  result,
  rows,
  nextCursor,
}: {
  rawParams: FinanceRawSearchParams;
  query: ReturnType<typeof parseFinanceRefundQuery>;
  result: Awaited<ReturnType<typeof listRefundReconciliationStates>>;
  rows: FinanceRefundReconciliationRow[];
  nextCursor: string | null;
}) {
  return (
    <section id="refunds" className="mt-10 scroll-mt-6">
      <h2 className="font-serif text-xl font-semibold text-foreground">Refund operations</h2>
      <p className="mt-1 text-sm text-muted">
        Every refund request&apos;s current operational status. A row needing attention is a triage
        signal, not proof that money moved incorrectly.
      </p>

      <form
        action="/admin/finance"
        method="get"
        className="mt-4 flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface p-4"
      >
        <div>
          <label htmlFor="refund-state" className="block text-xs text-muted">
            State
          </label>
          <select id="refund-state" name="refund_state" defaultValue={rawParams.refund_state ?? ""} className={controlClass}>
            <option value="">All states</option>
            {REFUND_STATE_OPTIONS.map((state) => (
              <option key={state} value={state}>
                {describeRefundOperationalState(state)}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="refund-attention" className="block text-xs text-muted">
            Attention
          </label>
          <select
            id="refund-attention"
            name="refund_attention"
            defaultValue={query.attention}
            className={controlClass}
          >
            {(Object.keys(ATTENTION_FILTER_LABELS) as AttentionFilterValue[]).map((value) => (
              <option key={value} value={value}>
                {ATTENTION_FILTER_LABELS[value]}
              </option>
            ))}
          </select>
        </div>

        <button type="submit" className={buttonClasses("primary", "sm")}>
          Apply
        </button>

        {query.isFiltered && (
          <Link href="/admin/finance#refunds" className="focus-ring rounded-sm text-sm font-medium text-primary hover:underline">
            Clear filters
          </Link>
        )}
      </form>

      {!result.ok && (
        <Alert variant="error" className="mt-4">
          {result.error}
        </Alert>
      )}

      {result.ok && rows.length === 0 && (
        <EmptyState
          className="mt-4"
          title={
            query.attention === "true" && !query.operationalState
              ? "No refunds require attention."
              : "No refunds match these filters."
          }
        />
      )}

      {result.ok && rows.length > 0 && (
        <>
          <RefundDesktopTable rows={rows} />
          <RefundMobileList rows={rows} />
        </>
      )}

      {nextCursor && (
        <div className="mt-4">
          <Link
            href={buildFinanceHref(rawParams, { refund_cursor: nextCursor })}
            className={buttonClasses("outline", "sm")}
          >
            Next
          </Link>
        </div>
      )}
    </section>
  );
}

function RefundDesktopTable({ rows }: { rows: FinanceRefundReconciliationRow[] }) {
  return (
    <div className="mt-4 hidden overflow-x-auto md:block">
      <table className="w-full min-w-[760px] border-collapse text-sm">
        <caption className="sr-only">Refund operational states</caption>
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
            <th scope="col" className="py-2 pr-4 font-medium">Reader</th>
            <th scope="col" className="py-2 pr-4 font-medium">Amount</th>
            <th scope="col" className="py-2 pr-4 font-medium">Requested</th>
            <th scope="col" className="py-2 pr-4 font-medium">Status</th>
            <th scope="col" className="py-2 pr-4 font-medium">Review</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.refund_request_id} className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <Link href={`/admin/refunds/${row.refund_request_id}`} className="text-primary hover:underline">
                  {resolveReaderDisplay(row.reader_id, row.reader_display_name)}
                </Link>
              </td>
              <td className="py-3 pr-4 whitespace-nowrap">{formatAmount(row.amount_cents)}</td>
              <td className="py-3 pr-4 whitespace-nowrap text-muted">{formatTimestamp(row.requested_at)}</td>
              <td className="py-3 pr-4">{describeRefundOperationalState(row.operational_state)}</td>
              <td className="py-3 pr-4">
                <AttentionBadge needsAttention={row.needs_attention} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RefundMobileList({ rows }: { rows: FinanceRefundReconciliationRow[] }) {
  return (
    <ul className="mt-4 flex flex-col gap-3 md:hidden">
      {rows.map((row) => (
        <li key={row.refund_request_id} className="rounded-lg border border-border bg-surface p-4 shadow-sm">
          <Link href={`/admin/refunds/${row.refund_request_id}`} className="font-medium text-primary hover:underline">
            {resolveReaderDisplay(row.reader_id, row.reader_display_name)}
          </Link>
          <p className="mt-0.5 text-xs text-muted">{formatTimestamp(row.requested_at)} &middot; {formatAmount(row.amount_cents)}</p>
          <p className="mt-2 text-sm">{describeRefundOperationalState(row.operational_state)}</p>
          <div className="mt-1">
            <AttentionBadge needsAttention={row.needs_attention} />
          </div>
        </li>
      ))}
    </ul>
  );
}

// ============================================================
// C. Disputes / transfer reversals
// ============================================================

function DisputeSection({
  rawParams,
  query,
  result,
  rows,
  nextCursor,
}: {
  rawParams: FinanceRawSearchParams;
  query: ReturnType<typeof parseFinanceDisputeQuery>;
  result: Awaited<ReturnType<typeof listFinanceDisputes>>;
  rows: FinanceDisputeRow[];
  nextCursor: string | null;
}) {
  return (
    <section id="disputes" className="mt-10 scroll-mt-6">
      <h2 className="font-serif text-xl font-semibold text-foreground">Disputes</h2>
      <p className="mt-1 text-sm text-muted">
        Stripe disputes Librum has recorded, including any transfer-reversal recovery status. Review
        an open dispute directly in Stripe -- Librum does not track evidence deadlines.
      </p>

      <form
        action="/admin/finance"
        method="get"
        className="mt-4 flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface p-4"
      >
        <div>
          <label htmlFor="dispute-attention" className="block text-xs text-muted">
            Attention
          </label>
          <select
            id="dispute-attention"
            name="dispute_attention"
            defaultValue={query.attention}
            className={controlClass}
          >
            {(Object.keys(DISPUTE_ATTENTION_FILTER_LABELS) as AttentionFilterValue[]).map((value) => (
              <option key={value} value={value}>
                {DISPUTE_ATTENTION_FILTER_LABELS[value]}
              </option>
            ))}
          </select>
        </div>

        <button type="submit" className={buttonClasses("primary", "sm")}>
          Apply
        </button>

        {query.isFiltered && (
          <Link href="/admin/finance#disputes" className="focus-ring rounded-sm text-sm font-medium text-primary hover:underline">
            Clear filters
          </Link>
        )}
      </form>

      {!result.ok && (
        <Alert variant="error" className="mt-4">
          {result.error}
        </Alert>
      )}

      {result.ok && rows.length === 0 && (
        <EmptyState
          className="mt-4"
          title={query.attention === "true" ? "No disputes require attention." : "No disputes match these filters."}
        />
      )}

      {result.ok && rows.length > 0 && (
        <>
          <DisputeDesktopTable rows={rows} />
          <DisputeMobileList rows={rows} />
        </>
      )}

      {nextCursor && (
        <div className="mt-4">
          <Link
            href={buildFinanceHref(rawParams, { dispute_cursor: nextCursor })}
            className={buttonClasses("outline", "sm")}
          >
            Next
          </Link>
        </div>
      )}
    </section>
  );
}

function DisputeDesktopTable({ rows }: { rows: FinanceDisputeRow[] }) {
  return (
    <div className="mt-4 hidden overflow-x-auto md:block">
      <table className="w-full min-w-[760px] border-collapse text-sm">
        <caption className="sr-only">Disputes</caption>
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
            <th scope="col" className="py-2 pr-4 font-medium">Reader</th>
            <th scope="col" className="py-2 pr-4 font-medium">Amount</th>
            <th scope="col" className="py-2 pr-4 font-medium">Created</th>
            <th scope="col" className="py-2 pr-4 font-medium">Status</th>
            <th scope="col" className="py-2 pr-4 font-medium">Reversal</th>
            <th scope="col" className="py-2 pr-4 font-medium">Review</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-b border-border align-top">
              <td className="py-3 pr-4">{resolveReaderDisplay(row.reader_id, row.reader_display_name)}</td>
              <td className="py-3 pr-4 whitespace-nowrap">{formatAmount(row.amount_cents)}</td>
              <td className="py-3 pr-4 whitespace-nowrap text-muted">{formatTimestamp(row.created_at)}</td>
              <td className="py-3 pr-4">
                {describeDisputeStatus(row.status)}
                <span className="ml-1 text-xs text-muted">({row.reason.replace(/_/g, " ")})</span>
              </td>
              <td className="py-3 pr-4">
                {describeTransferReversalStatus(row.transfer_reversal_status)}
                {row.transfer_reversal_failure_code && (
                  <span className="block text-xs text-muted">Code: {row.transfer_reversal_failure_code}</span>
                )}
              </td>
              <td className="py-3 pr-4">
                <AttentionBadge needsAttention={row.needs_attention} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DisputeMobileList({ rows }: { rows: FinanceDisputeRow[] }) {
  return (
    <ul className="mt-4 flex flex-col gap-3 md:hidden">
      {rows.map((row) => (
        <li key={row.id} className="rounded-lg border border-border bg-surface p-4 shadow-sm">
          <p className="font-medium text-foreground">{resolveReaderDisplay(row.reader_id, row.reader_display_name)}</p>
          <p className="mt-0.5 text-xs text-muted">{formatTimestamp(row.created_at)} &middot; {formatAmount(row.amount_cents)}</p>
          <p className="mt-2 text-sm">
            {describeDisputeStatus(row.status)} <span className="text-muted">({row.reason.replace(/_/g, " ")})</span>
          </p>
          <p className="mt-1 text-sm text-muted">{describeTransferReversalStatus(row.transfer_reversal_status)}</p>
          <div className="mt-1">
            <AttentionBadge needsAttention={row.needs_attention} />
          </div>
        </li>
      ))}
    </ul>
  );
}

// ============================================================
// D. Checkout exceptions (single-book only)
// ============================================================

function CheckoutExceptionSection({
  rawParams,
  result,
  rows,
  nextCursor,
}: {
  rawParams: FinanceRawSearchParams;
  result: Awaited<ReturnType<typeof listFinanceCheckoutExceptions>>;
  rows: FinanceCheckoutExceptionRow[];
  nextCursor: string | null;
}) {
  return (
    <section id="checkout" className="mt-10 scroll-mt-6">
      <h2 className="font-serif text-xl font-semibold text-foreground">Checkout exceptions</h2>
      <p className="mt-1 text-sm text-muted">
        Single-book checkouts Stripe confirmed as paid that Librum did not fulfill. Each has a specific
        recorded reason -- some represent a deliberate outcome, not a bug. Bundle reconciliation is not
        included in this view.
      </p>

      {!result.ok && (
        <Alert variant="error" className="mt-4">
          {result.error}
        </Alert>
      )}

      {result.ok && rows.length === 0 && <EmptyState className="mt-4" title="No checkout exceptions found." />}

      {result.ok && rows.length > 0 && (
        <>
          <CheckoutDesktopTable rows={rows} />
          <CheckoutMobileList rows={rows} />
        </>
      )}

      {nextCursor && (
        <div className="mt-4">
          <Link
            href={buildFinanceHref(rawParams, { checkout_cursor: nextCursor })}
            className={buttonClasses("outline", "sm")}
          >
            Next
          </Link>
        </div>
      )}
    </section>
  );
}

function CheckoutDesktopTable({ rows }: { rows: FinanceCheckoutExceptionRow[] }) {
  return (
    <div className="mt-4 hidden overflow-x-auto md:block">
      <table className="w-full min-w-[760px] border-collapse text-sm">
        <caption className="sr-only">Checkout exceptions</caption>
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
            <th scope="col" className="py-2 pr-4 font-medium">Book</th>
            <th scope="col" className="py-2 pr-4 font-medium">Reader</th>
            <th scope="col" className="py-2 pr-4 font-medium">Completed</th>
            <th scope="col" className="py-2 pr-4 font-medium">Reason</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.intent_id} className="border-b border-border align-top">
              <td className="py-3 pr-4 font-medium text-foreground">{row.book_title}</td>
              <td className="py-3 pr-4">{resolveReaderDisplay(row.reader_id, row.reader_display_name)}</td>
              <td className="py-3 pr-4 whitespace-nowrap text-muted">{formatTimestamp(row.completed_at)}</td>
              <td className="py-3 pr-4">
                {describeCheckoutReconciliationReason(row.reconciliation_reason)}
                <span className="block text-xs text-muted">({row.reconciliation_reason})</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CheckoutMobileList({ rows }: { rows: FinanceCheckoutExceptionRow[] }) {
  return (
    <ul className="mt-4 flex flex-col gap-3 md:hidden">
      {rows.map((row) => (
        <li key={row.intent_id} className="rounded-lg border border-border bg-surface p-4 shadow-sm">
          <p className="font-medium text-foreground">{row.book_title}</p>
          <p className="mt-0.5 text-xs text-muted">
            {resolveReaderDisplay(row.reader_id, row.reader_display_name)} &middot; {formatTimestamp(row.completed_at)}
          </p>
          <p className="mt-2 text-sm">{describeCheckoutReconciliationReason(row.reconciliation_reason)}</p>
          <p className="text-xs text-muted">({row.reconciliation_reason})</p>
        </li>
      ))}
    </ul>
  );
}

// ============================================================
// E. Refund / entitlement consistency
// ============================================================

function MismatchSection({
  result,
  rows,
}: {
  result: Awaited<ReturnType<typeof listFinanceRefundEntitlementMismatches>>;
  rows: FinanceRefundEntitlementMismatchRow[];
}) {
  return (
    <section id="mismatches" className="mt-10 scroll-mt-6">
      <h2 className="font-serif text-xl font-semibold text-foreground">Refund / entitlement consistency</h2>
      <p className="mt-1 text-sm text-muted">
        Potential consistency issues between refund records and purchase entitlement. These are flagged
        for review, not confirmed errors -- no repair action is available from this page.
      </p>

      {!result.ok && (
        <Alert variant="error" className="mt-4">
          {result.error}
        </Alert>
      )}

      {result.ok && rows.length === 0 && (
        <EmptyState className="mt-4" title="No refund/entitlement consistency issues found." />
      )}

      {result.ok && rows.length > 0 && (
        <ul className="mt-4 flex flex-col gap-3">
          {rows.map((row, index) => (
            <li
              key={`${row.mismatch_type}-${row.refund_request_id ?? row.purchase_id ?? index}`}
              className="rounded-lg border border-border bg-surface p-4 shadow-sm"
            >
              <p className="text-sm font-medium text-foreground">Potential consistency issue</p>
              <p className="mt-1 text-sm text-muted">{describeRefundEntitlementMismatch(row.mismatch_type)}</p>
              <p className="mt-1 text-xs text-muted">
                {resolveReaderDisplay(row.reader_id, row.reader_display_name)} &middot; {formatAmount(row.amount_cents)}
              </p>
              {row.refund_request_id && (
                <Link href={`/admin/refunds/${row.refund_request_id}`} className="mt-2 inline-block text-sm text-primary hover:underline">
                  View refund request
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
