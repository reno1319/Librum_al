"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function deleteAccount(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
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
