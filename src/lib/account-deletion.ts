import { createAdminClient } from "@/lib/supabase/admin";
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
import { readFileVersionPaths } from "@/lib/book-file-versions";
import { readPendingChangesForBooks } from "@/lib/book-pending-changes";
import { readWaitingReadersForBooks, scheduleDeletedBooksCancelledEmails } from "@/lib/preorder-emails";

// DEL (Renato 11-18): the REAL deletion of an account, 30 days after the
// person asked (request_account_deletion, migration
// 20261118170000_account_deletion_grace.sql). Until this pass it ran
// inside the deleteAccount Server Action the moment someone pressed the
// button; it now runs from the daily job
// (src/app/api/internal/account-deletions/run/route.ts), as the service
// role, after account_deletion_claim() -- so every read below that used
// the person's own session (RLS: own rows) now names the account
// explicitly. Every safety rule of the old action is unchanged: reads
// fail closed before anything irreversible, stored paths are DATA (only
// this account's exact canonical keys are removed), deleteUser runs and
// is checked before any storage object is touched.
//
// Never import this from a "use server" file: an exported function there
// is a public endpoint.

type ServiceClient = ReturnType<typeof createAdminClient>;

export type AccountDeletionResult =
  | "deleted"
  | "staff"
  | "staff_check_failed"
  | "prepare_failed"
  | "has_buyers"
  | "delete_failed";

export async function deleteAccountNow(service: ServiceClient, userId: string): Promise<AccountDeletionResult> {
  // Staff never lose their account to the job: request_account_deletion
  // refuses staff, and someone made staff during the 30 days is skipped
  // (a failed lookup is not "not staff").
  const { data: staffRow, error: staffLookupError } = await service
    .from("staff_members")
    .select("role")
    .eq("user_id", userId)
    .maybeSingle();
  if (staffLookupError) {
    console.error("deleteAccount: staff status lookup failed; nothing was deleted");
    return "staff_check_failed";
  }
  if (staffRow) {
    return "staff";
  }

  // AVATAR-STORAGE-PATH-AUTH-1: the stored avatar_path is removed below
  // with the service-role client, which Storage RLS does not constrain,
  // and until migration 20260924160846 any signed-in user could write it
  // directly -- so it is DATA, never authority. A read failure stops here,
  // before anything irreversible, rather than guessing. A missing row
  // (maybeSingle: no error, no data) simply means there is no avatar to
  // clean up.
  const { data: profile, error: profileReadError } = await service
    .from("profiles")
    .select("avatar_path")
    .eq("id", userId)
    .maybeSingle();

  if (profileReadError) {
    console.error("deleteAccount: profile read failed:", profileReadError);
    return "prepare_failed";
  }

  // Only a value that is EXACTLY this user's own canonical avatar key
  // (src/lib/avatar-path.ts) is ever handed to the privileged remove.
  // Anything else -- empty, malformed, another user's key, a wrong bucket
  // or depth, traversal, encoding -- is skipped: the account is still
  // deleted, that one avatar cleanup is not attempted, and nothing
  // outside this user's own canonical key can be touched. The value
  // itself is not logged.
  const storedAvatarPath: unknown = profile?.avatar_path ?? null;
  const avatarPathToRemove = isOwnCanonicalAvatarPath(storedAvatarPath, userId)
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
  const { data: books, error: booksReadError } = await service
    .from("books")
    .select("id, cover_path, file_path")
    .eq("author_id", userId)
    .returns<{ id: string; cover_path: string | null; file_path: string | null }[]>();

  if (booksReadError || !Array.isArray(books)) {
    console.error("deleteAccount: authored books read failed; nothing was deleted");
    return "prepare_failed";
  }

  const authoredBooks = books;
  const bookIds = authoredBooks.map((b) => b.id);

  // PEN-NAMES-1: the account's pen name photos (avatars bucket, under a
  // random folder each -- src/lib/pen-name-photo-path.ts). Read with the
  // session client (RLS: own rows; the author_id filter keeps it to this
  // account) before anything irreversible, like the reads above; only a
  // value of exactly the canonical shape is removed below. The rows
  // themselves go with the account (on delete cascade).
  const { data: penNameRows, error: penNamesReadError } = await service
    .from("pen_names")
    .select("avatar_path")
    .eq("author_id", userId)
    .returns<{ avatar_path: string | null }[]>();

  if (penNamesReadError || !Array.isArray(penNameRows)) {
    console.error("deleteAccount: pen names read failed; nothing was deleted");
    return "prepare_failed";
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
    } else if (isOwnCanonicalAvatarPath(storedPhotoPath, userId)) {
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
    // DEL: the service role reads purchases itself (the
    // author_book_purchases view keys on auth.uid(), which a job has
    // not). A failed count is not "no buyers".
    const { count: acquisitionCount, error: acquisitionError } = await service
      .from("purchases")
      .select("id", { count: "exact", head: true })
      .in("book_id", bookIds);

    if (acquisitionError) {
      console.error("deleteAccount: purchases count failed; nothing was deleted");
      return "prepare_failed";
    }
    if ((acquisitionCount ?? 0) > 0) {
      return "has_buyers";
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
        isOwnCanonicalBookCoverPath(storedCoverPath, userId, book.id) ||
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
      if (isOwnBookManuscriptPath(storedManuscriptPath, userId, book.id)) {
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

  // R22 (I3): the readers waiting on this account's pre-orders ("Më
  // njofto"). Their rows go with the books, so they are read NOW, before
  // deleteUser; a failed read stops the deletion. They get the
  // "cancelled" email only once the account is gone (below).
  let waitingReaders = new Map<string, { title: string; userIds: string[] }>();
  if (bookIds.length > 0) {
    const waiting = await readWaitingReadersForBooks(service, bookIds);
    if (!waiting.ok) {
      console.error("deleteAccount: pre-order readers read failed; nothing was deleted");
      return "prepare_failed";
    }
    waitingReaders = waiting.byBook;
  }

  // ADMIN-3-REVIEW (N3, P5): a book's review history may name more of its
  // own manuscript keys (the last approved file kept for buyers, a stale
  // snapshot). They are read NOW, before deleteUser -- the cascade sets
  // the rows' book_id to null -- with the service-role client; a failed
  // read stops the deletion before anything is touched. Every key is
  // classified against this user and that book (own-key rule only).
  if (bookIds.length > 0) {
    const snapshots = await readReviewSnapshots(service, bookIds);
    if (!snapshots.ok) {
      console.error("deleteAccount: review snapshots read failed; nothing was deleted");
      return "prepare_failed";
    }
    // FV1 (fv5 a): the files that were once live go with the (unsold)
    // books. Read now, before deleteUser; a failed read stops the deletion.
    const versions = await readFileVersionPaths(service, bookIds);
    if (!versions.ok) {
      console.error("deleteAccount: file versions read failed; nothing was deleted");
      return "prepare_failed";
    }
    for (const book of authoredBooks) {
      for (const path of deletedBookManuscriptKeys({
        authorId: userId,
        bookId: book.id,
        currentFilePath: null,
        reviews: snapshots.byBook.get(book.id) ?? [],
        versionFilePaths: versions.byBook.get(book.id) ?? [],
      })) {
        manuscriptPaths.add(path);
      }
    }

    // BD15 P5b-3b (Renato 11-05, Q2 a): a live book's waiting changes
    // may name a manuscript and a ballinë nothing above does (never sent
    // for review). Read now, before deleteUser (the rows go with the
    // books); a failed read stops the deletion. The manuscript must be
    // this user's own key for that book; the ballinë a new random-folder
    // key, trusted because it came from this account's own book's row
    // (the same rule as the books' own covers above and deleteBook).
    const pending = await readPendingChangesForBooks(service, bookIds);
    if (!pending.ok) {
      console.error("deleteAccount: waiting changes read failed; nothing was deleted");
      return "prepare_failed";
    }
    for (const book of authoredBooks) {
      const waiting = pending.byBook.get(book.id);
      if (!waiting) continue;
      if (waiting.filePath !== null && isOwnBookManuscriptPath(waiting.filePath, userId, book.id)) {
        manuscriptPaths.add(waiting.filePath);
      }
      if (waiting.coverPath !== null && isNewBookCoverPath(waiting.coverPath)) {
        coverPaths.add(waiting.coverPath);
      }
    }
  }

  // The account/database row is authoritative -- storage cleanup is
  // secondary. deleteUser runs (and its result is checked) BEFORE any
  // storage object is removed, so a failure here -- including the race
  // where a purchase appears after the advisory check above and
  // purchases.book_id's ON DELETE RESTRICT blocks the cascade -- leaves
  // every file, every row, and the account itself untouched.
  const { error: deleteUserError } = await service.auth.admin.deleteUser(userId);

  if (deleteUserError) {
    console.error("deleteAccount: failed to delete auth user:", deleteUserError);
    return "delete_failed";
  }

  // R22 (I3): best effort, after the job has answered; never throws.
  scheduleDeletedBooksCancelledEmails("deleteAccount", waitingReaders);

  // The account is gone at this point -- from the user's perspective the
  // deletion already succeeded. Any failure past here is an orphaned
  // storage file to clean up later, not a failed account deletion, so
  // it's logged rather than surfaced as an error, and nothing is
  // recreated to "undo" a partially-completed cleanup -- same
  // philosophy as deleteBook's storage cleanup in Phase 8A.
  if (coverPaths.size > 0) {
    const { error: coverError } = await service.storage
      .from(BOOK_COVERS_BUCKET)
      .remove([...coverPaths]);
    if (coverError) {
      console.error("deleteAccount: failed to remove orphaned cover files:", coverError);
    }
  }
  if (manuscriptPaths.size > 0) {
    const { error: manuscriptError } = await service.storage
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
    const { error: avatarError } = await service.storage
      .from(AVATARS_BUCKET)
      .remove([avatarPathToRemove]);
    if (avatarError) {
      console.error("deleteAccount: failed to remove orphaned avatar file:", avatarError);
    }
  }
  if (penNamePhotoPaths.size > 0) {
    const { error: penNamePhotoError } = await service.storage
      .from(AVATARS_BUCKET)
      .remove([...penNamePhotoPaths]);
    if (penNamePhotoError) {
      console.error("deleteAccount: failed to remove orphaned pen name photos:", penNamePhotoError);
    }
  }

  return "deleted";
}

// The daily job's batch: every account whose 30 days are over. Each is
// claimed first (account_deletion_claim: from then on Restore is
// refused); at most `limit` are worked on per run, and the rest wait for
// the next day. Accounts the claim refuses (staff or suspended now, or
// another run working on them) are passed over without counting toward
// the limit, and accounts never tried come before ones that failed
// before (oldest attempt first), so accounts that can't be finished never
// keep the others waiting (AUDIT S1). A claimed account whose deletion
// failed stays claimed and is tried again the next day. Logs counts only,
// never an account id.
export const ACCOUNT_DELETIONS_PER_RUN = 20;
// How many due rows one run looks at, at most (each costs one claim
// call, inside the route's 60 s).
export const ACCOUNT_DELETIONS_SCAN_LIMIT = 100;

export type AccountDeletionRun =
  | { ok: false }
  | { ok: true; counts: Record<AccountDeletionResult | "not_claimed", number> };

export async function runDueAccountDeletions(
  service: ServiceClient,
  now: Date = new Date(),
  limit: number = ACCOUNT_DELETIONS_PER_RUN,
): Promise<AccountDeletionRun> {
  const { data, error } = await service
    .from("account_deletion_requests")
    .select("user_id")
    .lte("delete_after", now.toISOString())
    .order("processing_at", { ascending: true, nullsFirst: true })
    .order("delete_after", { ascending: true })
    .limit(ACCOUNT_DELETIONS_SCAN_LIMIT)
    .returns<{ user_id: string }[]>();
  if (error || !Array.isArray(data)) {
    console.error("account-deletions: the due list could not be read; nothing was deleted");
    return { ok: false };
  }

  const counts: Record<AccountDeletionResult | "not_claimed", number> = {
    deleted: 0,
    staff: 0,
    staff_check_failed: 0,
    prepare_failed: 0,
    has_buyers: 0,
    delete_failed: 0,
    not_claimed: 0,
  };

  let worked = 0;
  for (const row of data) {
    if (worked >= limit) break;
    const { data: claimed, error: claimError } = await service.rpc("account_deletion_claim", {
      p_user_id: row.user_id,
    });
    if (claimError || claimed !== true) {
      counts.not_claimed += 1;
      continue;
    }
    worked += 1;
    counts[await deleteAccountNow(service, row.user_id)] += 1;
  }

  const stuck = counts.staff + counts.staff_check_failed + counts.prepare_failed + counts.has_buyers + counts.delete_failed;
  if (stuck > 0) {
    console.error("account-deletions: some due accounts were not deleted", counts);
  }
  return { ok: true, counts };
}
