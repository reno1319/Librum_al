"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireStaff } from "@/lib/staff";
import { sendAccountSuspendedEmail, sendAccountSuspensionLiftedEmail } from "@/lib/email";
import { scheduleWaitingReaderEmails } from "@/lib/preorder-emails";
import { resolveMaintenanceMode } from "@/lib/maintenance-mode";
import { redirectForMaintenance } from "@/lib/maintenance-response";
import {
  ACCESS_FIXED_SUCCESS_MESSAGE,
  ACCESS_RETRY_FAILED_MESSAGE,
  GENERIC_LIFT_ERROR_MESSAGE,
  LIFTED_SUCCESS_MESSAGE,
  LIFT_AUTH_STEP_FAILED_MESSAGE,
  LIFT_BAN_DURATION,
  RPC_NOT_AUTHENTICATED_MESSAGE,
  SUSPENDED_SUCCESS_MESSAGE,
  SUSPEND_AUTH_STEP_FAILED_MESSAGE,
  SUSPEND_BAN_DURATION,
  accessFixNeeded,
  mapLiftRpcError,
  mapSuspendRpcError,
  readUserId,
  validateSuspendForm,
} from "../suspension-logic";
import { isUuid } from "../../books/book-admin-logic";

// PEOPLE-2 (1a, 2a): Suspend, Lift, and "Try again" for the sign-in step.
// Same shape as the book takedown actions (books/actions.ts): the
// maintenance gate, then requireStaff("people.manage") as defense in
// depth, then the RPC through the staff member's OWN session client, so
// auth.uid() inside admin_suspend_account()/admin_lift_suspension() is
// that staff member and the RPC re-checks people.manage, staff, self and
// the reason itself. The account_suspensions row the RPC writes is the
// truth. The Supabase Auth ban follows it (service role, after the RPC
// committed); if that step fails the page says so and offers "Try
// again", and the middleware check still cuts the account off in the
// meantime because it also reads my_account_is_suspended(). The email is
// best effort, its address read only through the admin auth API, and
// never logged. redirect() stays outside every try/catch.

function personPath(userId: string): string {
  return `/admin/people/${userId}`;
}

function withQuery(path: string, key: "error" | "success", message: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(message)}`;
}

async function setBan(userId: string, banDuration: string): Promise<boolean> {
  try {
    const admin = createAdminClient();
    const { error } = await admin.auth.admin.updateUserById(userId, { ban_duration: banDuration });
    if (error) {
      console.error("people: the auth ban step failed", { userId, banDuration, code: error.code ?? null });
      return false;
    }
    return true;
  } catch (banError) {
    console.error("people: the auth ban step threw", { userId, banDuration, error: banError });
    return false;
  }
}

async function emailAccount(userId: string, send: (to: string) => Promise<void>, label: string): Promise<void> {
  try {
    const admin = createAdminClient();
    const { data } = await admin.auth.admin.getUserById(userId);
    const email = data?.user?.email;
    if (email) await send(email);
  } catch (emailError) {
    console.error(`people: the ${label} email failed`, { userId, error: emailError });
  }
}

// The account's books, bundles, pen-name, series and author pages all
// change together, so the whole layout tree is revalidated.
function revalidateEverything(userId: string): void {
  for (const [path, type] of [
    ["/", "layout"],
    ["/admin/people", undefined],
    [personPath(userId), undefined],
  ] as const) {
    try {
      if (type) revalidatePath(path, type);
      else revalidatePath(path);
    } catch (revalidateError) {
      console.error("people: revalidatePath failed", { path, error: revalidateError });
    }
  }
}

export async function suspendAccountAsStaff(formData: FormData) {
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    redirectForMaintenance("/admin/people");
  }

  await requireStaff("people.manage");

  const validation = validateSuspendForm(formData);
  if (!validation.ok) {
    const userId = readUserId(formData);
    redirect(withQuery(userId ? personPath(userId) : "/admin/people", "error", validation.error));
  }
  const backTo = personPath(validation.userId);

  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_suspend_account", {
    p_user_id: validation.userId,
    p_reason: validation.reason,
  });

  if (error) {
    if (error.message === RPC_NOT_AUTHENTICATED_MESSAGE) {
      redirect(`/admin/login?next=${encodeURIComponent(backTo)}`);
    }
    if (error.code !== "40P01") {
      console.error("suspendAccountAsStaff: admin_suspend_account failed", { userId: validation.userId, code: error.code });
    }
    redirect(withQuery(backTo, "error", mapSuspendRpcError(error)));
  }

  const banned = await setBan(validation.userId, SUSPEND_BAN_DURATION);
  await emailAccount(validation.userId, sendAccountSuspendedEmail, "suspended");
  revalidateEverything(validation.userId);

  redirect(
    banned
      ? withQuery(backTo, "success", SUSPENDED_SUCCESS_MESSAGE)
      : withQuery(backTo, "error", SUSPEND_AUTH_STEP_FAILED_MESSAGE),
  );
}

export async function liftSuspensionAsStaff(formData: FormData) {
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    redirectForMaintenance("/admin/people");
  }

  await requireStaff("people.manage");

  const userId = readUserId(formData);
  if (!userId) {
    redirect(withQuery("/admin/people", "error", GENERIC_LIFT_ERROR_MESSAGE));
  }
  const backTo = personPath(userId);

  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_lift_suspension", { p_user_id: userId });

  if (error) {
    if (error.message === RPC_NOT_AUTHENTICATED_MESSAGE) {
      redirect(`/admin/login?next=${encodeURIComponent(backTo)}`);
    }
    if (error.code !== "40P01") {
      console.error("liftSuspensionAsStaff: admin_lift_suspension failed", { userId, code: error.code });
    }
    redirect(withQuery(backTo, "error", mapLiftRpcError(error)));
  }

  const unbanned = await setBan(userId, LIFT_BAN_DURATION);
  await emailAccount(userId, sendAccountSuspensionLiftedEmail, "lifted");
  // BD16 P5 (Q4 a): a paused pre-order that couldn't come back ended as
  // cancelled; its waiting readers get the one "cancelled" email.
  scheduleWaitingReaderEmails("liftSuspensionAsStaff");
  revalidateEverything(userId);

  redirect(
    unbanned
      ? withQuery(backTo, "success", LIFTED_SUCCESS_MESSAGE)
      : withQuery(backTo, "error", LIFT_AUTH_STEP_FAILED_MESSAGE),
  );
}

// Brief check note 1: retries only the sign-in step, and only in the
// direction the account_suspensions row says. It bans only when an
// active suspension row exists for this id (which the RPC never writes
// for staff), and unbans only when none does, so it can never ban staff
// or unban a suspended account. Idempotent; no email.
export async function retryAccountAccessAsStaff(formData: FormData) {
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    redirectForMaintenance("/admin/people");
  }

  await requireStaff("people.manage");

  const userId = readUserId(formData);
  if (!userId) {
    redirect(withQuery("/admin/people", "error", ACCESS_RETRY_FAILED_MESSAGE));
  }
  const backTo = personPath(userId);

  let fix: ReturnType<typeof accessFixNeeded> | "failed";
  try {
    const admin = createAdminClient();
    const [suspension, authUser] = await Promise.all([
      admin
        .from("account_suspensions")
        .select("id")
        .eq("user_id", userId)
        .is("lifted_at", null)
        .maybeSingle<{ id: string }>(),
      admin.auth.admin.getUserById(userId),
    ]);
    if (suspension.error || authUser.error || !authUser.data?.user) {
      console.error("retryAccountAccessAsStaff: reading the account failed", {
        userId,
        suspension: suspension.error?.code ?? null,
        auth: authUser.error?.code ?? null,
      });
      fix = "failed";
    } else {
      fix = accessFixNeeded({
        activeSuspension: suspension.data !== null,
        bannedUntil: authUser.data.user.banned_until,
      });
    }
  } catch (readError) {
    console.error("retryAccountAccessAsStaff: reading the account threw", { userId, error: readError });
    fix = "failed";
  }

  if (fix === "failed") {
    redirect(withQuery(backTo, "error", ACCESS_RETRY_FAILED_MESSAGE));
  }
  if (fix === null) {
    redirect(withQuery(backTo, "success", ACCESS_FIXED_SUCCESS_MESSAGE));
  }

  const ok = await setBan(userId, fix === "ban" ? SUSPEND_BAN_DURATION : LIFT_BAN_DURATION);
  revalidateEverything(userId);
  redirect(withQuery(backTo, ok ? "success" : "error", ok ? ACCESS_FIXED_SUCCESS_MESSAGE : ACCESS_RETRY_FAILED_MESSAGE));
}

// BUILD 2b (b4 c): staff link one of a publishing house's authors to the
// SAME name on the writer's own author account, and unlink it. The RPCs
// run through the staff member's own session (auth.uid() is the staff
// member; they re-check people.manage, the house, the account and the
// name match) and write the audit log. The email is never logged.
const HOUSE_AUTHOR_LINKED_MESSAGE = "Author linked. Readers now see the writer's own author page.";
const HOUSE_AUTHOR_UNLINKED_MESSAGE = "Author unlinked. The house's own author page is back.";
const HOUSE_AUTHOR_GENERIC_ERROR = "The author link could not be changed. Please try again.";
const HOUSE_AUTHOR_NO_ACCOUNT = "No account has that email.";
const HOUSE_AUTHOR_LINK_ERRORS: Record<string, string> = {
  generic: HOUSE_AUTHOR_GENERIC_ERROR,
  not_found: "That author can't be linked.",
  not_house_author: "That author can't be linked.",
  already_linked: "That author is already linked. Unlink it first.",
  no_account: HOUSE_AUTHOR_NO_ACCOUNT,
  same_account: "That email belongs to this house's own account.",
  not_author: "That account is not a writer's own author account.",
  no_match: "No author name on that account matches this author's name exactly. Nothing was linked.",
};

function readPenNameId(formData: FormData): string | null {
  const value = formData.get("pen_name_id");
  return isUuid(value) ? value : null;
}

export async function linkHouseAuthorAsStaff(formData: FormData) {
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    redirectForMaintenance("/admin/people");
  }
  await requireStaff("people.manage");

  const userId = readUserId(formData);
  if (!userId) redirect(withQuery("/admin/people", "error", HOUSE_AUTHOR_GENERIC_ERROR));
  const back = personPath(userId);
  const penNameId = readPenNameId(formData);
  const email = String(formData.get("email") ?? "").trim();
  if (!penNameId) redirect(withQuery(back, "error", HOUSE_AUTHOR_GENERIC_ERROR));
  if (!email) redirect(withQuery(back, "error", HOUSE_AUTHOR_NO_ACCOUNT));

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("staff_link_house_author", { p_pen_name_id: penNameId, p_email: email });
  if (error) console.error("linkHouseAuthorAsStaff: staff_link_house_author failed", { code: error.code ?? null });
  if (error || data !== "linked") {
    const code = !error && typeof data === "string" && Object.hasOwn(HOUSE_AUTHOR_LINK_ERRORS, data) ? data : "generic";
    redirect(withQuery(back, "error", HOUSE_AUTHOR_LINK_ERRORS[code]));
  }
  revalidateEverything(userId);
  redirect(withQuery(back, "success", HOUSE_AUTHOR_LINKED_MESSAGE));
}

export async function unlinkHouseAuthorAsStaff(formData: FormData) {
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    redirectForMaintenance("/admin/people");
  }
  await requireStaff("people.manage");

  const userId = readUserId(formData);
  if (!userId) redirect(withQuery("/admin/people", "error", HOUSE_AUTHOR_GENERIC_ERROR));
  const back = personPath(userId);
  const penNameId = readPenNameId(formData);
  if (!penNameId) redirect(withQuery(back, "error", HOUSE_AUTHOR_GENERIC_ERROR));

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("staff_unlink_house_author", { p_pen_name_id: penNameId });
  if (error) console.error("unlinkHouseAuthorAsStaff: staff_unlink_house_author failed", { code: error.code ?? null });
  // Already unlinked (another tab) counts as done.
  if (error || (data !== "unlinked" && data !== "not_linked")) {
    redirect(withQuery(back, "error", HOUSE_AUTHOR_GENERIC_ERROR));
  }
  revalidateEverything(userId);
  redirect(withQuery(back, "success", HOUSE_AUTHOR_UNLINKED_MESSAGE));
}
