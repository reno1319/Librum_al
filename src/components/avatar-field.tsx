"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { fileInputClasses } from "@/lib/form-styles";

// LIBRUM 2.0 LAUNCH-FIX-1A AVATAR-1: the same direct browser->Storage
// pattern PRODUCT-5 proved for manuscripts and covers (see
// cover-field.tsx's own top-of-file comment), applied to the one
// upload surface that was never brought into that work -- the profile
// avatar. dashboard/profile/actions.ts's updateProfile() used to
// receive the raw avatar File through the Server Action's own
// FormData; the advertised 5MB avatar limit sits at/above Vercel's own
// request-body ceiling, the exact exposure class COVER-1 was built to
// close for covers. This field now uploads the file directly to
// Storage and the form carries only a small "avatarStoragePath" text
// reference.
//
// Staged in the PRIVATE "manuscripts" bucket, NOT the public "avatars"
// bucket -- audited directly in schema.sql before writing this:
// "avatars" is a genuinely PUBLIC bucket (its own `select` RLS policy
// has no owner restriction at all), so staging an unvalidated,
// not-yet-saved photo there would make it publicly addressable before
// the server ever confirms it's even a real JPEG/PNG under the size
// limit. "manuscripts" already has private, owner-scoped RLS on every
// operation (insert/select/update/delete) and is already reused as a
// general private staging area by resolveCoverInput() -- this is the
// SAME staging area, not a second, avatar-specific one.
//
// The local preview (Object URL) is entirely separate from this
// upload and never waits on it. This field's own submit-while-
// uploading guard is independent of any other field's on the same
// form -- same reasoning as CoverField's own guard (see its comment):
// each only ever defers a submission based on its OWN pending count.
type Status = "idle" | "uploading" | "success" | "error";

const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const MANUSCRIPTS_BUCKET = "manuscripts";
const GENERIC_ERROR = "We couldn't upload your profile photo. Please try again.";
const TOO_LARGE_ERROR = "This image is larger than the 5 MB limit.";
const UNSUPPORTED_FORMAT_ERROR = "Unsupported image format. Use JPEG or PNG.";

export function AvatarField({
  userId,
  existingAvatarUrl,
}: {
  // The signed-in user's own id -- used only to namespace this
  // upload's temporary Storage path, same convention as
  // cover-field.tsx/manuscript-field.tsx.
  userId: string;
  existingAvatarUrl: string | null;
}) {
  const [status, setStatus] = useState<Status>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

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
      if (error) console.error("AvatarField: failed to remove temporary object:", error);
    } catch (err) {
      console.error("AvatarField: failed to remove temporary object:", err);
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

  function handleAvatarChange(file: File | null) {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    // A superseded temp upload (a different photo picked before saving)
    // is removed best-effort -- never awaited, never blocks starting
    // the new upload.
    if (tempPathRef.current) {
      void removeTempObject(tempPathRef.current);
    }
    setHiddenPath(null);
    setErrorMessage("");

    if (!file) {
      setStatus("idle");
      setPreviewUrl(null);
      return;
    }

    // Client-side checks are a UX nicety only -- resolveAvatarInput()
    // re-validates the downloaded bytes' actual signature and size
    // server-side regardless (defense in depth, never trusted alone).
    if (file.type !== "image/jpeg" && file.type !== "image/png") {
      setStatus("error");
      setErrorMessage(UNSUPPORTED_FORMAT_ERROR);
      setPreviewUrl(null);
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      setStatus("error");
      setErrorMessage(TOO_LARGE_ERROR);
      setPreviewUrl(null);
      return;
    }

    // Local, synchronous preview -- never waits on the network.
    const nextPreviewUrl = URL.createObjectURL(file);
    previewUrlRef.current = nextPreviewUrl;
    setPreviewUrl(nextPreviewUrl);
    setStatus("uploading");

    const myRequestId = beginRequest();
    const extension = file.type === "image/png" ? "png" : "jpg";
    const tempPath = `${userId}/tmp/avatar/${crypto.randomUUID()}.${extension}`;

    const run = (async () => {
      try {
        const { error: uploadError } = await supabase()
          .storage.from(MANUSCRIPTS_BUCKET)
          .upload(tempPath, file, { contentType: file.type });

        if (isStale(myRequestId)) return;
        if (uploadError) {
          console.error("AvatarField: avatar upload failed:", uploadError);
          setStatus("error");
          setErrorMessage(GENERIC_ERROR);
          return;
        }

        setStatus("success");
        setHiddenPath(tempPath);
      } catch (err) {
        console.error("AvatarField: avatar upload failed:", err);
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

  // Submit-while-uploading guard -- see the top-of-file comment.
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

  const displayedPreview = previewUrl ?? existingAvatarUrl;

  return (
    <div className="flex items-center gap-4">
      <input ref={hiddenPathInputRef} type="hidden" name="avatarStoragePath" />

      {displayedPreview ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={displayedPreview}
          alt=""
          className="h-16 w-16 rounded-full object-cover"
        />
      ) : (
        <div className="h-16 w-16 rounded-full bg-border" />
      )}

      <div className="flex flex-1 flex-col gap-1">
        <label className="flex flex-col gap-1 text-sm">
          Photo (JPG or PNG, up to 5MB)
          <input
            type="file"
            accept="image/png,image/jpeg"
            className={fileInputClasses}
            onChange={(e) => handleAvatarChange(e.target.files?.[0] ?? null)}
          />
        </label>

        {status === "uploading" && (
          <p role="status" className="text-sm text-muted">
            Uploading photo…
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
    </div>
  );
}
