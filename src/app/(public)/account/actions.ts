"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { redirectIfRecoverySessionActive } from "@/lib/recovery-guard";

export async function deleteAccount(formData: FormData) {
  // AUTH-1C: defense-in-depth -- Proxy already blocks /account itself
  // while a recovery session is active, so this is the second layer
  // against a crafted direct POST. Account deletion is irreversible
  // (auth.admin.deleteUser() below, plus every authored book/file), so
  // this runs before any Supabase call at all, matching buyBook's/
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
  // immediately rather than after typing "DELETE" -- and deliberately
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
      "/account?error=Unable+to+verify+account+eligibility+for+deletion.+Try+again.",
    );
  }

  if (staffRow) {
    redirect(
      "/account?error=Remove+this+account+from+Librum+staff+before+deleting+the+account.",
    );
  }

  const confirmation = String(formData.get("confirmation") ?? "");
  if (confirmation !== "DELETE") {
    redirect("/account?error=Type+DELETE+to+confirm");
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("avatar_path")
    .eq("id", user.id)
    .single();

  const { data: books } = await supabase
    .from("books")
    .select("id, cover_path, file_path")
    .eq("author_id", user.id)
    .returns<{ id: string; cover_path: string | null; file_path: string | null }[]>();

  const authoredBooks = books ?? [];
  const bookIds = authoredBooks.map((b) => b.id);

  // A book with ANY acquisition history -- paid, free, or refunded --
  // must never be destroyed, matching Phase 8A's rule for deleteBook
  // (purchases.book_id is ON DELETE RESTRICT -- see migration 023).
  // Deleting the auth user cascades auth.users -> profiles -> books, so
  // if any authored book has ever been acquired, that cascade would be
  // blocked at the database level regardless -- this check exists to
  // catch that BEFORE any storage object is touched, not to replace the
  // FK as the real guarantee. Only a head/count request -- no purchase
  // rows (amounts, reader ids, Stripe ids) are ever read here.
  if (bookIds.length > 0) {
    const { count: acquisitionCount } = await supabase
      .from("purchases")
      .select("id", { count: "exact", head: true })
      .in("book_id", bookIds);

    if ((acquisitionCount ?? 0) > 0) {
      redirect(
        "/account?error=Your+account+can%27t+be+deleted+while+readers+own+books+you%27ve+published.+Unpublish+the+books+if+you+no+longer+want+them+for+sale.",
      );
    }
  }

  const admin = createAdminClient();

  const coverPaths = authoredBooks
    .map((b) => b.cover_path)
    .filter((p): p is string => !!p);
  const manuscriptPaths = authoredBooks
    .map((b) => b.file_path)
    .filter((p): p is string => !!p);

  // The account/database row is authoritative -- storage cleanup is
  // secondary. deleteUser runs (and its result is checked) BEFORE any
  // storage object is removed, so a failure here -- including the race
  // where a purchase appears after the advisory check above and
  // purchases.book_id's ON DELETE RESTRICT blocks the cascade -- leaves
  // every file, every row, and the account itself untouched.
  const { error: deleteUserError } = await admin.auth.admin.deleteUser(user.id);

  if (deleteUserError) {
    console.error("deleteAccount: failed to delete auth user:", deleteUserError);
    redirect(
      "/account?error=Something+went+wrong+deleting+your+account.+Please+try+again",
    );
  }

  // The account is gone at this point -- from the user's perspective the
  // deletion already succeeded. Any failure past here is an orphaned
  // storage file to clean up later, not a failed account deletion, so
  // it's logged rather than surfaced as an error, and nothing is
  // recreated to "undo" a partially-completed cleanup -- same
  // philosophy as deleteBook's storage cleanup in Phase 8A.
  if (coverPaths.length > 0) {
    const { error: coverError } = await admin.storage.from("covers").remove(coverPaths);
    if (coverError) {
      console.error("deleteAccount: failed to remove orphaned cover files:", coverError);
    }
  }
  if (manuscriptPaths.length > 0) {
    const { error: manuscriptError } = await admin.storage
      .from("manuscripts")
      .remove(manuscriptPaths);
    if (manuscriptError) {
      console.error(
        "deleteAccount: failed to remove orphaned manuscript files:",
        manuscriptError,
      );
    }
  }
  if (profile?.avatar_path) {
    const { error: avatarError } = await admin.storage
      .from("avatars")
      .remove([profile.avatar_path]);
    if (avatarError) {
      console.error("deleteAccount: failed to remove orphaned avatar file:", avatarError);
    }
  }

  await supabase.auth.signOut();

  revalidatePath("/", "layout");
  redirect("/?account=deleted");
}
