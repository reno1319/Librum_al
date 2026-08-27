"use server";

import { randomUUID } from "crypto";
import { convertDocxToDocument, type ConversionWarning, type DocSection } from "@/lib/docx-converter";
import { generateEpub } from "@/lib/epub-generator";
import { validateEpubStructure } from "@/lib/epub-validation";

// LIBRUM 2.0 PRODUCT-5: two deliberately narrow, side-effect-free
// Server Actions -- neither makes a Supabase call, neither writes to
// the DB or storage. Split into two steps (PRE-COMMIT CORRECTION,
// see below) rather than one:
//
//   1. parseDocxToDocument() -- the only step that needs Mammoth. Runs
//      once, the moment a DOCX is selected, and returns the normalized
//      sections/images. Never touches book title/author at all.
//   2. packageEpub() -- pure JSZip packaging (no Mammoth) of an
//      ALREADY-parsed document into real EPUB bytes with the CURRENT
//      book title/author baked into its metadata, then the exact same
//      validateEpubStructure() check every uploaded EPUB goes through.
//
// Why split: the new-book wizard's own step order collects the
// manuscript (Files, step 1) before the title (Book Details, step 2)
// -- generating the final distribution EPUB at DOCX-selection time
// would bake in a placeholder title that's wrong by the time the
// author actually saves the book. Keeping the parsed document in
// client state (see manuscript-field.tsx) and re-calling packageEpub()
// -- cheap, no Mammoth involved -- every time the title/author changes
// is what lets the EPUB actually submitted always carry the real,
// final Librum book title. Edit Book already has a real title from
// page load, so its very first packageEpub() call already uses it.
//
// Both run in this route segment's default Node.js runtime (this app
// has no Edge runtime anywhere) -- Mammoth and JSZip both need
// Buffer/zlib, which Edge doesn't provide.

const MAX_DOCX_BYTES = 50 * 1024 * 1024;

const ERROR_MESSAGES: Record<string, string> = {
  missing_file: "Choose a DOCX file to convert.",
  wrong_extension: "Please choose a .docx file.",
  too_large: "DOCX manuscript must be under 50MB.",
  invalid_zip: "That file doesn't look like a valid DOCX file.",
  not_a_docx: "That file doesn't look like a valid DOCX file.",
  macro_enabled_document_not_supported:
    "Macro-enabled documents (.docm) aren't supported. Please save as a standard .docx file and try again.",
  empty_document: "This document doesn't have any readable text to convert.",
  conversion_failed: "Something went wrong converting this document. Please try again.",
  // LIBRUM 2.0 PRODUCT-5 PRE-COMMIT CORRECTION: the ZIP-bomb preflight's
  // two rejection reasons (see zip-preflight.ts) -- deliberately never
  // exposes entry names, byte thresholds, or which specific check
  // fired. "Too large" (uncompressed size) and "too complex" (entry
  // count) are kept as distinct, actionable messages rather than one
  // generic failure, per the correction brief's own wording.
  too_large_uncompressed: "Document is too large to convert.",
  too_complex: "Document is too complex to convert.",
  generated_epub_invalid:
    "Something went wrong generating your ebook. Please try again, or upload an EPUB directly.",
};

// Server Action return values cross the RSC boundary -- images travel
// as base64 rather than raw Buffer/Uint8Array, the same well-supported
// technique the original single-action design already used for the
// final EPUB bytes.
export type ParseDocxResult =
  | {
      success: true;
      sections: DocSection[];
      images: { filename: string; mediaType: string; base64: string }[];
      warnings: ConversionWarning[];
    }
  | { success: false; error: string };

export async function parseDocxToDocument(formData: FormData): Promise<ParseDocxResult> {
  const file = formData.get("docx") as File | null;
  if (!file || file.size === 0) {
    return { success: false, error: ERROR_MESSAGES.missing_file };
  }
  if (!file.name.toLowerCase().endsWith(".docx")) {
    return { success: false, error: ERROR_MESSAGES.wrong_extension };
  }
  if (file.size > MAX_DOCX_BYTES) {
    return { success: false, error: ERROR_MESSAGES.too_large };
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const conversion = await convertDocxToDocument(bytes);
  if (!conversion.success) {
    return { success: false, error: ERROR_MESSAGES[conversion.error] ?? ERROR_MESSAGES.conversion_failed };
  }

  return {
    success: true,
    sections: conversion.sections,
    images: conversion.images.map((img) => ({
      filename: img.filename,
      mediaType: img.mediaType,
      base64: img.bytes.toString("base64"),
    })),
    warnings: conversion.warnings,
  };
}

export type PackageEpubResult =
  | { success: true; epubBase64: string }
  | { success: false; error: string };

// LIBRUM 2.0 PRODUCT-5 PRE-COMMIT CORRECTION: bookTitle/authorName are
// ALWAYS the caller's current, live values -- never a placeholder --
// see manuscript-field.tsx, which calls this again on every title/
// author change while a parsed document is cached, and calls it once
// immediately with whatever's already known otherwise (Edit Book's
// real book.title, or the wizard's live title field). No manuscript
// text is ever used as a metadata source.
export async function packageEpub(
  bookTitle: string,
  authorName: string,
  sections: DocSection[],
  images: { filename: string; mediaType: string; base64: string }[],
): Promise<PackageEpubResult> {
  const title = bookTitle.trim() || "Untitled manuscript";
  const author = authorName.trim() || "Unknown author";

  const epubBytes = await generateEpub({
    bookId: randomUUID(),
    title,
    authorName: author,
    sections,
    images: images.map((img) => ({
      filename: img.filename,
      mediaType: img.mediaType as "image/png" | "image/jpeg" | "image/gif",
      bytes: Buffer.from(img.base64, "base64"),
    })),
  });

  // LIBRUM 2.0 PRODUCT-5: the SAME validator every uploaded EPUB
  // already goes through (src/lib/epub-validation.ts), not a weaker
  // alternate check, and run again on EVERY re-packaging (not just the
  // first) -- if a title/author change ever produced something
  // invalid, this refuses to hand it back rather than silently
  // offering a broken file. createBook()/updateBook() independently
  // re-run this exact same validator too once the client submits the
  // File (defense in depth, not redundant trust).
  //
  // Scope, stated precisely (re-audited for the PRODUCT-5 pre-commit
  // review): validateEpubStructure() checks mimetype's exact value,
  // that META-INF/container.xml exists and points at a real rootfile,
  // and that the rootfile exists -- it never parses OPF metadata at
  // all, so it neither confirms nor denies dc:title/dc:creator/
  // dc:language/anything else in <metadata>. Passing it is proof this
  // is a structurally real EPUB (the same bar every uploaded EPUB
  // already clears), not proof of full EPUB3 metadata conformance --
  // that standard is met by what generateEpub() itself emits (see its
  // own dc:language/dc:title/dc:creator handling), not by this check.
  const validation = await validateEpubStructure(epubBytes);
  if (!validation.valid) {
    console.error("packageEpub: generated EPUB failed validation:", validation.reason);
    return { success: false, error: ERROR_MESSAGES.generated_epub_invalid };
  }

  return { success: true, epubBase64: epubBytes.toString("base64") };
}
