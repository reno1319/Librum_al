"use server";

import { randomUUID } from "crypto";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createCatalogWriteClient } from "@/lib/catalog-write-client";
import { GENRES } from "@/lib/genres";
import { isSupportedLanguage } from "@/lib/languages";
import { CONTRIBUTOR_ROLES } from "@/lib/contributor-roles";
import { sendNewBookEmails } from "@/lib/email";
import { sendReviewRequestedStaffEmail } from "@/lib/staff-alerts";
import { detectCoverImageKind, resolveVerifiedCoverStorageDetails } from "@/lib/cover-image";
import { BOOK_COVER_SIZE, IMAGE_CACHE_CONTROL_SECONDS, shrinkImageToJpeg } from "@/lib/cover-resize";
import { validateEpubStructure, type EpubValidationResult } from "@/lib/epub-validation";
import { redirectIfRecoverySessionActive } from "@/lib/recovery-guard";
import { resolveMaintenanceMode } from "@/lib/maintenance-mode";
import { canPublishPaidTitle } from "@/lib/paid-readiness";
import { checkPublishGate } from "@/lib/publish-readiness";
import { INVALID_ISBN_MESSAGE, isValidIsbn } from "@/lib/book-identifiers";
import { getRightsDeclarationState, recordRightsDeclaration } from "@/lib/book-rights";
import { resolveOwnPenNameId } from "@/lib/pen-name-write-client";
import { penNameErrorMessage } from "@/lib/pen-names";
import { isRightsBasis } from "@/lib/rights-statements";
import { getActiveTakedownState } from "@/lib/book-takedowns";
import { TAKEN_DOWN_DELETE_MESSAGE, TAKEN_DOWN_PUBLISH_MESSAGE } from "@/lib/takedown-reasons";
import {
  CATALOG_ROW_CHANGED_MESSAGE,
  PAID_REPRICING_UNAVAILABLE_MESSAGE,
  applyCatalogRowGuard,
  catalogRowGuard,
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
  readReviewSnapshots,
  removeUnretainedManuscripts,
  requestBookReview,
  withdrawBookReview,
} from "@/lib/book-reviews";
import {
  ALREADY_IN_REVIEW_MESSAGE,
  BOOK_CHANGED_WHILE_EDITING_MESSAGE,
  LIVE_FILES_IN_BUNDLE_MESSAGE,
  LIVE_FILES_REQUEST_FAILED_MESSAGE,
  LIVE_FILES_SAVED_MESSAGE,
  NOT_IN_REVIEW_MESSAGE,
  REVIEW_CANCELLED_MESSAGE,
  SENT_FOR_REVIEW_MESSAGE,
} from "@/lib/book-review-copy";
import {
  MAXIMUM_CATALOG_PRICE_ALL,
  MINIMUM_PAID_CATALOG_PRICE_ALL,
  parseCatalogPriceAll,
} from "@/lib/catalog-price";
import {
  isLivePriceChange,
  isPriceChangeConfirmed,
  PRICE_CHANGE_CONFIRM_MESSAGE,
} from "@/lib/price-change-confirm";

// ALL-WIRING-2: one message for every rejected catalog price, built
// from the module's own constants so it can never drift from the rule
// it describes. Deliberately states the whole accepted domain rather
// than diagnosing which part of the input failed -- an author who typed
// "9.99" needs to learn the shape of a Librum price, not that character
// four was unexpected.
const MISSING_ALL_PRICE_MESSAGE =
  "Set this book's price in lek before publishing it.";

// FIX1 (X16): Renato's W-B wording. True on the one path that shows it
// (createBook's intent=publish), because that path inserts the draft
// before performPublish refuses; publishBook's own refusal names only
// the first sentence, since there the book already is a draft.
const MISSING_DESCRIPTION_MESSAGE =
  "Add a description before publishing. Your book will still be saved as a draft.";
const MISSING_DESCRIPTION_SHORT_MESSAGE = "Add a description before publishing.";

// F4 (P4): Renato's rule, a rights choice before Publish. The same
// sentence on both publish paths; createBook adds "Saved as draft" as
// its success line, as for the missing description.
const MISSING_RIGHTS_MESSAGE = "Choose the rights before publishing.";

// F4 (D3): the existing generic refusal, also used when the rights
// choice cannot be read at all (before the migration, or a read error).
const PUBLISH_NOT_POSSIBLE_YET_QUERY =
  "We+couldn%27t+publish+your+book+yet.+Please+try+again+from+your+dashboard";

// F4 (P6): a published book cannot have its description cleared.
const PUBLISHED_NEEDS_DESCRIPTION_MESSAGE = "A published book needs a description.";

// The existing contributor failure sentence, shared by addContributor and
// Add a book's Translator field (F4, P2).
const ADD_CONTRIBUTOR_ERROR_MESSAGE = "We couldn't add the contributor. Please try again.";

// F4 (P2): the Translator field's bound (its input's maxLength). Over it,
// nothing is inserted and the contributor message applies.
const TRANSLATOR_MAX_LENGTH = 120;

const CATALOG_PRICE_ERROR_MESSAGE =
  `Enter your price in lek: 0 for a free ebook, or a whole number from ` +
  `${MINIMUM_PAID_CATALOG_PRICE_ALL} to ${MAXIMUM_CATALOG_PRICE_ALL}`;

const MAX_COVER_BYTES = 5 * 1024 * 1024;
const MAX_MANUSCRIPT_BYTES = 50 * 1024 * 1024;

// LIBRUM 2.0 PUBLISHING-UX-1 PART B: mirrors migration 044's own CHECK
// constraints exactly (see that migration's comment) -- a value that
// passes this can never fail at the database layer.
const SUBTITLE_MAX_LENGTH = 300;
const PUBLISHER_MAX_LENGTH = 200;
const EDITION_MAX_LENGTH = 100;

// Stored as a single comma-separated string (searched the same way as
// title/description) rather than a Postgres array — simpler to search
// and edit, and tags don't need to be a distinct type for this MVP.
function normalizeKeywords(raw: FormDataEntryValue | null): string {
  return String(raw ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean)
    .slice(0, 15)
    .join(", ");
}

// LIBRUM 2.0 PUBLISHING-UX-1 PART B FINAL PRE-COMMIT ROLLOUT-
// COMPATIBILITY CORRECTION: every one of the three resolvers below now
// reports `present` (formData.has(fieldName), never inferred from
// formData.get()'s own result) alongside the normalized `value` --
// same shape as this file's own pre-existing ResolvedManuscript/
// ResolvedCover types. createBook() only ever reads `.value` (absent
// and empty both legitimately mean "no value yet" for a brand-new
// row); updateBook() reads BOTH, since PUBLISHING-UX-1 is staged
// across three parts (Part B: server persistence, Part C: wizard UI
// for new books, Part D: Edit UI parity) -- an old Edit form that
// doesn't submit these fields yet must never wipe a value the Part-C
// wizard already saved, which formData.get()-only absent/empty
// conflation would have silently done the moment ANY existing field
// was edited through the old form. See updateBook()'s own comment at
// its update-payload call site for how `present` is actually used.
type ResolvedOptionalText = { present: boolean; value: string | null };

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
    // A literal "+"-joined query string, matching every other redirect
    // in this file (e.g. "Please+fill+in+every+field") -- fieldLabel is
    // always one of this file's own hardcoded call-site labels
    // ("Subtitle"/"Publisher"/"Edition"), never user input, so no
    // encoding is needed here.
    redirect(`${errorPath}?error=${fieldLabel}+must+be+${maxLength}+characters+or+fewer`);
  }
  return { present, value };
}

// Empty/absent is always valid -- this is the current wizard's own
// transitional-compatibility requirement (it doesn't submit a
// "language" field at all yet, and must keep working exactly as before
// until Part C adds one). A non-empty value must match the current
// LANGUAGES vocabulary (src/lib/languages.ts) -- never silently stored
// unrecognized. books.language itself carries no DB CHECK (see
// migration 044's own comment for why); this is the one real
// enforcement point.
function resolveLanguage(formData: FormData, errorPath: string): ResolvedOptionalText {
  const present = formData.has("language");
  const value = String(formData.get("language") ?? "").trim();
  if (!value) return { present, value: null };
  if (!isSupportedLanguage(value)) {
    redirect(`${errorPath}?error=Please+choose+a+supported+language`);
  }
  return { present, value };
}

// LIBRUM 2.0 PUBLISHING-UX-1 PART D FINAL PRE-COMMIT SERVER-SIDE
// UNCHANGED-LANGUAGE PRESERVATION CORRECTION: updateBook()-ONLY
// exception to resolveLanguage()'s own strict "must be in LANGUAGES"
// rule -- createBook() keeps calling resolveLanguage() directly, with
// no knowledge of this function, and can never accept an unsupported
// value for a brand-new row.
//
// books.language carries no DB CHECK (a book may already legitimately
// hold a code this deployed LANGUAGES doesn't recognize -- see
// migration 044's own comment), so an unrelated Edit save (e.g. fixing
// a typo in Description) must not force the author to either "fix" or
// silently lose that value merely by resubmitting the Edit form's own
// pre-populated select. This encodes ONLY "the author resubmitted the
// exact value already on this row, untouched" -- never "any
// unsupported value is now acceptable." A submitted value that differs
// from the existing row's own value is still rejected exactly as
// resolveLanguage() already does, whether it's unsupported OUTRIGHT
// (stored "sq", submitted "de") or unsupported and merely DIFFERENT
// from another already-unsupported stored value (stored "fr",
// submitted "de") -- preservation is never confused with "unsupported
// values are now validated."
//
// `existingLanguage` MUST come from the authoritative DB row already
// read for this update's own ownership check (see updateBook()'s own
// comment at that query) -- never from a hidden form field, client
// state, or query parameter, none of which a client could be trusted
// to report honestly.
type LanguageUpdateResolution =
  | { action: "omit" } // formData has no "language" key -- column untouched
  | { action: "clear" } // present, empty -- intentional clear to null
  | { action: "set"; value: string } // present, currently supported
  | { action: "preserve" }; // present, unsupported, === existing row's own value -- no-op

function resolveLanguageForUpdate(
  formData: FormData,
  existingLanguage: string | null,
  errorPath: string,
): LanguageUpdateResolution {
  if (!formData.has("language")) return { action: "omit" };

  const value = String(formData.get("language") ?? "").trim();
  if (!value) return { action: "clear" };
  if (isSupportedLanguage(value)) return { action: "set", value };

  if (value === existingLanguage) return { action: "preserve" };

  redirect(`${errorPath}?error=Please+choose+a+supported+language`);
}

// The author-supplied "originally published" date -- a genuinely
// different fact from published_at (Librum's own system-authoritative
// first-publish timestamp, set only by performPublish(), never read
// from form data at all -- see that function's own comment). Empty is
// always valid; a non-empty value must be a real calendar date,
// matching a native <input type="date">'s own "YYYY-MM-DD" shape, and
// may not be in the future -- "originally published" has no
// meaningful future value, and this field is explicitly not a
// scheduled-release mechanism (out of scope for PUBLISHING-UX-1
// entirely).
function resolveOriginalPublicationDate(formData: FormData, errorPath: string): ResolvedOptionalText {
  const present = formData.has("originalPublicationDate");
  const raw = String(formData.get("originalPublicationDate") ?? "").trim();
  if (!raw) return { present, value: null };

  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    redirect(`${errorPath}?error=Enter+a+valid+original+publication+date`);
  }

  const parsed = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
    redirect(`${errorPath}?error=Enter+a+valid+original+publication+date`);
  }

  if (parsed.getTime() > Date.now()) {
    redirect(`${errorPath}?error=Original+publication+date+can%27t+be+in+the+future`);
  }

  return { present, value: raw };
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
// createBook()/updateBook()'s own business rules ever see a
// difference -- neither function duplicates this logic.
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
// precedent for a dynamic-content message (see addContributor()'s own
// redirect further below) -- never exposing a ZIP-parser error, a
// stack trace, or an archive path either way.
function epubValidationErrorQuery(
  reason: Extract<EpubValidationResult, { valid: false }>["reason"],
): string {
  switch (reason) {
    case "too_many_entries":
    case "too_large_uncompressed":
    case "entry_too_large":
      return encodeURIComponent("The EPUB is too large or contains too many files.");
    case "encrypted_or_drm":
      return encodeURIComponent("This EPUB uses encryption/DRM that Librum does not support.");
    default:
      return "This+file+doesn%27t+appear+to+be+a+valid+EPUB";
  }
}

async function resolveManuscriptInput(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  formData: FormData,
  errorPath: string,
  // LIBRUM 2.0 EPUB-VALIDATION-1B: optional -- known and passed by
  // updateBook() (its own bookId parameter, available before this is
  // ever called), omitted by createBook() (bookId isn't generated
  // until after this resolves). Used only for the safe diagnostic log
  // below on a rejection; never affects validation or storage
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
        `${errorPath}?error=That+manuscript+reference+is+no+longer+valid.+Please+choose+your+file+again`,
      );
    }

    const { data, error: downloadError } = await supabase.storage
      .from("manuscripts")
      .download(tempPath);
    if (downloadError || !data) {
      console.error("resolveManuscriptInput: temp manuscript download failed:", downloadError);
      redirect(`${errorPath}?error=Could+not+read+your+uploaded+manuscript.+Please+try+again`);
    }

    bytes = Buffer.from(await data!.arrayBuffer());
    tempPathToCleanup = tempPath;
  } else {
    const manuscript = formData.get("manuscript") as File | null;
    if (!manuscript || manuscript.size === 0) {
      return { present: false };
    }
    if (!manuscript.name.toLowerCase().endsWith(".epub")) {
      redirect(`${errorPath}?error=The+manuscript+must+be+an+EPUB+file`);
    }
    bytes = Buffer.from(await manuscript.arrayBuffer());
  }

  // Defense in depth -- never trust client-side File.size (or the
  // browser's own pre-upload check) alone for bytes that came back
  // from a temp Storage download.
  if (bytes.length > MAX_MANUSCRIPT_BYTES) {
    redirect(`${errorPath}?error=Manuscript+must+be+under+50MB`);
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
    redirect(`${errorPath}?error=${epubValidationErrorQuery(manuscriptValidation.reason)}`);
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
      redirect(`${errorPath}?error=That+cover+reference+is+no+longer+valid.+Please+choose+your+file+again`);
    }

    const { data, error: downloadError } = await supabase.storage
      .from("manuscripts")
      .download(tempPath);
    if (downloadError || !data) {
      console.error("resolveCoverInput: temp cover download failed:", downloadError);
      redirect(`${errorPath}?error=Could+not+read+your+uploaded+cover.+Please+try+again`);
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
    redirect(`${errorPath}?error=Cover+image+must+be+under+5MB`);
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
    redirect(`${errorPath}?error=That+doesn%27t+look+like+a+valid+JPEG+or+PNG+image`);
  }
  // COVERS-1: the signature check above still gates what gets decoded;
  // the stored cover is always the shrunk JPEG, never the raw upload.
  const shrunk = await shrinkImageToJpeg(bytes, BOOK_COVER_SIZE);
  if (!shrunk) {
    redirect(`${errorPath}?error=Could+not+read+your+uploaded+cover.+Please+try+again`);
  }
  const { extension, contentType } = resolveVerifiedCoverStorageDetails("jpeg");

  return { present: true, bytes: shrunk!, extension, contentType, tempPathToCleanup };
}

// Confirms the chosen series actually belongs to this author (an empty
// selection is always valid — a book doesn't have to be in a series).
// Redirects back with an error rather than returning one, matching the
// other field validations in this file.
async function resolveSeriesSelection(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  formData: FormData,
  errorPath: string,
) {
  const seriesId = String(formData.get("seriesId") ?? "").trim() || null;
  if (!seriesId) {
    return { seriesId: null, seriesPosition: null };
  }

  const { data: series } = await supabase
    .from("series")
    .select("id")
    .eq("id", seriesId)
    .eq("author_id", userId)
    .maybeSingle();

  if (!series) {
    redirect(`${errorPath}?error=Choose+one+of+your+own+series`);
  }

  const rawPosition = String(formData.get("seriesPosition") ?? "").trim();
  const seriesPosition = rawPosition ? Number(rawPosition) : null;
  if (seriesPosition != null && (!Number.isInteger(seriesPosition) || seriesPosition < 1)) {
    redirect(`${errorPath}?error=Series+position+must+be+a+positive+whole+number`);
  }

  return { seriesId, seriesPosition };
}

// BOOK-STORAGE-MUTATION-AUTH-1: the one place createBook, updateBook
// and deleteBook hand stored or temporary keys to Storage for removal.
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

export async function createBook(formData: FormData) {
  // ALL-CUTOVER APP-A: catalog price is written by this action --
  // gated before any Supabase call.
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    redirectForMaintenance("/dashboard/books/new");
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const keywords = normalizeKeywords(formData.get("keywords"));
  const isbn = String(formData.get("isbn") ?? "").trim() || null;
  const genre = String(formData.get("genre") ?? "");
  // ALL-WIRING-2: the ONLY accepted parse of an author's catalog price.
  // `Math.round(Number(raw) * 100)` is gone -- it silently accepted
  // "1e3", " 7 ", 0.5 and every value in the unsellable 1..98 band, ran
  // the author's typed string through binary floating point, and wrote
  // the result into the legacy USD column. parseCatalogPriceAll is
  // string-based, admits exactly the binding forms ("99", "99.00",
  // "99,00", leading zeros, and the free forms "0"/"0.00"/"0,00"), and
  // rejects everything else with no partial value at all.
  const parsedPrice = parseCatalogPriceAll(formData.get("price"));
  const coverStoragePath = String(formData.get("coverStoragePath") ?? "").trim();
  const cover = formData.get("cover") as File | null;
  const coverProvided = coverStoragePath !== "" || (!!cover && cover.size > 0);
  const manuscriptStoragePath = String(formData.get("manuscriptStoragePath") ?? "").trim();
  const manuscript = formData.get("manuscript") as File | null;
  const manuscriptProvided = manuscriptStoragePath !== "" || (!!manuscript && manuscript.size > 0);

  if (!title || !coverProvided || !manuscriptProvided) {
    redirect("/dashboard/books/new?error=Please+fill+in+every+field");
  }

  // A parse failure performs NO insert and NO update. This redirect is
  // above every Supabase mutation in this function, and the maintenance
  // gate is above it in turn, so a rejected price costs no row and no
  // storage object.
  if (!parsedPrice.ok) {
    redirect(`/dashboard/books/new?error=${encodeURIComponent(CATALOG_PRICE_ERROR_MESSAGE)}`);
  }

  if (!GENRES.includes(genre as (typeof GENRES)[number])) {
    redirect("/dashboard/books/new?error=Please+choose+a+genre");
  }

  // FIX1 (X9): empty stays allowed; a filled ISBN must be a real one.
  if (isbn !== null && !isValidIsbn(isbn)) {
    redirect(`/dashboard/books/new?error=${encodeURIComponent(INVALID_ISBN_MESSAGE)}`);
  }

  // LIBRUM 2.0 PUBLISHING-UX-1 PART B: every one of these five is
  // optional and absent entirely from the current (pre-Part-C) wizard's
  // own FormData -- formData.get() simply returns null for a field the
  // form never submits. Unlike updateBook() below, createBook() only
  // ever reads `.value` here, never `.present`: a brand-new row has no
  // prior value to preserve, so absent and empty both legitimately mean
  // "no value yet," collapsing to `null` either way -- exactly the
  // pre-correction behavior, unchanged.
  const subtitle = resolveBoundedOptionalText(
    formData,
    "subtitle",
    SUBTITLE_MAX_LENGTH,
    "Subtitle",
    "/dashboard/books/new",
  ).value;
  const language = resolveLanguage(formData, "/dashboard/books/new").value;
  const publisher = resolveBoundedOptionalText(
    formData,
    "publisher",
    PUBLISHER_MAX_LENGTH,
    "Publisher",
    "/dashboard/books/new",
  ).value;
  const edition = resolveBoundedOptionalText(
    formData,
    "edition",
    EDITION_MAX_LENGTH,
    "Edition",
    "/dashboard/books/new",
  ).value;
  const originalPublicationDate = resolveOriginalPublicationDate(formData, "/dashboard/books/new").value;
  // F4 (P1) / PEN-NAMES-1 (10a): the pen name box, trimmed; empty means
  // the author's default pen name.
  const penName = String(formData.get("penName") ?? "").trim() || null;

  const { seriesId, seriesPosition } = await resolveSeriesSelection(
    supabase,
    user.id,
    formData,
    "/dashboard/books/new",
  );

  // PEN-NAMES-1 (10a, N1): the box resolves to one of the author's own pen
  // names -- found by name (any case) or created -- through the
  // server-only pen name writer, with the session user as the author.
  // Only pen_name_id is written below; the database keeps the legacy
  // books.pen_name text in step. Resolved before any upload, so a
  // refused name costs no storage object.
  const penNameResolution = await resolveOwnPenNameId(user.id, penName);
  if (!penNameResolution.ok) {
    redirect(
      `/dashboard/books/new?error=${encodeURIComponent(
        penNameResolution.reason === "invalid"
          ? penNameResolution.message
          : "Something went wrong saving your book. Please try again",
      )}`,
    );
  }

  // Normalizes EITHER a direct File OR a coverStoragePath/
  // manuscriptStoragePath reference into the same validated bytes --
  // see resolveCoverInput's/resolveManuscriptInput's own comments
  // above. coverProvided/manuscriptProvided already guarantee
  // `present: true` here; the checks below only keep each helper's
  // return type honest.
  const coverResult = await resolveCoverInput(supabase, user.id, formData, "/dashboard/books/new");
  if (!coverResult.present) {
    redirect("/dashboard/books/new?error=Please+fill+in+every+field");
  }

  const manuscriptResult = await resolveManuscriptInput(
    supabase,
    user.id,
    formData,
    "/dashboard/books/new",
  );
  if (!manuscriptResult.present) {
    redirect("/dashboard/books/new?error=Please+fill+in+every+field");
  }

  const bookId = randomUUID();
  // LAUNCH-1 P3-1: coverExtension is derived exclusively from the
  // verified byte signature above -- cover.name never reaches this key.
  // BOOK-STORAGE-MUTATION-AUTH-1: both keys come from the shared
  // constructors (src/lib/book-storage-path.ts), from the verified
  // session user id and this server-generated book id only.
  // PEN-2 (L10): the cover key is a fresh random folder
  // (newBookCoverPath), never the account or book id, and it is uploaded
  // with the trusted catalog writer: the contract migration drops every
  // user write policy on the covers bucket (C9), so covers are written by
  // the server only. Every input gate has already run above.
  //
  // ADMIN-3-REVIEW (M1): the manuscript, too, gets a fresh versioned key
  // (newBookManuscriptPath) and is uploaded with the trusted catalog
  // writer: authors may write only under their own "<uid>/tmp/" folder.
  const coverPath = newBookCoverPath(coverResult.extension);
  const manuscriptPath = newBookManuscriptPath(user.id, bookId);
  const catalogWriter = createCatalogWriteClient();

  const { error: coverError } = await catalogWriter.storage
    .from(BOOK_COVERS_BUCKET)
    .upload(coverPath, coverResult.bytes, {
      contentType: coverResult.contentType,
      cacheControl: IMAGE_CACHE_CONTROL_SECONDS,
    });

  if (coverError) {
    console.error("createBook: cover upload failed:", coverError);
    redirect(
      "/dashboard/books/new?error=Could+not+upload+your+cover+image.+Please+try+again",
    );
  }

  const { error: manuscriptError } = await catalogWriter.storage
    .from(BOOK_MANUSCRIPTS_BUCKET)
    .upload(manuscriptPath, manuscriptResult.bytes, { contentType: "application/epub+zip" });

  if (manuscriptError) {
    console.error("createBook: manuscript upload failed:", manuscriptError);
    await removeNewCoverUpload(catalogWriter, coverPath, "createBook");
    redirect(
      "/dashboard/books/new?error=Could+not+upload+your+manuscript.+Please+try+again",
    );
  }

  // LIBRUM 2.0 PRODUCT-1 PRE-COMMIT LEGACY RETIREMENT: preview_text is
  // deliberately NOT set here -- the Studio no longer collects it (Read
  // Sample is generated automatically, no author input required), so
  // this simply lets the column's own `not null default ''` apply, the
  // same as any other new-row default this insert doesn't override.
  //
  // CATALOG-STORAGE-PATH-AUTH-1: this insert names `cover_path` and
  // `file_path`, and since migration 20260924141734 `authenticated` may
  // not insert either one -- a storage path names an object the
  // service-role download and account-deletion paths later act on, so an
  // author must never be able to choose it. The row is therefore written
  // through the trusted catalog-write client, created only HERE: after
  // authentication, every input gate, the series ownership read, both
  // upload validations and both permanent uploads above. Every value that
  // identifies the row or a stored object is the server's own: `id` is
  // the randomUUID() above, `author_id` is the authenticated `user.id`,
  // and both paths were built above from those two and the verified cover
  // extension. No FormData id, author or path is ever read for them.
  // `.select("id")` must prove exactly this one new row, or the request
  // fails closed with the same author-facing error as an insert error.
  const { data: insertedRows, error: insertError } = await catalogWriter.from("books").insert({
    id: bookId,
    author_id: user.id,
    title,
    subtitle,
    description,
    keywords,
    isbn,
    language,
    publisher,
    edition,
    original_publication_date: originalPublicationDate,
    genre,
    series_id: seriesId,
    series_position: seriesPosition,
    // ALL-WIRING-2: `price_all` ONLY. `price_cents` is deliberately
    // absent from this payload -- not written, not scaled, not copied,
    // not calculated. It keeps its column default of 0, which is a
    // legacy USD artefact and is never read as a price again; a new
    // book priced at 199 ALL is therefore a paid book whose
    // `price_cents` is 0, and every decision site classifies it as
    // paid because none of them looks at that column.
    price_all: parsedPrice.priceAll,
    cover_path: coverPath,
    file_path: manuscriptPath,
    // PEN-NAMES-1: the resolved pen name (the author's own, above). The
    // books trigger re-checks it belongs to author_id and that it
    // matches the chosen series' pen name (11a, LB451).
    pen_name_id: penNameResolution.penNameId,
    // Always inserted as a draft, regardless of the submitted intent
    // (see below) -- the draft-first transition is intentional
    // (PUBLISHING-UX-1 Part B's own brief): a book is never inserted
    // directly as status='published', so a subsequent publish failure
    // always has an already-safely-saved draft to fall back to.
    //
    // CATALOG-WRITE-AUTH-1: `status` is deliberately ABSENT from this
    // payload. The row takes the column default, which is exactly
    // 'draft', and since migration 20260924101853 `authenticated` holds
    // no INSERT privilege on `status` at all -- naming it, even as
    // "draft", is refused by the database. The trusted writer could name
    // it, and deliberately does not: the default is the only way a new
    // row gets its status. Every column named here is one a draft may
    // carry, `price_all` included, because pricing a draft is not
    // publishing it.
  }).select("id");

  if (insertError) {
    console.error("createBook: book insert failed:", insertError);
    await removeNewCoverUpload(catalogWriter, coverPath, "createBook");
    await removeNewManuscriptUpload(catalogWriter, manuscriptPath, user.id, bookId, "createBook");
    const penNameMessage = penNameErrorMessage(insertError);
    if (penNameMessage) {
      redirect(`/dashboard/books/new?error=${encodeURIComponent(penNameMessage)}`);
    }
    redirect(
      "/dashboard/books/new?error=Something+went+wrong+saving+your+book.+Please+try+again",
    );
  }
  if (!isExactlyOneRowWritten(insertedRows) || insertedRows?.[0]?.id !== bookId) {
    console.error("createBook: trusted insert did not create exactly this one row", {
      bookId,
      rowCount: Array.isArray(insertedRows) ? insertedRows.length : null,
    });
    redirect(
      "/dashboard/books/new?error=Something+went+wrong+saving+your+book.+Please+try+again",
    );
  }

  // Only now, after the book row is fully saved pointing at the
  // permanent manuscriptPath above, is the temporary upload safe to
  // remove -- a failure here is an orphaned-object cleanup problem,
  // never a failed save (logged, not surfaced). Deliberately NOT
  // removed on any earlier failure path above: keeping it lets a retry
  // reuse the same already-uploaded/already-converted temp EPUB
  // instead of forcing the author to re-upload or re-convert from
  // scratch after e.g. a transient insert failure. The temp cover lives
  // in the "manuscripts" bucket's private staging area too (see
  // resolveCoverInput's own comment), so both go in one de-duplicated
  // removal from that bucket.
  await removeProvenBookStorageObjects(
    supabase,
    temporaryUploadRemovals(user.id, manuscriptResult.tempPathToCleanup, coverResult.tempPathToCleanup),
    "createBook",
  );

  revalidatePath("/dashboard");

  // F4 (P2): the Translator field becomes one book_contributors row,
  // inserted with the author's own session (the RLS path addContributor
  // uses) now that the book row exists. Its failure never costs the
  // book: it is logged, and the existing contributor message is shown
  // only when no publish refusal needs the one error slot.
  let translatorFailed = false;
  const translator = String(formData.get("translator") ?? "").trim();
  if (translator) {
    if (translator.length > TRANSLATOR_MAX_LENGTH) {
      console.error("createBook: translator name too long; not added", {
        bookId,
        length: translator.length,
      });
      translatorFailed = true;
    } else {
      const { error: translatorError } = await supabase
        .from("book_contributors")
        .insert({ book_id: bookId, name: translator, role: "Translator" });
      if (translatorError) {
        console.error("createBook: translator insert failed:", translatorError);
        translatorFailed = true;
      }
    }
  }
  const translatorErrorQuery = translatorFailed
    ? `error=${encodeURIComponent(ADD_CONTRIBUTOR_ERROR_MESSAGE)}`
    : null;

  // F4 (P3): the rights choice, recorded only when one of the two bases
  // was submitted. recordRightsDeclaration takes nothing else from the
  // client: the book, title, author and sentence all come from the
  // server. A failure is logged and never loses the saved draft; with
  // intent=publish the publish gate below then refuses.
  const rightsBasis = formData.get("rightsBasis");
  if (isRightsBasis(rightsBasis)) {
    const recorded = await recordRightsDeclaration(bookId, rightsBasis);
    if (!recorded.ok) {
      console.error("createBook: rights declaration not recorded", { bookId, reason: recorded.reason });
    }
  }

  // LIBRUM 2.0 PUBLISHING-UX-1 PART B: prepares createBook() for Part
  // C's eventual two final-step buttons (Save as draft / Publish book)
  // without changing anything about today's wizard, which never
  // submits an "intent" field at all -- formData.get("intent") is then
  // simply null, String(null ?? "draft") is "draft", and every branch
  // below behaves EXACTLY as before this change: redirect("/dashboard")
  // with the book already safely saved as a draft.
  const intent = String(formData.get("intent") ?? "draft");
  if (intent !== "publish") {
    redirect(translatorErrorQuery ? `/dashboard?${translatorErrorQuery}` : "/dashboard");
  }

  // The book row above is already a fully-saved, permanent draft at
  // this point -- performPublish() only ever ADVANCES its status, and
  // its own failure paths never touch the row at all, so every branch
  // below leaves a real, safe Draft behind even when publishing itself
  // doesn't succeed (see performPublish()'s own comment).
  const publishResult = await performPublish(supabase, bookId, user.id);

  // ADMIN-3-REVIEW (A): a new book always goes to review first -- it has
  // no approval yet. The draft is saved and waiting; nothing else to do.
  if (publishResult.ok && publishResult.outcome === "sent_for_review") {
    redirect(
      translatorErrorQuery
        ? `/dashboard?success=${encodeURIComponent(SENT_FOR_REVIEW_MESSAGE)}&${translatorErrorQuery}`
        : `/dashboard?success=${encodeURIComponent(SENT_FOR_REVIEW_MESSAGE)}`,
    );
  }

  if (publishResult.ok) {
    // Same reasoning as publishBook()'s own post-mutation block -- the
    // status="published" mutation above already committed inside
    // performPublish(), so nothing below may report that as a failure.
    // Each step is isolated and logged, never rethrown; redirect() stays
    // outside every try/catch so its NEXT_REDIRECT signal is never
    // swallowed. See publishBook() for the full rationale.
    if (publishResult.wasNewlyPublished) {
      try {
        const admin = createAdminClient();
        await sendNewBookEmails(admin, { bookId, authorId: user.id });
      } catch (error) {
        console.error("createBook: sendNewBookEmails failed after a successful publish", {
          bookId,
          authorId: user.id,
          error,
        });
      }
    }

    try {
      revalidatePath("/");
    } catch (error) {
      console.error("createBook: revalidatePath failed after a successful publish", {
        bookId,
        error,
      });
    }

    redirect(
      translatorErrorQuery
        ? `/dashboard?success=Your+book+is+now+live&${translatorErrorQuery}`
        : "/dashboard?success=Your+book+is+now+live",
    );
  }

  // Publish failed -- the draft inserted above remains exactly as
  // saved. Only controlled, non-leaking reasons exist here (see
  // performPublish()'s own result type); "not_found" is not reachable
  // in practice (this is the row this same request just inserted) but
  // still falls safely into the same generic branch rather than being
  // treated as exhaustive.
  if (publishResult.reason === "missing_all_price") {
    redirect(
      `/dashboard?success=Saved+as+draft&error=${encodeURIComponent(MISSING_ALL_PRICE_MESSAGE)}`,
    );
  }
  if (publishResult.reason === "missing_description") {
    redirect(
      `/dashboard?success=Saved+as+draft&error=${encodeURIComponent(MISSING_DESCRIPTION_MESSAGE)}`,
    );
  }
  // ADMIN-2-TAKEDOWN: not reachable for a book this request just
  // inserted (no takedown can exist yet); handled for completeness.
  if (publishResult.reason === "taken_down") {
    redirect(`/dashboard?success=Saved+as+draft&error=${encodeURIComponent(TAKEN_DOWN_PUBLISH_MESSAGE)}`);
  }
  // F4 (P4): a publish refusal always takes the one error slot; a
  // translator failure is then only logged (above).
  if (publishResult.reason === "missing_rights") {
    redirect(`/dashboard?success=Saved+as+draft&error=${encodeURIComponent(MISSING_RIGHTS_MESSAGE)}`);
  }
  if (publishResult.reason === "paid_mode_required") {
    redirect(
      "/dashboard?success=Saved+as+draft&error=Paid+publishing+isn%27t+available+right+now",
    );
  }
  // ADMIN-3-REVIEW: not reachable for a book this request just inserted
  // (no review can exist yet); handled for completeness.
  if (publishResult.reason === "already_in_review") {
    redirect(`/dashboard?success=Saved+as+draft&error=${encodeURIComponent(ALREADY_IN_REVIEW_MESSAGE)}`);
  }
  if (publishResult.reason === "book_changed") {
    redirect(`/dashboard?success=Saved+as+draft&error=${encodeURIComponent(BOOK_CHANGED_WHILE_EDITING_MESSAGE)}`);
  }
  // "rights_unavailable" (F4, D3), "takedown_unavailable" (ADMIN-2) and
  // "review_unavailable" (ADMIN-3) land here too: the existing sentence.
  redirect(`/dashboard?success=Saved+as+draft&error=${PUBLISH_NOT_POSSIBLE_YET_QUERY}`);
}

export async function updateBook(bookId: string, formData: FormData) {
  // ALL-CUTOVER APP-A: catalog price is written by this action --
  // gated before any Supabase call.
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    redirectForMaintenance(`/dashboard/books/${bookId}/edit`);
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // LIBRUM 2.0 PUBLISHING-UX-1 PART D FINAL PRE-COMMIT SERVER-SIDE
  // UNCHANGED-LANGUAGE PRESERVATION CORRECTION: `language` added to
  // this existing, already-ownership-scoped read -- no second query --
  // so resolveLanguageForUpdate() below has an authoritative source for
  // "what does this row already have" that a client can never spoof
  // (unlike a hidden form field or query parameter).
  //
  // PAID-REPRICING-1: `status` and `price_all` join the same read, so
  // the paid-repricing decision below is made from the server's own row,
  // never from anything the form submits.
  //
  // BOOK-STORAGE-MUTATION-AUTH-1: `id` joins the read so every key this
  // action builds, keeps or removes is bound to the row's own id, which
  // must be exactly the id the caller named (the uuid column compares
  // case-insensitively; a key never does). A read error, no row, another
  // author's row or any id mismatch stops here, before any upload.
  const { data: existing, error: existingError } = await supabase
    .from("books")
    .select("id, cover_path, file_path, author_id, language, status, price_all, isbn")
    .eq("id", bookId)
    .eq("author_id", user.id)
    .single();

  if (existingError || !existing || existing.id !== bookId || existing.author_id !== user.id) {
    redirect("/dashboard");
  }

  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const keywords = normalizeKeywords(formData.get("keywords"));
  const isbn = String(formData.get("isbn") ?? "").trim() || null;
  const genre = String(formData.get("genre") ?? "");
  // ALL-WIRING-2: same single parser as createBook -- see its comment.
  const parsedPrice = parseCatalogPriceAll(formData.get("price"));

  if (!title) {
    redirect(`/dashboard/books/${bookId}/edit?error=Please+fill+in+every+field`);
  }

  // A parse failure performs no update. Above every Supabase mutation
  // in this function, and below the ownership check already made above,
  // so a rejected price can neither write a row nor probe someone
  // else's.
  if (!parsedPrice.ok) {
    redirect(
      `/dashboard/books/${bookId}/edit?error=${encodeURIComponent(CATALOG_PRICE_ERROR_MESSAGE)}`,
    );
  }

  if (!GENRES.includes(genre as (typeof GENRES)[number])) {
    redirect(`/dashboard/books/${bookId}/edit?error=Please+choose+a+genre`);
  }

  // FIX1 (X9): same rule as createBook. An ISBN resubmitted exactly as
  // the row already holds it is kept, so a book saved before this check
  // existed can still have an unrelated field edited (the same
  // preserve-unchanged rule as resolveLanguageForUpdate).
  if (isbn !== null && isbn !== existing.isbn && !isValidIsbn(isbn)) {
    redirect(
      `/dashboard/books/${bookId}/edit?error=${encodeURIComponent(INVALID_ISBN_MESSAGE)}`,
    );
  }

  // PAID-REPRICING-1: an edit that would make a PUBLISHED book paid, or
  // change its paid price, is a paid publication and needs the same
  // permission performPublish() requires. Decided by the one shared rule
  // (src/lib/paid-repricing.ts), from the row read above, and refused
  // HERE -- before any storage upload and before any database write.
  // Keeping the current paid price, making the book free, and saving a
  // paid price on a draft all stay open.
  const priceAuthorization = resolvePriceUpdateAuthorization({
    currentStatus: existing.status,
    currentPriceAll: existing.price_all,
    submittedPriceAll: parsedPrice.priceAll,
  });
  if (
    priceAuthorization.kind === "paid_publishing_permission_required" &&
    !canPublishPaidTitle()
  ) {
    redirect(
      `/dashboard/books/${bookId}/edit?error=${encodeURIComponent(PAID_REPRICING_UNAVAILABLE_MESSAGE)}`,
    );
  }
  // LIVE-PRICE-CONFIRM-1 (Renato 10-24): a new price on a LIVE book
  // needs the tick under the price, carrying exactly this new price.
  // Decided from the row read above and refused before any write. A
  // publish or price change landing between that read and the save is
  // not re-checked for the tick: priceGuard below conditions only the
  // paid-repricing cases (a confirm step, not an authorization).
  if (
    isLivePriceChange({
      status: existing.status,
      currentPriceAll: existing.price_all,
      submittedPriceAll: parsedPrice.priceAll,
    }) &&
    !isPriceChangeConfirmed(formData, parsedPrice.priceAll)
  ) {
    redirect(
      `/dashboard/books/${bookId}/edit?error=${encodeURIComponent(PRICE_CHANGE_CONFIRM_MESSAGE)}`,
    );
  }
  // The row state the write below must still find. A read-then-check
  // alone would let a concurrent publish slip between the two: see
  // catalogRowGuard's own comment.
  const priceGuard = catalogRowGuard(priceAuthorization, {
    status: existing.status,
    priceAll: existing.price_all,
  });

  // F4 (P6, FIX1 advisory A5): a published book keeps a description,
  // Renato's publish rule, so clearing it is refused here -- before any
  // upload and any write. Drafts may still clear it. The write below
  // also requires the row to still be a draft whenever the description
  // is empty, so a publish that lands in between cannot be followed by
  // this clear (zero rows -> CATALOG_ROW_CHANGED_MESSAGE).
  const clearsDescription = description === "";
  if (clearsDescription && existing.status === "published") {
    redirect(
      `/dashboard/books/${bookId}/edit?error=${encodeURIComponent(PUBLISHED_NEEDS_DESCRIPTION_MESSAGE)}`,
    );
  }

  // F4 (P1): the same present/absent rule as the metadata below: a form
  // without the Pen name field leaves the book's pen name untouched; a
  // present, empty field means the author's default pen name
  // (PEN-NAMES-1).
  const penNamePresent = formData.has("penName");
  const penName = String(formData.get("penName") ?? "").trim() || null;
  // PEN-NAMES-1 (10a): resolved through the server-only pen name writer
  // (found by name or created), before any upload. 14a -- a book in a
  // series or bundle keeps its pen name -- is the database's refusal
  // (LB452), shown below as its own message.
  let penNameId: string | null = null;
  if (penNamePresent) {
    const penNameResolution = await resolveOwnPenNameId(user.id, penName);
    if (!penNameResolution.ok) {
      redirect(
        `/dashboard/books/${bookId}/edit?error=${encodeURIComponent(
          penNameResolution.reason === "invalid"
            ? penNameResolution.message
            : "Something went wrong saving your changes. Please try again",
        )}`,
      );
    }
    penNameId = penNameResolution.penNameId;
  }

  // LIBRUM 2.0 PUBLISHING-UX-1 PART B FINAL PRE-COMMIT ROLLOUT-
  // COMPATIBILITY CORRECTION: same five author-editable fields as
  // createBook(), but this function keeps each resolver's full
  // `{present, value}` result (never collapsing to just `.value` the
  // way createBook() does) -- see the update-payload call site further
  // below for exactly why: PUBLISHING-UX-1 is staged across three
  // parts, and the still-old (pre-Part-D) Edit form does not submit
  // these fields at all yet, so "the form didn't send this key" must
  // be distinguished from "the author cleared this field," and only
  // the latter may ever write `null` over an existing value.
  //
  // Never published_at regardless: no "publishedAt" form field is ever
  // read here, present or not -- see performPublish()'s own comment for
  // why that stays entirely outside author-submitted form data.
  const subtitleResolved = resolveBoundedOptionalText(
    formData,
    "subtitle",
    SUBTITLE_MAX_LENGTH,
    "Subtitle",
    `/dashboard/books/${bookId}/edit`,
  );
  // LIBRUM 2.0 PUBLISHING-UX-1 PART D FINAL PRE-COMMIT SERVER-SIDE
  // UNCHANGED-LANGUAGE PRESERVATION CORRECTION: updateBook()'s own
  // narrow resolver, not the shared resolveLanguage() createBook()
  // still uses unmodified -- see resolveLanguageForUpdate()'s own
  // comment for why. `existing.language` is the authoritative DB value
  // this update's own ownership-check query already fetched.
  const languageResolution = resolveLanguageForUpdate(
    formData,
    existing.language,
    `/dashboard/books/${bookId}/edit`,
  );
  const publisherResolved = resolveBoundedOptionalText(
    formData,
    "publisher",
    PUBLISHER_MAX_LENGTH,
    "Publisher",
    `/dashboard/books/${bookId}/edit`,
  );
  const editionResolved = resolveBoundedOptionalText(
    formData,
    "edition",
    EDITION_MAX_LENGTH,
    "Edition",
    `/dashboard/books/${bookId}/edit`,
  );
  const originalPublicationDateResolved = resolveOriginalPublicationDate(
    formData,
    `/dashboard/books/${bookId}/edit`,
  );

  const { seriesId, seriesPosition } = await resolveSeriesSelection(
    supabase,
    user.id,
    formData,
    `/dashboard/books/${bookId}/edit`,
  );

  // Normalizes EITHER a direct File OR a coverStoragePath reference
  // into the same validated bytes -- see resolveCoverInput's own
  // comment near the top of this file. `present: false` is a
  // legitimate, ordinary outcome here: no replacement chosen, keep
  // the existing cover untouched.
  //
  // BOOK-STORAGE-MUTATION-AUTH-1: a stored path is never re-persisted.
  // Without a replacement, `cover_path`/`file_path` are simply absent
  // from the update payload below (the column keeps its value, whatever
  // it is) and no Storage call names them. With a replacement, the new
  // key is built ONLY from the verified session user id, this row's own
  // id and the verified bytes -- never from form data or the stored row.
  //
  // QA-FIX-3: BOTH inputs are resolved (and so fully validated) before
  // any upload. The cover used to be uploaded before the manuscript was
  // validated, so a rejected EPUB could leave a changed live cover behind
  // an error message.
  const coverResult = await resolveCoverInput(
    supabase,
    user.id,
    formData,
    `/dashboard/books/${bookId}/edit`,
  );
  // Normalizes EITHER a direct File OR a manuscriptStoragePath
  // reference into the same validated bytes -- see
  // resolveManuscriptInput's own comment near the top of this file.
  // `present: false` is a legitimate, ordinary outcome here (unlike
  // createBook()): it just means "no replacement chosen, keep the
  // existing manuscript untouched."
  const manuscriptResult = await resolveManuscriptInput(
    supabase,
    user.id,
    formData,
    `/dashboard/books/${bookId}/edit`,
    bookId,
  );

  // QA-FIX-3: the live files are never overwritten before the row update
  // below has succeeded. Since PEN-2 (covers) and ADMIN-3 (manuscripts)
  // every replacement goes to a FRESH key, so it touches no live object
  // and is uploaded BEFORE the write, as the row must never point at a
  // missing object; nothing is ever overwritten in place.
  type PendingUpload = {
    bucket: typeof BOOK_COVERS_BUCKET | typeof BOOK_MANUSCRIPTS_BUCKET;
    path: string;
    bytes: Buffer;
    contentType: string;
    kind: "cover" | "manuscript";
  };
  const uploadsBeforeWrite: PendingUpload[] = [];

  let newCoverPath: string | null = null;
  // The superseded cover, removed only AFTER the guarded update below
  // proves it landed -- never before, so a failed update never leaves
  // books.cover_path pointing at a file that's already gone. Set only
  // when the stored value is this author's own canonical or documented
  // legacy key for THIS book, or a new random-folder key read from this
  // author's own row (src/lib/book-storage-path.ts); any other stored
  // value is left untouched in Storage and only counted.
  let coverPathToRemove: string | null = null;
  let tempCoverToCleanup: string | null = null;

  if (coverResult.present) {
    // LAUNCH-1 P3-1: coverExtension is derived exclusively from the
    // verified byte signature above -- cover.name never reaches this
    // key. An existing.cover_path from before this hardening (e.g.
    // "...-cover.JPG" or "...-cover.jpeg") is never reconstructed here:
    // it is classified against this author and book below, and only the
    // documented "jpeg" form (any ASCII case of those four letters, exact
    // author/book stem) is recognised as removable -- and then removed
    // exactly as stored.
    //
    // PEN-2 (L10): every replace gets a fresh random key
    // (newBookCoverPath), so it never overwrites the live object in place
    // and is always uploaded BEFORE the write, with the trusted catalog
    // writer (C9). If the compare-and-set below misses, that new upload
    // is removed instead of the old one.
    newCoverPath = newBookCoverPath(coverResult.extension);
    const storedCoverClass = classifyBookCoverPath(existing.cover_path, user.id, existing.id);

    uploadsBeforeWrite.push({
      bucket: BOOK_COVERS_BUCKET,
      path: newCoverPath,
      bytes: coverResult.bytes,
      contentType: coverResult.contentType,
      kind: "cover",
    });

    if (storedCoverClass !== "unsafe" && existing.cover_path !== newCoverPath) {
      coverPathToRemove = existing.cover_path;
    } else if (storedCoverClass === "unsafe" && existing.cover_path !== null) {
      console.warn("updateBook: stored cover path is not this book's own key; left untouched", {
        bookId: existing.id,
        coverPathClass: storedCoverClass,
      });
    }

    tempCoverToCleanup = coverResult.tempPathToCleanup;
  }

  let newManuscriptPath: string | null = null;
  let tempManuscriptToCleanup: string | null = null;

  if (manuscriptResult.present) {
    // ADMIN-3-REVIEW (M1, Design): every replacement gets a FRESH
    // versioned key (newBookManuscriptPath), so books.file_path changes
    // whenever the bytes change and an approval of the old file can never
    // cover the new one. The superseded key is never removed here
    // directly: the retention rule below decides (N3/P1), after the write
    // is proven -- under N2 ★a buyers keep the last approved file.
    newManuscriptPath = newBookManuscriptPath(user.id, existing.id);
    if (existing.file_path !== null && !isOwnBookManuscriptPath(existing.file_path, user.id, existing.id)) {
      console.warn("updateBook: stored manuscript path is not this book's own key; left untouched", {
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

  // ADMIN-3-REVIEW (C, 2b): a new file or cover takes a LIVE book out of
  // the Bookstore until Librum approves it, so a book a published bundle
  // sells cannot change them (the bundle would sell a book that is no
  // longer available). Refused here, before any upload. Fails closed.
  const filesChanged = newCoverPath !== null || newManuscriptPath !== null;
  const wasLive = existing.status === "published";
  if (filesChanged && wasLive) {
    const membership = await bookBelongsToPublishedBundle(supabase, existing.id);
    if (!membership.ok) {
      redirect(
        `/dashboard/books/${bookId}/edit?error=Something+went+wrong+saving+your+changes.+Please+try+again`,
      );
    }
    if (membership.inPublishedBundle) {
      redirect(`/dashboard/books/${bookId}/edit?error=${encodeURIComponent(LIVE_FILES_IN_BUNDLE_MESSAGE)}`);
    }
  }
  // D: a draft already waiting for review gets its pending snapshot
  // replaced (request_book_review cancels the stale row and inserts a new
  // one, P1) when its file or cover changes. Read only when they change;
  // an unreadable state leaves the stale row for the approve RPC to
  // refuse (it binds to the current files) and the author can send it
  // again.
  let wasPending = false;
  if (filesChanged && !wasLive) {
    const reviewState = await getBookReviewState(supabase, existing.id);
    wasPending = reviewState.kind === "ok" && reviewState.pending;
  }

  // CATALOG-WRITE-AUTH-1 / PEN-2: the trusted writer is created only now,
  // after authentication, the ownership read, price validation, the
  // repricing gate and both input validations. It uploads the cover
  // (C9: covers are server-written only) and, since ADMIN-3 (M1), the
  // manuscript, and writes the row below.
  const catalogWriter = createCatalogWriteClient();

  for (const upload of uploadsBeforeWrite) {
    // Both go to a fresh key and never overwrite anything, so neither
    // needs an upsert.
    const { error: uploadError } = await catalogWriter.storage
      .from(upload.bucket)
      .upload(upload.path, upload.bytes, {
        contentType: upload.contentType,
        ...(upload.kind === "cover" ? { cacheControl: IMAGE_CACHE_CONTROL_SECONDS } : {}),
      });

    if (uploadError) {
      console.error(`updateBook: ${upload.kind} upload failed:`, uploadError);
      if (upload.kind === "manuscript" && newCoverPath !== null) {
        await removeNewCoverUpload(catalogWriter, newCoverPath, "updateBook");
      }
      if (upload.kind === "cover" && newManuscriptPath !== null) {
        await removeNewManuscriptUpload(catalogWriter, newManuscriptPath, user.id, existing.id, "updateBook");
      }
      redirect(
        upload.kind === "cover"
          ? `/dashboard/books/${bookId}/edit?error=Could+not+upload+your+cover+image.+Please+try+again`
          : `/dashboard/books/${bookId}/edit?error=Could+not+upload+your+manuscript.+Please+try+again`,
      );
    }
  }

  // LIBRUM 2.0 PRODUCT-1 PRE-COMMIT LEGACY RETIREMENT: preview_text is
  // deliberately OMITTED from this update payload -- the Studio form no
  // longer submits it at all, and a Supabase `.update()` only ever
  // touches the keys actually present in the object passed here (unlike
  // a full-row PUT/replace). Omitting the key means this column is
  // simply never written by this call, so any legacy value already
  // stored for an existing book survives editing untouched. Explicitly
  // NOT `preview_text: String(formData.get("previewText") ?? "")`,
  // which would have silently overwritten every existing legacy value
  // with an empty string the very first time each book was next edited.
  // LIBRUM 2.0 PUBLISHING-UX-1 PART B FINAL PRE-COMMIT ROLLOUT-
  // COMPATIBILITY CORRECTION: each of the five new metadata fields is
  // spread in ONLY when its own resolver reports `present: true` --
  // exactly the same "a Supabase `.update()` only ever touches keys
  // actually present in the object passed here" mechanism the comment
  // above already relies on for preview_text, now applied deliberately
  // to these five instead of by omission. A field the still-old
  // (pre-Part-D) Edit form never submits is simply never a key on this
  // object at all, so its existing database value -- however it got
  // there, including from the Part-C wizard's own eventual create flow
  // -- survives untouched. A field the form DOES submit, even as an
  // empty string, IS included, as `null` -- an intentional clear, not
  // an accidental one.
  //
  // PAID-REPRICING-1: guarded by `priceGuard` (see above) and followed by
  // `.select("id")`, because an update that matched no row is not an
  // error to PostgREST -- only the returned rows prove this write landed
  // on the row that was authorized.
  //
  // CATALOG-WRITE-AUTH-1: this ONE row update carries `price_all`
  // alongside the metadata, and `authenticated` may no longer write
  // `price_all` directly, so it runs through the trusted catalog-write
  // client -- created only here, after authentication, the ownership
  // read, price validation, the repricing gate and every upload above.
  // Metadata and price are never split into two writes: a failure or a
  // stale guard changes neither. The `id` and `author_id` filters are the
  // ownership boundary (that client bypasses RLS), and exactly one
  // returned row is still the only proof of success.
  const updateQuery = catalogWriter
    .from("books")
    .update({
      title,
      description,
      keywords,
      isbn,
      genre,
      series_id: seriesId,
      series_position: seriesPosition,
      // ALL-WIRING-2: `price_all` ONLY -- see createBook's own comment.
      // Saving a valid ALL price is also the single act that brings a
      // previously unpriced legacy row back into listings and search.
      price_all: parsedPrice.priceAll,
      // BOOK-STORAGE-MUTATION-AUTH-1: a path key is present ONLY when
      // this request uploaded its replacement; otherwise it is absent
      // and the stored value is not re-written.
      ...(newCoverPath !== null ? { cover_path: newCoverPath } : {}),
      ...(newManuscriptPath !== null ? { file_path: newManuscriptPath } : {}),
      // ADMIN-3-REVIEW (C, S5): a new file or cover ALWAYS writes the
      // book as a draft and clears Librum's choice (as unpublish does),
      // in this same row write and whatever status was read -- so a
      // publish that lands in between can never leave unapproved files
      // live (the live-files trigger refuses that, LB463).
      ...(filesChanged ? { status: "draft" as const, librum_choice_at: null } : {}),
      ...(subtitleResolved.present ? { subtitle: subtitleResolved.value } : {}),
      // "omit" (absent) and "preserve" (unchanged unsupported value)
      // both spread in nothing -- see resolveLanguageForUpdate()'s own
      // comment for why "preserve" is a deliberate no-op, not merely
      // an oversight sharing "omit"'s own code path.
      ...(languageResolution.action === "set"
        ? { language: languageResolution.value }
        : languageResolution.action === "clear"
          ? { language: null }
          : {}),
      ...(publisherResolved.present ? { publisher: publisherResolved.value } : {}),
      ...(editionResolved.present ? { edition: editionResolved.value } : {}),
      ...(originalPublicationDateResolved.present
        ? { original_publication_date: originalPublicationDateResolved.value }
        : {}),
      // PEN-NAMES-1: only pen_name_id is written (the database keeps the
      // legacy text in step), and only when the box was submitted.
      ...(penNameId !== null ? { pen_name_id: penNameId } : {}),
    })
    .eq("id", existing.id)
    .eq("author_id", user.id);
  // BOOK-STORAGE-MUTATION-AUTH-1: a cover replacement also compares-and-
  // sets the cover_path this request read. The superseded object removed
  // below is then provably the value this write replaced: a concurrent
  // edit that changed the cover in between makes this write match no
  // row, so nothing is removed and the author is asked to retry.
  const coverGuardedQuery =
    newCoverPath === null
      ? updateQuery
      : existing.cover_path === null
        ? updateQuery.is("cover_path", null)
        : updateQuery.eq("cover_path", existing.cover_path);
  // ADMIN-3-REVIEW (N3): the same compare-and-set for a manuscript
  // replacement, so the key the retention cleanup below treats as
  // superseded is provably the one this write replaced.
  const fileGuardedQuery =
    newManuscriptPath === null
      ? coverGuardedQuery
      : existing.file_path === null
        ? coverGuardedQuery.is("file_path", null)
        : coverGuardedQuery.eq("file_path", existing.file_path);
  // F4 (P6): see the published-description check above.
  const descriptionGuardedQuery = clearsDescription
    ? fileGuardedQuery.eq("status", "draft")
    : fileGuardedQuery;
  const { data: updatedRows, error: updateError } = await applyCatalogRowGuard(
    descriptionGuardedQuery,
    priceGuard,
  ).select("id");

  if (updateError) {
    console.error("updateBook: book update failed:", updateError);
    if (newCoverPath !== null) {
      await removeNewCoverUpload(catalogWriter, newCoverPath, "updateBook");
    }
    if (newManuscriptPath !== null) {
      await removeNewManuscriptUpload(catalogWriter, newManuscriptPath, user.id, existing.id, "updateBook");
    }
    // ADMIN-3-REVIEW (S3): the live-files trigger (LB463) or the publish
    // gate (LB462) caught a change that landed after the read above.
    if (updateError.code === "LB463" || updateError.code === "LB462") {
      redirect(`/dashboard/books/${bookId}/edit?error=${encodeURIComponent(BOOK_CHANGED_WHILE_EDITING_MESSAGE)}`);
    }
    const penNameMessage = penNameErrorMessage(updateError);
    if (penNameMessage) {
      redirect(`/dashboard/books/${bookId}/edit?error=${encodeURIComponent(penNameMessage)}`);
    }
    redirect(
      `/dashboard/books/${bookId}/edit?error=Something+went+wrong+saving+your+changes.+Please+try+again`,
    );
  }
  if (!isExactlyOneRowWritten(updatedRows) || updatedRows?.[0]?.id !== existing.id) {
    console.error("updateBook: guarded update did not change exactly one row", {
      bookId,
      rowCount: Array.isArray(updatedRows) ? updatedRows.length : null,
    });
    // PEN-2 (L10): the compare-and-set missed, so the row still names
    // whatever cover it named before; the new upload is unreferenced and
    // is removed, and the previous object is left alone.
    if (newCoverPath !== null) {
      await removeNewCoverUpload(catalogWriter, newCoverPath, "updateBook");
    }
    if (newManuscriptPath !== null) {
      await removeNewManuscriptUpload(catalogWriter, newManuscriptPath, user.id, existing.id, "updateBook");
    }
    redirect(
      `/dashboard/books/${bookId}/edit?error=${encodeURIComponent(CATALOG_ROW_CHANGED_MESSAGE)}`,
    );
  }

  // F4 (P3): the Edit page's rights choice, recorded only now that the
  // save is proven (so the declaration's book_title is the saved title),
  // and only when it changes something: no declaration yet, or a
  // different basis from the current one. An identical resubmission, or
  // a book whose declarations cannot be read (`unavailable`), records
  // nothing. A failure is logged and never undoes the save.
  const rightsBasis = formData.get("rightsBasis");
  if (isRightsBasis(rightsBasis)) {
    const rightsState = await getRightsDeclarationState(existing.id);
    if (
      rightsState.kind === "none" ||
      (rightsState.kind === "present" && rightsState.declaration.basis !== rightsBasis)
    ) {
      const recorded = await recordRightsDeclaration(existing.id, rightsBasis);
      if (!recorded.ok) {
        console.error("updateBook: rights declaration not recorded", {
          bookId: existing.id,
          reason: recorded.reason,
        });
      }
    }
  }

  // ADMIN-3-REVIEW (C, D): the row is proven a draft with the new files.
  // A book that was live, or was waiting for review, is sent for review
  // with them now (a stale pending snapshot is replaced, P1). If the
  // request fails, the book stays a draft and the author can press Send
  // for review (S5).
  let reviewRequestFailed = false;
  if (filesChanged && (wasLive || wasPending)) {
    const request = await requestBookReview(supabase, existing.id);
    reviewRequestFailed = !request.ok && request.reason !== "already_pending";
    // ADMIN-ALERTS-1 (2a): a new review request starts a new 48h clock.
    if (request.ok) await sendReviewRequestedStaffEmail({ bookId: existing.id, authorId: user.id });
  }

  // ADMIN-3-REVIEW (N3, P1): after the review request -- whether it
  // succeeded or failed -- remove this book's own manuscript keys the
  // retention rule no longer keeps (the key this write superseded, and
  // any stale snapshot). Trusted read and removal (authors can read no
  // review paths and delete no final key); best effort.
  if (newManuscriptPath !== null) {
    await removeUnretainedManuscripts(catalogWriter, catalogWriter, {
      authorId: user.id,
      bookId: existing.id,
      superseded: [existing.file_path],
      caller: "updateBook",
    });
  }

  // Only now that the DB row correctly points at the new cover is it
  // safe to remove the file it superseded. A cleanup failure here is an
  // orphaned-file problem, not a failed update -- same philosophy as
  // deleteBook's storage cleanup in Phase 8A: log it, don't tell the
  // author their update failed, don't undo the already-successful save.
  // The temporary uploads (both staged in the private manuscripts
  // bucket, see resolveCoverInput's own comment) are removed only now
  // too, once the row is confirmed pointing at the permanent keys.
  const removals = temporaryUploadRemovals(user.id, tempManuscriptToCleanup, tempCoverToCleanup);
  if (coverPathToRemove !== null) {
    removals.unshift({ bucket: BOOK_COVERS_BUCKET, path: coverPathToRemove });
  }
  await removeProvenBookStorageObjects(supabase, removals, "updateBook");

  revalidatePath("/dashboard");
  revalidatePath(`/books/${bookId}`);
  revalidatePath("/");
  if (filesChanged && (wasLive || wasPending)) {
    if (reviewRequestFailed) {
      redirect(`/dashboard/books/${bookId}/edit?success=${encodeURIComponent(LIVE_FILES_REQUEST_FAILED_MESSAGE)}`);
    }
    if (wasLive) {
      revalidatePath("/bookstore");
      redirect(`/dashboard?success=${encodeURIComponent(LIVE_FILES_SAVED_MESSAGE)}`);
    }
  }
  redirect("/dashboard?success=Book+updated");
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
      `/dashboard/books/${bookId}/edit?error=${encodeURIComponent(
        result.reason === "not_pending" ? NOT_IN_REVIEW_MESSAGE : "Something went wrong. Please try again",
      )}`,
    );
  }

  revalidatePath("/dashboard");
  revalidatePath(`/dashboard/books/${bookId}/edit`);
  redirect(`/dashboard/books/${bookId}/edit?success=${encodeURIComponent(REVIEW_CANCELLED_MESSAGE)}`);
}

// LIBRUM 2.0 PUBLISHING-UX-1 PART B: the ONE authoritative, non-
// redirecting publish gate -- extracted from what was previously
// publishBook()'s own inline body, byte-for-byte the same rules,
// so createBook()'s new "intent=publish" path (below) and the public
// publishBook() Server Action (further below) can never drift apart
// into two independently-maintained copies of the payout/status rule.
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
  | { ok: true; outcome: "sent_for_review" }
  // ALL-WIRING-2: `missing_all_price` is a DISTINCT reason, never folded
  // into paid_mode_required. The two refusals have opposite remedies --
  // the author fixes the first themselves in one edit and can do nothing
  // about the second -- so telling an author with an unpriced draft that
  // "paid publishing isn't available" would be a false explanation.
  | {
      ok: false;
      reason:
        | "not_found"
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
        | "paid_mode_required"
        | "update_failed";
    };

async function performPublish(
  supabase: Awaited<ReturnType<typeof createClient>>,
  bookId: string,
  userId: string,
): Promise<PerformPublishResult> {
  // AUTH-1C: defense-in-depth -- Proxy already blocks /dashboard/* while
  // a recovery session is active, so this is the second layer against a
  // crafted direct POST. Placed in this single shared helper (not
  // duplicated in publishBook() and createBook()'s own intent=publish
  // branch) so both callers get it for free and can't drift. Runs
  // before the status mutation below -- a book's publish state is a
  // publicly-visible, buyer-facing change.
  await redirectIfRecoverySessionActive();

  const { data: book } = await supabase
    .from("books")
    .select("status, price_all, published_at, description")
    .eq("id", bookId)
    .eq("author_id", userId)
    .single();

  if (!book) {
    return { ok: false, reason: "not_found" };
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
  //   draft, and saving a draft without one is untouched (createBook
  //   inserts the draft before calling this).
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
    if (!reviewState.approvalValid) {
      const request = await requestBookReview(supabase, bookId);
      if (request.ok) {
        // ADMIN-ALERTS-1: best effort, never throws.
        await sendReviewRequestedStaffEmail({ bookId, authorId: userId });
        return { ok: true, outcome: "sent_for_review" };
      }
      if (request.reason === "already_pending") {
        return { ok: false, reason: "already_in_review" };
      }
      if (request.reason === "taken_down") {
        return { ok: false, reason: "taken_down" };
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
  // concurrent updateBook that made a free draft paid in between leaves
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

export async function publishBook(bookId: string) {
  // ALL-CUTOVER APP-A: publish re-checks the catalog price and bundle
  // membership state -- gated before any Supabase call.
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    redirectForMaintenance("/dashboard");
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // Thin wrapper around the one authoritative helper above -- auth,
  // then a redirect chosen from its small controlled result, nothing
  // else. External behavior (redirect targets, notification timing) is
  // unchanged from before this extraction.
  const result = await performPublish(supabase, bookId, user.id);

  if (!result.ok) {
    // PAID-MODE-1: deliberately generic -- it names no environment
    // variable, no deployment and no payout state. An author learns that
    // paid publishing is closed, and nothing about why.
    // ALL-WIRING-2: the missing-price refusal names the real obstacle
    // and points at the one action that clears it. Unlike the paid-mode
    // denial below, it is safe to be specific: it describes the author's
    // OWN row back to them and leaks nothing about this deployment.
    if (result.reason === "missing_all_price") {
      redirect(
        `/dashboard/books/${bookId}/edit?error=${encodeURIComponent(MISSING_ALL_PRICE_MESSAGE)}`,
      );
    }
    if (result.reason === "missing_description") {
      redirect(
        `/dashboard/books/${bookId}/edit?error=${encodeURIComponent(MISSING_DESCRIPTION_SHORT_MESSAGE)}`,
      );
    }
    if (result.reason === "missing_rights") {
      redirect(`/dashboard/books/${bookId}/edit?error=${encodeURIComponent(MISSING_RIGHTS_MESSAGE)}`);
    }
    // ADMIN-2-TAKEDOWN (G): the book stays locked; named on its own
    // Edit page, where the takedown notice is shown.
    if (result.reason === "taken_down") {
      redirect(`/dashboard/books/${bookId}/edit?error=${encodeURIComponent(TAKEN_DOWN_PUBLISH_MESSAGE)}`);
    }
    // F4 (D3): the existing generic sentence, on the dashboard. ADMIN-2:
    // an unreadable takedown state is answered the same way.
    // ADMIN-3-REVIEW: already waiting, or changed under the author.
    if (result.reason === "already_in_review") {
      redirect(`/dashboard/books/${bookId}/edit?error=${encodeURIComponent(ALREADY_IN_REVIEW_MESSAGE)}`);
    }
    if (result.reason === "book_changed") {
      redirect(`/dashboard/books/${bookId}/edit?error=${encodeURIComponent(BOOK_CHANGED_WHILE_EDITING_MESSAGE)}`);
    }
    if (
      result.reason === "rights_unavailable" ||
      result.reason === "takedown_unavailable" ||
      result.reason === "review_unavailable"
    ) {
      redirect(`/dashboard?error=${PUBLISH_NOT_POSSIBLE_YET_QUERY}`);
    }
    if (result.reason === "paid_mode_required") {
      redirect("/dashboard?error=Paid+publishing+isn%27t+available+right+now");
    }
    // "not_found" (no such book, or not owned by this user) and
    // "update_failed" both redirect back to the dashboard -- the
    // former matches this function's own pre-extraction behavior
    // exactly (`if (!book) { redirect("/dashboard"); }`); the latter is
    // a new, previously-unhandled case (the update call was never
    // checked for an error before this extraction) getting the same
    // safe fallback rather than being silently ignored.
    redirect("/dashboard");
  }

  // ADMIN-3-REVIEW (A): sent for review -- nothing went live, so there is
  // nothing to notify or refresh but the author's own Dashboard.
  if (result.outcome === "sent_for_review") {
    revalidatePath("/dashboard");
    redirect(`/dashboard?success=${encodeURIComponent(SENT_FOR_REVIEW_MESSAGE)}`);
  }

  // The books.status="published" mutation above has already committed
  // -- everything from here on is best-effort follow-up (notifying
  // followers, refreshing cached pages), never something that may turn
  // an already-successful publish into a reported failure. Each step is
  // isolated in its own try/catch and logged server-side only, never
  // rethrown, so a transient failure here can cost at most a missed
  // notification or a stale cached page, never the user's confidence
  // that their book is actually live. redirect() below stays OUTSIDE
  // every try/catch: Next.js implements redirect() by throwing a special
  // NEXT_REDIRECT signal that a surrounding catch would otherwise
  // swallow, turning a successful publish into the generic error page.
  if (result.wasNewlyPublished) {
    try {
      const admin = createAdminClient();
      await sendNewBookEmails(admin, { bookId, authorId: user.id });
    } catch (error) {
      console.error("publishBook: sendNewBookEmails failed after a successful publish", {
        bookId,
        authorId: user.id,
        error,
      });
    }
  }

  try {
    revalidatePath("/dashboard");
    revalidatePath("/");
  } catch (error) {
    console.error("publishBook: revalidatePath failed after a successful publish", {
      bookId,
      error,
    });
  }

  redirect("/dashboard?success=Your+book+is+now+live");
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
    .select("id")
    .eq("id", bookId)
    .eq("author_id", user.id)
    .maybeSingle();

  if (bookReadError) {
    console.error("unpublishBook: book read failed", { bookId, error: bookReadError });
    redirect("/dashboard?error=Could+not+unpublish+that+book+right+now");
  }
  if (!book) {
    redirect("/dashboard");
  }

  // PHASE-2C: a book that's a member of a currently published bundle
  // can't be unpublished out from under it -- the bundle would then be
  // advertising and selling a book that's no longer actually available.
  // The author must unpublish or edit (remove this book from) the
  // bundle first. Fails closed on a genuine read error -- see
  // bookBelongsToPublishedBundle()'s own comment.
  const membership = await bookBelongsToPublishedBundle(supabase, bookId);
  if (!membership.ok) {
    redirect("/dashboard?error=Could+not+unpublish+that+book+right+now");
  }
  if (membership.inPublishedBundle) {
    redirect(
      "/dashboard?error=This+book+is+part+of+a+published+bundle+-+unpublish+or+edit+the+bundle+first",
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
    redirect("/dashboard?error=Could+not+unpublish+that+book+right+now");
  }
  if (!isExactlyOneRowWritten(updatedRows)) {
    console.error("unpublishBook: update did not change exactly one row", { bookId, userId: user.id });
    redirect("/dashboard?error=Could+not+unpublish+that+book+right+now");
  }

  // F5 (C5): the unpublish above succeeded, so this book stops being
  // Librum's choice (best effort, see clearOwnBookLibrumChoice).
  await clearOwnBookLibrumChoice(catalogWriter, bookId, user.id, "unpublishBook");

  revalidatePath("/dashboard");
  revalidatePath("/");
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
    .select("id, author_id, cover_path, file_path")
    .eq("id", bookId)
    .eq("author_id", user.id)
    .single();

  if (bookError || !book || book.id !== bookId || book.author_id !== user.id) {
    redirect("/dashboard");
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
    redirect("/dashboard?error=Could+not+delete+that+book+right+now");
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
    redirect("/dashboard?error=Could+not+delete+that+book+right+now");
  }
  if (membership.inPublishedBundle) {
    redirect(
      "/dashboard?error=This+book+is+part+of+a+published+bundle+-+unpublish+or+remove+it+from+the+bundle+first",
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
      "/dashboard?error=This+book+has+been+acquired+by+readers+and+can%27t+be+deleted+-+unpublish+it+instead",
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
    redirect("/dashboard?error=Could+not+delete+that+book+right+now");
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
        "/dashboard?error=This+book+has+been+acquired+by+readers+and+can%27t+be+deleted+-+unpublish+it+instead",
      );
    }
    // ADMIN-2-TAKEDOWN: the delete-lock trigger (LB461) caught a
    // takedown that landed after the read above.
    if (deleteError.code === "LB461") {
      redirect(`/dashboard?error=${encodeURIComponent(TAKEN_DOWN_DELETE_MESSAGE)}`);
    }
    redirect("/dashboard?error=Could+not+delete+that+book+right+now");
  }

  if (!isExactlyOneRowWritten(deletedRows) || deletedRows?.[0]?.id !== book.id) {
    console.error("deleteBook: delete did not remove exactly this one row", {
      bookId: book.id,
      rowCount: Array.isArray(deletedRows) ? deletedRows.length : null,
    });
    redirect("/dashboard?error=Could+not+delete+that+book+right+now");
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
  if (unsafeStoredPathCount > 0) {
    console.warn("deleteBook: stored paths that are not this book's own keys were left untouched", {
      bookId: book.id,
      unsafeStoredPathCount,
    });
  }
  await removeProvenBookStorageObjects(supabase, removals, "deleteBook");

  revalidatePath("/dashboard");
  revalidatePath("/");
}

export async function addContributor(bookId: string, formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const name = String(formData.get("name") ?? "").trim();
  const role = String(formData.get("role") ?? "");

  if (!name || !CONTRIBUTOR_ROLES.includes(role as (typeof CONTRIBUTOR_ROLES)[number])) {
    redirect(`/dashboard/books/${bookId}/edit?error=Enter+a+name+and+choose+a+role`);
  }

  const { data: book } = await supabase
    .from("books")
    .select("id")
    .eq("id", bookId)
    .eq("author_id", user.id)
    .maybeSingle();

  if (!book) {
    redirect("/dashboard");
  }

  const { error } = await supabase.from("book_contributors").insert({
    book_id: bookId,
    name,
    role,
  });

  if (error) {
    // LIBRUM 2.0 LAUNCH-FIX-1A ERR-2: was error.message -- see the
    // identical correction in src/app/books/[id]/actions.ts for why.
    redirect(
      `/dashboard/books/${bookId}/edit?error=${encodeURIComponent(ADD_CONTRIBUTOR_ERROR_MESSAGE)}`,
    );
  }

  revalidatePath(`/dashboard/books/${bookId}/edit`);
  revalidatePath(`/books/${bookId}`);
  redirect(`/dashboard/books/${bookId}/edit?success=Contributor+added`);
}

export async function removeContributor(bookId: string, contributorId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // RLS also enforces this (the delete policy checks the book's
  // author_id), but this makes the ownership check explicit here too.
  const { data: book } = await supabase
    .from("books")
    .select("id")
    .eq("id", bookId)
    .eq("author_id", user.id)
    .maybeSingle();

  if (!book) {
    redirect("/dashboard");
  }

  await supabase.from("book_contributors").delete().eq("id", contributorId);

  revalidatePath(`/dashboard/books/${bookId}/edit`);
  revalidatePath(`/books/${bookId}`);
}
