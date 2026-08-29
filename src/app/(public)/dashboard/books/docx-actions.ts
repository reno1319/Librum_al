"use server";

import { randomUUID } from "crypto";
import { createClient } from "@/lib/supabase/server";
import { convertDocxToDocument, type ConversionWarning } from "@/lib/docx-converter";
import { generateEpub, patchEpubMetadata } from "@/lib/epub-generator";
import { validateEpubStructure } from "@/lib/epub-validation";

// LIBRUM 2.0 PRODUCT-5 413 CORRECTION: a confirmed production defect --
// an 8.3MB real-world DOCX (well under the advertised 50MB limit) 413'd
// before conversion ever started, because Vercel Functions enforce a
// platform-level request-body ceiling around 4.5MB REGARDLESS of this
// app's own next.config.ts `serverActions.bodySizeLimit`. The original
// design sent the DOCX's own bytes straight into a Server Action's
// FormData -- exactly the payload shape that ceiling blocks.
//
// Fix: large binary bytes never cross a Vercel Function request/
// response body in either direction anymore, in either phase.
//
//   UPLOAD PHASE (browser -> conversion): the browser uploads the DOCX
//   directly to Supabase Storage (see manuscript-field.tsx) -- a
//   separate origin entirely, not subject to Vercel's limit -- into a
//   TEMPORARY, private, user-id-namespaced path under the EXISTING
//   "manuscripts" bucket (already private, already RLS-scoped to
//   auth.uid() via storage.foldername(name)[1] -- see schema.sql's
//   "storage: cover images (public) and manuscript files (private)"
//   section). parseDocxToDocument() below receives only that small
//   path string, downloads the bytes itself (server <-> Supabase
//   Storage, not through any Vercel request body), and runs the
//   EXISTING, unmodified conversion pipeline.
//
//   PACKAGING PHASE (conversion -> browser): the normalized
//   sections/images Mammoth produces, and the generated EPUB itself,
//   both stay server/storage-side too -- neither has ever round-
//   tripped through a Server Action response since this correction.
//   parseDocxToDocument() packages a first EPUB immediately (Mammoth
//   runs exactly once, same as before) and stores ONLY that generated
//   EPUB privately, temporarily, in the same bucket. The client
//   receives just a small storage-path reference plus warnings.
//
//   RETITLING (every keystroke on the book title): re-running Mammoth
//   or re-uploading a whole normalized document just to change a
//   title would be wasteful and, for an illustrated manuscript, could
//   itself exceed Vercel's limits again. repackageWithTitle() instead
//   downloads the ALREADY-GENERATED temporary EPUB and patches only
//   its OPF metadata (see epub-generator.ts's patchEpubMetadata(),
//   empirically verified to leave every other entry byte-for-byte
//   untouched) -- cheaper than the original full-rebuild-per-keystroke
//   design, and still never sends EPUB bytes through this action's
//   response.
//
//   FINAL SUBMISSION: the browser downloads the finished temporary
//   EPUB directly from Supabase Storage (again, not through Vercel)
//   into a real File, and hands it to the EXISTING, completely
//   unmodified manuscript hidden-input/createBook()/updateBook() path
//   -- exactly as a directly-uploaded EPUB already works. That last
//   leg (browser -> createBook()/updateBook()) is unchanged from
//   before this correction and shares its own pre-existing Vercel
//   body-size exposure with plain direct EPUB uploads above ~4.5MB --
//   audited, not fixed, this round (see the correction's own report:
//   carried forward, since fixing it requires materially modifying
//   createBook()/updateBook(), which this correction's brief
//   explicitly reserves for a separate, reviewed change).
//
// Both Server Actions below use the SAME per-user Supabase server
// client every other Server Action in this app already uses (cookie-
// derived session, RLS-enforced) -- no service-role key, no new
// authorization mechanism. A caller can only ever download/upload/
// remove objects under their own "<their-own-uid>/tmp/..." prefix:
// RLS enforces this at the database level exactly as it already does
// for permanent manuscripts, and an explicit ownership check below
// (defense in depth, this codebase's established pattern) rejects any
// path that doesn't start with the CALLING user's own id before ever
// touching Storage.

const MANUSCRIPTS_BUCKET = "manuscripts";
const MAX_DOCX_BYTES = 50 * 1024 * 1024;

const ERROR_MESSAGES: Record<string, string> = {
  missing_path: "Choose a DOCX file to convert.",
  not_authenticated: "Your session has expired. Please refresh the page and try again.",
  unauthorized: "Something went wrong converting this document. Please try again.",
  temp_upload_failed:
    "We couldn't upload your manuscript. Please check your connection and try again.",
  temp_file_missing: "Something went wrong converting this document. Please try again.",
  too_large: "DOCX manuscript must be under 50MB.",
  invalid_zip: "That file doesn't look like a valid DOCX file.",
  not_a_docx: "That file doesn't look like a valid DOCX file.",
  macro_enabled_document_not_supported:
    "Macro-enabled documents (.docm) aren't supported. Please save as a standard .docx file and try again.",
  empty_document: "This document doesn't have any readable text to convert.",
  conversion_failed: "Something went wrong converting this document. Please try again.",
  too_large_uncompressed: "Document is too large to convert.",
  too_complex: "Document is too complex to convert.",
  generated_epub_invalid:
    "Something went wrong generating your ebook. Please try again, or upload an EPUB directly.",
};

async function requireOwnedTempPath(tempPath: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false as const, error: ERROR_MESSAGES.not_authenticated };
  }
  if (!tempPath || !tempPath.startsWith(`${user.id}/tmp/`)) {
    return { ok: false as const, error: ERROR_MESSAGES.unauthorized };
  }
  return { ok: true as const, supabase, userId: user.id };
}

export type ParseDocxResult =
  | { success: true; conversionId: string; warnings: ConversionWarning[] }
  | { success: false; error: string };

// Receives only the small temporary-storage path the browser already
// uploaded the DOCX to -- never the file's own bytes (see the top-of-
// file comment for why). Downloads it, runs Mammoth exactly once, and
// immediately packages + stores a first EPUB (title/author not
// necessarily final yet -- see repackageWithTitle()) so the client
// never needs the normalized sections/images at all.
export async function parseDocxToDocument(tempDocxPath: string): Promise<ParseDocxResult> {
  const auth = await requireOwnedTempPath(tempDocxPath);
  if (!auth.ok) return { success: false, error: auth.error };
  const { supabase, userId } = auth;

  const cleanupTempDocx = async () => {
    const { error } = await supabase.storage.from(MANUSCRIPTS_BUCKET).remove([tempDocxPath]);
    if (error) {
      console.error("parseDocxToDocument: failed to remove temporary DOCX:", error);
    }
  };

  const { data: fileData, error: downloadError } = await supabase.storage
    .from(MANUSCRIPTS_BUCKET)
    .download(tempDocxPath);

  if (downloadError || !fileData) {
    console.error("parseDocxToDocument: temp DOCX download failed:", downloadError);
    await cleanupTempDocx();
    return { success: false, error: ERROR_MESSAGES.temp_file_missing };
  }

  const bytes = Buffer.from(await fileData.arrayBuffer());

  // Defense in depth: the browser already rejects a >50MB file before
  // ever starting the upload (see manuscript-field.tsx), but this
  // downloaded copy is re-checked rather than trusted.
  if (bytes.length > MAX_DOCX_BYTES) {
    await cleanupTempDocx();
    return { success: false, error: ERROR_MESSAGES.too_large };
  }

  const conversion = await convertDocxToDocument(bytes);
  // The temporary DOCX is never needed again past this point, success
  // or failure -- see the correction brief's "temporary DOCX only"
  // lifecycle rule (upload -> convert -> delete).
  await cleanupTempDocx();

  if (!conversion.success) {
    return { success: false, error: ERROR_MESSAGES[conversion.error] ?? ERROR_MESSAGES.conversion_failed };
  }

  const conversionId = randomUUID();
  const epubBytes = await generateEpub({
    bookId: conversionId,
    // Same trim-or-placeholder fallback repackageWithTitle() uses --
    // applied here too so no stored EPUB, even this transient first
    // packaging, ever carries a literally-blank dc:title/dc:creator.
    // The client always calls repackageWithTitle() immediately after a
    // successful parse with whatever title/author is actually known
    // (real, for Edit Book's already-known title; still blank, for the
    // wizard's Files step, in which case this placeholder is exactly
    // what would be applied anyway).
    title: "Untitled manuscript",
    authorName: "Unknown author",
    sections: conversion.sections,
    images: conversion.images,
  });

  // The SAME validator every uploaded EPUB already goes through (see
  // docx-actions.ts's pre-413-correction history / epub-validation.ts)
  // -- run here on the very first packaging, and again on every
  // subsequent repackageWithTitle() call below.
  const validation = await validateEpubStructure(epubBytes);
  if (!validation.valid) {
    console.error("parseDocxToDocument: generated EPUB failed validation:", validation.reason);
    return { success: false, error: ERROR_MESSAGES.generated_epub_invalid };
  }

  const tempEpubPath = `${userId}/tmp/epub/${conversionId}.epub`;
  const { error: uploadError } = await supabase.storage
    .from(MANUSCRIPTS_BUCKET)
    .upload(tempEpubPath, epubBytes, { contentType: "application/epub+zip", upsert: true });

  if (uploadError) {
    console.error("parseDocxToDocument: temp EPUB upload failed:", uploadError);
    return { success: false, error: ERROR_MESSAGES.generated_epub_invalid };
  }

  return { success: true, conversionId: tempEpubPath, warnings: conversion.warnings };
}

export type RepackageResult = { success: true } | { success: false; error: string };

// conversionId is the temporary EPUB's own storage path (returned by
// parseDocxToDocument above) -- re-validated as owned by the CALLING
// user on every call, same as parseDocxToDocument. Patches only the
// OPF's title/creator metadata in the ALREADY-GENERATED temporary
// EPUB (see epub-generator.ts's patchEpubMetadata()) rather than
// re-running Mammoth or shipping full EPUB bytes through this
// action's own request/response -- cheap and repeatable, callable on
// every title keystroke exactly as the pre-413-correction design's
// packageEpub() was.
export async function repackageWithTitle(
  conversionId: string,
  bookTitle: string,
  authorName: string,
): Promise<RepackageResult> {
  const auth = await requireOwnedTempPath(conversionId);
  if (!auth.ok) return { success: false, error: auth.error };
  const { supabase } = auth;

  const { data: fileData, error: downloadError } = await supabase.storage
    .from(MANUSCRIPTS_BUCKET)
    .download(conversionId);

  if (downloadError || !fileData) {
    console.error("repackageWithTitle: temp EPUB download failed:", downloadError);
    return { success: false, error: ERROR_MESSAGES.temp_file_missing };
  }

  const epubBytes = Buffer.from(await fileData.arrayBuffer());
  const title = bookTitle.trim() || "Untitled manuscript";
  const author = authorName.trim() || "Unknown author";

  let patched: Buffer;
  try {
    patched = await patchEpubMetadata(epubBytes, title, author);
  } catch (err) {
    console.error("repackageWithTitle: metadata patch failed:", err);
    return { success: false, error: ERROR_MESSAGES.generated_epub_invalid };
  }

  const validation = await validateEpubStructure(patched);
  if (!validation.valid) {
    console.error("repackageWithTitle: patched EPUB failed validation:", validation.reason);
    return { success: false, error: ERROR_MESSAGES.generated_epub_invalid };
  }

  const { error: uploadError } = await supabase.storage
    .from(MANUSCRIPTS_BUCKET)
    .upload(conversionId, patched, { contentType: "application/epub+zip", upsert: true });

  if (uploadError) {
    console.error("repackageWithTitle: temp EPUB re-upload failed:", uploadError);
    return { success: false, error: ERROR_MESSAGES.generated_epub_invalid };
  }

  return { success: true };
}
