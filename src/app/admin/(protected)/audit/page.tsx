import Link from "next/link";
import { requireStaff } from "@/lib/staff";
import { Alert } from "@/components/ui/alert";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { buttonClasses } from "@/components/ui/button";
import { listAdminAuditEvents } from "./actions";
import { listStaffMembers } from "../staff/actions";
import {
  AUDIT_ACTIONS,
  AUDIT_TARGET_TYPES,
  ACTION_LABELS,
  getActionLabel,
  formatAuditDetails,
  resolveAuditActorDisplay,
  resolveAuditTargetDisplay,
  resolveActorFilterOptions,
  type ActorFilterOption,
} from "./audit-log-logic";
import {
  parseAuditQuery,
  buildAuditHref,
  resolveAuditPage,
  AUDIT_DISPLAY_PAGE_SIZE,
  type AuditRawSearchParams,
} from "./audit-query";
import type { AuditEventRow, StaffListRow } from "@/lib/types";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Audit log",
};

// V1 friendly labels only, in AUDIT_TARGET_TYPES' own order -- matches
// audit-log-logic.ts's own AUDIT_TARGET_TYPE_LABELS singular form
// ("Book report"), pluralized here since this is a filter option
// ("Book reports"), not a per-row target label.
const TARGET_TYPE_FILTER_LABELS: Record<string, string> = {
  staff_members: "Staff members",
  book_reports: "Book reports",
  refund_requests: "Refund requests",
};

function formatAuditTimestamp(createdAt: string): string {
  return new Date(createdAt).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ADMIN-1C Part C: this page reads audit events ONLY through the
// committed Part B server primitive (listAdminAuditEvents, ./actions.ts)
// -- never a direct `supabase.from("admin_audit_log")` query and never
// createAdminClient()/the service-role client. requireStaff("audit.view")
// below is this route's own explicit gate, matching every sibling admin
// page (reports/page.tsx's requireStaff("reports.view"), refunds/
// page.tsx's requireStaff("refunds.view"), staff/page.tsx's
// requireStaff("staff.view")) -- the shared admin/(protected)/layout.tsx
// only proves admin.access (SOME staff member), which moderator/support
// both also carry without audit.view. listAdminAuditEvents() itself
// independently re-derives this exact same check server-side as the
// actual authority; this call exists so a denial redirects BEFORE this
// page ever calls it, the same "defense in depth plus the redirect
// happens here" posture every other admin route already has.
export default async function AdminAuditLogPage({
  searchParams,
}: {
  searchParams: Promise<AuditRawSearchParams>;
}) {
  await requireStaff("audit.view");

  const rawParams = await searchParams;
  const query = parseAuditQuery(rawParams);

  // ADMIN-1C Part C actor-filter decision: reuses listStaffMembers()
  // (staff.view-gated, src/app/admin/(protected)/staff/actions.ts)
  // rather than widening any permission or adding a new roster primitive
  // -- both roles that ever hold audit.view (owner, admin) already hold
  // staff.view too (src/lib/staff-permissions.ts's own matrix), so every
  // caller who can reach this page can already safely call this exact
  // primitive. Only user_id/display_name are ever read from its rows
  // below -- email is never rendered, even though the underlying
  // StaffListRow carries it.
  const rosterResult = await listStaffMembers();
  const roster: StaffListRow[] = rosterResult.ok ? rosterResult.data : [];

  // ADMIN-1C Part C FINAL PRE-COMMIT UI CORRECTION: a valid ?actor=<uuid>
  // that isn't in the current roster (a former/deleted staff member)
  // still gets a real, selected option -- see resolveActorFilterOptions'
  // own comment (audit-log-logic.ts) for why the prior "roster-only"
  // dropdown silently misrepresented the active filter state.
  const actorOptions: ActorFilterOption[] = resolveActorFilterOptions(roster, query.actorId);

  // A reversed date range gets its own dedicated message and skips the
  // RPC call entirely -- see parseAuditQuery's own comment for why.
  //
  // ADMIN-1C Part C FINAL PRE-COMMIT UI CORRECTION: requests
  // AUDIT_DISPLAY_PAGE_SIZE + 1 rows (lookahead pagination) -- resolving
  // exactly how many of those are actually displayed, and deriving the
  // Next cursor correctly, is entirely resolveAuditPage's own job (see
  // its own comment, audit-query.ts) for why this replaces the prior
  // "Next whenever exactly the limit came back" heuristic, which could
  // show a false Next when the true remaining count was an exact
  // multiple of the page size.
  const listResult = query.dateRangeError
    ? null
    : await listAdminAuditEvents({
        action: query.action,
        actorId: query.actorId,
        targetType: query.targetType,
        createdAfter: query.createdAfter,
        createdBefore: query.createdBefore,
        cursorCreatedAt: query.cursor?.createdAt ?? null,
        cursorId: query.cursor?.id ?? null,
        limit: AUDIT_DISPLAY_PAGE_SIZE + 1,
      });

  const fetchedRows: AuditEventRow[] = listResult?.ok ? listResult.data : [];
  const { rows, nextCursor } = listResult?.ok
    ? resolveAuditPage(fetchedRows)
    : { rows: [] as AuditEventRow[], nextCursor: null };

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-10 sm:px-6">
      <Link href="/admin" className="text-sm text-muted hover:underline">
        &larr; Back to admin
      </Link>
      <div className="mt-2">
        <PageHeader
          title="Audit log"
          description="Review consequential administrative actions performed in Librum."
        />
      </div>

      <AuditFilterForm query={rawParams} actorOptions={actorOptions} isFiltered={query.isFiltered} />

      {query.dateRangeError && (
        <Alert variant="error" className="mt-6">
          {query.dateRangeError}
        </Alert>
      )}

      {listResult && !listResult.ok && (
        <Alert variant="error" className="mt-6">
          {listResult.error}
        </Alert>
      )}

      {listResult?.ok && rows.length === 0 && (
        <EmptyState
          className="mt-6"
          title={
            query.isFiltered
              ? "No audit events match these filters."
              : "No audit events yet."
          }
        />
      )}

      {listResult?.ok && rows.length > 0 && (
        <>
          <AuditDesktopTable rows={rows} />
          <AuditMobileList rows={rows} />
        </>
      )}

      {nextCursor && (
        <div className="mt-6">
          <Link href={buildAuditHref(rawParams, { cursor: nextCursor })} className={buttonClasses("outline", "sm")}>
            Next
          </Link>
        </div>
      )}
    </main>
  );
}

// GET form -> URL search params -> this Server Component rerenders --
// no client-side fetching, no client component needed here at all.
// Every filter lives in ONE form (unlike src/app/bookstore/page.tsx's
// separate search/price forms), so submitting it always carries every
// active filter together -- no hidden-field preservation trick is
// needed. Submitting never includes a cursor field, so applying/changing
// any filter always resets pagination back to the first page, per the
// design brief's own "a filter change resets pagination cursor"
// requirement.
function AuditFilterForm({
  query,
  actorOptions,
  isFiltered,
}: {
  query: AuditRawSearchParams;
  actorOptions: ActorFilterOption[];
  isFiltered: boolean;
}) {
  const controlClass =
    "focus-ring rounded-md border border-border bg-surface px-3 py-1.5 text-sm";

  return (
    <form
      action="/admin/audit"
      method="get"
      className="mt-6 flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface p-4"
    >
      <div>
        <label htmlFor="audit-action" className="block text-xs text-muted">
          Action
        </label>
        <select id="audit-action" name="action" defaultValue={query.action ?? ""} className={controlClass}>
          <option value="">All actions</option>
          {AUDIT_ACTIONS.map((action) => (
            <option key={action} value={action}>
              {ACTION_LABELS[action]}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="audit-target-type" className="block text-xs text-muted">
          Target
        </label>
        <select
          id="audit-target-type"
          name="target_type"
          defaultValue={query.target_type ?? ""}
          className={controlClass}
        >
          <option value="">All targets</option>
          {AUDIT_TARGET_TYPES.map((targetType) => (
            <option key={targetType} value={targetType}>
              {TARGET_TYPE_FILTER_LABELS[targetType]}
            </option>
          ))}
        </select>
      </div>

      {/* Omitted entirely when there are no options at all rather than
          shown as a disabled/empty control -- see resolveActorFilterOptions'
          own comment (audit-log-logic.ts) for the synthetic
          former/deleted-staff option this list can also carry. An empty
          roster with no active actor filter should never actually happen
          in practice (every audit.view holder also holds staff.view),
          but this stays defensive either way instead of rendering a
          guaranteed-useless "All actors" only dropdown. */}
      {actorOptions.length > 0 && (
        <div>
          <label htmlFor="audit-actor" className="block text-xs text-muted">
            Actor
          </label>
          <select id="audit-actor" name="actor" defaultValue={query.actor ?? ""} className={controlClass}>
            <option value="">All actors</option>
            {actorOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      )}

      <div>
        <label htmlFor="audit-from" className="block text-xs text-muted">
          From
        </label>
        <input
          id="audit-from"
          type="date"
          name="from"
          defaultValue={query.from ?? ""}
          className={controlClass}
        />
      </div>

      <div>
        <label htmlFor="audit-to" className="block text-xs text-muted">
          To
        </label>
        <input id="audit-to" type="date" name="to" defaultValue={query.to ?? ""} className={controlClass} />
      </div>

      <button type="submit" className={buttonClasses("primary", "sm")}>
        Apply filters
      </button>

      {isFiltered && (
        <Link href="/admin/audit" className="focus-ring rounded-sm text-sm font-medium text-primary hover:underline">
          Clear filters
        </Link>
      )}
    </form>
  );
}

// Desktop: a real table. Mobile: stacked cards below (AuditMobileList) --
// rendered from the exact same rows, just laid out differently, mirroring
// src/app/admin/(protected)/staff/page.tsx's own established dual-render
// pattern for the identical reason: a five-column table does not fit a
// 390px viewport usefully.
function AuditDesktopTable({ rows }: { rows: AuditEventRow[] }) {
  return (
    <div className="mt-6 hidden overflow-x-auto md:block">
      <table className="w-full min-w-[720px] border-collapse text-sm">
        <caption className="sr-only">Librum admin audit log</caption>
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
            <th scope="col" className="py-2 pr-4 font-medium">
              Time
            </th>
            <th scope="col" className="py-2 pr-4 font-medium">
              Actor
            </th>
            <th scope="col" className="py-2 pr-4 font-medium">
              Action
            </th>
            <th scope="col" className="py-2 pr-4 font-medium">
              Target
            </th>
            <th scope="col" className="py-2 pr-4 font-medium">
              Details
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const target = resolveAuditTargetDisplay(row.target_type, row.target_id);
            const details = formatAuditDetails(row.action, row.metadata);
            return (
              <tr key={row.id} className="border-b border-border align-top">
                <td className="py-3 pr-4 whitespace-nowrap text-muted">
                  {formatAuditTimestamp(row.created_at)}
                </td>
                <td className="py-3 pr-4">{resolveAuditActorDisplay(row.actor_display_name)}</td>
                <td className="py-3 pr-4 font-medium text-foreground">{getActionLabel(row.action)}</td>
                <td className="py-3 pr-4">
                  {target.href ? (
                    <Link href={target.href} className="text-primary hover:underline">
                      {target.label}
                    </Link>
                  ) : (
                    target.label
                  )}
                </td>
                <td className="py-3 pr-4 text-muted">{details ?? "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function AuditMobileList({ rows }: { rows: AuditEventRow[] }) {
  return (
    <ul className="mt-6 flex flex-col gap-3 md:hidden">
      {rows.map((row) => {
        const target = resolveAuditTargetDisplay(row.target_type, row.target_id);
        const details = formatAuditDetails(row.action, row.metadata);
        return (
          <li key={row.id} className="rounded-lg border border-border bg-surface p-4 shadow-sm">
            <p className="font-medium text-foreground">{getActionLabel(row.action)}</p>
            <p className="mt-0.5 text-xs text-muted">{formatAuditTimestamp(row.created_at)}</p>
            <p className="mt-2 text-sm">
              <span className="text-muted">Actor: </span>
              {resolveAuditActorDisplay(row.actor_display_name)}
            </p>
            <p className="mt-1 text-sm">
              <span className="text-muted">Target: </span>
              {target.href ? (
                <Link href={target.href} className="text-primary hover:underline">
                  {target.label}
                </Link>
              ) : (
                target.label
              )}
            </p>
            {details && <p className="mt-1 text-sm text-muted">{details}</p>}
          </li>
        );
      })}
    </ul>
  );
}
