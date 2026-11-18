"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { redirectIfRecoverySessionActive } from "@/lib/recovery-guard";
import { LEAVE_NOTE_MAX_LENGTH, parseLeaveReason, tiranaDay } from "@/lib/account-deletion-reasons";
import { formatTimestampAsDate } from "@/lib/book-detail-dates";
import { sendAccountDeletionRequestedEmail } from "@/lib/email";

// DEL (Renato 11-18, del1 a .. del8 c): pressing "Fshini llogarinë time"
// no longer deletes anything at once. request_account_deletion (migration
// 20261118170000) hides the account, signs it out everywhere, saves the
// optional reason without the account, and schedules the real deletion
// 30 days later; the daily job (src/lib/account-deletion.ts) does it
// then, unless the person pressed Restore (./restore). The checks before
// the call are unchanged: recovery session, staff (fail closed), FSHI.

export async function deleteAccount(formData: FormData) {
  // AUTH-1C: defense-in-depth -- Proxy already blocks /account itself
  // while a recovery session is active, so this is the second layer
  // against a crafted direct POST. Account deletion hides the account
  // and signs it out everywhere, so this runs before any Supabase call at all, matching buyBook's/
  // buyBundle's own placement (src/app/books/[id]/actions.ts,
  // src/app/bundles/[id]/actions.ts).
  await redirectIfRecoverySessionActive();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // LIBRUM 2.0 ADMIN-1B PART B, FAIL-OPEN CORRECTION: an active staff
  // member (any role -- owner/admin/editor/moderator/support, no
  // exception) cannot delete their own Librum account through this
  // ordinary self-service path. Checked FIRST, before the
  // confirmation-text check below, so a staff member learns this
  // immediately rather than after typing "FSHI" -- and deliberately
  // does nothing else: no auto-removal from staff_members, no silent
  // mutation of anything, just a stable redirect either way.
  //
  // A direct, narrow lookup here -- not getStaffMember() -- specifically
  // so this destructive action can distinguish "confirmed not staff"
  // from "the lookup itself failed" (a Postgres/network error mid-query,
  // not merely an absent row). getStaffMember() (src/lib/staff.ts)
  // discards its own query's error and collapses both cases to null,
  // which is the correct, safe default for every READ-time gate that
  // already uses it (requireStaff() simply redirects either way, and an
  // over-cautious false "not staff" there costs nothing worse than an
  // extra login prompt) -- but is NOT an acceptable ambiguity for a
  // guard whose failure mode is "irreversibly delete an active staff
  // member's account." getStaffMember() itself is deliberately left
  // unmodified: this fix is scoped to the one call site where the
  // distinction is safety-critical, not a broad redesign of the shared
  // helper every other admin surface already depends on.
  const { data: staffRow, error: staffLookupError } = await supabase
    .from("staff_members")
    .select("role")
    .eq("user_id", user.id)
    .maybeSingle();

  if (staffLookupError) {
    console.error("deleteAccount: staff status lookup failed:", staffLookupError);
    redirect(
      `/account?error=${encodeURIComponent(
        "Nuk mundëm të kontrollojmë nëse kjo llogari mund të fshihet. Provoni përsëri.",
      )}`,
    );
  }

  if (staffRow) {
    redirect(`/account?error=${encodeURIComponent(
        "Hiqeni këtë llogari nga stafi i Librum para se ta fshini.",
      )}`);
  }

  const confirmation = String(formData.get("confirmation") ?? "");
  if (confirmation !== "FSHI") {
    redirect(`/account?error=${encodeURIComponent("Shkruani FSHI për ta konfirmuar.")}`);
  }

  const reason = parseLeaveReason(formData.get("reason"));
  const note = String(formData.get("reason_note") ?? "").trim();
  if (note.length > LEAVE_NOTE_MAX_LENGTH) {
    redirect(`/account?error=${encodeURIComponent(
        "Shkruani deri në 500 shkronja te «Doni të na tregoni më shumë?».",
      )}`);
  }

  const { data: deleteAfter, error: requestError } = await supabase.rpc("request_account_deletion", {
    p_reason: reason,
    p_note: note === "" ? null : note,
  });

  if (requestError || typeof deleteAfter !== "string") {
    const code = (requestError as { code?: string } | null)?.code;
    if (code === "LB520") redirect("/account/restore");
    if (code === "LB519") {
      redirect(`/account?error=${encodeURIComponent(
        "Hiqeni këtë llogari nga stafi i Librum para se ta fshini.",
      )}`);
    }
    if (code === "LB522") {
      redirect(`/account?error=${encodeURIComponent(
        "Llogaria juaj nuk mund të fshihet ndërsa lexuesit kanë libra që keni botuar. Hiqini librat nga publikimi nëse nuk doni më t'i shisni.",
      )}`);
    }
    if (code === "LB523") {
      redirect(`/account?error=${encodeURIComponent(
        "Shkruani deri në 500 shkronja te «Doni të na tregoni më shumë?».",
      )}`);
    }
    console.error("deleteAccount: the deletion request failed", { code: code ?? null });
    redirect(`/account?error=${encodeURIComponent(
        "Diçka shkoi keq gjatë fshirjes së llogarisë. Provoni përsëri.",
      )}`);
  }

  // del5 a: one email, best effort, after the page has answered.
  const email = user.email;
  if (email) {
    const providers = user.app_metadata?.providers;
    const hasPassword = Array.isArray(providers)
      ? providers.includes("email")
      : user.app_metadata?.provider === "email";
    const details = {
      requestedOn: formatTimestampAsDate(new Date().toISOString()),
      deleteOn: formatTimestampAsDate(deleteAfter),
      hasPassword,
    };
    after(async () => {
      try {
        await sendAccountDeletionRequestedEmail(email, details);
      } catch (error) {
        console.error("deleteAccount: the deletion email failed", error);
      }
    });
  }

  // The RPC already ended every session in the database; this clears
  // this browser's cookies too.
  await supabase.auth.signOut();

  revalidatePath("/", "layout");
  const day = tiranaDay(deleteAfter);
  redirect(day ? `/?account=deletion_requested&until=${day}` : "/?account=deletion_requested");
}
