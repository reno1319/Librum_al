import { isUuid } from "../books/book-admin-logic";
import { isBannedNow } from "@/lib/suspension-gate";

// PEOPLE-2: pure helpers for Suspend, Lift and "Try again" on
// /admin/people/[id] -- the form rules (the same as the database's), the
// RPC error mapping, and whether the Supabase Auth ban is out of step
// with the account_suspensions row. Kept out of the actions so each is
// directly unit-testable, as book-admin-logic.ts is.

export const SUSPEND_REASON_MAX_LENGTH = 2000;

// Supabase Auth's ban: "876000h" is about 100 years (there is no
// "forever"); "none" lifts it.
export const SUSPEND_BAN_DURATION = "876000h";
export const LIFT_BAN_DURATION = "none";

export const SUSPENDED_SUCCESS_MESSAGE =
  "Account suspended. They're signed out, and their books are out of the Bookstore.";
export const LIFTED_SUCCESS_MESSAGE = "Suspension lifted. They can sign in again.";
export const ACCESS_FIXED_SUCCESS_MESSAGE = "Sign-in now matches the account's status.";
export const SUSPEND_AUTH_STEP_FAILED_MESSAGE =
  "The account is suspended and its books are out of the Bookstore, but blocking sign-in failed. Use Try again below.";
export const LIFT_AUTH_STEP_FAILED_MESSAGE =
  "The suspension is lifted, but allowing sign-in again failed. Use Try again below.";
export const ACCESS_RETRY_FAILED_MESSAGE = "Couldn't update sign-in. Please try again.";
export const GENERIC_SUSPEND_ERROR_MESSAGE = "Couldn't suspend the account. Nothing was changed. Try again.";
export const GENERIC_LIFT_ERROR_MESSAGE = "Couldn't lift the suspension. Nothing was changed. Try again.";
export const WRITE_REASON_MESSAGE = "Write the reason for the suspension.";
export const REASON_TOO_LONG_MESSAGE = `Keep the reason under ${SUSPEND_REASON_MAX_LENGTH} characters.`;
export const RPC_NOT_AUTHENTICATED_MESSAGE = "not authenticated";

// The database trims exactly these characters (btrim(reason, E' \t\r\n')).
export function trimReason(value: string): string {
  return value.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
}

// char_length() counts code points, as [...value] does; .length counts
// UTF-16 units and would refuse some reasons the database accepts.
function codePointLength(value: string): number {
  return [...value].length;
}

export type SuspendFormResult = { ok: true; userId: string; reason: string } | { ok: false; error: string };

export function validateSuspendForm(formData: FormData): SuspendFormResult {
  const userId = formData.get("userId");
  if (!isUuid(userId)) return { ok: false, error: GENERIC_SUSPEND_ERROR_MESSAGE };
  const raw = formData.get("reason");
  const reason = typeof raw === "string" ? trimReason(raw) : "";
  if (codePointLength(reason) === 0) return { ok: false, error: WRITE_REASON_MESSAGE };
  if (codePointLength(reason) > SUSPEND_REASON_MAX_LENGTH) return { ok: false, error: REASON_TOO_LONG_MESSAGE };
  return { ok: true, userId, reason };
}

export function readUserId(formData: FormData): string | null {
  const userId = formData.get("userId");
  return isUuid(userId) ? userId : null;
}

const KNOWN_SUSPEND_RPC_ERRORS: Record<string, string> = {
  "not authorized": "You don't have permission to suspend accounts.",
  "no account found for this id": "This account no longer exists.",
  "you cannot suspend yourself": "You can't suspend your own account.",
  "staff cannot be suspended": "Staff can't be suspended. Remove them from Staff first.",
  "this account is already suspended": "This account is already suspended.",
  "invalid reason": WRITE_REASON_MESSAGE,
};

const KNOWN_LIFT_RPC_ERRORS: Record<string, string> = {
  "not authorized": "You don't have permission to lift suspensions.",
  "this account is not suspended": "This account isn't suspended. Reload to see what changed.",
};

type RpcError = { code?: string | null; message?: string | null } | null | undefined;

export function mapSuspendRpcError(error: RpcError): string {
  if (error?.code === "40P01") return "Please try again.";
  const message = error?.message?.trim();
  return (message && KNOWN_SUSPEND_RPC_ERRORS[message]) || GENERIC_SUSPEND_ERROR_MESSAGE;
}

// N2: any other refusal (one no published path raises today) is shown
// as "nothing was changed": the lift is one transaction.
export function mapLiftRpcError(error: RpcError): string {
  if (error?.code === "40P01") return "Please try again.";
  const message = error?.message?.trim();
  return (message && KNOWN_LIFT_RPC_ERRORS[message]) || GENERIC_LIFT_ERROR_MESSAGE;
}

// Brief check note 1: the account_suspensions row is the truth; the
// Supabase Auth ban follows it. When they disagree, the page offers
// "Try again", and the retry action does exactly this.
export type AccessFix = "ban" | "unban" | null;

export function accessFixNeeded(input: {
  activeSuspension: boolean;
  bannedUntil: string | null | undefined;
  now?: Date;
}): AccessFix {
  const banned = isBannedNow(input.bannedUntil, input.now);
  if (input.activeSuspension && !banned) return "ban";
  if (!input.activeSuspension && banned) return "unban";
  return null;
}
