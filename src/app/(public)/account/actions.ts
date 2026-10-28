"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { redirectIfRecoverySessionActive } from "@/lib/recovery-guard";
import { AVATARS_BUCKET, isOwnCanonicalAvatarPath } from "@/lib/avatar-path";
import { isPenNamePhotoPath } from "@/lib/pen-name-photo-path";
import {
  BOOK_COVERS_BUCKET,
  BOOK_MANUSCRIPTS_BUCKET,
  isNewBookCoverPath,
  isOwnCanonicalBookCoverPath,
  isOwnBookManuscriptPath,
} from "@/lib/book-storage-path";
import { deletedBookManuscriptKeys, readReviewSnapshots } from "@/lib/book-reviews";

const PREPARE_FAILED_PATH = `/account?error=${encodeURIComponent(
  "Nuk mundëm ta përgatisim fshirjen e llogarisë. Provoni përsëri.",
)}`;

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
    redirect(
      `/account?error=${encodeURIComponent(
        "Hiqeni këtë llogari nga stafi i Librum para se ta fshini.",
      )}`,
    );
  }

  const confirmation = String(formData.get("confirmation") ?? "");
  if (confirmation !== "FSHI") {
    redirect(`/account?error=${encodeURIComponent("Shkruani FSHI për ta konfirmuar.")}`);
  }

  // AVATAR-STORAGE-PATH-AUTH-1: the stored avatar_path is removed below
  // with the service-role client, which Storage RLS does not constrain,
  // and until migration 20260924160846 any signed-in user could write it
  // directly -- so it is DATA, never authority. A read failure stops here,
  // before anything irreversible, rather than guessing. A missing row
  // (maybeSingle: no error, no data) simply means there is no avatar to
  // clean up.
  const { data: profile, error: profileReadError } = await supabase
    .from("profiles")
    .select("avatar_path")
    .eq("id", user.id)
    .maybeSingle();

  if (profileReadError) {
    console.error("deleteAccount: profile read failed:", profileReadError);
    redirect(PREPARE_FAILED_PATH);
  }

  // Only a value that is EXACTLY this user's own canonical avatar key
  // (src/lib/avatar-path.ts) is ever handed to the privileged remove.
  // Anything else -- empty, malformed, another user's key, a wrong bucket
  // or depth, traversal, encoding -- is skipped: the account is still
  // deleted, that one avatar cleanup is not attempted, and nothing
  // outside this user's own canonical key can be touched. The value
  // itself is not logged.
  const storedAvatarPath: unknown = profile?.avatar_path ?? null;
  const avatarPathToRemove = isOwnCanonicalAvatarPath(storedAvatarPath, user.id)
    ? storedAvatarPath
    : null;
  if (storedAvatarPath !== null && avatarPathToRemove === null) {
    console.warn(
      "deleteAccount: stored avatar_path is not this user's canonical avatar key; avatar cleanup skipped",
    );
  }

  // ACCOUNT-DELETION-BOOK-STORAGE-AUTH-1: this read decides which
  // objects the service-role client removes below, so a failure stops
  // here, before anything irreversible, exactly like the profile read
  // above. An error is never trusted, even when rows came back with it,
  // and a result that is not a list is not "no books" either: only a
  // genuine, successful (possibly empty) list lets deletion go ahead.
  const { data: books, error: booksReadError } = await supabase
    .from("books")
    .select("id, cover_path, file_path")
    .eq("author_id", user.id)
    .returns<{ id: string; cover_path: string | null; file_path: string | null }[]>();

  if (booksReadError || !Array.isArray(books)) {
    console.error("deleteAccount: authored books read failed; nothing was deleted");
    redirect(PREPARE_FAILED_PATH);
  }

  const authoredBooks = books;
  const bookIds = authoredBooks.map((b) => b.id);

  // PEN-NAMES-1: the account's pen name photos (avatars bucket, under a
  // random folder each -- src/lib/pen-name-photo-path.ts). Read with the
  // session client (RLS: own rows; the author_id filter keeps it to this
  // account) before anything irreversible, like the reads above; only a
  // value of exactly the canonical shape is removed below. The rows
  // themselves go with the account (on delete cascade).
  const { data: penNameRows, error: penNamesReadError } = await supabase
    .from("pen_names")
    .select("avatar_path")
    .eq("author_id", user.id)
    .returns<{ avatar_path: string | null }[]>();

  if (penNamesReadError || !Array.isArray(penNameRows)) {
    console.error("deleteAccount: pen names read failed; nothing was deleted");
    redirect(PREPARE_FAILED_PATH);
  }

  // PEN-NAMES-1 r4 (17a): the migration copied the profile photo onto the
  // default pen name, so a pen name may hold this user's own canonical
  // avatar key ("<uid>/avatar.<ext>") -- the SAME object as
  // profiles.avatar_path. Every object is removed exactly once: a key
  // already removed as the profile avatar is not listed again here.
  const penNamePhotoPaths = new Set<string>();
  for (const row of penNameRows) {
    const storedPhotoPath: unknown = row.avatar_path;
    if (storedPhotoPath === null) continue;
    if (isPenNamePhotoPath(storedPhotoPath)) {
      penNamePhotoPaths.add(storedPhotoPath);
    } else if (isOwnCanonicalAvatarPath(storedPhotoPath, user.id)) {
      if (storedPhotoPath !== avatarPathToRemove) penNamePhotoPaths.add(storedPhotoPath);
    } else {
      console.warn("deleteAccount: a stored pen name photo path is not canonical; cleanup skipped");
    }
  }

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
    // PEN-NAMES-2 [23b]: counted through author_book_purchases (purchases
    // of the caller's own books; the base table no longer shows them).
    const { count: acquisitionCount } = await supabase
      .from("author_book_purchases")
      .select("id", { count: "exact", head: true })
      .in("book_id", bookIds);

    if ((acquisitionCount ?? 0) > 0) {
      redirect(
        `/account?error=${encodeURIComponent(
          "Llogaria juaj nuk mund të fshihet ndërsa lexuesit kanë libra që keni botuar. Hiqini librat nga publikimi nëse nuk doni më t'i shisni.",
        )}`,
      );
    }
  }

  // Stored cover_path/file_path values are DATA, never authority: they
  // are removed below with the service-role client, which Storage RLS
  // does not constrain, and a forged or legacy value could name another
  // author's cover or manuscript. Each one is therefore checked on its
  // own against the exact canonical keys built from the authenticated
  // user's id and THAT row's book id (src/lib/book-storage-path.ts).
  // Only an exact match is ever handed to the privileged remove; any
  // other non-null value is skipped (left as a possible orphan) without
  // being logged, and never stops the account deletion or the cleanup of
  // any other object. A null path has nothing to clean up.
  const coverPaths = new Set<string>();
  const manuscriptPaths = new Set<string>();
  let skippedCoverCount = 0;
  let skippedManuscriptCount = 0;
  for (const book of authoredBooks) {
    const storedCoverPath: unknown = book.cover_path;
    if (storedCoverPath !== null) {
      // PEN-2 (L10): a new random-folder key (`<uuid>/cover.<jpg|png>`)
      // is accepted too. It names no owner, so it is trusted only because
      // it came from this account's own books row, read above with the
      // author_id filter; the old canonical shape stays accepted until
      // the contract migration (C10) rules it out.
      if (
        isOwnCanonicalBookCoverPath(storedCoverPath, user.id, book.id) ||
        isNewBookCoverPath(storedCoverPath)
      ) {
        coverPaths.add(storedCoverPath);
      } else {
        skippedCoverCount += 1;
      }
    }
    const storedManuscriptPath: unknown = book.file_path;
    if (storedManuscriptPath !== null) {
      // ADMIN-3-REVIEW: the canonical key or a versioned one
      // (`<uid>/<book id>/<uuid>.epub`), both bound to this user and book.
      if (isOwnBookManuscriptPath(storedManuscriptPath, user.id, book.id)) {
        manuscriptPaths.add(storedManuscriptPath);
      } else {
        skippedManuscriptCount += 1;
      }
    }
  }
  if (skippedCoverCount > 0) {
    console.warn(
      "deleteAccount: stored book cover_path values that are not this user's canonical keys were skipped; count:",
      skippedCoverCount,
    );
  }
  if (skippedManuscriptCount > 0) {
    console.warn(
      "deleteAccount: stored book file_path values that are not this user's canonical keys were skipped; count:",
      skippedManuscriptCount,
    );
  }

  const admin = createAdminClient();

  // ADMIN-3-REVIEW (N3, P5): a book's review history may name more of its
  // own manuscript keys (the last approved file kept for buyers, a stale
  // snapshot). They are read NOW, before deleteUser -- the cascade sets
  // the rows' book_id to null -- with the service-role client; a failed
  // read stops the deletion before anything is touched. Every key is
  // classified against this user and that book (own-key rule only).
  if (bookIds.length > 0) {
    const snapshots = await readReviewSnapshots(admin, bookIds);
    if (!snapshots.ok) {
      console.error("deleteAccount: review snapshots read failed; nothing was deleted");
      redirect(PREPARE_FAILED_PATH);
    }
    for (const book of authoredBooks) {
      for (const path of deletedBookManuscriptKeys({
        authorId: user.id,
        bookId: book.id,
        currentFilePath: null,
        reviews: snapshots.byBook.get(book.id) ?? [],
      })) {
        manuscriptPaths.add(path);
      }
    }
  }

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
      `/account?error=${encodeURIComponent(
        "Diçka shkoi keq gjatë fshirjes së llogarisë. Provoni përsëri.",
      )}`,
    );
  }

  // The account is gone at this point -- from the user's perspective the
  // deletion already succeeded. Any failure past here is an orphaned
  // storage file to clean up later, not a failed account deletion, so
  // it's logged rather than surfaced as an error, and nothing is
  // recreated to "undo" a partially-completed cleanup -- same
  // philosophy as deleteBook's storage cleanup in Phase 8A.
  if (coverPaths.size > 0) {
    const { error: coverError } = await admin.storage
      .from(BOOK_COVERS_BUCKET)
      .remove([...coverPaths]);
    if (coverError) {
      console.error("deleteAccount: failed to remove orphaned cover files:", coverError);
    }
  }
  if (manuscriptPaths.size > 0) {
    const { error: manuscriptError } = await admin.storage
      .from(BOOK_MANUSCRIPTS_BUCKET)
      .remove([...manuscriptPaths]);
    if (manuscriptError) {
      console.error(
        "deleteAccount: failed to remove orphaned manuscript files:",
        manuscriptError,
      );
    }
  }
  if (avatarPathToRemove !== null) {
    const { error: avatarError } = await admin.storage
      .from(AVATARS_BUCKET)
      .remove([avatarPathToRemove]);
    if (avatarError) {
      console.error("deleteAccount: failed to remove orphaned avatar file:", avatarError);
    }
  }
  if (penNamePhotoPaths.size > 0) {
    const { error: penNamePhotoError } = await admin.storage
      .from(AVATARS_BUCKET)
      .remove([...penNamePhotoPaths]);
    if (penNamePhotoError) {
      console.error("deleteAccount: failed to remove orphaned pen name photos:", penNamePhotoError);
    }
  }

  await supabase.auth.signOut();

  revalidatePath("/", "layout");
  redirect("/?account=deleted");
}
