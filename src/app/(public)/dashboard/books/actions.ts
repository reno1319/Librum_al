"use server";

import { PD_FROZEN_MESSAGE } from "@/lib/pd-editions";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createCatalogWriteClient } from "@/lib/catalog-write-client";
import { sendNewBookEmails } from "@/lib/email";
import { sendReviewRequestedStaffEmail } from "@/lib/staff-alerts";
import { detectCoverImageKind, resolveVerifiedCoverStorageDetails } from "@/lib/cover-image";
import {
  BOOK_COVER_SIZE,
  EBOOK_COVER_SIZE,
  IMAGE_CACHE_CONTROL_SECONDS,
  shrinkImageToJpeg,
} from "@/lib/cover-resize";
import { LIBRUM_MADE_EBOOK_METADATA, readLibrumMadeMarker, syncCoverIntoLibrumEbook } from "@/lib/ebook-cover-sync";
import { withEbookCoverWarning } from "@/lib/ebook-cover-notice";
import { readLibrumEbookCover, restampLibrumEpubMetadata } from "@/lib/epub-cover";
import { validateEpubStructure, type EpubValidationResult } from "@/lib/epub-validation";
import { redirectIfRecoverySessionActive } from "@/lib/recovery-guard";
import { resolveMaintenanceMode } from "@/lib/maintenance-mode";
import { canPublishPaidTitle } from "@/lib/paid-readiness";
import { checkPublishGate } from "@/lib/publish-readiness";
import { INVALID_ISBN_MESSAGE, isValidIsbn } from "@/lib/book-identifiers";
import { parseAiAnswer, readAiDisclosure, writeAiDisclosure } from "@/lib/book-ai-disclosure";
import { missingDetails } from "@/lib/book-details";
import {
  EBOOK_RESTAMP_FAILED_MESSAGE,
  PRICE_FIELD,
  PRICE_INVALID_MESSAGE,
  PRICE_MODE_FIELD,
  PRICE_MODE_MISSING_MESSAGE,
  SEND_CONFIRMATION_NOT_SAVED_MESSAGE,
  SEND_INCOMPLETE_MESSAGE,
  SEND_TICKS_MISSING_MESSAGE,
  hasSendTicks,
  isFreeOnlyRightsBasis,
  parsePriceMode,
  resolvePricingSubmission,
} from "@/lib/book-pricing";
import {
  AI_NOT_SAVED_MESSAGE,
  CONTENT_SAVED_MESSAGE,
  CHANGES_SENT_MESSAGE,
  DETAILS_SAVED_MESSAGE,
  LIVE_ADULT_CATEGORY_MESSAGE,
  LIVE_NOT_LIVE_MESSAGE,
  LIVE_REVIEW_CANCELLED_MESSAGE,
  LIVE_SAVED_MESSAGE,
  LIVE_SAVED_PENDING_MESSAGE,
  NO_CHANGES_TO_SEND_MESSAGE,
  UNPUBLISHED_MESSAGE,
  BOOK_DELETED_MESSAGE,
  LIVE_DELETE_REFUSED_MESSAGE,
  editorPath,
} from "@/lib/book-editor-copy";
import {
  changedPendingFields,
  readPendingChanges,
  savePendingChanges,
  type PendingChanges,
} from "@/lib/book-pending-changes";
import { getRightsDeclarationState, recordRightsDeclaration } from "@/lib/book-rights";
import type { RightsBasis } from "@/lib/types";
import { getActiveTakedownState } from "@/lib/book-takedowns";
import { TAKEN_DOWN_DELETE_MESSAGE, TAKEN_DOWN_PUBLISH_MESSAGE } from "@/lib/takedown-reasons";
import {
  CATALOG_ROW_CHANGED_MESSAGE,
  PAID_REPRICING_UNAVAILABLE_MESSAGE,
  applyCatalogRowGuard,
  isExactlyOneRowWritten,
  resolvePriceUpdateAuthorization,
} from "@/lib/paid-repricing";
import { redirectForMaintenance } from "@/lib/maintenance-response";
import { isSchemaFeatureOffError, logSchemaFeatureOffOnce } from "@/lib/schema-feature-off";
import {
  BOOK_COVERS_BUCKET,
  BOOK_MANUSCRIPTS_BUCKET,
  classifyBookCoverPath,
  groupBookStorageRemovals,
  isOwnBookManuscriptPath,
  isOwnTemporaryCoverUploadPath,
  isOwnTemporaryManuscriptUploadPath,
  isOwnVersionedBookManuscriptPath,
  isNewBookCoverPath,
  newBookCoverPath,
  newBookManuscriptPath,
  type BookStorageRemoval,
} from "@/lib/book-storage-path";
import {
  deletedBookManuscriptKeys,
  getBookReviewState,
  isInReviewLockError,
  isWaitingForReview,
  readReviewSnapshots,
  removeUnretainedManuscripts,
  requestBookReview,
  withdrawBookReview,
} from "@/lib/book-reviews";
import {
  ALREADY_IN_REVIEW_MESSAGE,
  BOOK_CHANGED_WHILE_EDITING_MESSAGE,
  IN_REVIEW_LOCKED_MESSAGE,
  NOT_IN_REVIEW_MESSAGE,
  REVIEW_CANCELLED_MESSAGE,
  SENT_FOR_REVIEW_MESSAGE,
} from "@/lib/book-review-copy";
import {
} from "@/lib/catalog-price";
import {
  isLivePriceChange,
  isPriceChangeConfirmed,
  PRICE_CHANGE_CONFIRM_MESSAGE,
} from "@/lib/price-change-confirm";
import { getPreorderSchemaFeature } from "@/lib/catalog-schema-features";
import {
  CANCEL_PREORDER_CONFIRM_FIELD,
  CANCEL_PREORDER_CONFIRM_MISSING_MESSAGE,
  PREORDER_CANCELLED_MESSAGE,
  PREORDER_DATE_INVALID_MESSAGE,
  PREORDER_NOT_AVAILABLE_MESSAGE,
  PREORDER_NOT_PREORDER_MESSAGE,
  PREORDER_REVIEW_CANCELLED_MESSAGE,
  PREORDER_SENT_MESSAGE,
  PREORDER_UNPUBLISH_REFUSED_MESSAGE,
  PREORDER_DELETE_NOTE,
  PREORDER_PUBLIC_DOMAIN_NOTE,
  PREORDER_PUBLISHED_BEFORE_NOTE,
  PREORDER_USED_UP_NOTE,
  PUSH_DONE_MESSAGE,
  PUSH_INVALID_MESSAGE,
  PUSH_REFUSED_MESSAGE,
  RELEASE_DATE_FIELD,
  isInPreorderWindow,
  isValidPushDate,
  parseDay,
  parseReleaseChoice,
  preorderBlock,
  tiranaToday,
} from "@/lib/preorders";

// B6: the follower emails go out after the page has answered (Next's
// after()), so a long follower list can't slow down or time out Publish.
// Best effort, as before: a failure -- scheduling or sending -- is only
// logged, never rethrown, so it can never turn a committed publish into
// a reported failure. It still runs when the action ends in redirect().
function sendNewBookEmailsAfterResponse(caller: string, ids: { bookId: string; authorId: string }) {
  const logFailure = (error: unknown) =>
    console.error(`${caller}: sendNewBookEmails failed after a successful publish`, { ...ids, error });
  try {
    const admin = createAdminClient();
    after(async () => {
      try {
        await sendNewBookEmails(admin, ids);
      } catch (error) {
        logFailure(error);
      }
    });
  } catch (error) {
    logFailure(error);
  }
}

// ALL-WIRING-2: one message for every rejected catalog price, built
// from the module's own constants so it can never drift from the rule
// it describes. Deliberately states the whole accepted domain rather
// than diagnosing which part of the input failed -- an author who typed
// "9.99" needs to learn the shape of a Librum price, not that character
// four was unexpected.
const MISSING_ALL_PRICE_MESSAGE =
  "Vendosni çmimin e librit në lekë para se ta publikoni.";

const MISSING_DESCRIPTION_SHORT_MESSAGE = "Shtoni një përshkrim para publikimit.";

// F4 (P4): Renato's rule, a rights choice before Publish.
const MISSING_RIGHTS_MESSAGE = "Zgjidhni të drejtat para publikimit.";
// BD15 P2: a draft from the new editor without its manuscript or cover.
const MISSING_FILES_MESSAGE = "Shtoni dorëshkrimin dhe ballinën para se ta dërgoni për shqyrtim.";

// F4 (D3): the existing generic refusal, also used when the rights
// choice cannot be read at all (before the migration, or a read error).
const PUBLISH_NOT_POSSIBLE_YET_QUERY =
  encodeURIComponent(
    "Libri juaj nuk u publikua dot ende. Provoni përsëri nga paneli juaj",
  );

// BD15 P4: the two existing publish sentences, named for saveBookPricing.
const BOOK_PUBLISHED_MESSAGE = "Libri juaj u publikua";
const PAID_PUBLISHING_UNAVAILABLE_MESSAGE = "Publikimi me pagesë nuk është i mundur tani";

const MAX_COVER_BYTES = 5 * 1024 * 1024;
const MAX_MANUSCRIPT_BYTES = 50 * 1024 * 1024;

// LIBRUM 2.0 PUBLISHING-UX-1 PART B: mirrors migration 044's own CHECK
// constraint exactly (see that migration's comment) -- a value that
// passes this can never fail at the database layer.
const PUBLISHER_MAX_LENGTH = 200;

// LIBRUM 2.0 PUBLISHING-UX-1 PART B FINAL PRE-COMMIT ROLLOUT-
// COMPATIBILITY CORRECTION: every one of the three resolvers below now
// reports `present` (formData.has(fieldName), never inferred from
// formData.get()'s own result) alongside the normalized `value` --
// same shape as this file's own pre-existing ResolvedManuscript/
// ResolvedCover types: a form that doesn't submit a field must never
// wipe a value already saved, which formData.get()-only absent/empty
// conflation would silently do. BD15 cleanup: saveBookContent (the
// publisher field) is the one caller left.
type ResolvedOptionalText = { present: boolean; value: string | null };

// BD15 P3: a message joined onto a path. The new editor's paths already
// carry "?tab=...", so the message is joined with "&" there; every older
// path (no "?") gets exactly "?error=" as before. The same helper as
// editor-actions.ts (page-messages.sources.test.ts reads its calls).
function withQuery(path: string, key: "error" | "success", message: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(message)}`;
}

// Shared trim/empty-becomes-null/length-bound normalization for
// subtitle, publisher, and edition -- all three are optional free text
// with the exact same shape. Mirrors migration 044's own CHECK
// constraints exactly (see that migration's comment for why
// 300/200/100), so a value that passes here can never fail at the
// database layer -- an over-limit value is a controlled, author-facing
// rejection here instead.
function resolveBoundedOptionalText(
  formData: FormData,
  fieldName: string,
  maxLength: number,
  fieldLabel: string,
  errorPath: string,
): ResolvedOptionalText {
  const present = formData.has(fieldName);
  const value = String(formData.get(fieldName) ?? "").trim();
  if (!value) return { present, value: null };
  if (value.length > maxLength) {
    // ALBANIAN-9: encoded like every other redirect message in this
    // file now; fieldLabel is always one of this file's own hardcoded
    // call-site labels ("Nëntitulli"/"Botuesi"/"Botimi"), never user input.
    redirect(
      withQuery(errorPath, "error", `${fieldLabel} mund të ketë deri në ${maxLength} karaktere`),
    );
  }
  return { present, value };
}

// LIBRUM 2.0 PRODUCT-5 CB-1: a manuscript can arrive two ways --
//   A. a plain File in FormData (a small direct upload, or any other
//      future caller that still posts one this way), or
//   B. "manuscriptStoragePath", a small reference to an EPUB the
//      browser ALREADY uploaded directly to the private "manuscripts"
//      bucket's own "<uid>/tmp/epub/<uuid>.epub" namespace (see
//      manuscript-field.tsx) -- used for every manuscript the Studio's
//      own UI submits now, generated-from-DOCX or directly-uploaded
//      EPUB alike, so neither can ever need to cross this Server
//      Action's own request body (Vercel's ~4.5MB ceiling) again.
// Both are normalized into the same validated bytes here, once, before
// saveBookContent()'s own business rules ever see a difference.
//
// The temp-path branch never trusts the path's OWNERSHIP OR its own
// ".epub" extension as proof of anything: ownership is re-checked
// against the CALLING user's own id (RLS enforces the same boundary
// at the database level, this is defense in depth, not the only
// guard), and the extension is "only a routing guard, not proof of
// EPUB validity" -- validateEpubStructure() below is what actually
// proves that, for bytes from EITHER source, exactly as it always has
// for a directly-uploaded EPUB.
type ResolvedManuscript =
  | { present: false }
  | { present: true; bytes: Buffer; tempPathToCleanup: string | null };

// LIBRUM 2.0 EPUB-VALIDATION-1B: the redirect-query fragment for each
// validateEpubStructure() rejection reason. The pre-existing generic
// fallback string is kept byte-for-byte identical to what every
// rejection redirected to before this pass (a hardcoded, already-"+"-
// encoded literal, matching this file's own established convention
// for redirect messages elsewhere) -- every reason this validator
// already had before EPUB-VALIDATION-1B still falls through to it
// unchanged. The two genuinely new, more specific messages use
// encodeURIComponent() instead, matching this file's own existing
// precedent for a dynamic-content message -- never exposing a ZIP-parser error, a
// stack trace, or an archive path either way.
function epubValidationErrorMessage(
  reason: Extract<EpubValidationResult, { valid: false }>["reason"],
): string {
  switch (reason) {
    case "too_many_entries":
    case "too_large_uncompressed":
    case "entry_too_large":
      return "EPUB-i është shumë i madh ose ka shumë skedarë.";
    case "encrypted_or_drm":
      return "Ky EPUB përdor enkriptim/DRM që Librum nuk e mbështet.";
    default:
      return "Ky skedar nuk duket si EPUB i vlefshëm";
  }
}

async function resolveManuscriptInput(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  formData: FormData,
  errorPath: string,
  // LIBRUM 2.0 EPUB-VALIDATION-1B: optional -- the caller's own bookId
  // when it has one (saveBookContent passes it). Used only for the safe
  // diagnostic log below on a rejection; never affects validation or storage
  // behavior.
  bookId?: string,
): Promise<ResolvedManuscript> {
  const tempPath = String(formData.get("manuscriptStoragePath") ?? "").trim();

  let bytes: Buffer;
  let tempPathToCleanup: string | null = null;

  if (tempPath) {
    // BOOK-STORAGE-MUTATION-AUTH-1: the exact temporary-key shape under
    // the caller's own id (src/lib/book-storage-path.ts), not a prefix --
    // this same value is later handed to remove().
    if (!isOwnTemporaryManuscriptUploadPath(tempPath, userId)) {
      redirect(
        withQuery(errorPath, "error", "Dorëshkrimi i zgjedhur nuk vlen më. Zgjidhni skedarin përsëri"),
      );
    }

    const { data, error: downloadError } = await supabase.storage
      .from("manuscripts")
      .download(tempPath);
    if (downloadError || !data) {
      console.error("resolveManuscriptInput: temp manuscript download failed:", downloadError);
      redirect(withQuery(errorPath, "error", "Dorëshkrimi i ngarkuar ka skaduar ose nuk u lexua dot. Zgjidhni skedarin përsëri"));
    }

    bytes = Buffer.from(await data!.arrayBuffer());
    tempPathToCleanup = tempPath;
  } else {
    const manuscript = formData.get("manuscript") as File | null;
    if (!manuscript || manuscript.size === 0) {
      return { present: false };
    }
    if (!manuscript.name.toLowerCase().endsWith(".epub")) {
      redirect(withQuery(errorPath, "error", "Dorëshkrimi duhet të jetë skedar EPUB"));
    }
    bytes = Buffer.from(await manuscript.arrayBuffer());
  }

  // Defense in depth -- never trust client-side File.size (or the
  // browser's own pre-upload check) alone for bytes that came back
  // from a temp Storage download.
  if (bytes.length > MAX_MANUSCRIPT_BYTES) {
    redirect(withQuery(errorPath, "error", "Dorëshkrimi duhet të jetë nën 50 MB"));
  }

  const manuscriptValidation = await validateEpubStructure(bytes);
  if (!manuscriptValidation.valid) {
    // LIBRUM 2.0 EPUB-VALIDATION-1B: the EPUB-VALIDATION-1A audit found
    // this rejection path never logged WHICH reason fired (unlike the
    // DOCX-generated-EPUB validation failure in docx-actions.ts, which
    // already did) -- closed here. Safe diagnostics only: userId,
    // bookId if known, the validation reason, and the compressed byte
    // size actually uploaded. Never the manuscript's own bytes/content,
    // never an archive path, never a raw ZIP/XML parser error.
    console.error("resolveManuscriptInput: EPUB validation failed", {
      userId,
      ...(bookId ? { bookId } : {}),
      reason: manuscriptValidation.reason,
      compressedBytes: bytes.length,
    });
    redirect(withQuery(errorPath, "error", epubValidationErrorMessage(manuscriptValidation.reason)));
  }

  return { present: true, bytes, tempPathToCleanup };
}

// LIBRUM 2.0 PRODUCT-5 COVER-1: the same normalization pattern as
// resolveManuscriptInput() above, for covers. A cover between ~4.5MB
// and the app's own advertised 5MB limit could 413 through the old
// File-in-FormData path (Vercel's own request-body ceiling is BELOW
// the app's limit) -- covers now travel the same way manuscripts do:
// direct browser->Storage upload (see cover-field.tsx), this Server
// Action receiving only a small "coverStoragePath" reference.
//
// Deliberately staged in the PRIVATE "manuscripts" bucket, NOT the
// public "covers" bucket -- audited directly in schema.sql before
// writing this: "covers" is a genuinely PUBLIC bucket (its own
// `select` RLS policy has no owner restriction at all, unlike
// "manuscripts"). Staging an unvalidated, not-yet-saved cover there
// would make it publicly addressable before this action ever confirms
// it's even a real JPEG/PNG under the size limit -- an exposure this
// correction's own brief explicitly asked to avoid, not ignore.
// "manuscripts" already has private, owner-scoped RLS on every
// operation (insert/select/update/delete), so it's reused here as a
// general private staging area, not something cover-specific.
type ResolvedCover =
  | { present: false }
  | {
      present: true;
      bytes: Buffer;
      // W7 (4b): the verified original upload, kept only for the sharper
      // copy put inside a Librum-made ebook (ebookCoverJpeg below). Never
      // stored as uploaded.
      originalBytes: Buffer;
      extension: "jpg" | "png";
      contentType: "image/jpeg" | "image/png";
      tempPathToCleanup: string | null;
    };

async function resolveCoverInput(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  formData: FormData,
  errorPath: string,
): Promise<ResolvedCover> {
  const tempPath = String(formData.get("coverStoragePath") ?? "").trim();

  let bytes: Buffer;
  let tempPathToCleanup: string | null = null;

  if (tempPath) {
    // BOOK-STORAGE-MUTATION-AUTH-1: exact temporary-key shape, as for
    // the manuscript above.
    if (!isOwnTemporaryCoverUploadPath(tempPath, userId)) {
      redirect(withQuery(errorPath, "error", "Ballina e zgjedhur nuk vlen më. Zgjidhni skedarin përsëri"));
    }

    const { data, error: downloadError } = await supabase.storage
      .from("manuscripts")
      .download(tempPath);
    if (downloadError || !data) {
      console.error("resolveCoverInput: temp cover download failed:", downloadError);
      redirect(withQuery(errorPath, "error", "Ballina e ngarkuar ka skaduar ose nuk u lexua dot. Zgjidhni skedarin përsëri"));
    }

    bytes = Buffer.from(await data!.arrayBuffer());
    tempPathToCleanup = tempPath;
  } else {
    const cover = formData.get("cover") as File | null;
    if (!cover || cover.size === 0) {
      return { present: false };
    }
    bytes = Buffer.from(await cover.arrayBuffer());
  }

  // Defense in depth -- never trust client-side File.size (or the
  // browser's own pre-upload check) alone for bytes that came back
  // from a temp Storage download.
  if (bytes.length > MAX_COVER_BYTES) {
    redirect(withQuery(errorPath, "error", "Imazhi i ballinës duhet të jetë nën 5 MB"));
  }

  // The SAME authoritative byte-signature check every cover has always
  // gone through (src/lib/cover-image.ts) -- a temp path's own
  // ".jpg"/".png" extension is only a routing guard above, never proof
  // of real format. Node's own File supports slice().arrayBuffer()
  // (confirmed directly, not assumed) so detectCoverImageKind() needs
  // no changes at all to accept bytes from either source.
  const coverFile = new File([new Uint8Array(bytes)], "cover", { type: "application/octet-stream" });
  const coverKind = await detectCoverImageKind(coverFile);
  if (!coverKind) {
    redirect(withQuery(errorPath, "error", "Ky nuk duket si imazh i vlefshëm JPEG ose PNG"));
  }
  // COVERS-1: the signature check above still gates what gets decoded;
  // the stored cover is always the shrunk JPEG, never the raw upload.
  const shrunk = await shrinkImageToJpeg(bytes, BOOK_COVER_SIZE);
  if (!shrunk) {
    redirect(withQuery(errorPath, "error", "Ballina e ngarkuar nuk u lexua dot. Provoni përsëri"));
  }
  const { extension, contentType } = resolveVerifiedCoverStorageDetails("jpeg");

  return { present: true, bytes: shrunk!, originalBytes: bytes, extension, contentType, tempPathToCleanup };
}

// W7 (4b): the cover put inside a Librum-made ebook -- 1600px wide from
// the original upload, or the stored 800px cover if that resize fails.
async function ebookCoverJpeg(cover: Extract<ResolvedCover, { present: true }>): Promise<Buffer> {
  return (await shrinkImageToJpeg(cover.originalBytes, EBOOK_COVER_SIZE)) ?? cover.bytes;
}

// W7 (3a): the book's byline (its pen name, src/lib/book-byline.ts), for
// dc:creator inside a Librum-made ebook. null keeps the ebook's own value.
// r2 (audit minor): the author's OWN pen_names row (RLS + author filter),
// not public_pen_names, which hides a pen name no book uses yet.
async function readPenNameForEbook(
  client: Awaited<ReturnType<typeof createClient>>,
  authorId: string,
  penNameId: string | null,
): Promise<string | null> {
  if (!penNameId) return null;
  const { data, error } = await client
    .from("pen_names")
    .select("name")
    .eq("id", penNameId)
    .eq("author_id", authorId)
    .maybeSingle();
  if (error || !data) return null;
  const name = (data as { name?: unknown }).name;
  return typeof name === "string" && name.trim() !== "" ? name : null;
}

// W7 r2 (Q1 b-lite): a post-save redirect, with the one-line note added
// when the cover could not be put inside a Librum-made ebook.
function redirectAfterSave(ebookCoverWarning: boolean, url: string): never {
  redirect(withEbookCoverWarning(url, ebookCoverWarning));
}

// W7: a stored object's bytes, or null. Callers pass only keys already
// proven to be this author's own for this book.
async function downloadStoredBytes(
  client: ReturnType<typeof createCatalogWriteClient>,
  bucket: typeof BOOK_COVERS_BUCKET | typeof BOOK_MANUSCRIPTS_BUCKET,
  path: string,
): Promise<Buffer | null> {
  try {
    const { data, error } = await client.storage.from(bucket).download(path);
    if (error || !data) return null;
    return Buffer.from(await data.arrayBuffer());
  } catch {
    return null;
  }
}

// BOOK-STORAGE-MUTATION-AUTH-1: the one place saveBookContent and
// deleteBook hand stored or temporary keys to Storage for removal.
// Every candidate must already be proven by src/lib/book-storage-path.ts
// for the signed-in author (and, for a permanent key, the exact book);
// the candidates are de-duplicated and removed with at most one call per
// bucket and client: the author's own temporary uploads ("<uid>/tmp/...",
// manuscripts bucket) on the author's own session, every permanent key
// with the trusted catalog writer -- covers since PEN-2 (C9: no user
// write policy is left on covers), final manuscripts since ADMIN-3 (M1:
// authors may write and delete only under their own "<uid>/tmp/"). A
// failure is an orphaned object, never a failed save or deletion, so it
// is logged -- caller, bucket and object count only, never a key or the
// Storage error -- and never surfaced.
function isTemporaryUploadKey(path: string): boolean {
  return path.split("/")[1] === "tmp";
}

async function removeProvenBookStorageObjects(
  supabase: Awaited<ReturnType<typeof createClient>>,
  removals: readonly BookStorageRemoval[],
  caller: string,
): Promise<void> {
  for (const [bucket, paths] of groupBookStorageRemovals(removals)) {
    const onSession = bucket === BOOK_MANUSCRIPTS_BUCKET ? paths.filter(isTemporaryUploadKey) : [];
    const onWriter = paths.filter((path) => !onSession.includes(path));
    for (const [client, group] of [
      [supabase, onSession],
      [onWriter.length > 0 ? createCatalogWriteClient() : null, onWriter],
    ] as const) {
      if (client === null || group.length === 0) continue;
      const { error } = await client.storage.from(bucket).remove(group);
      if (error) {
        // Deliberately NOT the Storage error object, nor its message,
        // details, cause or response: any of them may echo a key.
        console.error(`${caller}: failed to remove superseded storage objects`, {
          bucket,
          objectCount: group.length,
        });
      }
    }
  }
}

// ADMIN-3-REVIEW: the manuscript twin of removeNewCoverUpload below -- a
// manuscript this request itself just uploaded under a fresh versioned
// key, when the row write that would have referenced it failed or lost
// its compare-and-set. Re-checked for that exact own shape. Logged
// without the key or the Storage error.
async function removeNewManuscriptUpload(
  writer: ReturnType<typeof createCatalogWriteClient>,
  path: string,
  authorId: string,
  bookId: string,
  caller: string,
): Promise<void> {
  if (!isOwnVersionedBookManuscriptPath(path, authorId, bookId)) {
    return;
  }
  const { error } = await writer.storage.from(BOOK_MANUSCRIPTS_BUCKET).remove([path]);
  if (error) {
    console.error(`${caller}: failed to remove an unreferenced new manuscript upload`, { objectCount: 1 });
  }
}

// PEN-2 (L10): removes a cover this request itself just uploaded under a
// fresh random key, when the row write that would have referenced it
// failed or lost its compare-and-set. The key was built by
// newBookCoverPath in this same request, so nothing else can reference
// it; it is re-checked for that exact shape anyway. Logged without the
// key or the Storage error.
async function removeNewCoverUpload(
  writer: ReturnType<typeof createCatalogWriteClient>,
  path: string,
  caller: string,
): Promise<void> {
  if (!isNewBookCoverPath(path)) {
    return;
  }
  const { error } = await writer.storage.from(BOOK_COVERS_BUCKET).remove([path]);
  if (error) {
    console.error(`${caller}: failed to remove an unreferenced new cover upload`, { objectCount: 1 });
  }
}

// BOOK-STORAGE-MUTATION-AUTH-1: a temporary upload key is removed only
// when it still has the exact temporary shape under the caller's own id
// (resolveCoverInput/resolveManuscriptInput already refused anything
// else before downloading it; this re-proves it at the removal site).
function temporaryUploadRemovals(
  userId: string,
  tempManuscriptPath: string | null,
  tempCoverPath: string | null,
): BookStorageRemoval[] {
  const removals: BookStorageRemoval[] = [];
  if (tempManuscriptPath && isOwnTemporaryManuscriptUploadPath(tempManuscriptPath, userId)) {
    removals.push({ bucket: BOOK_MANUSCRIPTS_BUCKET, path: tempManuscriptPath });
  }
  if (tempCoverPath && isOwnTemporaryCoverUploadPath(tempCoverPath, userId)) {
    removals.push({ bucket: BOOK_MANUSCRIPTS_BUCKET, path: tempCoverPath });
  }
  return removals;
}

// W7: a Librum-made (Word) ebook carries the cover inside it (1a), with
// the saved title and pen name (3a); used by saveBookContent (BD15 P3,
// moved here unchanged from the old edit page's updateBook). Adds to or
// rewrites uploadsBeforeWrite; returns whether the one-line warning is due and
// the fresh manuscript key it added for a cover-only change (else null).
type PendingUpload = {
  bucket: typeof BOOK_COVERS_BUCKET | typeof BOOK_MANUSCRIPTS_BUCKET;
  path: string;
  bytes: Buffer;
  contentType: string;
  kind: "cover" | "manuscript";
  // W7 r2 (R2): the Librum-made marker on a Librum-made ebook.
  metadata?: Record<string, string>;
};

async function syncLibrumEbookCover({
  supabase,
  catalogWriter,
  userId,
  existing,
  coverResult,
  title,
  penNameId,
  uploadsBeforeWrite,
  caller,
}: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  catalogWriter: ReturnType<typeof createCatalogWriteClient>;
  userId: string;
  existing: { id: string; file_path: string | null; cover_path: string | null; pen_name_id?: string | null };
  coverResult: ResolvedCover;
  title: string;
  penNameId: string | null;
  uploadsBeforeWrite: PendingUpload[];
  caller: string;
}): Promise<{ ebookCoverWarning: boolean; newManuscriptPath: string | null }> {
  // Directly uploaded ebooks are never
  // touched (2a), and a failed swap never fails the save: the ebook is
  // then stored as it was, the reason is logged and the success message
  // gets one more line (Q1 b-lite).
  //   - A new ebook in this save: the new cover goes in; without one, the
  //     sharp cover already inside the current ebook is carried over (4b)
  //     -- read only when Storage marks that ebook Librum-made (R2) --
  //     else the stored site cover, re-encoded as a 1600px JPEG (R1).
  //   - Only a new cover: Storage is asked (info(), no download) whether
  //     Librum made the current ebook (R2). Only then is it downloaded and
  //     rewritten to a FRESH versioned key, exactly like an uploaded
  //     replacement -- the same compare-and-set on file_path, the same
  //     review and retention rules (buyers keep the last approved file
  //     until Librum approves this one). The shape check runs again on the
  //     downloaded bytes. No marker (every ebook stored before W7, 5a) or
  //     an unreadable marker: no swap. The cover change already takes a
  //     live book to review.
  let ebookCoverWarning = false;
  let newManuscriptPath: string | null = null;
  const ownStoredManuscript =
    existing.file_path !== null && isOwnBookManuscriptPath(existing.file_path, userId, existing.id)
      ? existing.file_path
      : null;
  const ebookPenNameId = penNameId ?? existing.pen_name_id ?? null;
  const getEbookAuthorName = () => readPenNameForEbook(supabase, userId, ebookPenNameId);
  const pendingManuscriptUpload = uploadsBeforeWrite.find((upload) => upload.kind === "manuscript");
  if (pendingManuscriptUpload) {
    const sync = await syncCoverIntoLibrumEbook(pendingManuscriptUpload.bytes, {
      getCoverJpeg: async () => {
        if (coverResult.present) return ebookCoverJpeg(coverResult);
        if (ownStoredManuscript !== null && (await readLibrumMadeMarker(catalogWriter.storage, ownStoredManuscript)) === "yes") {
          const current = await downloadStoredBytes(catalogWriter, BOOK_MANUSCRIPTS_BUCKET, ownStoredManuscript);
          const carried = current ? await readLibrumEbookCover(current) : null;
          if (carried) return carried;
        }
        if (
          existing.cover_path !== null &&
          classifyBookCoverPath(existing.cover_path, userId, existing.id) !== "unsafe"
        ) {
          const stored = await downloadStoredBytes(catalogWriter, BOOK_COVERS_BUCKET, existing.cover_path);
          // R1: a stored cover may be a PNG; the ebook needs a JPEG.
          return stored ? shrinkImageToJpeg(stored, EBOOK_COVER_SIZE) : null;
        }
        return null;
      },
      title,
      getAuthorName: getEbookAuthorName,
      maxBytes: MAX_MANUSCRIPT_BYTES,
      caller,
      bookId: existing.id,
    });
    if (sync.kind === "embedded") pendingManuscriptUpload.bytes = sync.bytes;
    if (sync.kind !== "not_librum_made") pendingManuscriptUpload.metadata = { ...LIBRUM_MADE_EBOOK_METADATA };
    ebookCoverWarning = sync.kind === "skipped";
  } else if (coverResult.present && ownStoredManuscript !== null) {
    const marker = await readLibrumMadeMarker(catalogWriter.storage, ownStoredManuscript);
    if (marker === "unknown") {
      console.error(`${caller}: could not check whether Librum made the current ebook; cover not put inside it`, {
        bookId: existing.id,
      });
    }
    if (marker === "yes") {
      const current = await downloadStoredBytes(catalogWriter, BOOK_MANUSCRIPTS_BUCKET, ownStoredManuscript);
      if (current === null) {
        console.error(`${caller}: current ebook not read; cover not put inside it`, { bookId: existing.id });
        ebookCoverWarning = true;
      } else {
        const sync = await syncCoverIntoLibrumEbook(current, {
          getCoverJpeg: () => ebookCoverJpeg(coverResult),
          title,
          getAuthorName: getEbookAuthorName,
          maxBytes: MAX_MANUSCRIPT_BYTES,
          caller,
          bookId: existing.id,
        });
        if (sync.kind === "embedded") {
          newManuscriptPath = newBookManuscriptPath(userId, existing.id);
          uploadsBeforeWrite.push({
            bucket: BOOK_MANUSCRIPTS_BUCKET,
            path: newManuscriptPath,
            bytes: sync.bytes,
            contentType: "application/epub+zip",
            kind: "manuscript",
            metadata: { ...LIBRUM_MADE_EBOOK_METADATA },
          });
        } else if (sync.kind === "skipped") {
          ebookCoverWarning = true;
        } else {
          // Marked, but not the shape Librum writes: left untouched.
          console.error(`${caller}: marked ebook is not a Librum-made package; cover not put inside it`, {
            bookId: existing.id,
          });
        }
      }
    }
  }

  return { ebookCoverWarning, newManuscriptPath };
}

// BD15 P3: the new editor's Content tab (PLAN-BD15-r1 §2.4) -- the
// manuscript, the cover, ISBN, publisher and the staff-only "AI used"
// answer of the author's own book. A draft's row write is bound to
// status 'draft'; a live book's changes go to its waiting changes
// (P5b-2); a book waiting for review is read-only.
//
// The file handling is the old updateBook's, unchanged: both inputs
// validated before any upload, fresh keys uploaded before the write, a compare-
// and-set on the paths read, the W7 cover inside a Librum-made ebook,
// and only after the write is proven the superseded objects removed
// (Renato 11-04, Q1 a: a replaced manuscript goes at once, as today;
// removeUnretainedManuscripts keeps the approved file buyers get).
// BD15 P5a: a write refused because the book is waiting for review
// (LB490) -- it was sent from another tab. P5b-3a: the editor shows it
// read-only with "Anuloni shqyrtimin".
function toInReviewEditPage(bookId: string): never {
  redirect(withQuery(editorPath(bookId, "details"), "error", IN_REVIEW_LOCKED_MESSAGE));
}

export async function saveBookContent(bookId: string, formData: FormData) {
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    // The editor shows the maintenance notice (audit r1, F1: a path
    // without "?tab=", since this helper adds "?error=").
    redirectForMaintenance(`/dashboard/books/${bookId}/editor`);
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login");
  }

  const here = editorPath(bookId, "content");
  const fail = (message: string): never => redirect(withQuery(here, "error", message));

  // An ownership-bound read: the row's own id must be
  // exactly the id named, before any upload.
  const { data: existing, error: existingError } = await supabase
    .from("books")
    .select("id, author_id, status, title, pen_name_id, cover_path, file_path, isbn, description, is_adult, original_author")
    .eq("id", bookId)
    .eq("author_id", user.id)
    .maybeSingle<{
      id: string;
      author_id: string;
      status: string;
      title: string;
      pen_name_id: string | null;
      cover_path: string | null;
      file_path: string | null;
      isbn: string | null;
      description: string;
      is_adult: boolean;
      original_author: string | null;
    }>();
  if (existingError || !existing || existing.id !== bookId || existing.author_id !== user.id) {
    redirect("/dashboard");
  }

  // Drafts and (P5b-2) live books, not while waiting for review.
  // P5b-3a: the editor shows a book in review read-only; an unreadable
  // review state saves nothing. BD16 P2: a live pre-order is saved like
  // a live book (its final manuscript becomes a waiting change).
  const live = existing.status === "published" || existing.status === "preorder";
  if (existing.status !== "draft" && !live) redirect("/dashboard");
  const review = await getBookReviewState(supabase, existing.id);
  if (review.kind !== "ok") return fail("Diçka shkoi keq gjatë ruajtjes së ndryshimeve. Provoni përsëri");
  if (review.pending) toInReviewEditPage(existing.id);

  // BD15 P5b-2: a live book's new manuscript or ballinë goes to its
  // waiting changes, never onto the live row; the working version (the
  // waiting one, else the live one) is what a new file replaces and what
  // the Librum-made ebook's cover is taken from.
  let pendingRead: PendingChanges | null = null;
  // P5b-3b (audit P5b-2 r1 F4): the version read here; the save below is
  // refused (LB496) if another save came in meanwhile.
  let pendingVersion: number | null = null;
  if (live) {
    const read = await readPendingChanges(createCatalogWriteClient(), existing.id);
    if (!read.ok) return fail("Diçka shkoi keq gjatë ruajtjes së ndryshimeve. Provoni përsëri");
    pendingRead = read.pending;
    pendingVersion = read.version;
  }
  const liveValues: PendingChanges = {
    filePath: existing.file_path,
    coverPath: existing.cover_path,
    description: existing.description,
    isAdult: existing.is_adult,
    originalAuthor: existing.original_author,
  };
  const working: PendingChanges = pendingRead ?? liveValues;

  // ISBN: the shared rule (book-identifiers.ts); an unchanged stored value
  // is kept as it is (FIX1 X9).
  const isbnPresent = formData.has("isbn");
  const isbn = String(formData.get("isbn") ?? "").trim() || null;
  if (isbnPresent && isbn !== null && isbn !== existing.isbn && !isValidIsbn(isbn)) {
    fail(INVALID_ISBN_MESSAGE);
  }
  const publisherResolved = resolveBoundedOptionalText(formData, "publisher", PUBLISHER_MAX_LENGTH, "Botuesi", here);
  // Not answered stays not answered; a value other than yes/no is refused.
  const rawAi = formData.get("aiUsed");
  const aiAnswer = parseAiAnswer(rawAi);
  if (rawAi !== null && rawAi !== "" && aiAnswer === null) {
    fail(AI_NOT_SAVED_MESSAGE);
  }

  // Both inputs validated before any upload (QA-FIX-3).
  const coverResult = await resolveCoverInput(supabase, user.id, formData, here);
  const manuscriptResult = await resolveManuscriptInput(supabase, user.id, formData, here, existing.id);

  const uploadsBeforeWrite: PendingUpload[] = [];
  let newCoverPath: string | null = null;
  let coverPathToRemove: string | null = null;
  let tempCoverToCleanup: string | null = null;
  if (coverResult.present) {
    newCoverPath = newBookCoverPath(coverResult.extension);
    const storedCoverClass = classifyBookCoverPath(existing.cover_path, user.id, existing.id);
    uploadsBeforeWrite.push({
      bucket: BOOK_COVERS_BUCKET,
      path: newCoverPath,
      bytes: coverResult.bytes,
      contentType: coverResult.contentType,
      kind: "cover",
    });
    if (live) {
      // P5b-2: the live ballinë is never removed here; only a waiting one
      // this save replaces (re-checked against the live row before it
      // goes, below).
      if (pendingRead?.coverPath && pendingRead.coverPath !== existing.cover_path && isNewBookCoverPath(pendingRead.coverPath)) {
        coverPathToRemove = pendingRead.coverPath;
      }
    } else if (storedCoverClass !== "unsafe" && existing.cover_path !== newCoverPath) {
      coverPathToRemove = existing.cover_path;
    } else if (storedCoverClass === "unsafe" && existing.cover_path !== null) {
      console.warn("saveBookContent: stored cover path is not this book's own key; left untouched", {
        bookId: existing.id,
        coverPathClass: storedCoverClass,
      });
    }
    tempCoverToCleanup = coverResult.tempPathToCleanup;
  }

  let newManuscriptPath: string | null = null;
  let tempManuscriptToCleanup: string | null = null;
  if (manuscriptResult.present) {
    newManuscriptPath = newBookManuscriptPath(user.id, existing.id);
    if (existing.file_path !== null && !isOwnBookManuscriptPath(existing.file_path, user.id, existing.id)) {
      console.warn("saveBookContent: stored manuscript path is not this book's own key; left untouched", {
        bookId: existing.id,
        manuscriptPathClass: "unsafe",
      });
    }
    uploadsBeforeWrite.push({
      bucket: BOOK_MANUSCRIPTS_BUCKET,
      path: newManuscriptPath,
      bytes: manuscriptResult.bytes,
      contentType: "application/epub+zip",
      kind: "manuscript",
    });
    tempManuscriptToCleanup = manuscriptResult.tempPathToCleanup;
  }

  const catalogWriter = createCatalogWriteClient();
  const ebookSync = await syncLibrumEbookCover({
    supabase,
    catalogWriter,
    userId: user.id,
    existing: { ...existing, file_path: working.filePath, cover_path: working.coverPath },
    coverResult,
    title: existing.title,
    penNameId: null,
    uploadsBeforeWrite,
    caller: "saveBookContent",
  });
  if (ebookSync.newManuscriptPath !== null) newManuscriptPath = ebookSync.newManuscriptPath;

  const removeNewUploads = async () => {
    if (newCoverPath !== null) await removeNewCoverUpload(catalogWriter, newCoverPath, "saveBookContent");
    if (newManuscriptPath !== null) {
      await removeNewManuscriptUpload(catalogWriter, newManuscriptPath, user.id, existing.id, "saveBookContent");
    }
  };

  for (const upload of uploadsBeforeWrite) {
    const { error: uploadError } = await catalogWriter.storage.from(upload.bucket).upload(upload.path, upload.bytes, {
      contentType: upload.contentType,
      ...(upload.kind === "cover" ? { cacheControl: IMAGE_CACHE_CONTROL_SECONDS } : {}),
      ...(upload.metadata ? { metadata: upload.metadata } : {}),
    });
    if (uploadError) {
      console.error(`saveBookContent: ${upload.kind} upload failed`, { bookId: existing.id });
      await removeNewUploads();
      fail(
        upload.kind === "cover"
          ? "Imazhi i ballinës nuk u ngarkua dot. Provoni përsëri"
          : "Dorëshkrimi nuk u ngarkua dot. Provoni përsëri",
      );
    }
  }

  // One guarded row write: the caller's own draft, with the paths it read
  // (compare-and-set), so the superseded objects removed below are
  // provably the ones this write replaced.
  const payload = {
    ...(isbnPresent ? { isbn } : {}),
    ...(publisherResolved.present ? { publisher: publisherResolved.value } : {}),
    ...(!live && newCoverPath !== null ? { cover_path: newCoverPath } : {}),
    ...(!live && newManuscriptPath !== null ? { file_path: newManuscriptPath } : {}),
  };
  // Audit r1, F4: nothing to write (a form without these fields) goes
  // straight on to the AI answer; there is then no upload either.
  if (Object.keys(payload).length > 0) {
    let query = catalogWriter
      .from("books")
      .update(payload)
      .eq("id", existing.id)
      .eq("author_id", user.id)
      .eq("status", existing.status);
    if (!live && newCoverPath !== null) {
      query = existing.cover_path === null ? query.is("cover_path", null) : query.eq("cover_path", existing.cover_path);
    }
    if (!live && newManuscriptPath !== null) {
      query = existing.file_path === null ? query.is("file_path", null) : query.eq("file_path", existing.file_path);
    }
    const { data: updatedRows, error: updateError } = await query.select("id");
    if (updateError) {
      console.error("saveBookContent: book update failed", { bookId: existing.id, code: updateError.code ?? null });
      await removeNewUploads();
      // BD15 P5a (P3 audit F3): sent for review in another tab after the
      // check above; the book is read-only now.
      if (isInReviewLockError(updateError)) toInReviewEditPage(existing.id);
      if (["LB462", "LB463"].includes(updateError.code ?? "")) fail(BOOK_CHANGED_WHILE_EDITING_MESSAGE);
      // BD15 P7 (Q1 a): a picked public-domain edition's ISBN and publisher.
      if (updateError.code === "LB497") fail(PD_FROZEN_MESSAGE);
      fail("Diçka shkoi keq gjatë ruajtjes së ndryshimeve. Provoni përsëri");
    }
    if (!isExactlyOneRowWritten(updatedRows) || updatedRows?.[0]?.id !== existing.id) {
      console.error("saveBookContent: guarded update did not change exactly one row", { bookId: existing.id });
      await removeNewUploads();
      fail(live ? LIVE_NOT_LIVE_MESSAGE : CATALOG_ROW_CHANGED_MESSAGE);
    }
  }

  // P5b-2: a live book's new files become its waiting version (with its
  // waiting -- or live -- description, 18+ label and original author).
  if (live && (newCoverPath !== null || newManuscriptPath !== null)) {
    const saved = await savePendingChanges(catalogWriter, {
      authorId: user.id,
      bookId: existing.id,
      expectedVersion: pendingVersion,
      changes: {
        ...working,
        filePath: newManuscriptPath ?? working.filePath,
        coverPath: newCoverPath ?? working.coverPath,
      },
    });
    if (!saved.ok) {
      console.error("saveBookContent: waiting changes not saved", { bookId: existing.id, reason: saved.reason });
      await removeNewUploads();
      if (saved.reason === "in_review") toInReviewEditPage(existing.id);
      if (saved.reason === "not_live") fail(LIVE_NOT_LIVE_MESSAGE);
      // Renato 11-05 (Q1 a): the later save is refused; its new upload is
      // removed above and nothing the other save named is touched.
      if (saved.reason === "conflict") fail(BOOK_CHANGED_WHILE_EDITING_MESSAGE);
      fail("Diçka shkoi keq gjatë ruajtjes së ndryshimeve. Provoni përsëri");
    }
  }

  // Superseded objects, only now that the write is proven (best effort).
  if (newManuscriptPath !== null) {
    await removeUnretainedManuscripts(catalogWriter, catalogWriter, {
      authorId: user.id,
      bookId: existing.id,
      superseded: [live ? working.filePath : existing.file_path],
      caller: "saveBookContent",
    });
  }
  if (live && coverPathToRemove !== null) {
    // The replaced waiting ballinë, unless it became the live one since
    // it was read (an approval in between).
    const { data: now } = await catalogWriter
      .from("books")
      .select("cover_path")
      .eq("id", existing.id)
      .eq("author_id", user.id)
      .maybeSingle<{ cover_path: string | null }>();
    if (!now || now.cover_path === coverPathToRemove) coverPathToRemove = null;
  }
  const removals = temporaryUploadRemovals(user.id, tempManuscriptToCleanup, tempCoverToCleanup);
  if (coverPathToRemove !== null) {
    if (live) {
      const { error: removeError } = await catalogWriter.storage.from(BOOK_COVERS_BUCKET).remove([coverPathToRemove]);
      if (removeError) console.error("saveBookContent: replaced waiting ballinë not removed", { bookId: existing.id });
    } else {
      removals.unshift({ bucket: BOOK_COVERS_BUCKET, path: coverPathToRemove });
    }
  }
  await removeProvenBookStorageObjects(supabase, removals, "saveBookContent");

  revalidatePath("/dashboard");
  revalidatePath("/dashboard/books");

  // The files are saved; an AI answer that fails to save is reported on
  // the tab, never undoing them.
  if (aiAnswer !== null) {
    const aiWrite = await writeAiDisclosure(existing.id, aiAnswer);
    if (aiWrite === "in_review") toInReviewEditPage(existing.id);
    if (aiWrite !== "ok") {
      console.error("saveBookContent: AI answer not recorded", { bookId: existing.id });
      redirectAfterSave(ebookSync.ebookCoverWarning, withQuery(here, "error", AI_NOT_SAVED_MESSAGE));
    }
  }

  // D1: "← Të dhënat" saves first, then goes back.
  const intent = String(formData.get("intent") ?? "");
  const next = editorPath(existing.id, intent === "next" ? "pricing" : intent === "back" ? "details" : "content");
  const savedMessage = !live
    ? CONTENT_SAVED_MESSAGE
    : newCoverPath !== null || newManuscriptPath !== null || pendingRead !== null
      ? LIVE_SAVED_PENDING_MESSAGE
      : LIVE_SAVED_MESSAGE;
  redirectAfterSave(ebookSync.ebookCoverWarning, `${next}&success=${encodeURIComponent(savedMessage)}`);
}

// BD15 P4: at "Send for review", a Librum-made ebook gets the book's
// CURRENT title and byline written into it (restampLibrumEpubMetadata):
// the Word conversion wrote them at upload, and the Details tab may have
// changed either since. Directly uploaded ebooks are never touched. A
// rewrite is stored under a fresh versioned key with the same
// compare-and-set on file_path the Content tab uses, and the superseded
// key goes through the same retention rule (removeUnretainedManuscripts:
// the last approved file stays the buyers'). "failed" stops the send, so
// a book never goes to review with an ebook that names the old title.
async function restampLibrumEbookForSend({
  supabase,
  catalogWriter,
  userId,
  book,
}: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  catalogWriter: ReturnType<typeof createCatalogWriteClient>;
  userId: string;
  book: { id: string; title: string; pen_name_id: string | null; file_path: string | null };
}): Promise<"unchanged" | "stamped" | "failed"> {
  const caller = "saveBookPricing";
  if (book.file_path === null || !isOwnBookManuscriptPath(book.file_path, userId, book.id)) return "unchanged";
  const marker = await readLibrumMadeMarker(catalogWriter.storage, book.file_path);
  if (marker === "no") return "unchanged";
  if (marker === "unknown") {
    console.error(`${caller}: could not check whether Librum made the current ebook`, { bookId: book.id });
    return "failed";
  }
  const current = await downloadStoredBytes(catalogWriter, BOOK_MANUSCRIPTS_BUCKET, book.file_path);
  if (current === null) {
    console.error(`${caller}: current ebook not read`, { bookId: book.id });
    return "failed";
  }
  const authorName = await readPenNameForEbook(supabase, userId, book.pen_name_id);
  // Audit r1, F4: an unread pen name would leave the old byline inside.
  if (book.pen_name_id !== null && authorName === null) {
    console.error(`${caller}: pen name not read; ebook byline not rewritten`, { bookId: book.id });
    return "failed";
  }
  const restamped = await restampLibrumEpubMetadata(current, { title: book.title, authorName });
  if (!restamped.ok && restamped.reason === "unreadable") {
    console.error(`${caller}: Librum-made ebook could not be rewritten`, { bookId: book.id });
    return "failed";
  }
  if (!restamped.ok) {
    // Marked, but not the shape Librum writes: left as it is (as W7).
    console.error(`${caller}: marked ebook is not a Librum-made package; title not rewritten`, {
      bookId: book.id,
      reason: restamped.reason,
    });
    return "unchanged";
  }
  if (!restamped.changed) return "unchanged";
  if (restamped.bytes.length > MAX_MANUSCRIPT_BYTES || !(await validateEpubStructure(restamped.bytes)).valid) {
    console.error(`${caller}: rewritten ebook failed the ebook checks`, { bookId: book.id });
    return "failed";
  }

  const newPath = newBookManuscriptPath(userId, book.id);
  const { error: uploadError } = await catalogWriter.storage.from(BOOK_MANUSCRIPTS_BUCKET).upload(newPath, restamped.bytes, {
    contentType: "application/epub+zip",
    metadata: { ...LIBRUM_MADE_EBOOK_METADATA },
  });
  if (uploadError) {
    console.error(`${caller}: rewritten ebook upload failed`, { bookId: book.id });
    await removeNewManuscriptUpload(catalogWriter, newPath, userId, book.id, caller);
    return "failed";
  }
  const { data: rows, error: updateError } = await catalogWriter
    .from("books")
    .update({ file_path: newPath })
    .eq("id", book.id)
    .eq("author_id", userId)
    .eq("status", "draft")
    .eq("file_path", book.file_path)
    .select("id");
  if (updateError || !isExactlyOneRowWritten(rows)) {
    console.error(`${caller}: guarded file_path update did not change exactly one row`, {
      bookId: book.id,
      code: updateError?.code ?? null,
    });
    await removeNewManuscriptUpload(catalogWriter, newPath, userId, book.id, caller);
    return "failed";
  }
  await removeUnretainedManuscripts(catalogWriter, catalogWriter, {
    authorId: userId,
    bookId: book.id,
    superseded: [book.file_path],
    caller,
  });
  return "stamped";
}

// BD15 P5b-2: "Dërgoni ndryshimet për shqyrtim" for a LIVE book, after
// its price is saved and both ticks are checked. Its waiting changes
// must exist and differ from the live book, and the working version must
// be complete (the same lists as a draft, with the AI answer: 13 older
// staging books have none). No ebook re-stamp: the title and pen name of
// a published book never change (LB480/LB481). The ticks are recorded,
// then request_book_review() sends the waiting version (LB494 nothing to
// send, LB493 18+ beside a children/teen category, LB489, LB460). The
// book stays live and is read-only while in review (Q2 a).
async function sendLiveBookChanges({
  supabase,
  userId,
  existing,
  rightsBasis,
  priceAll,
  here,
}: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  userId: string;
  existing: {
    id: string;
    status: string;
    title: string;
    categories: string[] | null;
    file_path: string | null;
    cover_path: string | null;
    description: string | null;
    is_adult: boolean;
    original_author: string | null;
  };
  rightsBasis: RightsBasis | null;
  priceAll: number;
  here: string;
  formData: FormData;
}): Promise<never> {
  const fail = (message: string): never => redirect(withQuery(here, "error", message));
  const read = await readPendingChanges(createCatalogWriteClient(), existing.id);
  if (!read.ok) return fail("Diçka shkoi keq gjatë ruajtjes së ndryshimeve. Provoni përsëri");
  const live: PendingChanges = {
    filePath: existing.file_path,
    coverPath: existing.cover_path,
    description: existing.description ?? "",
    isAdult: existing.is_adult,
    originalAuthor: existing.original_author,
  };
  if (!read.pending || changedPendingFields(live, read.pending).length === 0) return fail(NO_CHANGES_TO_SEND_MESSAGE);
  // Audit r1 F6: the same paid rule as a draft's send -- Librum's approval
  // refuses a paid book while paid publishing is off, so it is not sent.
  if (priceAll > 0 && !canPublishPaidTitle()) return fail(PAID_PUBLISHING_UNAVAILABLE_MESSAGE);
  const working = read.pending;

  const ai = await readAiDisclosure(existing.id);
  const detailsMissing = missingDetails({
    title: existing.title,
    categories: existing.categories,
    description: working.description,
    rightsBasis,
    originalAuthor: working.originalAuthor,
  });
  // BD16 P2: a pre-order may send its other changes before the final
  // manuscript (request_book_review allows it while it has none).
  const fileOptional = existing.status === "preorder" && existing.file_path === null;
  if (
    detailsMissing.length > 0 ||
    (working.filePath === null && !fileOptional) ||
    working.coverPath === null ||
    !ai.ok ||
    ai.answer === null ||
    rightsBasis === null
  ) {
    fail(SEND_INCOMPLETE_MESSAGE);
  }

  const recorded = await recordRightsDeclaration(existing.id, rightsBasis!, { atSend: true });
  if (!recorded.ok) {
    console.error("saveBookPricing: send confirmation not recorded", { bookId: existing.id, reason: recorded.reason });
    if (await isWaitingForReview(supabase, existing.id)) toInReviewEditPage(existing.id);
    fail(SEND_CONFIRMATION_NOT_SAVED_MESSAGE);
  }

  const request = await requestBookReview(supabase, existing.id);
  if (!request.ok) {
    switch (request.reason) {
      case "nothing_to_send":
        fail(NO_CHANGES_TO_SEND_MESSAGE);
        break;
      case "adult_category":
        fail(LIVE_ADULT_CATEGORY_MESSAGE);
        break;
      case "incomplete":
        fail(SEND_INCOMPLETE_MESSAGE);
        break;
      case "already_pending":
        fail(ALREADY_IN_REVIEW_MESSAGE);
        break;
      case "taken_down":
        fail(TAKEN_DOWN_PUBLISH_MESSAGE);
        break;
      default:
        fail("Diçka shkoi keq gjatë ruajtjes së ndryshimeve. Provoni përsëri");
    }
  }
  // ADMIN-ALERTS-1 (2a): a new review request starts a new 48h clock.
  await sendReviewRequestedStaffEmail({ bookId: existing.id, authorId: userId });
  revalidatePath("/dashboard");
  redirect(`/dashboard?success=${encodeURIComponent(CHANGES_SENT_MESSAGE)}`);
}

// BD15 P4: the new editor's Pricing tab (PLAN-BD15-r1 §2.5). Saves the
// price ("Ruaj draftin"), or saves it and sends the book for review
// ("Dërgo për shqyrtim"). Drafts and live books, not while in review;
// a taken-down book's price saves but it is never sent (P5b-3a, Q2 a).
//
// Sending, in order, each step refusing before the next:
//   1. the price is saved (so a refusal below never loses it);
//   2. both ticks (Renato 11-04, Q2 a: unticked on every send);
//   3. Details, Content (file, cover, AI answer) and the rights choice
//      are complete -- the app-side check; request_book_review refuses
//      a book with no file, cover or AI answer too (P5a, LB489);
//   4. the ebook is re-stamped with the current title and byline;
//   5. the ticks are recorded (a new rights declaration row);
//   6. performPublish(): the same gate as everywhere else -- review, or
//      publish when Librum's approval still matches the files (3a).
export async function saveBookPricing(bookId: string, formData: FormData) {
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    redirectForMaintenance(`/dashboard/books/${bookId}/editor`);
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login");
  }

  const here = editorPath(bookId, "pricing");
  const fail = (message: string): never => redirect(withQuery(here, "error", message));

  const { data: existing, error: existingError } = await supabase
    .from("books")
    .select("id, author_id, status, title, pen_name_id, price_all, file_path, cover_path, description, categories, original_author, is_adult")
    .eq("id", bookId)
    .eq("author_id", user.id)
    .maybeSingle<{
      id: string;
      author_id: string;
      status: string;
      title: string;
      pen_name_id: string | null;
      price_all: number | null;
      file_path: string | null;
      cover_path: string | null;
      description: string | null;
      categories: string[] | null;
      original_author: string | null;
      is_adult: boolean;
    }>();
  if (existingError || !existing || existing.id !== bookId || existing.author_id !== user.id) {
    redirect("/dashboard");
  }

  // BD15 P5b-2: a live book too (its price saves at once; "send" sends
  // its waiting changes and it stays live). BD16 P2: so does a live
  // pre-order (nobody can buy it, so a new price needs no tick).
  const live = existing.status === "published" || existing.status === "preorder";
  if (existing.status !== "draft" && !live) redirect("/dashboard");
  const [review, takedown, rights] = await Promise.all([
    getBookReviewState(supabase, existing.id),
    getActiveTakedownState(supabase, existing.id),
    getRightsDeclarationState(existing.id),
  ]);
  // P5b-3a: a book in review shows read-only in the editor; an
  // unreadable review state saves nothing.
  if (review.kind !== "ok") return fail("Diçka shkoi keq gjatë ruajtjes së ndryshimeve. Provoni përsëri");
  if (review.pending) toInReviewEditPage(existing.id);
  // Audit r1, F6: an unreadable takedown state is not a takedown.
  if (takedown.kind === "unavailable") redirect(`/dashboard?error=${PUBLISH_NOT_POSSIBLE_YET_QUERY}`);
  // P5b-3a (Renato 11-04, Q2 a): a taken-down book is edited like a
  // draft -- its price saves -- but it is never sent (checked again
  // below, after the save, and by request_book_review, LB460).
  const takenDown = takedown.kind === "active";
  // Audit r1, F2: without the rights choice it is unknown whether the
  // book is free only, so nothing is saved.
  if (rights.kind === "unavailable") fail("Diçka shkoi keq gjatë ruajtjes së ndryshimeve. Provoni përsëri");
  const rightsBasis = rights.kind === "present" ? rights.declaration.basis : null;

  // D1: "← Përmbajtja" saves first, then goes back. With no price
  // chosen yet there is nothing to save, so it just goes back; a price
  // that is not valid stays here with its message, so nothing typed is
  // lost.
  const intent = String(formData.get("intent") ?? "");
  const back = editorPath(existing.id, "content");
  if (intent === "back" && !isFreeOnlyRightsBasis(rightsBasis) && parsePriceMode(formData.get(PRICE_MODE_FIELD)) === null) {
    redirect(back);
  }

  // 1. The price. A public-domain book is free only.
  const pricing = resolvePricingSubmission({
    mode: formData.get(PRICE_MODE_FIELD),
    price: formData.get(PRICE_FIELD),
    rightsBasis,
  });
  const priceAll = pricing.ok
    ? pricing.priceAll
    : fail(pricing.reason === "missing_mode" ? PRICE_MODE_MISSING_MESSAGE : PRICE_INVALID_MESSAGE);
  if (priceAll !== existing.price_all) {
    if (live) {
      // P5b-2: a live book's new price is a live price change -- the same
      // two rules the edit page applies (PAID-REPRICING-1: a new paid
      // price needs paid publishing; LIVE-PRICE-CONFIRM-1: the tick under
      // the price carrying exactly this price).
      const authorization = resolvePriceUpdateAuthorization({
        currentStatus: existing.status,
        currentPriceAll: existing.price_all,
        submittedPriceAll: priceAll,
      });
      if (authorization.kind === "paid_publishing_permission_required" && !canPublishPaidTitle()) {
        fail(PAID_REPRICING_UNAVAILABLE_MESSAGE);
      }
      if (isLivePriceChange({ status: existing.status, currentPriceAll: existing.price_all, submittedPriceAll: priceAll }) &&
        !isPriceChangeConfirmed(formData, priceAll)) {
        fail(PRICE_CHANGE_CONFIRM_MESSAGE);
      }
    }
    // A draft (or the live book) only -- compare-and-set on status and the
    // price read above -- through the trusted writer: price_all is a
    // protected column.
    const { data: rows, error } = await applyCatalogRowGuard(
      createCatalogWriteClient().from("books").update({ price_all: priceAll }).eq("id", existing.id).eq("author_id", user.id),
      { status: existing.status, priceAll: existing.price_all },
    ).select("id");
    if (error) {
      console.error("saveBookPricing: price update failed", { bookId: existing.id, code: error.code ?? null });
      if (isInReviewLockError(error)) toInReviewEditPage(existing.id);
      fail("Diçka shkoi keq gjatë ruajtjes së ndryshimeve. Provoni përsëri");
    }
    if (!isExactlyOneRowWritten(rows)) fail(CATALOG_ROW_CHANGED_MESSAGE);
  }
  revalidatePath("/dashboard");
  revalidatePath("/dashboard/books");

  // BD16 P2: a draft's "Kur del libri" choice (Pricing tab). A pre-order
  // asks for its day on the draft (books.release_date); "now" clears it,
  // so a normal send never carries a stale day (the approval compares
  // it). Saved on every save, before any send; request_book_review
  // checks the same window again (LB500, LB501, LB502).
  if (!live) {
    const choice = parseReleaseChoice(formData);
    if (choice.kind === "invalid") fail(PREORDER_DATE_INVALID_MESSAGE);
    if (choice.kind === "now" || choice.kind === "preorder") {
      const preorderFeature = await getPreorderSchemaFeature();
      if (choice.kind === "preorder") {
        if (!preorderFeature || takenDown) fail(PREORDER_NOT_AVAILABLE_MESSAGE);
        const { data: facts, error: factsError } = await supabase
          .from("books")
          .select("published_at, preorder_count, pd_work_id")
          .eq("id", existing.id)
          .eq("author_id", user.id)
          .maybeSingle<{ published_at: string | null; preorder_count: number; pd_work_id: string | null }>();
        if (factsError || !facts) fail("Diçka shkoi keq gjatë ruajtjes së ndryshimeve. Provoni përsëri");
        const block = preorderBlock({ ...facts!, rightsBasis });
        if (block !== null) {
          fail(
            block === "used_up"
              ? PREORDER_USED_UP_NOTE
              : block === "published_before"
                ? PREORDER_PUBLISHED_BEFORE_NOTE
                : PREORDER_PUBLIC_DOMAIN_NOTE,
          );
        }
        if (!isInPreorderWindow(choice.releaseDate, tiranaToday())) fail(PREORDER_DATE_INVALID_MESSAGE);
      }
      if (preorderFeature) {
        const releaseDate = choice.kind === "preorder" ? choice.releaseDate : null;
        // The trusted writer (authenticated may not write books columns),
        // bound to the caller's own draft. Audit r1 F1: a day is written
        // only onto a book still never published, in the write itself (the
        // database does not check it; Renato 11-06 a). Clearing is always
        // allowed.
        let write = createCatalogWriteClient()
          .from("books")
          .update({ release_date: releaseDate })
          .eq("id", existing.id)
          .eq("author_id", user.id)
          .eq("status", "draft");
        if (releaseDate !== null) write = write.is("published_at", null);
        const { data: rows, error } = await write.select("id");
        if (error) {
          console.error("saveBookPricing: release date update failed", { bookId: existing.id, code: error.code ?? null });
          if (isInReviewLockError(error)) toInReviewEditPage(existing.id);
          fail("Diçka shkoi keq gjatë ruajtjes së ndryshimeve. Provoni përsëri");
        }
        if (!isExactlyOneRowWritten(rows)) fail(CATALOG_ROW_CHANGED_MESSAGE);
      }
    }
  }

  if (intent !== "send") {
    // P5b-2: a live book is not a draft; its price is live at once.
    const savedMessage = live ? LIVE_SAVED_MESSAGE : DETAILS_SAVED_MESSAGE;
    redirect(`${intent === "back" ? back : here}&success=${encodeURIComponent(savedMessage)}`);
  }

  // P5b-3a: the price above is saved; a taken-down book is not sent.
  if (takenDown) fail(TAKEN_DOWN_PUBLISH_MESSAGE);

  // 2. Both ticks, every send.
  if (!hasSendTicks(formData)) fail(SEND_TICKS_MISSING_MESSAGE);

  if (live) {
    // Audit r1 F1: an older live book with no rights record sends as own
    // rights, the only basis LB492 allows it; the ticked box records it.
    await sendLiveBookChanges({
      supabase,
      userId: user.id,
      existing,
      rightsBasis: rightsBasis ?? (rights.kind === "none" ? "own_rights" : null),
      priceAll,
      here,
      formData,
    });
  }

  // 3. Every tab complete. BD16 P2: a pre-order listing may come
  // without its manuscript (D5).
  const preorderListing = parseReleaseChoice(formData).kind === "preorder";
  const ai = await readAiDisclosure(existing.id);
  const detailsMissing = missingDetails({
    title: existing.title,
    categories: existing.categories,
    description: existing.description,
    rightsBasis,
    originalAuthor: existing.original_author,
  });
  if (
    detailsMissing.length > 0 ||
    (existing.file_path === null && !preorderListing) ||
    existing.cover_path === null ||
    !ai.ok ||
    ai.answer === null ||
    rightsBasis === null
  ) {
    fail(SEND_INCOMPLETE_MESSAGE);
  }

  // Audit r1, F3: the paid-publishing permission performPublish checks,
  // asked before the ebook or the ticks are written, so a send that can
  // not happen leaves no record behind.
  if (priceAll > 0 && !canPublishPaidTitle()) fail(PAID_PUBLISHING_UNAVAILABLE_MESSAGE);

  // 4. The current title and byline inside a Librum-made ebook.
  const restamp = await restampLibrumEbookForSend({
    supabase,
    catalogWriter: createCatalogWriteClient(),
    userId: user.id,
    book: existing,
  });
  if (restamp === "failed") {
    if (await isWaitingForReview(supabase, existing.id)) toInReviewEditPage(existing.id);
    fail(EBOOK_RESTAMP_FAILED_MESSAGE);
  }

  // 5. The ticks, recorded for this send.
  const recorded = await recordRightsDeclaration(existing.id, rightsBasis, { atSend: true });
  if (!recorded.ok) {
    console.error("saveBookPricing: send confirmation not recorded", { bookId: existing.id, reason: recorded.reason });
    if (await isWaitingForReview(supabase, existing.id)) toInReviewEditPage(existing.id);
    fail(SEND_CONFIRMATION_NOT_SAVED_MESSAGE);
  }

  // 6. The one publish gate.
  const result = await performPublish(supabase, existing.id, user.id);
  if (!result.ok) {
    switch (result.reason) {
      case "missing_files":
        fail(MISSING_FILES_MESSAGE);
        break;
      case "missing_all_price":
        fail(MISSING_ALL_PRICE_MESSAGE);
        break;
      case "missing_description":
        fail(MISSING_DESCRIPTION_SHORT_MESSAGE);
        break;
      case "missing_rights":
        fail(MISSING_RIGHTS_MESSAGE);
        break;
      case "send_incomplete":
        fail(SEND_INCOMPLETE_MESSAGE);
        break;
      case "already_in_review":
        fail(ALREADY_IN_REVIEW_MESSAGE);
        break;
      case "taken_down":
        fail(TAKEN_DOWN_PUBLISH_MESSAGE);
        break;
      case "book_changed":
        fail(BOOK_CHANGED_WHILE_EDITING_MESSAGE);
        break;
      case "paid_mode_required":
        fail(PAID_PUBLISHING_UNAVAILABLE_MESSAGE);
        break;
      case "preorder_date":
        fail(PREORDER_DATE_INVALID_MESSAGE);
        break;
      case "preorder_used_up":
        fail(PREORDER_USED_UP_NOTE);
        break;
      case "preorder_public_domain":
        fail(PREORDER_PUBLIC_DOMAIN_NOTE);
        break;
      case "rights_unavailable":
      case "takedown_unavailable":
      case "review_unavailable":
        redirect(`/dashboard?error=${PUBLISH_NOT_POSSIBLE_YET_QUERY}`);
        break;
      default:
        redirect("/dashboard");
    }
    return;
  }

  if (result.outcome === "sent_for_review") {
    revalidatePath("/dashboard");
    redirect(
      `/dashboard?success=${encodeURIComponent(result.preorder ? PREORDER_SENT_MESSAGE : SENT_FOR_REVIEW_MESSAGE)}`,
    );
  }

  // Published (Librum's approval still matched).
  if (result.wasNewlyPublished) {
    sendNewBookEmailsAfterResponse("saveBookPricing", { bookId: existing.id, authorId: user.id });
  }
  try {
    revalidatePath("/dashboard");
    revalidatePath("/");
  } catch (error) {
    console.error("saveBookPricing: revalidatePath failed after a successful publish", { bookId: existing.id, error });
  }
  redirect(`/dashboard?success=${encodeURIComponent(BOOK_PUBLISHED_MESSAGE)}`);
}

// ADMIN-3-REVIEW (E): the author's "Cancel review" -- the pending review
// becomes 'withdrawn' (withdraw_book_review checks the caller owns the
// book) and the book simply stays a draft. Nothing is removed: the last
// approved file stays the buyers' file (N2 ★a), and the withdrawn
// snapshot is the book's current file.
export async function cancelBookReview(bookId: string) {
  await redirectIfRecoverySessionActive();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const result = await withdrawBookReview(supabase, bookId);
  if (!result.ok) {
    redirect(
      withQuery(
        editorPath(bookId, "details"),
        "error",
        result.reason === "not_pending" ? NOT_IN_REVIEW_MESSAGE : "Diçka shkoi keq. Provoni përsëri",
      ),
    );
  }

  revalidatePath("/dashboard");
  revalidatePath(`/dashboard/books/${bookId}/editor`);
  // BD15 P4: the book is a plain draft again, edited in the new editor.
  // P5b-2 (audit r1 F2): a live book stays on sale; its changes wait in
  // the editor again. An unreadable status says the draft line.
  const { data: after } = await supabase
    .from("books")
    .select("status")
    .eq("id", bookId)
    .eq("author_id", user.id)
    .maybeSingle<{ status: string }>();
  const cancelledMessage =
    after?.status === "published"
      ? LIVE_REVIEW_CANCELLED_MESSAGE
      : after?.status === "preorder"
        ? PREORDER_REVIEW_CANCELLED_MESSAGE
        : REVIEW_CANCELLED_MESSAGE;
  redirect(`${editorPath(bookId, "details")}&success=${encodeURIComponent(cancelledMessage)}`);
}

// LIBRUM 2.0 PUBLISHING-UX-1 PART B: the ONE authoritative, non-
// redirecting publish gate. BD15 cleanup: publishBook() and
// createBook()'s "intent=publish" path are gone; saveBookPricing's Send
// is its one caller.
// Deliberately NOT exported and NOT itself a Server Action -- this
// file already starts with "use server", which requires every
// EXPORTED top-level value to be an async function; keeping this
// helper internal (Option A from the brief) is the smallest correct
// architecture, and sidesteps that class of defect entirely rather
// than needing a second module (this codebase hit exactly this defect
// once already -- see finance/finance-logic.ts's own "RPC error
// mapping" comment for the ADMIN-1D PART C precedent).
//
// Ownership is enforced by the `eq("author_id", userId)` filters below,
// not by trusting the caller -- both call sites already independently
// re-derive `userId` from their own auth.getUser() before reaching
// here, but this function re-checks it anyway rather than assuming.
//
// published_at semantics (migration 044's own comment has the full
// rationale): read alongside status/price_cents so "set it only if
// currently null" can be decided in the SAME update payload as the
// status transition -- never a separate write, never re-evaluated
// after the fact. A book that was already published once (published_at
// already non-null) keeps that original timestamp through any later
// unpublish/republish cycle or edit -- this function's update payload
// simply omits the key whenever published_at is already set, and a
// Supabase `.update()` never touches a key that isn't present in the
// payload object it's given.
//
// ADMIN-3-REVIEW (A): after every existing check, a draft goes live only
// when Librum has approved its CURRENT file and cover (and after its
// latest takedown, if any) -- book_review_state() says so, and the
// books_require_review_approval trigger refuses the write otherwise
// (LB462). Without that approval the book is sent for review instead
// (request_book_review) and stays a draft: outcome "sent_for_review".
type PerformPublishResult =
  | { ok: true; outcome: "published"; wasNewlyPublished: boolean }
  // BD16 P2: preorder -- the review is a pre-order listing.
  | { ok: true; outcome: "sent_for_review"; preorder: boolean }
  // ALL-WIRING-2: `missing_all_price` is a DISTINCT reason, never folded
  // into paid_mode_required. The two refusals have opposite remedies --
  // the author fixes the first themselves in one edit and can do nothing
  // about the second -- so telling an author with an unpriced draft that
  // "paid publishing isn't available" would be a false explanation.
  | {
      ok: false;
      reason:
        | "not_found"
        // BD15 P2: the new editor saves a draft before it has a
        // manuscript or a cover (both columns are nullable). Such a book
        // is never sent for review or published. Checked first, after
        // the takedown: the author adds them on the edit page.
        | "missing_files"
        | "missing_all_price"
        // FIX1 (X16): an empty (after trimming) description. Checked
        // after the price and before paid permission: the author can fix
        // it themselves, so it is named before a refusal they can't.
        | "missing_description"
        // F4 (P4): no rights choice recorded for this book yet. Checked
        // after the description and before paid permission, for the same
        // reason: the author can fix it themselves.
        | "missing_rights"
        // F4 (D3): the rights choice could not be read at all (before the
        // migration, or a read error). Fails closed, with the generic
        // message, because no choice can be shown to exist.
        | "rights_unavailable"
        // ADMIN-2-TAKEDOWN (G, S4): Librum took this book down and has
        // not allowed it again. Checked right after the ownership read,
        // before every other gate: nothing the author fixes changes it.
        | "taken_down"
        // ADMIN-2-TAKEDOWN (S4): the takedown could not be read (before
        // the migration, or a read error). Fails closed, with the generic
        // message, like rights_unavailable.
        | "takedown_unavailable"
        // ADMIN-3-REVIEW: the book is already waiting for review.
        | "already_in_review"
        // ADMIN-3-REVIEW: the review state could not be read, or the
        // review request failed. Fails closed, with the generic message.
        | "review_unavailable"
        // ADMIN-3-REVIEW (S3): the write met LB462/LB463 -- the book's
        // files changed after the read above.
        | "book_changed"
        | "send_incomplete"
        | "paid_mode_required"
        // BD16 P2: request_book_review refused the listing (LB500-LB502).
        | "preorder_date"
        | "preorder_used_up"
        | "preorder_public_domain"
        | "update_failed";
    };

async function performPublish(
  supabase: Awaited<ReturnType<typeof createClient>>,
  bookId: string,
  userId: string,
): Promise<PerformPublishResult> {
  // AUTH-1C: defense-in-depth -- Proxy already blocks /dashboard/* while
  // a recovery session is active, so this is the second layer against a
  // crafted direct POST. Runs before the status mutation below -- a book's publish state is a
  // publicly-visible, buyer-facing change.
  await redirectIfRecoverySessionActive();

  const { data: book } = await supabase
    .from("books")
    .select("status, price_all, published_at, description, file_path, cover_path")
    .eq("id", bookId)
    .eq("author_id", userId)
    .single();

  if (!book) {
    return { ok: false, reason: "not_found" };
  }

  // BD16 P2: a draft with a release day asks for a pre-order listing.
  // Read on its own, only where the database has the column; unreadable
  // there fails closed (a listing must never be published directly).
  let preorderListing = false;
  if (book.status === "draft" && (await getPreorderSchemaFeature())) {
    const { data: day, error: dayError } = await supabase
      .from("books")
      .select("release_date")
      .eq("id", bookId)
      .eq("author_id", userId)
      .maybeSingle<{ release_date: string | null }>();
    if (dayError || !day) return { ok: false, reason: "review_unavailable" };
    preorderListing = typeof day.release_date === "string";
  }

  // ADMIN-2-TAKEDOWN (G, S4): a taken-down book stays locked until staff
  // allow it again -- read with the author's own session (RLS: own rows),
  // and fail closed. The books trigger refuses the write below as well.
  const takedown = await getActiveTakedownState(supabase, bookId);
  if (takedown.kind === "active") {
    return { ok: false, reason: "taken_down" };
  }
  if (takedown.kind === "unavailable") {
    return { ok: false, reason: "takedown_unavailable" };
  }

  // BD15 P2: no manuscript or no cover yet -- see "missing_files". Both
  // columns are in the select above, so a row always carries them
  // (null when empty). Only a book never published: an older book that
  // was live once keeps the rules it was published under (audit r1, F2).
  // BD16 P2 (D5): a pre-order listing's manuscript may come later.
  if (
    book.published_at === null &&
    ((!preorderListing && (book.file_path === null || book.file_path === "")) ||
      book.cover_path === null ||
      book.cover_path === "")
  ) {
    return { ok: false, reason: "missing_files" };
  }

  // ADMIN-3-REVIEW (M2): the gate itself now lives in ONE shared helper,
  // checkPublishGate() (src/lib/publish-readiness.ts), so the staff
  // Approve action re-runs exactly these checks in exactly this order.
  // The history of each rule, unchanged:
  //
  //   ALL-WIRING-2: the catalog price is read fresh from the book's own
  //   row -- never trusted from the client -- and classified three ways.
  //   A book with no authored ALL price cannot be published at any
  //   permission level: there is no price for a reader to be shown and
  //   none for a checkout to freeze. This is a refusal to publish, NOT an
  //   unpublish -- an already-published legacy row with a null price stays
  //   published and stays reachable; nothing in this function or anywhere
  //   else in this patch moves a row back to draft.
  //   FIX1 (X16): Renato's rule, a description before Publish. A refusal
  //   only: an already-published book without one is never moved back to
  //   draft, and saving a draft without one is untouched.
  //   F4 (P4): Renato's rule, a rights choice before Publish -- read with
  //   the author's own session, three ways (book-rights.ts). A refusal
  //   only: an already-published book is never moved back to draft.
  //   Only a book that will actually be sold needs paid-publishing
  //   authorization at all -- so a FREE (price_all = 0) title publishes
  //   here exactly as it always has, with no paid-mode permission
  //   involved.
  //   PAID-MODE-1 / PR-G: whether Librum may publish a PAID title at all
  //   is a product permission, decided HERE -- after the book's own
  //   server-read `price_all` proves this title is paid. Since PR G this
  //   is the SOLE authorization for paid publishing, and while
  //   PAID_PUBLISHING_MODE is absent it denies everywhere.
  //
  //   The legacy profiles.stripe_payouts_enabled prerequisite that used
  //   to sit below it is gone: it is provider-specific author-payout
  //   state, and provider-specific payout state is not a valid
  //   permission to publish a priced title. (Stripe itself, with the
  //   Connect code and webhook that could set the flag, has since been
  //   removed.) Removing it does not weaken this gate:
  //   canPublishPaidTitle() still denies in every environment where
  //   PAID_PUBLISHING_MODE is unset, which is everywhere today.
  //
  //   Consequence worth stating plainly: performPublish() now reads no
  //   `profiles` row at ANY price. A denial costs no database query and
  //   cannot be used to probe another author's state -- the property the
  //   old ordering bought, now unconditional.
  const gate = await checkPublishGate({
    priceAll: book.price_all,
    description: book.description,
    readRights: async () => (await getRightsDeclarationState(bookId)).kind,
    paidPublishingAvailable: canPublishPaidTitle,
  });
  if (!gate.ok) {
    return { ok: false, reason: gate.reason };
  }

  // ADMIN-3-REVIEW (A, M5): every author-fixable and permission gate has
  // passed. A draft whose current files Librum has not approved is sent
  // for review instead of published; a draft with a valid approval (3a)
  // and an already-published book continue below exactly as before.
  // Read with the author's own session (book_review_state checks the
  // caller owns the book); fails closed.
  if (book.status !== "published") {
    const reviewState = await getBookReviewState(supabase, bookId);
    if (reviewState.kind === "unavailable") {
      return { ok: false, reason: "review_unavailable" };
    }
    // BD16 P2: a pre-order listing always goes to review (the database
    // skips the "already approved" answer for it, too).
    if (!reviewState.approvalValid || preorderListing) {
      const request = await requestBookReview(supabase, bookId);
      if (request.ok) {
        // ADMIN-ALERTS-1: best effort, never throws.
        await sendReviewRequestedStaffEmail({ bookId, authorId: userId });
        return { ok: true, outcome: "sent_for_review", preorder: preorderListing };
      }
      if (
        request.reason === "preorder_date" ||
        request.reason === "preorder_used_up" ||
        request.reason === "preorder_public_domain"
      ) {
        return { ok: false, reason: request.reason };
      }
      // A listing is never published here, whatever the answer.
      if (preorderListing && request.reason === "already_approved") {
        return { ok: false, reason: "review_unavailable" };
      }
      if (request.reason === "already_pending") {
        return { ok: false, reason: "already_in_review" };
      }
      if (request.reason === "taken_down") {
        return { ok: false, reason: "taken_down" };
      }
      // BD15 P5a: the database's own check (LB489) -- the manuscript,
      // the cover or the AI answer went missing after the app's check.
      if (request.reason === "incomplete") {
        return { ok: false, reason: "send_incomplete" };
      }
      // "already_approved": an approval landed after the read above, so
      // the publish below goes ahead (the trigger re-checks it).
      if (request.reason !== "already_approved") {
        return { ok: false, reason: "review_unavailable" };
      }
    }
  }

  // Only a genuine FIRST publication should notify followers --
  // otherwise every unpublish/republish toggle would spam them again.
  // `status` alone can't distinguish "never published before" from "was
  // unpublished, is now republishing" -- both read status === "draft"
  // here. published_at can: it is set exactly once, on first publish
  // (immediately below), and unpublishBook() never clears it (see that
  // function's own comment), so a non-null published_at read BEFORE this
  // update is authoritative proof this book has already been published
  // at least once before.
  const isFirstPublication = book.published_at == null;

  const updatePayload: { status: "published"; published_at?: string } = { status: "published" };
  if (isFirstPublication) {
    updatePayload.published_at = new Date().toISOString();
  }

  // PAID-REPRICING-1: compare-and-set. Every decision above was made
  // from the status and `price_all` read at the top of this function, so
  // the write lands only if the row is STILL in exactly that state. A
  // concurrent price save that made a free draft paid in between leaves
  // this publish matching no row, instead of publishing a paid title the
  // paid-mode check above never saw. `.select("id")` is what proves one
  // row changed; zero rows is a failure, never a publish.
  //
  // CATALOG-WRITE-AUTH-1: `status` and `published_at` are protected
  // columns, so this write goes through the trusted catalog-write client,
  // created only now -- after the recovery check, the ownership-scoped
  // read, the price classification and the paid-publishing permission
  // above have all passed. The read stays on the author's session.
  //
  // F4 (N1): the write also requires a non-empty description, so a draft
  // edit that clears it after the read above leaves this publish matching
  // no row (update_failed) instead of publishing a book with none. Both
  // writers trim, so "" is the only empty stored form.
  const catalogWriter = createCatalogWriteClient();
  const { data: publishedRows, error } = await applyCatalogRowGuard(
    catalogWriter.from("books").update(updatePayload).eq("id", bookId).eq("author_id", userId),
    { status: book.status, priceAll: book.price_all },
  )
    .not("description", "is", null)
    .neq("description", "")
    .select("id");

  if (error) {
    // ADMIN-2-TAKEDOWN: the lock trigger (LB460) caught a takedown that
    // landed after the read above.
    if (error.code === "LB460") {
      return { ok: false, reason: "taken_down" };
    }
    // ADMIN-3-REVIEW (S3): the approval no longer matches the files
    // (LB462), or the live files changed (LB463), after the reads above.
    if (error.code === "LB462" || error.code === "LB463") {
      return { ok: false, reason: "book_changed" };
    }
    return { ok: false, reason: "update_failed" };
  }
  if (!isExactlyOneRowWritten(publishedRows)) {
    console.error("performPublish: guarded publish did not change exactly one row", { bookId });
    return { ok: false, reason: "update_failed" };
  }

  // F5 (C5 self-heal): a real draft -> published transition never brings
  // back a "Librum's choice" pick an earlier unpublish failed to clear.
  // Keyed on the status read above, not on isFirstPublication: a write
  // to an already-published book (which may be the valid pick) clears
  // nothing. No status/price compare-and-set here -- after the publish
  // above, `status = 'draft'` would match no row.
  if (book.status !== "published") {
    await clearOwnBookLibrumChoice(catalogWriter, bookId, userId, "performPublish");
  }

  return { ok: true, outcome: "published", wasNewlyPublished: isFirstPublication };
}

// F5 (C5, Renato 10:25Z): an unpublished book loses its "Librum's choice"
// pick and never gets it back by itself. Runs only after the caller's
// own auth, ownership read and guarded status write have succeeded, and
// reuses the catalog writer that caller already created after those
// checks (authenticated has no UPDATE on librum_choice_at). The filters
// reach at most this one book, owned by the caller, and only its pick
// column; it can only clear, never set. The RPC clear_librum_choice is
// not used: it clears whatever is picked, so a race could clear a newer
// pick of another book.
//
// catalog-write-client.ts rule 3's audited exception: 0 rows is the
// normal case (the book is not picked), so there is no
// isExactlyOneRowWritten and no log on 0 rows. Best effort: before the
// migration the column is missing (feature off, warned once); any other
// error is logged and never turns the caller's successful write into a
// failure -- getLibrumChoiceBook() still hides an unpublished pick.
async function clearOwnBookLibrumChoice(
  catalogWriter: ReturnType<typeof createCatalogWriteClient>,
  bookId: string,
  userId: string,
  caller: string,
): Promise<void> {
  try {
    const { error } = await catalogWriter
      .from("books")
      .update({ librum_choice_at: null })
      .eq("id", bookId)
      .eq("author_id", userId)
      .not("librum_choice_at", "is", null);
    if (error) {
      if (isSchemaFeatureOffError(error)) {
        logSchemaFeatureOffOnce("Librum's choice", error);
      } else {
        console.error(`${caller}: clearing the Librum's choice pick failed`, { bookId, error });
      }
    }
  } catch (error) {
    console.error(`${caller}: clearing the Librum's choice pick failed`, { bookId, error });
  }
}

// PHASE-2C bundle-membership-integrity: shared by unpublishBook() and
// deleteBook() below. A book's publish state (and its very existence)
// is part of the composition of any bundle it's currently a member of
// -- if that bundle is itself published, an unrelated author action
// here (unpublishing or deleting the underlying book) must not silently
// shrink or invalidate what a published, publicly-listed bundle
// advertises to buyers. This is the mutation-time half of the defense;
// create_bundle_checkout_snapshot() (supabase/schema.sql) is the
// matching checkout-time half, guarding the same invariant from the
// other direction (a bundle whose membership already drifted invalid
// through some other path, e.g. before this check existed).
//
// Both the caller-provided bookId and the exact scope of this query are
// deliberately ownership-agnostic on their own -- callers below MUST
// confirm the caller owns bookId before invoking this, so that a
// published-bundle "yes"/"no" answer (the only thing this returns) is
// never disclosed for a book the caller doesn't own.
//
// Fails CLOSED on a genuine read error: `data` and `error` are always
// inspected separately (never conflated), and any real query failure
// returns `{ok: false}` -- treated by both callers as "block the
// mutation," never silently coerced into "not in any published
// bundle," which would let the very failure this check exists to catch
// instead defeat it.
type PublishedBundleMembershipCheck =
  | { ok: true; inPublishedBundle: boolean }
  | { ok: false };

async function bookBelongsToPublishedBundle(
  supabase: Awaited<ReturnType<typeof createClient>>,
  bookId: string,
): Promise<PublishedBundleMembershipCheck> {
  const { data, error } = await supabase
    .from("bundle_books")
    .select("bundle_id, bundles!inner(status)")
    .eq("book_id", bookId)
    .eq("bundles.status", "published");

  if (error) {
    console.error("bookBelongsToPublishedBundle: membership read failed", { bookId, error });
    return { ok: false };
  }

  return { ok: true, inPublishedBundle: (data?.length ?? 0) > 0 };
}

export async function unpublishBook(bookId: string) {
  // AUTH-1C: defense-in-depth -- Proxy already blocks /dashboard/*
  // while a recovery session is active, so this is the second layer
  // against a crafted direct POST. A book's publish state is a public,
  // buyer-facing change, so this runs before any Supabase call, matching
  // buyBook's/buyBundle's own placement.
  //
  // ALL-CUTOVER APP-A: the maintenance gate runs first of all, before
  // even the recovery-session check above it in this comment's own
  // ordering -- unpublishing touches bundle-membership validation
  // (migration 058) against columns this cutover renames.
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    redirectForMaintenance("/dashboard");
  }

  await redirectIfRecoverySessionActive();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // Ownership-scoped existence check, added by PHASE-2C so the
  // published-bundle membership check just below never runs for (and
  // therefore never discloses anything about) a book this caller
  // doesn't own -- see bookBelongsToPublishedBundle()'s own comment.
  // `.maybeSingle()` distinguishes an ordinary "no such book, or not
  // owned by this author" ({data: null, error: null}) from a genuine
  // read failure, exactly like every other fail-closed read in this
  // codebase.
  const { data: book, error: bookReadError } = await supabase
    .from("books")
    .select("id, status")
    .eq("id", bookId)
    .eq("author_id", user.id)
    .maybeSingle<{ id: string; status: string }>();

  if (bookReadError) {
    console.error("unpublishBook: book read failed", { bookId, error: bookReadError });
    redirect(`/dashboard?error=${encodeURIComponent("Ky libër nuk mund të hiqet nga publikimi tani")}`);
  }
  if (!book) {
    redirect("/dashboard");
  }
  // BD16 P2: a pre-order is cancelled with its own confirmation
  // (cancelPreorder), never through "Hiqeni nga shitja".
  if (book.status === "preorder") {
    redirect(withQuery(editorPath(bookId, "details"), "error", PREORDER_UNPUBLISH_REFUSED_MESSAGE));
  }

  // PHASE-2C: a book that's a member of a currently published bundle
  // can't be unpublished out from under it -- the bundle would then be
  // advertising and selling a book that's no longer actually available.
  // The author must unpublish or edit (remove this book from) the
  // bundle first. Fails closed on a genuine read error -- see
  // bookBelongsToPublishedBundle()'s own comment.
  const membership = await bookBelongsToPublishedBundle(supabase, bookId);
  if (!membership.ok) {
    redirect(`/dashboard?error=${encodeURIComponent("Ky libër nuk mund të hiqet nga publikimi tani")}`);
  }
  if (membership.inPublishedBundle) {
    redirect(
      `/dashboard?error=${encodeURIComponent("Ky libër është pjesë e një pakete të publikuar. Hiqeni paketën nga publikimi ose ndryshojeni atë fillimisht")}`,
    );
  }

  // `.select("id")` is required, not cosmetic -- a plain
  // `.update(...).eq(...)` with no `.select()` returns `data: null` even
  // when it succeeds, so it can't prove the mutation actually affected
  // the row this function just verified ownership of. Mirrors the same
  // pattern already used in performBundlePublish() (dashboard/bundles/
  // actions.ts) and buyBundle()'s own link-back update.
  //
  // CATALOG-WRITE-AUTH-1: `status` is a protected column, so the write
  // goes through the trusted catalog-write client, created only after the
  // ownership read and the published-bundle membership check above.
  const catalogWriter = createCatalogWriteClient();
  const { data: updatedRows, error: updateError } = await catalogWriter
    .from("books")
    .update({ status: "draft" })
    .eq("id", bookId)
    .eq("author_id", user.id)
    .select("id");

  if (updateError) {
    console.error("unpublishBook: update failed", { bookId, error: updateError });
    redirect(`/dashboard?error=${encodeURIComponent("Ky libër nuk mund të hiqet nga publikimi tani")}`);
  }
  if (!isExactlyOneRowWritten(updatedRows)) {
    console.error("unpublishBook: update did not change exactly one row", { bookId, userId: user.id });
    redirect(`/dashboard?error=${encodeURIComponent("Ky libër nuk mund të hiqet nga publikimi tani")}`);
  }

  // F5 (C5): the unpublish above succeeded, so this book stops being
  // Librum's choice (best effort, see clearOwnBookLibrumChoice).
  await clearOwnBookLibrumChoice(catalogWriter, bookId, user.id, "unpublishBook");

  revalidatePath("/dashboard");
  revalidatePath("/");
  // BD15 P5b-3a: "Hiqeni nga shitja" sits in the editor's Veprime box;
  // the book opens there again as a draft, with what happened.
  redirect(withQuery(editorPath(bookId, "details"), "success", UNPUBLISHED_MESSAGE));
}

export async function deleteBook(bookId: string) {
  // AUTH-1C: defense-in-depth -- Proxy already blocks /dashboard/*
  // while a recovery session is active, so this is the second layer
  // against a crafted direct POST. Book deletion is irreversible, so
  // this runs before any Supabase call, matching buyBook's/buyBundle's
  // own placement.
  //
  // ALL-CUTOVER APP-A: the maintenance gate runs first of all -- book
  // deletion cascades into purchases/discount_codes/bundle_books rows
  // this cutover renames or purges.
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    redirectForMaintenance("/dashboard");
  }

  await redirectIfRecoverySessionActive();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // BOOK-STORAGE-MUTATION-AUTH-1: `id` and `author_id` join the read so
  // the keys removed below are classified against this exact row, which
  // must be exactly the id the caller named. A read error, no row or any
  // mismatch stops here, before any write.
  const { data: book, error: bookError } = await supabase
    .from("books")
    .select("id, author_id, status, cover_path, file_path")
    .eq("id", bookId)
    .eq("author_id", user.id)
    .single();

  if (bookError || !book || book.id !== bookId || book.author_id !== user.id) {
    redirect("/dashboard");
  }

  // Renato 11-05 (P6 Q4 a): only a draft is ever deleted. A live book is
  // taken off sale first ("Hiqeni nga shitja"); the editor and the
  // Dashboard menu hide Delete on one, and this refuses a direct POST.
  // The delete below also filters on status = draft, so a book Librum
  // approves after this read is not deleted either.
  if (book.status !== "draft") {
    redirect(
      `/dashboard?error=${encodeURIComponent(book.status === "preorder" ? PREORDER_DELETE_NOTE : LIVE_DELETE_REFUSED_MESSAGE)}`,
    );
  }

  // ADMIN-2-TAKEDOWN (M5, Renato's Q8 = a): a taken-down book can't be
  // deleted until Librum has reviewed it. This is the friendly answer;
  // the database refuses a direct delete as well (LB461, audit A1 = a),
  // while account deletion's cascade still goes through. The takedown
  // record survives a deletion (book_id set null, title kept). Read with
  // the author's own session, after the ownership check; fails closed.
  const takedown = await getActiveTakedownState(supabase, bookId);
  if (takedown.kind === "active") {
    redirect(`/dashboard?error=${encodeURIComponent(TAKEN_DOWN_DELETE_MESSAGE)}`);
  }
  if (takedown.kind === "unavailable") {
    redirect(`/dashboard?error=${encodeURIComponent("Ky libër nuk mund të fshihet tani")}`);
  }

  // PHASE-2C: a book that's a member of a currently published bundle
  // can't be deleted out from under it, for the same reason it can't be
  // unpublished (see unpublishBook()'s own comment) -- deleting the
  // book would additionally cascade-remove its bundle_books row
  // (bundle_books.book_id references public.books(id) on delete
  // cascade) with no revalidation of the owning bundle's status at all,
  // silently narrowing what that published bundle advertises. Checked
  // BEFORE the purchases check below -- and uses a distinct message
  // from it -- since these are two independent reasons a book can't be
  // deleted right now; a book referenced only by draft (or no) bundles
  // is unaffected and may still be deleted normally, exactly as before
  // this check existed. Fails closed on a genuine read error -- see
  // bookBelongsToPublishedBundle()'s own comment.
  const membership = await bookBelongsToPublishedBundle(supabase, bookId);
  if (!membership.ok) {
    redirect(`/dashboard?error=${encodeURIComponent("Ky libër nuk mund të fshihet tani")}`);
  }
  if (membership.inPublishedBundle) {
    redirect(
      `/dashboard?error=${encodeURIComponent("Ky libër është pjesë e një pakete të publikuar. Hiqeni paketën nga publikimi ose hiqeni librin nga paketa fillimisht")}`,
    );
  }

  // A book with ANY acquisition history -- paid, free, or refunded --
  // must never be hard-deletable: those purchases rows are readers'
  // permanent record of ownership. count/head avoids reading the rows
  // themselves; the "Authors can view purchases of their own books" RLS
  // policy already lets this count run as the owning author. Unpublish
  // is the only removal path once any row exists (the database itself
  // also enforces this via purchases.book_id's foreign key -- see
  // supabase/migrations -- so this app-level check is a UX nicety on
  // top of a real, authoritative guarantee, not the only thing standing
  // between a book and its buyers' purchase history).
  // PEN-NAMES-2 [23b]: counted through author_book_purchases, which
  // replaced the author policy on purchases.
  const { count: purchaseCount } = await supabase
    .from("author_book_purchases")
    .select("id", { count: "exact", head: true })
    .eq("book_id", bookId);

  if ((purchaseCount ?? 0) > 0) {
    redirect(
      `/dashboard?error=${encodeURIComponent("Këtë libër e kanë marrë lexues dhe nuk mund të fshihet. Hiqeni nga publikimi")}`,
    );
  }

  // ADMIN-3-REVIEW (N3, P5): every manuscript key this book's review
  // history names (a superseded approved file, a stale snapshot) is read
  // NOW, with the trusted client -- authors cannot read review paths, and
  // the rows lose their book_id once the book is gone. A failed read
  // stops the deletion (fail closed), so nothing is ever orphaned
  // silently.
  const catalogWriter = createCatalogWriteClient();
  const snapshots = await readReviewSnapshots(catalogWriter, [book.id]);
  if (!snapshots.ok) {
    redirect(`/dashboard?error=${encodeURIComponent("Ky libër nuk mund të fshihet tani")}`);
  }
  // BD15 P5b-2: a live book's waiting changes (the row goes with the
  // book) may name a manuscript and a ballinë nothing else does.
  const pendingAtDelete = await readPendingChanges(catalogWriter, book.id);
  if (!pendingAtDelete.ok) {
    redirect(`/dashboard?error=${encodeURIComponent("Ky libër nuk mund të fshihet tani")}`);
  }

  // The books row is deleted BEFORE any storage cleanup is attempted --
  // deliberately, not incidentally. The count check above is only an
  // advisory, point-in-time snapshot: a reader could acquire this book
  // in the window between that check and this delete. Once migration
  // 023 is applied, purchases.book_id's ON DELETE RESTRICT makes this
  // delete itself the authoritative, race-proof guard -- it will fail
  // if a purchase now exists, and because it runs first, no file has
  // been touched yet if that happens. Deleting storage first would risk
  // destroying a legitimate new buyer's manuscript even though their
  // purchase record (and the book row) end up surviving.
  //
  // BOOK-STORAGE-MUTATION-AUTH-1: `.select("id")` because a delete that
  // matched no row is not an error to PostgREST. Only exactly this one
  // returned row proves the book is gone; anything else touches no
  // Storage object.
  const { data: deletedRows, error: deleteError } = await supabase
    .from("books")
    .delete()
    .eq("id", book.id)
    .eq("author_id", user.id)
    .eq("status", "draft")
    .select("id");

  if (deleteError) {
    // 23503 is Postgres's foreign_key_violation code -- once migration
    // 023 is applied, this is exactly the race this whole ordering
    // exists to catch: a purchase appeared after the advisory count
    // check above but before this delete ran, and purchases.book_id's
    // ON DELETE RESTRICT rejected the delete to protect it. That's the
    // same "acquired by readers" case as the earlier check, not a
    // generic failure, so it gets the same friendly message rather than
    // a raw constraint-violation string.
    if (deleteError.code === "23503") {
      redirect(
        `/dashboard?error=${encodeURIComponent("Këtë libër e kanë marrë lexues dhe nuk mund të fshihet. Hiqeni nga publikimi")}`,
      );
    }
    // ADMIN-2-TAKEDOWN: the delete-lock trigger (LB461) caught a
    // takedown that landed after the read above.
    if (deleteError.code === "LB461") {
      redirect(`/dashboard?error=${encodeURIComponent(TAKEN_DOWN_DELETE_MESSAGE)}`);
    }
    redirect(`/dashboard?error=${encodeURIComponent("Ky libër nuk mund të fshihet tani")}`);
  }

  if (!isExactlyOneRowWritten(deletedRows) || deletedRows?.[0]?.id !== book.id) {
    console.error("deleteBook: delete did not remove exactly this one row", {
      bookId: book.id,
      rowCount: Array.isArray(deletedRows) ? deletedRows.length : null,
    });
    redirect(`/dashboard?error=${encodeURIComponent("Ky libër nuk mund të fshihet tani")}`);
  }

  // The book row is gone at this point -- from the author's perspective
  // the deletion already succeeded. Any failure past here is an orphan
  // storage file to clean up later, not a failed book deletion, so it's
  // logged rather than surfaced as an error, and the row is never
  // recreated to "undo" a partially-completed cleanup.
  //
  // BOOK-STORAGE-MUTATION-AUTH-1: only this author's own canonical (or
  // documented legacy, or -- PEN-2 -- new random-folder key read from this
  // own row) cover key and own canonical manuscript key for
  // THIS book are removed -- never merely something under the author's
  // folder. Any other stored value is left in place and only counted: an
  // orphaned object is always preferable to deleting another book's or
  // another author's file.
  const removals: BookStorageRemoval[] = [];
  let unsafeStoredPathCount = 0;
  if (book.cover_path !== null) {
    if (classifyBookCoverPath(book.cover_path, user.id, book.id) !== "unsafe") {
      removals.push({ bucket: BOOK_COVERS_BUCKET, path: book.cover_path });
    } else {
      unsafeStoredPathCount += 1;
    }
  }
  if (book.file_path !== null && !isOwnBookManuscriptPath(book.file_path, user.id, book.id)) {
    unsafeStoredPathCount += 1;
  }
  // ADMIN-3-REVIEW: the current manuscript (canonical or versioned key)
  // and every own key the review snapshots name; removed with the
  // trusted catalog writer (M1: no author delete outside "<uid>/tmp/").
  for (const path of deletedBookManuscriptKeys({
    authorId: user.id,
    bookId: book.id,
    currentFilePath: book.file_path,
    reviews: snapshots.byBook.get(book.id) ?? [],
  })) {
    removals.push({ bucket: BOOK_MANUSCRIPTS_BUCKET, path });
  }
  const pendingFiles = pendingAtDelete.pending;
  if (pendingFiles) {
    if (
      pendingFiles.filePath !== null &&
      isOwnBookManuscriptPath(pendingFiles.filePath, user.id, book.id) &&
      !removals.some((r) => r.path === pendingFiles.filePath)
    ) {
      removals.push({ bucket: BOOK_MANUSCRIPTS_BUCKET, path: pendingFiles.filePath });
    }
    if (
      pendingFiles.coverPath !== null &&
      pendingFiles.coverPath !== book.cover_path &&
      isNewBookCoverPath(pendingFiles.coverPath)
    ) {
      removals.push({ bucket: BOOK_COVERS_BUCKET, path: pendingFiles.coverPath });
    }
  }
  if (unsafeStoredPathCount > 0) {
    console.warn("deleteBook: stored paths that are not this book's own keys were left untouched", {
      bookId: book.id,
      unsafeStoredPathCount,
    });
  }
  await removeProvenBookStorageObjects(supabase, removals, "deleteBook");

  revalidatePath("/dashboard");
  revalidatePath("/");
  // BD15 P5b-3b: the editor of a deleted book would answer 404.
  redirect(withQuery("/dashboard", "success", BOOK_DELETED_MESSAGE));
}

// BD16 P2 (Q3 b): the author cancels a live pre-order. It goes back to
// draft; books_preorder_rules (P1) clears its day, sets
// preorder_cancelled_at and marks every waiting reader for the one
// "cancelled" email (Q4 a, sent by the daily job, P5); its waiting review
// is cancelled and its waiting changes become the draft (as any book
// going offline). It may be pre-ordered again while it has had fewer
// than 2 (Q3b a). A required tick confirms it. The write goes through the
// trusted writer (status is protected), bound to the caller's own book
// and to status 'preorder', so a book released meanwhile is untouched.
export async function cancelPreorder(bookId: string, formData: FormData) {
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    redirectForMaintenance(`/dashboard/books/${bookId}/editor`);
  }
  await redirectIfRecoverySessionActive();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login");
  }

  const here = editorPath(bookId, "details");
  const { data: book, error: readError } = await supabase
    .from("books")
    .select("id, author_id, status")
    .eq("id", bookId)
    .eq("author_id", user.id)
    .maybeSingle<{ id: string; author_id: string; status: string }>();
  if (readError || !book || book.id !== bookId || book.author_id !== user.id) {
    redirect("/dashboard");
  }
  if (book.status !== "preorder") redirect(withQuery(here, "error", PREORDER_NOT_PREORDER_MESSAGE));
  if (formData.get(CANCEL_PREORDER_CONFIRM_FIELD) !== "yes") {
    redirect(withQuery(here, "error", CANCEL_PREORDER_CONFIRM_MISSING_MESSAGE));
  }

  const catalogWriter = createCatalogWriteClient();
  const { data: rows, error } = await catalogWriter
    .from("books")
    .update({ status: "draft" })
    .eq("id", bookId)
    .eq("author_id", user.id)
    .eq("status", "preorder")
    .select("id");
  if (error) {
    console.error("cancelPreorder: update failed", { bookId, code: error.code ?? null });
    redirect(withQuery(here, "error", "Parapublikimi nuk mund të anulohet tani. Provoni përsëri"));
  }
  if (!isExactlyOneRowWritten(rows)) redirect(withQuery(here, "error", PREORDER_NOT_PREORDER_MESSAGE));

  // As unpublishBook: it stops being Librum's choice (best effort).
  await clearOwnBookLibrumChoice(catalogWriter, bookId, user.id, "cancelPreorder");

  revalidatePath("/dashboard");
  revalidatePath("/");
  redirect(withQuery(here, "success", PREORDER_CANCELLED_MESSAGE));
}

// BD16 P2 (Q2 a): the author moves the release day once, 1 to 30 days
// later, until the final file's due date. push_preorder_release_date
// (P1) checks every rule again with the author's own session (LB504)
// and marks the one slip used.
export async function pushPreorderDate(bookId: string, formData: FormData) {
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    redirectForMaintenance(`/dashboard/books/${bookId}/editor`);
  }
  await redirectIfRecoverySessionActive();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login");
  }

  const here = editorPath(bookId, "details");
  const { data: book, error: readError } = await supabase
    .from("books")
    .select("id, author_id, status, release_date")
    .eq("id", bookId)
    .eq("author_id", user.id)
    .maybeSingle<{ id: string; author_id: string; status: string; release_date: string | null }>();
  if (readError || !book || book.id !== bookId || book.author_id !== user.id) {
    redirect("/dashboard");
  }
  if (book.status !== "preorder" || book.release_date === null) {
    redirect(withQuery(here, "error", PREORDER_NOT_PREORDER_MESSAGE));
  }
  const wanted = parseDay(formData.get(RELEASE_DATE_FIELD));
  if (wanted === null || !isValidPushDate(book.release_date, wanted)) {
    redirect(withQuery(here, "error", PUSH_INVALID_MESSAGE));
  }

  const { error } = await supabase.rpc("push_preorder_release_date", {
    p_book_id: bookId,
    p_release_date: wanted,
  });
  if (error) {
    if (error.code === "LB504") redirect(withQuery(here, "error", PUSH_REFUSED_MESSAGE));
    console.error("pushPreorderDate: push failed", { bookId, code: error.code ?? null });
    redirect(withQuery(here, "error", "Data nuk mund të shtyhet tani. Provoni përsëri"));
  }

  revalidatePath("/dashboard");
  revalidatePath(`/libra/${bookId}`);
  redirect(withQuery(here, "success", PUSH_DONE_MESSAGE));
}
