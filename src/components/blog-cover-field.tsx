"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { fileInputClasses } from "@/lib/form-styles";

// LIBRUM 2.0 BLOG-1C: adapted from src/components/cover-field.tsx (see
// that file's own header for the full "why direct browser->Storage,
// why the private manuscripts bucket for staging" reasoning -- unchanged
// here, just for staff identity instead of an author's). BLOG-1B.1's
// storage review already confirmed the existing manuscripts bucket's
// owner-path policies (`auth.uid()::text = (storage.foldername(name))[1]`)
// require no new policy at all for `<staff-uid>/tmp/blog/<uuid>.<ext>` --
// only the path prefix changes from "tmp/cover" to "tmp/blog".
//
// Client-side format/size checks are a UX nicety only -- the Server
// Action's own byte-signature validation (mirroring
// resolveCoverInput()) is the real, authoritative check; never trusted
// alone.
type Status = "idle" | "uploading" | "success" | "error";

const MAX_COVER_BYTES = 5 * 1024 * 1024;
const MANUSCRIPTS_BUCKET = "manuscripts";
const GENERIC_ERROR = "We couldn't upload this cover. Please try again.";
const TOO_LARGE_ERROR = "This cover is larger than the 5 MB limit.";
const UNSUPPORTED_FORMAT_ERROR = "Unsupported cover format. Use JPEG or PNG.";

export function BlogCoverField({
  staffUserId,
  existingCoverUrl,
}: {
  // The signed-in staff member's own id -- used only to namespace this
  // upload's temporary Storage path (never persisted as any kind of
  // ownership of the resulting article).
  staffUserId: string;
  // Edit-page only: presence of this prop switches this field into
  // "replace" mode, showing the existing cover as the fallback preview.
  // Omit entirely for a new article.
  existingCoverUrl?: string;
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
      if (error) console.error("BlogCoverField: failed to remove temporary object:", error);
    } catch (err) {
      console.error("BlogCoverField: failed to remove temporary object:", err);
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
    if (tempPathRef.current) {
      void removeTempObject(tempPathRef.current);
    }
    setHiddenPath(null);
    setErrorMessage("");
    setReadyFileName(null);

    if (!file) {
      setStatus("idle");
      setPreviewUrl(null);
      return;
    }

    if (file.type !== "image/jpeg" && file.type !== "image/png") {
      setStatus("error");
      setErrorMessage(UNSUPPORTED_FORMAT_ERROR);
      setPreviewUrl(null);
      return;
    }
    if (file.size > MAX_COVER_BYTES) {
      setStatus("error");
      setErrorMessage(TOO_LARGE_ERROR);
      setPreviewUrl(null);
      return;
    }

    const nextPreviewUrl = URL.createObjectURL(file);
    previewUrlRef.current = nextPreviewUrl;
    setPreviewUrl(nextPreviewUrl);
    setStatus("uploading");

    const myRequestId = beginRequest();
    const extension = file.type === "image/png" ? "png" : "jpg";
    const tempPath = `${staffUserId}/tmp/blog/${crypto.randomUUID()}.${extension}`;

    const run = (async () => {
      try {
        const { error: uploadError } = await supabase()
          .storage.from(MANUSCRIPTS_BUCKET)
          .upload(tempPath, file, { contentType: file.type });

        if (isStale(myRequestId)) return;
        if (uploadError) {
          console.error("BlogCoverField: cover upload failed:", uploadError);
          setStatus("error");
          setErrorMessage(GENERIC_ERROR);
          return;
        }

        setStatus("success");
        setHiddenPath(tempPath);
        setReadyFileName(file.name);
      } catch (err) {
        console.error("BlogCoverField: cover upload failed:", err);
        void removeTempObject(tempPath);
        if (isStale(myRequestId)) return;
        setStatus("error");
        setErrorMessage(GENERIC_ERROR);
      } finally {
        pendingCountRef.current -= 1;
      }
    })();

    inFlightRef.current = run;
  }

  // Submit-while-uploading guard -- same technique as CoverField's own
  // (see that component's header comment for why this stays
  // independent rather than sharing state with any sibling field).
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
            <img src={displayedPreview} alt="" className="aspect-[3/2] w-40 rounded-md object-cover" />
          ) : (
            <div className="aspect-[3/2] w-40 rounded-md bg-border" />
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
          JPEG or PNG · up to 5 MB · roughly 3:2 works best.
          {isReplaceMode ? " Leave blank to keep the current cover." : " Optional."}
        </span>
      </label>

      {!isReplaceMode && previewUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={previewUrl} alt="" className="aspect-[3/2] w-40 rounded-md object-cover shadow-sm" />
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
