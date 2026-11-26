"use client";

import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { createClient } from "@/lib/supabase/client";
import { MAX_SLIDE_PICTURE_BYTES, SLIDE_STAGING_BUCKET, stagedSlidePicturePath } from "@/lib/libraria-banner";

// Banner two-pictures fix (Renato 2026-11-26, bp1 a): the slide form
// looks the same as before. When Save is pressed with a new picture,
// this button first puts each picture straight into the private
// staging bucket (see banner-actions.ts), fills the two hidden names,
// then lets the save go on. The pictures themselves never travel with
// the form, so two big pictures no longer pass Vercel's ~4.5 MB request
// limit. The button reads "Saving…" while the pictures go up and while
// the save runs.
//
// The two picture inputs carry no name (so the browser never adds their
// bytes to the form) and are found by data-slide-picture="wide|phone".
const UPLOAD_FAILED = "Couldn’t upload the picture. Please try again.";
const BAD_PICTURE = "Each picture must be a JPG or PNG under 5 MB.";

type Picked = { kind: "wide" | "phone"; file: File };

export function SlideSaveButton({
  staffUserId,
  label,
  className,
}: {
  staffUserId: string;
  label: string;
  className: string;
}) {
  const { pending } = useFormStatus();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wideRef = useRef<HTMLInputElement>(null);
  const phoneRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const passRef = useRef(false);

  useEffect(() => {
    const form = wideRef.current?.form;
    if (!form) return;

    function picked(): Picked[] {
      const list: Picked[] = [];
      for (const kind of ["wide", "phone"] as const) {
        const input = form!.querySelector<HTMLInputElement>(`input[data-slide-picture="${kind}"]`);
        const file = input?.files?.[0];
        if (file && file.size > 0) list.push({ kind, file });
      }
      return list;
    }

    function setNames(wide: string, phone: string) {
      if (wideRef.current) wideRef.current.value = wide;
      if (phoneRef.current) phoneRef.current.value = phone;
    }

    function handleSubmit(e: SubmitEvent) {
      // The second, real submit after the pictures went up.
      if (passRef.current) {
        passRef.current = false;
        return;
      }
      const files = picked();
      if (!busyRef.current) {
        setNames("", "");
        setError(null);
      }
      // No new picture: the save goes on as before.
      if (files.length === 0 && !busyRef.current) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (busyRef.current) return;

      if (files.some(({ file }) => (file.type !== "image/jpeg" && file.type !== "image/png") || file.size > MAX_SLIDE_PICTURE_BYTES)) {
        setError(BAD_PICTURE);
        return;
      }
      const submitter = e.submitter instanceof HTMLElement ? e.submitter : null;

      busyRef.current = true;
      setUploading(true);
      void (async () => {
        const supabase = createClient();
        const bucket = supabase.storage.from(SLIDE_STAGING_BUCKET);
        const done: { kind: Picked["kind"]; path: string }[] = [];
        try {
          const results = await Promise.all(
            files.map(async ({ kind, file }) => {
              const path = stagedSlidePicturePath(
                staffUserId,
                crypto.randomUUID(),
                file.type === "image/png" ? "png" : "jpg",
              );
              const { error: uploadError } = await bucket.upload(path, file, { contentType: file.type });
              if (uploadError) {
                console.error("SlideSaveButton: picture upload failed:", uploadError);
                return false;
              }
              done.push({ kind, path });
              return true;
            }),
          );
          if (results.includes(false)) throw new Error("upload failed");
          setNames(done.find((d) => d.kind === "wide")?.path ?? "", done.find((d) => d.kind === "phone")?.path ?? "");
          passRef.current = true;
          form!.requestSubmit(submitter);
        } catch {
          if (done.length > 0) void bucket.remove(done.map((d) => d.path));
          setError(UPLOAD_FAILED);
        } finally {
          busyRef.current = false;
          setUploading(false);
        }
      })();
    }

    form.addEventListener("submit", handleSubmit, true);
    return () => form.removeEventListener("submit", handleSubmit, true);
  }, [staffUserId]);

  const saving = uploading || pending;
  return (
    <>
      <input ref={wideRef} type="hidden" name="pictureStoragePath" />
      <input ref={phoneRef} type="hidden" name="phonePictureStoragePath" />
      <button type="submit" disabled={saving} className={className}>
        {saving ? "Saving…" : label}
      </button>
      {error && (
        <p role="alert" className="w-full text-sm text-red-800">
          {error}
        </p>
      )}
    </>
  );
}
