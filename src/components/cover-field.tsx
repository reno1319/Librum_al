"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { fileInputClasses } from "@/lib/form-styles";

// LIBRUM 2.0 PRODUCT-5 COVER-1 CORRECTION: a cover between ~4.5MB and
// the app's own advertised 5MB limit could 413 through the old
// File-in-FormData path -- Vercel's own request-body ceiling sits
// BELOW the app's cover limit. Covers now travel the same way
// manuscripts do (see manuscript-field.tsx): direct browser->Storage
// upload, with createBook()/updateBook() (src/app/dashboard/books/
// actions.ts's resolveCoverInput()) receiving only a small
// "coverStoragePath" reference.
//
// One deliberate difference from the manuscript temp namespace: the
// temp object here is uploaded into the PRIVATE "manuscripts" bucket
// under "<uid>/tmp/cover/<uuid>.<ext>", NOT the public "covers"
// bucket -- audited directly in schema.sql before choosing this:
// "covers" has no owner-scoped read policy at all (it's genuinely
// public), so staging an unvalidated, not-yet-saved cover there would
// make it publicly addressable before the server ever confirms it's
// even a real JPEG/PNG under the size limit. "manuscripts" already has
// private, owner-scoped RLS on every operation, reused here as a
// general private staging area (see resolveCoverInput's own comment
// for the same reasoning from the server side).
//
// The local preview (Object URL) is entirely separate from this
// upload and never waits on it -- the author sees their chosen image
// immediately, synchronously, exactly as before this correction. Only
// the FORM SUBMISSION path changed: a hidden "coverStoragePath" text
// field instead of the cover File itself.
//
// This field's own submit-while-uploading guard is independent of
// ManuscriptField's (a separate component instance, its own
// capture-phase listener on the same <form>) -- not sharing state
// with it is deliberate: each only ever defers a submission based on
// its OWN pending count, and a deferred resubmission re-dispatches a
// fresh event that every other guard also gets to see, so two
// independent, non-conflicting guards on one form compose correctly
// without needing to coordinate (verified live, not just reasoned
// about -- see the correction's own report).
type Status = "idle" | "uploading" | "success" | "error";

const MAX_COVER_BYTES = 5 * 1024 * 1024;
const MANUSCRIPTS_BUCKET = "manuscripts";
const GENERIC_ERROR = "We couldn't upload your cover. Please try again.";
const TOO_LARGE_ERROR = "This cover is larger than the 5 MB limit.";
const UNSUPPORTED_FORMAT_ERROR = "Unsupported cover format. Use JPEG or PNG.";

export function CoverField({
  authorId,
  existingCoverUrl,
  onCoverChange,
}: {
  // The signed-in author's own id -- used only to namespace this
  // upload's temporary Storage path, same convention as
  // manuscript-field.tsx.
  authorId: string;
  // Edit-page only: presence of this prop (even as an empty string)
  // switches this field into "replace" mode -- labeling, "leave blank
  // to keep the current cover" copy, and showing the existing cover
  // as the fallback preview. Omit entirely for New Book.
  existingCoverUrl?: string;
  // Display-only info for the caller's own step-readiness/review UI --
  // never a File (see the top-of-file comment for why). LIBRUM 2.0
  // PUBLISHING-UX-1 PART C: now also carries the same local
  // Object-URL preview this field already renders itself, so a caller
  // (the new wizard's Review step) can show an actual thumbnail
  // without introducing a second upload/preview implementation.
  onCoverChange?: (info: { name: string; previewUrl: string } | null) => void;
}) {
  const isReplaceMode = existingCoverUrl !== undefined;
  const [status, setStatus] = useState<Status>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [readyFileName, setReadyFileName] = useState<string | null>(null);

  const hiddenPathInputRef = useRef<HTMLInputElement>(null);
  const previewUrlRef = useRef<string | null>(null);
  const tempPathRef = useRef<string | null>(null);
  const requestIdRef = useRef(0);
  const pendingCountRef = useRef(0);
  const inFlightRef = useRef<Promise<void>>(Promise.resolve());
  const supabaseClientRef = useRef<ReturnType<typeof createClient> | null>(null);

  function supabase() {
    if (!supabaseClientRef.current) {
      supabaseClientRef.current = createClient();
    }
    return supabaseClientRef.current;
  }

  useEffect(() => {
    return () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      if (tempPathRef.current) void removeTempObject(tempPathRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function setHiddenPath(path: string | null) {
    if (hiddenPathInputRef.current) {
      hiddenPathInputRef.current.value = path ?? "";
    }
    tempPathRef.current = path;
  }

  async function removeTempObject(path: string) {
    try {
      const { error } = await supabase().storage.from(MANUSCRIPTS_BUCKET).remove([path]);
      if (error) console.error("CoverField: failed to remove temporary object:", error);
    } catch (err) {
      console.error("CoverField: failed to remove temporary object:", err);
    }
  }

  function beginRequest(): number {
    const id = ++requestIdRef.current;
    pendingCountRef.current += 1;
    return id;
  }
  function isStale(id: number): boolean {
    return id !== requestIdRef.current;
  }

  function handleCoverChange(file: File | null) {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    // A superseded temp upload (author picked a different file before
    // saving) is removed best-effort -- never awaited, never blocks
    // starting the new upload.
    if (tempPathRef.current) {
      void removeTempObject(tempPathRef.current);
    }
    setHiddenPath(null);
    setErrorMessage("");
    setReadyFileName(null);

    if (!file) {
      setStatus("idle");
      setPreviewUrl(null);
      onCoverChange?.(null);
      return;
    }

    // Client-side checks are a UX nicety only -- resolveCoverInput()
    // re-validates the downloaded bytes' actual signature and size
    // server-side regardless (defense in depth, never trusted alone).
    if (file.type !== "image/jpeg" && file.type !== "image/png") {
      setStatus("error");
      setErrorMessage(UNSUPPORTED_FORMAT_ERROR);
      setPreviewUrl(null);
      onCoverChange?.(null);
      return;
    }
    if (file.size > MAX_COVER_BYTES) {
      setStatus("error");
      setErrorMessage(TOO_LARGE_ERROR);
      setPreviewUrl(null);
      onCoverChange?.(null);
      return;
    }

    // Local, synchronous preview -- never waits on the network.
    const nextPreviewUrl = URL.createObjectURL(file);
    previewUrlRef.current = nextPreviewUrl;
    setPreviewUrl(nextPreviewUrl);
    setStatus("uploading");

    const myRequestId = beginRequest();
    const extension = file.type === "image/png" ? "png" : "jpg";
    const tempPath = `${authorId}/tmp/cover/${crypto.randomUUID()}.${extension}`;

    const run = (async () => {
      try {
        const { error: uploadError } = await supabase()
          .storage.from(MANUSCRIPTS_BUCKET)
          .upload(tempPath, file, { contentType: file.type });

        if (isStale(myRequestId)) return;
        if (uploadError) {
          console.error("CoverField: cover upload failed:", uploadError);
          setStatus("error");
          setErrorMessage(GENERIC_ERROR);
          onCoverChange?.(null);
          return;
        }

        setStatus("success");
        setHiddenPath(tempPath);
        setReadyFileName(file.name);
        onCoverChange?.({ name: file.name, previewUrl: nextPreviewUrl });
      } catch (err) {
        console.error("CoverField: cover upload failed:", err);
        void removeTempObject(tempPath);
        if (isStale(myRequestId)) return;
        setStatus("error");
        setErrorMessage(GENERIC_ERROR);
        onCoverChange?.(null);
      } finally {
        pendingCountRef.current -= 1;
      }
    })();

    inFlightRef.current = run;
  }

  // Submit-while-uploading guard -- see the top-of-file comment for
  // why this is independent of ManuscriptField's own, rather than
  // sharing its state.
  useEffect(() => {
    const form = hiddenPathInputRef.current?.form;
    if (!form) return;

    function handleSubmit(e: Event) {
      if (pendingCountRef.current === 0) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      void (async () => {
        while (pendingCountRef.current > 0) {
          await inFlightRef.current;
        }
        form!.requestSubmit();
      })();
    }

    form.addEventListener("submit", handleSubmit, true);
    return () => form.removeEventListener("submit", handleSubmit, true);
  }, []);

  const displayedPreview = previewUrl ?? (isReplaceMode ? existingCoverUrl : undefined);

  return (
    <div className="flex flex-col gap-2">
      <input ref={hiddenPathInputRef} type="hidden" name="coverStoragePath" />

      {isReplaceMode && (
        <>
          <p className="text-sm font-medium">Current cover</p>
          {displayedPreview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={displayedPreview} alt="" className="h-24 w-16 rounded object-cover" />
          ) : (
            <div className="h-24 w-16 rounded bg-border" />
          )}
        </>
      )}

      <label className="flex flex-col gap-1 text-sm">
        {status === "success" ? "Replace cover" : isReplaceMode ? "Replace cover image" : "Cover image"}
        <input
          type="file"
          accept="image/png,image/jpeg"
          className={fileInputClasses}
          onChange={(e) => handleCoverChange(e.target.files?.[0] ?? null)}
        />
        <span className="text-xs text-muted">
          JPEG or PNG · up to 5 MB.
          {isReplaceMode ? " Leave blank to keep the current cover." : ""}
        </span>
      </label>

      {!isReplaceMode && previewUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={previewUrl} alt="" className="aspect-[2/3] w-32 rounded-md object-cover shadow-sm" />
      )}

      {status === "uploading" && (
        <p role="status" className="text-sm text-muted">
          Uploading cover…
        </p>
      )}

      {status === "success" && readyFileName && (
        <p role="status" className="text-sm text-primary">
          Cover ready — {readyFileName}
        </p>
      )}

      {status === "error" && (
        <p
          role="alert"
          className="rounded-lg border-l-4 border-red-600 bg-surface px-3 py-2 text-sm text-red-800"
        >
          {errorMessage}
        </p>
      )}
    </div>
  );
}
