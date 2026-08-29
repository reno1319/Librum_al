import Link from "next/link";
import { requireStaff } from "@/lib/staff";
import { roleHasPermission } from "@/lib/staff-permissions";
import { Alert } from "@/components/ui/alert";
import { listStaffMembers } from "./actions";
import {
  addStaffMemberByEmailFormAction,
  changeStaffRoleFormAction,
  removeStaffMemberFormAction,
} from "./page-actions";
import { AddStaffForm } from "./add-staff-form";
import { RoleChangeRow } from "./role-change-row";
import { RemoveStaffButton } from "./remove-staff-button";
import { STAFF_ROLE_LABELS, canManageStaffRow, formatStaffAddedDate } from "./staff-management-logic";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Staff",
};

// LIBRUM 2.0 ADMIN-1B PART C: gated by staff.view specifically (not
// admin.access, which admin/(protected)/layout.tsx already checked one
// level up) -- moderator/support both carry admin.access but not
// staff.view, and must never reach this page at all, matching every
// other admin surface's own narrower, route-specific requireStaff()
// call (see reports/page.tsx's requireStaff("reports.view"),
// refunds/page.tsx's requireStaff("refunds.view")). canManage is
// derived from the SAME role requireStaff() already returned, via
// roleHasPermission() -- the canonical TypeScript permission layer --
// never a role-name check (`role === "owner"`); under the current,
// unmodified matrix this happens to mean only 'owner' sees the manage
// controls, but nothing here assumes that -- it would track the matrix
// automatically if that ever changed.
export default async function AdminStaffPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  const { userId, role } = await requireStaff("staff.view");
  const { error, success } = await searchParams;
  const canManage = roleHasPermission(role, "staff.manage");

  const result = await listStaffMembers();

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-10 sm:px-6">
      <Link href="/admin" className="text-sm text-muted hover:underline">
        &larr; Back to admin
      </Link>
      <h1 className="mt-2 font-serif text-3xl font-semibold">Staff</h1>
      <p className="mt-1 text-sm text-muted">
        {canManage
          ? "Manage who has administrative access to Librum."
          : "You have read-only access to staff."}
      </p>

      {error && (
        <Alert variant="error" className="mt-4">
          {error}
        </Alert>
      )}
      {success && (
        <Alert variant="success" className="mt-4">
          {success}
        </Alert>
      )}

      {!result.ok ? (
        // LIBRUM 2.0 ADMIN-1B PART C: the fixed page-level copy the
        // design brief requires for a load failure, not result.error
        // (which is already a safe, mapped message from Part B, but a
        // separately-worded one meant for a mutation, not a listing) --
        // never the raw RPC/Postgres text either way.
        <Alert variant="error" className="mt-6">
          Unable to load staff members.
        </Alert>
      ) : result.data.length === 0 ? (
        // Should never actually happen -- migration 041's own trigger
        // guarantees at least one owner always exists -- but rendering a
        // restrained safe state instead of crashing on an impossible
        // input is cheaper than assuming it can't happen. No invented
        // recovery action here that would bypass RBAC (e.g. no
        // "re-bootstrap an owner" button) -- an empty roster this page
        // can't explain is a database-level problem, not a UI one.
        <p className="mt-8 rounded-lg border border-dashed border-border px-6 py-16 text-center text-muted">
          No staff members found.
        </p>
      ) : (
        <>
          {/* Desktop: a real table. Mobile: stacked cards below --
              rendered from the exact same result.data, just laid out
              differently; a wide multi-column table does not fit a
              390px viewport usefully. */}
          <div className="mt-6 hidden overflow-x-auto md:block">
            <table className="w-full min-w-[640px] border-collapse text-sm">
              <caption className="sr-only">Librum staff members</caption>
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Staff member
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Email
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Role
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Added
                  </th>
                  {canManage && (
                    <th scope="col" className="py-2 pr-4 font-medium">
                      Actions
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {result.data.map((member) => {
                  const isSelf = member.user_id === userId;
                  const editable = canManageStaffRow(member.user_id, userId, canManage);

                  return (
                    <tr key={member.user_id} className="border-b border-border align-top">
                      <td className="py-3 pr-4 font-medium text-foreground">
                        {member.display_name}
                        {isSelf && <span className="ml-1 font-normal text-muted">(You)</span>}
                      </td>
                      <td className="max-w-[220px] break-words py-3 pr-4 text-muted">
                        {member.email}
                      </td>
                      <td className="py-3 pr-4">
                        {editable ? (
                          <RoleChangeRow
                            targetUserId={member.user_id}
                            displayName={member.display_name}
                            currentRole={member.role}
                            action={changeStaffRoleFormAction}
                          />
                        ) : (
                          STAFF_ROLE_LABELS[member.role]
                        )}
                      </td>
                      <td className="py-3 pr-4 whitespace-nowrap text-muted">
                        {formatStaffAddedDate(member.created_at)}
                      </td>
                      {canManage && (
                        <td className="py-3 pr-4">
                          {editable && (
                            <RemoveStaffButton
                              targetUserId={member.user_id}
                              displayName={member.display_name}
                              action={removeStaffMemberFormAction}
                            />
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <ul className="mt-6 flex flex-col gap-3 md:hidden">
            {result.data.map((member) => {
              const isSelf = member.user_id === userId;
              const editable = canManageStaffRow(member.user_id, userId, canManage);

              return (
                <li
                  key={member.user_id}
                  className="rounded-lg border border-border bg-surface p-4 shadow-sm"
                >
                  <p className="font-medium text-foreground">
                    {member.display_name}
                    {isSelf && <span className="ml-1 font-normal text-muted">(You)</span>}
                  </p>
                  <p className="mt-0.5 break-words text-sm text-muted">{member.email}</p>
                  <p className="mt-1 text-xs text-muted">
                    Added {formatStaffAddedDate(member.created_at)}
                  </p>

                  <div className="mt-3">
                    {editable ? (
                      <RoleChangeRow
                        targetUserId={member.user_id}
                        displayName={member.display_name}
                        currentRole={member.role}
                        action={changeStaffRoleFormAction}
                      />
                    ) : (
                      <p className="text-sm">
                        <span className="text-muted">Role: </span>
                        {STAFF_ROLE_LABELS[member.role]}
                      </p>
                    )}
                  </div>

                  {editable && (
                    <div className="mt-3">
                      <RemoveStaffButton
                        targetUserId={member.user_id}
                        displayName={member.display_name}
                        action={removeStaffMemberFormAction}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}

      {canManage && (
        <div className="mt-10 border-t border-border pt-6">
          <h2 className="font-serif text-xl font-semibold">Add staff</h2>
          <AddStaffForm action={addStaffMemberByEmailFormAction} />
        </div>
      )}
    </main>
  );
}
